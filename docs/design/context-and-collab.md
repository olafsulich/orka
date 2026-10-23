# Design: context handling and collaborative jobs

Status: proposal, 2026-10-21. No code changed. Line refs are `bin/orka.mjs` and `lib/*.mjs` at `b49d0a0`.

Four topics: (1) AGENTS.md instead of CLAUDE.md, (2) a ~50% context cap with handoff to a fresh agent, (3) what to take from Limen, (4) one task split across several workers.

## 1. AGENTS.md instead of CLAUDE.md

### Verdict

**The claim is right, with one condition.** Claude Code reads `AGENTS.md` natively since v2.1.277, but by default **only when there is no `CLAUDE.md` in the working directory or any parent**.

- Docs, https://code.claude.com/docs/en/memory#agents-md: "Claude Code can read `AGENTS.md` as your project instructions, so a repository already set up for other coding agents works without adding a `CLAUDE.md`, an import, or a setting." and "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working directory or above it."
- CHANGELOG 2.1.277: "Added AGENTS.md support: in a project with no CLAUDE.md, Claude Code reads AGENTS.md instead; change it under "Project instructions" in `/config`".
- What blocks it: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` in cwd or above. `~/.claude/CLAUDE.md` does not block it. The "Project instructions" setting has `claude-md`, `claude-md-or-agents-md` (default), `claude-md-and-agents-md`, `managed-only`; it is honoured only in user, `--settings` or managed settings, not project settings. An `@AGENTS.md` import or a symlink still works and is never read twice.
- Local proof: `claude --version` → `2.1.306`; the binary `~/.local/share/claude/versions/2.1.306` contains `claude-md-or-agents-md` (8×) and the log line `no CLAUDE.md found; AGENTS.md loaded` (2×).
- **Pi** (`@earendil-works/pi-coding-agent` 0.87.0, installed) reads one file per directory, first match of `["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]` (`dist/core/resource-loader.js:33`), walking up from cwd, plus `~/.pi/agent/AGENTS.md`. Pi does not expand `@file` imports.

So with both files present, **Claude reads CLAUDE.md and Pi reads AGENTS.md**. That split is the only real hazard.

### Current state

- orka never names either file: `grep -n "CLAUDE.md\|AGENTS.md" bin/orka.mjs lib/*.mjs` is empty. All rules reach agents through the first `herdr agent prompt` (`orchestratorPrompt` `bin/orka.mjs:1572`, `workerPrompt` `:1158`). `startArgs` passes only `--model` (`bin/orka.mjs:927-931`).
- The orka repo has neither file.
- Target repos on this VPS: `diagram-framework`, `mega-press` have AGENTS.md only; `mega-dev`, `jk-skills` have AGENTS.md plus a CLAUDE.md that imports it (`@AGENTS.md`; mega-dev also imports `@BRAIN.md @.pi/APPEND_SYSTEM.md`, which Pi will not see); `motion-lab`, `motion-craft`, `thumb-lab`, `vault-audit` have neither.
- Job worktrees live **inside** the target repo, at `<repo>/.orka/worktrees/<id>` (`worktreePath`, `bin/orka.mjs:406`). Both agents walk up from cwd, so a pane sees the worktree's committed copy *and* the primary checkout's copy (possibly newer or uncommitted). Whether Claude dedupes two identical AGENTS.md files at different paths is **unknown**; not tested.

### Proposal

- **orka itself:** add `AGENTS.md` (what orka is, the test command, file layout, "never close panes", no push). No `CLAUDE.md`. Native read covers Claude ≥2.1.277; Pi reads it too.
- **Target repos: orka writes nothing into them.** It checks and warns at `orka run` and `orka run --dry-run`:
  - AGENTS.md only → fine for both. Warn if `claude --version` < 2.1.277.
  - CLAUDE.md only → fine for both (Pi falls back to CLAUDE.md). Warn only if CLAUDE.md uses `@imports`, since Pi will not follow them.
  - Both, and CLAUDE.md does not import AGENTS.md (and is not a symlink to it) → warn: "Claude and Pi workers will read different rules. Make CLAUDE.md a one-line `@AGENTS.md`."
  - Neither → nothing.
- **Recommended setup for Olaf's repos:** AGENTS.md is the one source. Either no CLAUDE.md, or a CLAUDE.md that is exactly `@AGENTS.md` (needed only where a CLAUDE.md must exist for other tools, or for `InstructionsLoaded` hooks, which do not fire for the native read).
- Do not set "Project instructions" to `claude-md-and-agents-md` globally: with a both-files repo it loads two diverging files into every Claude pane.

### Open questions

1. Is a `orka run` warning enough, or should orka refuse to start a mixed Claude/Pi job when the two files diverge?
2. The worktree-inside-repo double read: test it (one job, compare `/context` or the session's loaded-files log), then decide whether orka should pass `--settings` with `claudeMdExcludes` for the primary checkout. Needs a measurement first.

### Follow-up tasks

| file | scope | size |
|------|-------|------|
| `tasks/16-orka-agents-md.md` | Write `AGENTS.md` for the orka repo. | S |
| `tasks/17-context-file-check.md` | `orka run` / dry-run detect the four cases above and warn; Claude version check; tests with fixture repos. | S |
| `tasks/18-worktree-double-read.md` | Measure whether a pane in `.orka/worktrees/<id>` loads the primary checkout's AGENTS.md too; write the result into this doc. | S |

## 2. Context cap at ~50% with handoff

### Current state

- No part of orka reads context usage. The verifier is the only role that is fresh by design: each round is a new pane (`verifierPrompt`, `bin/orka.mjs:1466`, "You start with fresh context").
- Compaction defence today is the digest: `orka digest` renders a 2400-character snapshot (`DIGEST_MAX`, `lib/digest.mjs:4`) and `orka steer` prepends it to every steer (`cmdSteer`, `bin/orka.mjs:2266-2302`; `steerText`, `lib/digest.mjs:43`). Decisions survive in `decisions.tsv` (`orka log`, `bin/orka.mjs:2107-2142`).
- herdr exposes no token data. `herdr agent list` (herdr 0.9.0) returns only `agent, agent_status, cwd, focused, foreground_cwd, interactive_ready, name, pane_id, revision, state_change_seq, tab_id, terminal_id, terminal_title, terminal_title_stripped, workspace_id`.
- The orchestrator's name is baked into every worker prompt: `herdr agent prompt ${job.agent} "<note>"` (`bin/orka.mjs:1179`, `:1508`). The watcher reads `job.agent` and `job.pane` once at start (`cmdWatch`, `bin/orka.mjs:3187`). Steer, stop and the watcher all address `job.agent`. A handoff that only starts a new pane would break all three.
- Panes: finished worker panes stay open until `releaseJob` on done/stop (`bin/orka.mjs:810-856`); the orchestrator pane stays until `orka cleanup`. The only mid-job close is a provably unused duplicate (`closeUnusedDuplicates`, `bin/orka.mjs:1918-1933`).

### How to measure context (proved)

Both agents write per-turn token usage into their session transcript. Current context = the last assistant turn's input side.

- Claude Code: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, `message.usage` on `type: assistant` lines. Context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- Pi: `~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`, `usage` with `input`, `cacheRead`, `cacheWrite`, `totalTokens`.

Proof on a live job (motion-lab `lauren-mechanic-r3-arms`), one transcript per pane in the shared worktree dir:

```
$ cd ~/.claude/projects/-home-olaf-projects-motion-lab--orca-worktrees-20261021205713915-lauren-mechanic-r3-arms
$ for f in *.jsonl; do python3 last_usage.py "$f"; done   # last assistant message.usage: input + cache_read + cache_creation
262c7c46 claude-sonnet-5-5 ctx_tokens= 124829 pct_of_200k=62% | You are a worker for orka job 20261021205...
638ae96e claude-haiku-5-5  ctx_tokens=  84801 pct_of_200k=42% | [Image: ...]
c74543a0 claude-opus-5-5   ctx_tokens=  56527 pct_of_200k=28% | arms r3 done f061e63: ...
```

So one worker in that job was already past 50% of a 200k window.

Two gaps, both fixable:

1. **Which transcript belongs to which pane.** Every pane in a job shares the worktree cwd, so they share one transcript folder. Fix: orka generates a UUID per agent and starts Claude with `--session-id <uuid>` (flag exists in the installed `claude --help`), stores it on the worker record, and reads exactly that file. For Pi, record the newest session file that appears in `~/.pi/agent/sessions/<slug>/` right after the start, and match it by the first user message (the orka prompt names the worker).
2. **Window size.** The transcript has tokens, not the window (200k by default, 1M with extended context). Default 200k, overridable per job or in `.orka/config.json` `contextWindow`. Percent = tokens / window.

Other sources, checked:
- **Statusline JSON** (https://code.claude.com/docs/en/statusline) has exactly what we want: `context_window.context_window_size`, `context_window.used_percentage` (input + cache tokens), `transcript_path`, `session_id`. It runs on each new assistant message. orka could pass `--settings '{"statusLine":{...}}'` at `herdr agent start` so a tiny script writes `<jobdir>/ctx/<name>.json`, with nothing installed in the target repo. Claude-only, and it replaces Olaf's own statusline in those panes (none is set today). Use it later to get the exact window size; not needed for v1.
- **Hooks**: no hook carries live usage (only `SessionStart` on resume and `PreModelSwitch` have `context_tokens`). `PreCompact` exists and can block an auto-compact (exit 2). Useful as a safety net: a `--settings` PreCompact hook that writes `ctx/<name>.compact` lets the watcher hand off instead of letting a pane compact silently.
- **herdr**: nothing (see above).

Transcript parsing is the primary method: it works for Claude and Pi and installs nothing.

### Proposal

**Who triggers.** The existing watcher (`lib/watch.mjs`), one per job, already polls every 30 s. Add a context check to its loop: for the orchestrator and each live worker, read the tail of its transcript and compute percent. The agent itself does not decide (it cannot see its own usage reliably, and it would hand off at the wrong moment). The orchestrator does not decide either (it would burn its own context reading numbers).

**When.** Threshold `contextCap` default 0.5, per job (`orka run --context-cap 0.5`) or config. Hand off only at a safe point: agent status `idle` or `done`, never `working` or `blocked`. If a worker is past the cap but still working, the watcher writes `notes/<name>.ctx` with the percent and waits; at 0.7 it sends one short line: "Context at 70%. Finish the current step, then write the handoff note." Hard stop never.

**Handoff note.** Based on Matt Pocock's `handoff` skill (text in the appendix). orka sends the outgoing agent one prompt: write the handoff note to `<jobdir>/handoff/<name>-<n>.md`. Adapted to orka:
- path is fixed by orka, not a temp file;
- sections: goal (pointer to the brief, not a copy), done so far with commit SHAs, open work, files touched, decisions (point to `decisions.tsv` rows, do not repeat them), dead ends, next step, and a "do not redo" list;
- reference artifacts by path (results JSON, verifier JSON, digest), never paste them;
- hard cap: 200 lines / 8 KB, so it stays far below the 50% it replaces.

**New pane.** orka starts the successor in a new pane split from the old one, same cwd, same model, same role. Name: herdr names are global and never reused (`freeWorkerName`, `bin/orka.mjs:1234`), so:
- rename the old agent `builder` → `builder-h1` (`herdr agent rename`), then start the new agent as `builder`. This keeps the routing target stable: worker prompts that say `herdr agent prompt <orchestrator>` still reach the live orchestrator, and `job.agent` never changes. Workers' `results/<name>.json` and `notes/<name>.txt` paths stay the same.
- Record on the worker: `handoffs: [{ n, from: "builder-h1", pane, sessionId, pct, at, note }]`.

First prompt of the successor = the normal role prompt (`workerPrompt` or `orchestratorPrompt`) + "You continue from a handoff. Read `<note>` first. Do not repeat what it lists as done." For the orchestrator also prepend the current `orka digest`, the same way steer does.

**Old pane.** Stays open, idle, until done/stop/cleanup, like any finished worker. `releaseJob` already closes every `job.workers[].pane`; handed-off panes are in that list, so nothing changes there. The renamed orchestrator pane `j<id>-h1` is a worker-style record and is closed by `releaseJob`; the live orchestrator pane keeps today's rule (stays until `orka cleanup`).

**Interactions.**
- *Digest:* add one line per worker with a handoff (`builder: h2, 54% → fresh`), inside `DIGEST_MAX`. The digest is the orchestrator's re-entry kit, so `DIGEST_MAX` stays 2400; the handoff note carries the rest.
- *Steer:* unchanged, it addresses `job.agent`, which is the successor after the rename. A steer that arrives during a handoff waits (orka holds a `handoff.lock` in the job dir; steer retries for up to 60 s).
- *Verifier:* exempt. It is fresh each round and short-lived. If a verifier passes the cap, the watcher only logs it; a round that needs more than half a window is a sign the task is too big, and the orchestrator should split verification.
- *Finish webhook:* unchanged. Handoffs are not terminal. Add `handoffs: <count>` to the payload so Olaf sees it.
- *Watcher itself:* reload `job.agent`/`job.pane` from the job file each poll instead of once at start (`bin/orka.mjs:3187`), so a handoff never strands it.
- *Housekeeping popups and needs-input:* the watcher already reads the lead pane; the handoff check runs after those.

**RAM.** A handoff briefly has two live processes for one role. Kill nothing: the old agent is idle, but it still holds ~300 MB (measured: 6 `claude` processes, avg 308 MB RSS). Count handed-off panes against the job's worker cap (section 4).

### Open questions

1. 50% of what: of the model's full window, or of the point where Claude auto-compacts? Proposal: of the full window, measured from the transcript.
2. Should the orchestrator be handed off at all, or only workers? It holds the plan; the digest + `decisions.tsv` + handoff note should be enough, but this is the riskiest case. Proposal: workers first, orchestrator behind a flag.
3. Is keeping the old pane (and its ~300 MB) worth it when RAM is tight? The rule says yes; an alternative is to `/exit` the old agent but leave the pane shell open.

### Follow-up tasks

| file | scope | size |
|------|-------|------|
| `tasks/19-session-id-per-pane.md` | Start Claude panes with `--session-id`, record it on each worker; Pi: record the session file. | S |
| `tasks/20-context-meter.md` | `lib/context.mjs`: read the transcript tail, compute tokens and percent; `orka status` shows it per pane. Tests with fixture jsonl. | M |
| `tasks/21-watcher-reloads-job.md` | Watcher reloads `job.agent`/`job.pane` each poll. | S |
| `tasks/22-handoff-worker.md` | Watcher triggers handoff for builder workers at the cap: note prompt, rename, new pane, successor prompt, job record, digest line. | L |
| `tasks/23-handoff-orchestrator.md` | Same for the orchestrator, behind `--handoff-orchestrator`; digest prepended. | M |

## 3. What to take from Limen

### Current state

Sources: `docs/research/limen-2026-10-10.md`, `docs/research/overment-vs-orca.md`, `docs/research/overment-agents.html`, and the local Limen checkout (`~/projects/limen` at `3241454`, 2026-10-17). Limen is public at https://github.com/overment/limen (background: https://mega.dev/autonomous-product-development). It has no document on context handling; the points below come from its code and templates. No context-limit threshold or custom compaction prompt exists in it.

What Limen does with context:
- **It does not compact or hand off.** Pi (or OMP) compacts the session. Limen keeps big stable text out of the thread and leaves the full record on disk (`limen-2026-10-10.md:41`).
- **Rules live on the system prompt, plus a hidden per-turn cue** rebuilt every turn, so they survive compaction (`hook/communication.ts`, `limen-2026-10-10.md:63`). Pi-only (a Pi extension).
- **Bounded wake:** `handoffExcerpt` clips a finished job's result to 15 lines / 1200 chars + 10 commits (`limen-2026-10-10.md:83`). orka already copied this as the digest.
- **`limen continue` copies the parent's jsonl** into the child. Context is kept, not shrunk (`limen-2026-10-10.md:33`).
- **A correction goes to the same coordinator, which keeps its context** (`overment-vs-orca.md:14`, `overment-agents.html` "Correction").
- **Worker reading budget:** about ten reads, then a probe edit; stop if the seam widens (`templates/worker.md`). **Handoffs under ~200 words** (`templates/agents.md`).
- **AGENTS.md:** a project `AGENTS.md` replaces Limen's inherited shop manual (`hook/communication.ts:234-237`, `docs/setup.md:76`). Limen treats AGENTS.md as the one project file.
- **Groups** (collaboration): several teams pursue the same feature with different approaches, each candidate in its own worktree, findings published to a shared cabinet, the lead merges what it keeps onto one integration branch (`docs/groups.md:3,43,87,89`).

### Copy

- The ~200-word handoff discipline and "point to files, never paste": into the handoff note template (section 2).
- The worker reading budget as one sentence in `workerPrompt`. It delays the 50% point for free.
- Per-candidate worktrees + one integration branch owned by the lead: into section 4.
- "Publish first hypothesis before reading peers": for collaborative workers, write your plan to the findings file before reading others'.
- AGENTS.md as the single project file (section 1).

### Do not copy

- A Pi extension / per-turn hidden cue. Claude panes would not get it, and orka must not install hooks in the target repo.
- `continue` by copying the transcript. It is the opposite of a fresh agent.
- Relying on the harness's own compaction as the only defence. That is exactly what the 50% cap replaces.
- Groups' lock, lease and delivery-claim machinery (`docs/groups.md:109-124`). orka has one orchestrator per job; the job file plus `herdr agent prompt` is enough.
- Competing teams on one feature. Olaf asked for cooperation on one task, not a race (orka skipped best-of-N, `tasks/README.md` #21).

### Open questions

1. Does Olaf want the reading budget as a hard number ("ten reads") or a softer rule?

### Follow-up tasks

| file | scope | size |
|------|-------|------|
| `tasks/24-worker-reading-budget.md` | One sentence in `workerPrompt` and the verifier prompt; test asserts it. | S |

## 4. Collaborative jobs

### Current state (correction)

"Each worker gets its own worktree" is not right. **One job = one linked worktree on branch `orka/<id>`; every worker of that job, the orchestrator and the verifier all work in that same checkout.**

- `addWorktree` creates exactly one worktree per job at `orka run` (`bin/orka.mjs:1759-1772`, called once at `:1836`).
- `cmdWorker` splits a pane with `--cwd job.worktree` and creates no worktree (`bin/orka.mjs:1976`, `splitPane` `:1869-1874`). The job records `workerLayout: "shared-worktree"` (`:1724`); dry-run prints "layout: shared worktree (workers do not get sibling checkouts)" (`:1641`).
- Prompts say so: worker "Other workers share this worktree. Do not revert their files. Do not create a branch, worktree, or push." (`:1166`); orchestrator "Workers share one worktree, so never give two workers the same files. Split by file or area" (`:1581-1585`); digest contract "Contract: shared worktree." (`lib/digest.mjs:21`).
- Header comment: "Workers share that worktree." (`bin/orka.mjs:2-3`).

So orka already runs several workers on one goal in parallel; what is missing is structure: ownership is a prompt rule, there is no shared findings file, no dependency order, and no integration step.

### Proposal

Keep the shared worktree as the default. Add structure around it, and add per-worker branches only for parts that cannot be split by files.

**Plan file.** The orchestrator writes `<jobdir>/plan.json` before starting workers, via `orka plan <id> --file plan.json` (orka validates it):

```json
{ "parts": [
  { "name": "api",  "owns": ["src/api/**"],       "after": [],      "task": "..." },
  { "name": "ui",   "owns": ["src/ui/**"],        "after": ["api"], "task": "..." },
  { "name": "docs", "owns": ["docs/feature.md"],  "after": ["api"], "task": "..." }
]}
```

- `owns` globs must not overlap; orka refuses overlap. `orka worker --part ui` puts the globs into SCOPE.
- `after` is the dependency order. `orka worker --part ui` refuses (or `--queue`s) until `api` has `ok: true`. Independent parts start together.
- Ownership check: before `orka done`, and on every worker note, orka runs `git diff --name-only <base>` and attributes files to parts. A file changed outside every `owns` is a warning in the digest. With one shared checkout orka cannot tell who wrote a file, so this is a check of the plan, not of people; commits per worker (below) close that gap.

**Commit per part.** Each worker commits its own files when done (`git add <owned paths> && git commit -m "<part>: ..."`). Today workers do not commit; the orchestrator's `SUMMARY_FROM_DIFF` reads the whole diff. Per-part commits give attribution, let the verifier route failures by `git log -- <file>`, and make a revert of one part cheap.

**Shared findings.** `<jobdir>/findings.md`, append-only, one entry per line: `<ts> <part> <kind: fact|decision|interface|blocker> <text, ≤200 chars> <path refs>`. Written with `orka note <id> --part ui "..."` (orka does the locking and the cap; agents never edit the file directly). Workers read it at start and before touching an interface. Limen's rule applies: write your plan entry first, then read others'. The digest shows the last 3 `interface`/`blocker` entries.

**Integration step.** When all parts report, the orchestrator starts one `integrator` worker (a builder role with SCOPE = glue files only, listed in `plan.json` `integration.owns`) whose task is: run the full build and tests, fix seams only in glue files, report. Then the verifier runs as today.

**Verifier.** Judges the whole job against the goal, unchanged. Add: the verifier task gets the plan (parts and acceptance per part) and must report each blocking failure with the part that owns the file; routing then goes straight to that part's worker (the existing route-by-owner rule, `bin/orka.mjs:1529`, now backed by `owns`).

**Per-worker branches (opt-in, `--isolate`).** For parts that must touch the same files or run conflicting dev servers. orka creates `orka/<id>/<part>` worktrees from the job branch tip; the orchestrator merges them in `after` order into `orka/<id>`; a conflict is routed to the integrator. Cost: one checkout + one `node_modules` per part, so this is the exception, not the default.

**VPS limits.** 4 cores, 7.7 GB RAM, ~1 GB available when measured. Measured RSS: ~300 MB per `claude` pane (6 panes, avg 308 MB), ~500 MB per headless Chrome session (6 processes 40-200 MB). Cap per job: `maxParallel` default 3 working builders (plus orchestrator and at most one verifier), `orka worker` queues beyond that. Global cap: `orka worker` refuses a new pane when `MemAvailable` < 1.5 GB and says so; the orchestrator then waits for a part to finish. Handed-off idle panes count toward the global check, not toward `maxParallel`.

### Open questions

1. Should workers commit (new behaviour) or should the orchestrator keep one squash at the end? Proposal: workers commit their part; Olaf still decides the merge to main.
2. Is `--isolate` worth building now, or only after a real job needs it? Proposal: later.
3. Default `maxParallel`: 3 is safe for RAM today; with a browser per worker, 2.
4. Should `findings.md` also feed the handoff note (section 2), so a successor reads peers' interfaces? Proposal: yes, by reference.

### Follow-up tasks

| file | scope | size |
|------|-------|------|
| `tasks/25-plan-file.md` | `orka plan` validates `plan.json` (no overlapping `owns`, acyclic `after`); `orka worker --part` fills SCOPE and enforces order. | M |
| `tasks/26-findings-file.md` | `orka note --part`, append-only capped `findings.md`, digest shows last interface/blocker lines; prompt lines. | S |
| `tasks/27-commit-per-part.md` | Worker prompt: commit owned files; orka ownership check from `git diff --name-only`, warning in digest. | M |
| `tasks/28-integrator-and-verifier-parts.md` | Integrator role in the flow; verifier gets the plan and reports owning part per failure. | M |
| `tasks/29-parallel-cap.md` | `maxParallel` per job + `MemAvailable` floor, queueing in `orka worker`. | S |
| `tasks/30-isolate-parts.md` | Opt-in per-part worktrees and orchestrator merge in `after` order. | L |

## Appendix: Matt Pocock's handoff skill

Source: https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md, fetched 2026-10-21.

```
---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
```

What orka changes: the note goes to `<jobdir>/handoff/<name>-<n>.md`, not `$TMPDIR` (it must outlive the pane and sit next to `decisions.tsv`); orka triggers it, not the user (`disable-model-invocation` does not apply, orka sends the text as a prompt); "suggested skills" becomes "next commands" (orka commands and checks to run); "reference by path" and "redact secrets" stay as they are; the argument is filled by orka with the worker's open SCOPE.

## Limen, latest source (2026-10-21)

Source: https://github.com/overment/limen, `main` at `a8cb4b0` (2026-10-21 15:06 +02:00), `package.json` `@overment/limen` 0.1.0. There are no tags or releases. The npm package named `limen` is unrelated (0.0.0, last changed 2022). I read a sparse, shallow clone of `src/`, `hook/`, `templates/` and `docs/`. Refs below are to that commit. The newest public writing is https://mega.dev/autonomous-product-development; `docs/research/overment-agents.html` covers Adam's messages from Sep 1 to Oct 20.

**a. Context limits.** Limen has none.
- No threshold, no measurement of a live context window, and no compaction prompt anywhere in the code.
- `src/job/usage.ts:20-44` (`readSessionUsage`) adds up the input, output and cache tokens of every assistant turn in `.limen/jobs/<id>/session/*.jsonl`. It only feeds the `tokens` line of `limen jobs <id>` (`src/commands/jobs.ts:371-373`). Its own comment says "This informs; it never blocks" (`usage.ts:48`).
- Compaction belongs to the engine (Pi or OMP). Limen only reacts to it: the Pi hook clears its read-recall on `session_compact` (`hook/communication.ts:105-110`).
- Rules survive compaction because they are re-attached every turn. `before_agent_start` (`hook/communication.ts:73-92`) appends the guidance to the system prompt and adds a hidden per-turn cue (`display: false`, `:84`).
- The only bounds are spend bounds, not context bounds: a detached job gets 90 minutes and 900 tool calls (`src/runtime/wrapper.ts:32-35`). "A job is one short turn" (`:32`).
- So neither "50% of the full window" nor "50% of the auto-compact point" has a Limen precedent. Limen keeps jobs short instead.

**b. Handoff format.**
- A worker's handoff is its final message. Template `templates/worker.md:40`: "changes, checks actually run, commit(s), anything you left running or outside the worktree, what the next worker must know, and any remaining slice … The worktree, branch, and `.limen/jobs/<id>/session` are the handoff."
- The coordinator gets a bounded excerpt of it in the wake (`docs/jobs.md:37`).
- Coordinator-to-worker handoffs stay short and point to files ("Use a short instruction, not a ticket dump", `templates/agents.md:150`).
- Picking up the work means `limen spawn --branch <branch>`, which reuses the job's branch and worktree (`src/commands/spawn.ts:610-631`, `docs/jobs.md:105`), or `limen continue`.
- `limen continue` **copies the transcript**: `copyFile(job.session.source, …/session/…)` (`src/job/publication.ts:177`, `docs/jobs.md:144`). Context is carried over, not reset.

**c. Coordinator.** It is never handed off or reset by Limen.
- "The coordinator is a hosted session in Herdr … It is not a limen job" (`templates/agents.md:7`). Limen never spawns or replaces a coordinator (`:17`).
- It lives on engine compaction plus the per-turn cue, and the job files are its source of truth after a reload ("Job files under `.limen/jobs/<id>/` are truth", `templates/agents.md:148`).
- For groups: "Resume the original lead session … A different session does not silently inherit lead authority" (`docs/groups.md:97`).
- Fresh context is reserved for workers and reviewers. "A reviewer is independent because it is a fresh session" (`templates/agents.md:189`). Spawning costs "a cold context" (`:185`).

**d. Collaboration.**
- Every spawned job gets its own worktree and branch (`addNewWorktree`, `src/project/git.ts:207-209`, used at `src/commands/spawn.ts:629`).
- **Workers commit**: "commit, write the final summary as the last message, then call `finish`" (`templates/worker.md:10`).
- The coordinator integrates with `limen land`, a plain `git merge --no-edit <branch>` onto its own checkout (`src/project/git.ts:255-258`, `src/commands/land.ts:44`), after it reads the diff and runs or orders review (`templates/agents.md:150-151`).
- Groups (newest version) are several teams, each on its own model, working **one ticket in rounds** (`draft`, `critique`, `revise`, `final`; `docs/groups.md:3,9-20`):
  - Each team has its own worktree (`:55`).
  - Round results are saved to `.limen/groups/<id>/rounds/<round>/team-N.md`, and every team gets every team's results in the next round (`:41`).
  - Urgent findings go through `limen group publish` (`:57-61`).
  - The `final` team writes the single result (`:20`).
  - The lead merges the branches it keeps onto one integration branch (`:101`).
  - A launch lock makes sure a round starts once (`:45`). There is no automatic merge or push (`:5`).
  - Limen does not split a task into file areas. Teams overlap on purpose and then critique each other.

**e. Changed vs the article and the Oct 17 checkout.**
- Groups were "teams pursuing the same feature through different approaches" at `3241454` (2026-10-17). Now they are **rounds with critique and one final writer**, configured as `--team ENGINE:PROVIDER/MODEL:THINKING` and `--rounds` (`docs/groups.md:3,17-20`).
- The article's "one agent each from xAI, OpenAI and Anthropic … returns one result" matches the `final` round.
- The article says "the coordinator keeps its context. It does not start again", and the code agrees: no coordinator reset.
- The article describes "merge to main, push". In the code, `land` merges only, with no push (`src/commands/land.ts`), and groups never push (`docs/groups.md:5`). Pushing is a separate step.

### Copy, adapt, skip (tied to the open questions above)

- **50% of the full window vs the auto-compact point.** Adapt. Limen has no threshold to copy, and its answer is short jobs plus spend caps. Keep orka's measure: transcript tokens ÷ full window, the same source Limen uses in `usage.ts` (Limen sums all turns; orka takes the last turn). Add Limen's tool-call/time cap as a second trigger for workers.
- **Orchestrator handoff.** Skip by default, matching Limen: the coordinator stays one session, and files are truth. Copy the per-turn re-injection in the only form orka can do portably, the digest on every steer (already built). Keep orchestrator handoff behind a flag, as proposed.
- **Workers commit their part.** Copy. Limen workers always commit, and the coordinator integrates with a plain merge. For orka's shared worktree that means "commit your owned paths" (task 27). For `--isolate` it means Limen's branch-per-job and merge-in-order.
- **Handoff note.** Copy Limen's final-message checklist (changes, checks run, commits, left running, next must know, remaining slice) into orka's handoff note. Skip transcript copying (`limen continue`).
- **Collaboration shape.** Adapt rounds later, as an option for hard design questions (draft → critique → final, results as files). Do not use rounds for ordinary splits. Skip the cabinet locks and the publish/wait protocol.
