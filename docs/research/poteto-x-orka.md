# poteto's pyramid × orka

Research only, 2026-10-22. No product code changed. Branch `research/poteto-x-orka` from `main` at `b49d0a0`. Line refs are `bin/orka.mjs` at `b49d0a0`.

The question: how to raise trust in what orka-run agents ship, using poteto's inverse pyramid (most correction effort in the codebase, then static analysis, then prose, least in human review), for orka itself and for the repos it runs (motion-lab first).

## Sources and method

- **pstack**: fresh shallow clone of `github.com/cursor/plugins`, commit `9b93e81` (2026-10-22). Every `skills/*/SKILL.md` read; `poteto-mode`, `correct`, `architect`, `recall`, `sharpen`, `in-your-own-words`, `create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, `figure-it-out`, `show-me-your-work`, `reflect`, `blast-radius`, `swarm` and `docs/harness/claude-code.md` in full. A second pass ([section 8](#8-pstack-readme--guides)) read the README, `docs/guide/`, every playbook, reference, agent, script and the benny pack.
- **The earlier pstack round** (`research/IMPROVEMENTS-pstack-limen.md`, tasks 01-15, all done) used the local checkout `/home/olaf/projects/cursor-plugins` at `c1c0a32` (2026-09-14). The skills poteto's tweet now points at did not exist then: `correct`, `sharpen`, `in-your-own-words`, `create-formal-verification-skill`, `maintain-formal-verification-skill`, `statechart`, `benchmark-checklist`, `principle-explain-the-number`, `ketchup`, `poteto-help` (`diff -rq` of the two trees). This doc covers that gap and does not repeat 01-15.
- **Also read**: `docs/research/overment-vs-orca.md` (untracked on `main`), `PLAN-usage.md` (untracked on `main`), `docs/design/context-and-collab.md` on branch `design/context-and-collab`, `docs/verify.md`, the prompts (`workerPrompt` :1158, `verifierPrompt` :1459, `orchestratorPrompt` :1572, `FEATURE_FLOW` :1517).
- **Job data**: all 125 job records under `~/projects/{diagram-framework,motion-craft,motion-lab,orca,thumb-lab,vault-audit}/.orca/jobs/` (no repo has `.orka/jobs` yet), with their `decisions.tsv`, `results/` and `notes/`. Script: [`poteto-x-orka/jobs.mjs`](poteto-x-orka/jobs.mjs).
- **Transcripts**: 839 Claude Code sessions in `~/.claude/projects/*--orca-worktrees-*` (110 orchestrator, 492 worker, 197 verifier, 40 other), role taken from the first prompt line. Script: [`poteto-x-orka/transcripts.mjs`](poteto-x-orka/transcripts.mjs).
- **Vault** (read only): `50_Knowledge/explainers/pstack-explainer.md`, `50_Knowledge/concepts/back-pressure.md`, `60_Sources/tweets/2026-09-16_loops-you-can-trust.md`.

Every number below is Measured unless it says Guessed. Classifications done by regex are labelled; their counts are approximate.

## TL;DR

1. **The prose round did not move the first-pass rate.** Verifier first-round pass was 34/51 (67%) before the 2026-10-18 pstack tasks and 30/45 (67%) after. Those tasks were almost all prompt text (layer 3). Confound: the verifier default moved to haiku for CLI jobs in the same window (task 13).
2. **Static analysis is the thinnest layer, and it is broken where it exists.** Only 12 of 95 failing verifier checks were a static gate. In motion-lab, `npm run check` with no argument fails on every commit; 22 of 33 job folders record a verifier proving that again on the base commit. `npm run lint` (motion-lab's taste lint, the one place Olaf's taste was encoded) appears in 10 of 33. The verifier prompt asks for `npm test` and `npm run check`, never `lint`.
3. **The environment is rediscovered by hand.** motion-lab worker and verifier sessions spend 14.2% of tool calls on environment probes (4.5 per session) against 5.1% (1.25) in diagram-framework, the only target with an `AGENTS.md` and a generated verification skill. 24 of 33 motion-lab job folders hand-symlink `node_modules`; 7 hit an `ELOOP` from a self-referencing link. `scripts/link-node-modules.sh` landed on 2026-10-18 and only 5 job folders mention it since.
4. **Human review is spent on taste and on regressions of approved work.** 107 steers in 30 of 125 jobs. Roughly half are taste rounds on creative output, about 10 report a regression of something already approved or passed, about 15 are environment or RAM. The motion-lab lens took five rounds (v5 to v9, "Olaf is frustrated") and its fix still lives as prose: three later steers repeat "lens untouched", and `tests/` has no check for it.
5. **Splits are mostly forced serial.** Of 49 logged split decisions, 7 are parallel; 20 cite RAM or disk, 27 cite shared files. Parallelism is not where the time goes. Intent (taste rounds) and environment are.

Top 5 recommendations are in [section 7](#7-ranked-follow-up-tasks).

## 1. pstack, one line per skill

Inputs/outputs in brackets. **New** = added since the 2026-09-14 checkout the earlier round used. All are markdown the agent reads; there is no runtime. Defaults name Cursor tools and `grok-4.7` / `claude-opus-5-5` models; `docs/harness/claude-code.md` maps them (grok becomes "inherit the session model", so multi-model steps lose their diversity in Claude Code).

**Front door and workflow**
- `poteto-mode`: routes a task to one of ~23 playbooks, copies its steps into a todo list, names the principles behind each decision [task → todo list, reply with principles cited]. 149 lines plus playbooks.
- `figure-it-out`: designs a bespoke playbook when none fits: falsifiable done predicate, phases, hypothesis loop, decision log [task → phase list, `decisions.tsv`, verdict per unit].
- `swarm`: fans out N workers on slices or a race, aggregates PASS / ISSUES / BLOCKED [brief → one report].
- `arena`: N candidates at one task, pick a base, graft the best of the losers [task → one synthesized artifact].
- `show-me-your-work`: append-only TSV decision log, audited against the transcript [run → `decisions.tsv`]. Orka already has it (`orka log`, task 04).

**Understanding and intake**
- `in-your-own-words` (**new**): one line, "restate the user's goals and the problem" [prompt → restatement].
- `sharpen` (**new**): make the task deeper, not bigger: what a top professional would add, the rawest input, the methods, what *other than you or me* would show it is right; then rewrite the prompt, leaving the user's choices open [prompt → rewritten prompt].
- `how` / `why` / `teach`: subsystem walkthrough, cited design rationale, plain explanation [question → cited explanation].
- `recall`: rebuild recent context from transcripts plus the shared record (PRs, tickets, errors) [topic + window → capsule, threads with status tags, recurring problems, next move].
- `ketchup` (**new**), `bro`: catch the user up / restate plainly.

**Design**
- `architect`: ground (how/why), sketch types and signatures with `not implemented` bodies via arena with at least two structurally different candidates, screen against design red flags, implement against the sketch, scrap on repeated friction [task → module map, types, rationale].
- `interrogate`: multi-model adversarial review, lead triages into act/consider/noted/dismissed [diff → triaged findings].
- `blast-radius`: find what a change breaks elsewhere and prove the one safety fact by running code; 5-step certainty ladder (said so, pointed at line, showed it can't happen, ran it, reproduced live) [diff → risks, cleared items, proof script].
- `statechart` (**new**): Mermaid statechart from a TLA+ model, bugs as numbered paths [TLA+ model → diagram].

**Verification**
- `create-verification-skill`: interview the repo (surface, run, drive, observe, isolate), write `verify-<app>/SKILL.md` (launch, doctor, drive, evidence, cleanup, helpers) and a feature map, then prove it end to end once [repo → project-local skill + `features/`].
- `maintain-verification-skill`: per-feature source readers plus one live session over every feature; outcome clean / changed (one PR) / blocked [skill → at most one PR].
- `create-formal-verification-skill` (**new**): pick the promise where a bug costs most and tests reach least, choose the tool (TLA+ default for orderings), show each property failing on a broken variant, leave a skill with a coverage record and a sync commit [repo → formal check + skill].
- `maintain-formal-verification-skill` (**new**): bring the model back in line after code changes; each failure is drift or a real bug [skill + commits → updated model, verdicts].
- `benchmark-checklist` (**new**), `principle-explain-the-number` (**new**): vet a measured number before acting on it.
- `tdd`: failing test first, only when cheap or asked.

**Correcting the environment**
- `correct` (**new**): mine recent commits, reverts, review comments and agent rule files for mistake classes (a class counts after two occurrences); fix each at the highest level that works: architecture, then types, then a lint whose error names the fix, then a test, docs last; prove each check fails on a real past mistake; keep a rule → enforcer table in the agent instruction file; on each new correction, a rule that was already written but not enforced is a repeat and gets fixed one level higher [repo history → one commit per class, rule table].
- `reflect`: three reviewers over the transcript, synthesizer, Accepted / Rejected / Backlog, apply only after approval; anything a lint could enforce moves to Backlog [transcript → skill edits].
- `automate-me`: turn the user's habits into a personal `-mode` skill.
- `principle-encode-lessons-in-structure`: the second time you write an instruction, encode it as a lint, flag, runtime check or script. "The instruction is the symptom."

**Writing and style**: `unslop`, `technical-writing`, `no-comments` (spawns comment-sicko), `typescript-best-practices`, `make-bot-ui`.

**Setup**: `setup-pstack` (model per role into `~/.claude/rules/pstack-models.md` in Claude Code), `poteto-help` (**new**).

**Principles**: 23 `principle-*` leaves (prove it works, fix root causes, attack the premise, model the domain, boundary discipline, type-system discipline, make operations idempotent, separate before serializing shared state, sequence verifiable units, never block on the human, guard the context window, laziness protocol, and others). One paragraph each.

pstack is not installed for Claude Code on this machine (`~/.claude/plugins` has no pstack entry). Install path: `/plugin marketplace add cursor/plugins`, `/plugin install pstack@cursor-plugins`; commands become `/pstack:<name>`. The adapter says the `Skill` tool refuses most pstack skills, so an agent reads `<pstack>/skills/<name>/SKILL.md` directly.

## 2. What the data says

### 2.1 Corpus

| repo | jobs | with verifier | verifier rounds | first-round pass | jobs steered | follow-up rounds |
|---|---|---|---|---|---|---|
| diagram-framework | 34 | 22 | 39 | 16 | 8 | 1 |
| motion-craft | 4 | 3 | 5 | 2 | 0 | 0 |
| motion-lab | 35 | 31 | 82 | 21 | 12 | 8 |
| orca | 33 | 22 | 38 | 14 | 4 | 0 |
| thumb-lab | 8 | 8 | 22 | 5 | 4 | 4 |
| vault-audit | 11 | 10 | 14 | 6 | 2 | 0 |
| **total** | **125** | **96** | **200** | **64 (67%)** | **30** | **13** |

Status: 107 done, 6 failed, 10 stopped, 2 running. 4 failures were `agent name ... is already used` at start. Duration (started to finished, n=117): median 29 min, p90 270 min. Builders per job: median 2; 5 jobs used 18 to 37 builders (long multi-round creative jobs).

### 2.2 Verifier rounds and what fails

- 200 rounds over 96 jobs (mean 2.08): 131 pass, 62 fail. 38 jobs failed at least once. 13 jobs passed round 1 and then ran more rounds because a steer or follow-up reopened them.
- `verifier.stall` is null in all 125 records. 11 jobs logged 1 to 4 `orka strategy` changes.
- `orka verify`: skipped 83, passed 13, failed 14, absent 15. Only diagram-framework has an `orca.verify.json`.
- Before vs after the 2026-10-18 tasks: 34/51 vs 30/45 first-round pass. After 10-18, 41 of 48 jobs used the structured brief and 36 logged decisions, so the prompt changes were in effect. They did not change the rate. Confounds: haiku became the CLI verifier default in the same window, and the job mix shifted toward motion-lab renders.

Failing check names, 95 entries, 87 distinct (regex classes, approximate):

| class | count | examples |
|---|---|---|
| research / doc accuracy, citations | 26 | `motion-lab-citation-numbers`, `C-beat-arithmetic`, `summary-8-12-sentences` |
| CLI behaviour acceptance (orca repo) | 19 | `ac1-ready-gate-slow-agent` (twice), `ac2-delivered-only-when-working` |
| other | 18 | `check-all-sound-rules`, `webhook-payload-fields` |
| static gate (`npm test`, `npm run check`, `orka verify`) | 12 | `npm-test`, `orca-verify` |
| visual fidelity (stills, shapes, seams) | 11 | `arm-attachment-visual` (twice), `anim-loop-seam-visual` |
| framing, frame fill, width | 9 | `acceptance-terminal-width-65-80`, `acc-2-width-65-80`, `width: framings 65-80 % of frame`, `act1-frame-fill`, `sibling-fidelity-frame-fill` |

Framing recurs across two repos and three wordings of one rule ("65-80% of frame"). By `correct`'s rule (a class counts after two) it is a lint candidate, not a verifier judgement.

### 2.3 Human corrections (steers)

107 steers in 30 jobs. Classification by regex then hand-checked; boundaries are fuzzy, so treat these as approximate:

| kind | ≈ count | what it looks like |
|---|---|---|
| taste / direction on creative output (incl. briefs relayed as follow-up rounds) | 55 | "too simple, wants dark", "the head looks fake", thumbnail rounds 2-6 |
| environment, RAM, disk, lost prompts | 15 | "VPS memory pressure", "/tmp is freed now", ".env is gitignored so it is not in your worktree" (twice), "the builder never received its task" |
| approval or lock of a result | 12 | "approved agent-setup-v4 ... FREEZE", "Olaf approved the v9 lens" |
| regression of approved or passed work | 10 | R5 timeline blocks "became thin unlabeled slivers", lens digits missing (v5), still broken (v6, v7), "was ALREADY correct in v2" (v7), blurred (v8) |
| plan or scope change | 8 | "go with React", "drop the timeline entirely" |
| plumbing | 7 | "orca steer cannot deliver to its own pane" (6 in one job) |

- 26 jobs were steered after a verifier pass.
- The lens case: commits `453f076` (v7) → `7b5b5df` (v8) → `072090e` (v9) in motion-lab; v9 found the cause ("stacked under/shade copies + film grain + head bitmap resampling"). After that the protection was prose: 3 later steers say some form of "lens code untouched". `grep -ril lens tests/` is empty.
- Taste was encoded once and it worked as structure: Olaf's "think as a director" steer led to motion-lab's taste lint (`README.md` "Taste lint", `npm run lint` = `tsc --noEmit` + `motion lint --all`, errors on missing treatment, glow, soft shadows). The harness then does not run it (2.4).

### 2.4 Environment rediscovery

Environment probe = a Bash call matching `which`, `--version`, `ls ~/bin`, `npm install`, `ln -s ... node_modules`, `ls node_modules`, `free -m`, `df -h`, `nproc`, `PATH=` (proxy; some probes are legitimate, and motion-lab steers *ordered* `free -m` checks).

| repo (workers + verifiers) | sessions | probes / session | share of tool calls | sessions with ≥1 probe | AGENTS.md | verify skill |
|---|---|---|---|---|---|---|
| motion-lab | 250 | 4.48 | 14.2% | 87% | no | no |
| motion-craft | 16 | 3.81 | 24.9% | 63% | no | no |
| thumb-lab | 87 | 1.32 | 5.6% | 72% | no | no |
| diagram-framework | 156 | 1.25 | 5.1% | 59% | yes | yes (`.agents/skills/verify-diagram-framework/`) |
| orca | 92 | 1.18 | 8.4% | 54% | no | no |
| vault-audit | 128 | 1.08 | 3.4% | 58% | no | no |

Orchestrators probe too: 21% of their tool calls, median 4 per session.

motion-lab specifics, from job `notes/` and `results/` (33 job folders):
- 24 mention a `node_modules` symlink or its absence; 7 mention `ELOOP` / a symlink loop; commit `0a3e76e` fixed one ("216 = ELOOP on PATH (main node_modules self-loop)").
- 22 record `npm run check` failing with no clip argument (`clip not found: clips//clip.ts`, `package.json` script `"check": "node bin/motion.mjs check"`). Each verifier re-proves it on the base commit; `cartoon-r10-render` did it by `git archive` of the base plus a linked `node_modules`.
- `scripts/link-node-modules.sh` (commit `9f5888b`, 2026-10-18) exists. Symlink mentions continue after it (8 folders on 10-19, 7 on 10-20); 5 folders mention the script. It is encoded but not wired: someone has to remember to run it.
- `PLAN-usage.md` (2026-10-13) measured the same thing on one day: 5 to 11 of 22 to 41 turns per fresh motion-lab session rediscovering that node and ffmpeg live in `~/bin`.

### 2.5 How goals get split

- 26 of 125 goals are a pointer to a brief file (`Follow .orca/briefs/<x>.md`), usually written by Olaf's Grok Bot layer. The orchestrator reads it and splits immediately. There is no intake step that restates the goal or names a done predicate; the prompt goes straight to "Split the goal into the smallest set of worker tasks" (:1579).
- Signals the prompt gives for splitting: smallest set of tasks, parallel when independent, never two workers on the same files (:1579-1581), brief format GOAL / SCOPE / CONTEXT / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT (:1594). Ownership is prompt text; nothing checks it.
- 49 `split` rows in 36 logged jobs: 17 single worker, 20 sequential chains, 7 parallel, 5 other. Reasons cited: shared files 27, RAM/disk 20, "the brief mandates" 12.
- RAM is handled by steers (3 memory steers in `grok-bot-story`, "at most 2 workers at once, one render at a time, check free -m") and by worker judgement, not by orka. The collab design (`tasks/29-parallel-cap.md`, proposed) would move that into code.

## 3. The pyramid mapped to orka

| layer | poteto's mechanism | orka today | gap the data shows |
|---|---|---|---|
| 1. Codebase and environment | one owner per piece of state, one supported way, delete the old way; worktree isolation per agent | one worktree per job, ports per job, process tags, reaping, patch-id guard, prompt-delivery retries (all enforced in code) | the worktree is not runnable as created: no `node_modules`, no `.env`, tools off `PATH`. Every agent repairs it by hand (2.4). |
| 2. Static analysis | lint whose error names the fix, tests that fail on a real past mistake, CI, formal checks; context-efficient output | `orka verify` (browser JSON steps, fail-closed), `--base` comparison; the verifier *is asked* to run `npm test` and `npm run check` | gates live inside an LLM prompt, not in the CLI; broken gates are re-proved per job (22×); the one encoded taste lint is not run; no per-repo gate list; no cache of base results |
| 3. Prose | minimal AGENTS.md, skills, a rule → enforcer table, generated verification skill | long prompts in `bin/orka.mjs`; `orca.features.md`; no AGENTS.md in 5 of 6 targets (and not in orka); diagram-framework has a generated verify skill and its `orca.verify.json` `note` field has grown to 8.3 KB of prose | rules repeat in steers (lens ×3, RAM ×3, `.env` ×2) instead of becoming structure |
| 4. Human review | spend it designing the environment; correct → encode | `orka steer`, follow-up rounds | 107 steers, none turned into a check by orka; approvals are not recorded, so approved work regresses |

## 4. Area A: request → orchestrator → workers

### Today

The orchestrator gets the goal and the split rules above, starts workers with the 8-field brief, logs `split` rows, and routes verifier failures to the owning builder. Efficiency in numbers: median 2 builders, 2.08 verifier rounds per verified job, 67% first-round pass, 30 of 125 jobs needed human steers, 13 needed follow-up rounds. The rework that hurts most is not a bad split; it is a misread intent (taste rounds) and a broken environment.

### A poteto-style version

1. **Intake (sharpen + in your own words), always on, cheap.** Before splitting, the orchestrator writes `<jobdir>/intent.md`: the goal restated in its own words; the done predicate as something falsifiable; what other than the agents would show it is right (a reference image, a command, a number, a test); and the choices it is leaving to Olaf. It does not wait for approval (never-block-on-the-human); the intent goes into the first status line and the finish wake. For creative jobs this is the cheapest place to ask for the oracle: the lens rounds converged only once `reference/lens-target.png` existed (v8 steer). Guessed effect: fewer taste rounds per job; measure it.
2. **Architect step, opt-in (`--architect`), for code jobs that cross a module boundary.** Output is the collab design's `plan.json` (parts, `owns`, `after`), plus per part: acceptance and the gate that proves it. That makes the plan the contract the verifier and the ownership check read. pstack's "design it twice" (two structurally different sketches) can run single-model in Claude Code; the multi-model arena cannot without non-Claude runners. Skip for renders, research and one-file changes: 37 of 49 logged splits were single or sequential anyway.
3. **Split on resources in code, not in steers.** `maxParallel` and a `MemAvailable` floor (collab `tasks/29-parallel-cap.md`) remove the RAM steers and the "RAM limit allows one builder" reasoning that 20 split rows spend.
4. **Measure the split, not just the verdict.** Add per job: rounds, first-round pass, steers, post-pass steers, probe share. The scripts in `poteto-x-orka/` already compute them from existing records; an `orka stats` command makes it a number Olaf can watch (build-the-lever, explain-the-number).

## 5. Area B: quality and verification

### B1. Gates before the verifier (layer 2, enforced by the CLI)

`.orka/config.json` gets `"gates": ["npm run lint", "npm test"]` (per target repo). After builders report and before the verifier starts, orka runs each gate in the worktree, stores exit code and the last lines of output under `results/gates/`, and on failure runs the same gate once at `baseCommit`, caching the base result by `(baseCommit, command)`. A gate that fails on the base is a warning, proved once, not re-proved every round. A gate that fails only on the branch goes back to the builders without spending a verifier. The verifier prompt then says "gates already ran, see the digest" instead of "run npm test and npm run check" (:1491).

Why first: it moves the static layer out of an LLM's judgement, removes the 22× re-proof in motion-lab, and wires in the taste lint that Olaf already paid for.

### B2. A runnable worktree (layer 1)

`.orka/config.json` gets `"setup": ["scripts/link-node-modules.sh"]` and `"env": ["ORKA_ENV_FILE=../../.env"]`-style pointers (shape open). `orka run` executes setup in the new worktree and records the result. `orka doctor <id>` is a read-only check (tools on `PATH`, `node_modules` resolves without a loop, `.env` reachable, `MemAvailable`, free disk), run at start and printed in the first digest. This is pstack's "Doctor" section from `create-verification-skill`, owned by the harness instead of each agent.

### B3. One verification skill per target repo (layer 3, but generated and proven)

Run `create-verification-skill` once per repo as an orka job (playbook `investigation` is wrong for it; it builds and proves). Output: `.agents/skills/verify-<repo>/SKILL.md` + `features/`. The verifier prompt reads it when present. diagram-framework already has one and has the lowest probe share among the repos with heavy UI work. Decide whether `orca.features.md` folds into the skill's `features/` (one map, not two). `maintain-verification-skill` runs as a periodic job, or when the feature map's staleness guard finds many stale entries.

### B4. Evidence tiers

Adopt the overment doc's recommendation 3 with blast-radius's ladder as the tier names: claimed, pointed (file:line), reasoned, ran, reproduced live. UI and bug-fix jobs require "reproduced live" for their acceptance checks. This makes a pass say how far it was proved; the lens v5-v8 passes were judged "from stills only" (the r10 verifier says so in its summary).

### B5. Approve and lock (layer 1 for taste)

`orka approve <id> <path...> [--note "..."]` records a content hash (and for images, a reference crop) of what Olaf approved, in a committed `orka.approved.json`. Gates check that approved paths are unchanged unless the brief says `UNLOCK: <path>`. 12 approval steers and about 10 regression steers are the evidence. This turns "lens code untouched from ef45442" from a sentence into a check whose error names the fix.

### B6. Correct the environment, not the reply

When a job ends with steers, orka proposes a **correct pass** (a separate job, `--playbook correct`, using pstack's `correct` text as the brief). It reads the job's steers, verifier failures and decisions, groups them into classes, and for each picks the highest level that works:

| steer class | level | owner | example from the data |
|---|---|---|---|
| environment | 1, orka config (`setup`, `gates`, caps) or orka code | orka repo, Olaf merges | `.env` not in worktree; `node_modules` loops; RAM |
| regression of approved work | 1, `orka approve` lock or a golden test in the target repo | target repo job branch | lens v5-v8 |
| recurring acceptance rule | 2, lint in the target repo whose error names the fix | target repo job branch | framing "65-80% of frame" (3 wordings, 2 repos) |
| broken or missing gate | 2, fix the script | target repo | `npm run check` with no argument |
| judgement or taste | 3, a decisions file the brief points to | Olaf writes, agents read | "no plot, a camera journey", "no 4K" |
| plumbing | orka bug | orka repo | steer cannot deliver to its own pane |

Every fix lands on a branch; nothing is merged without Olaf (consistent with "you decide what to merge"). The target repo's `AGENTS.md` keeps pstack's rule table (`rule | enforced by`); a rule whose enforcer column is empty and that shows up again is a repeat and goes one level up. Who: the correct job's worker writes the change, a verifier proves the new check fails on the real past mistake (pstack's "prove each check fails on a real past mistake"; for the lens: the v5 commit), Olaf merges.

### B7. Formal verification, for orka itself only

orka's own bugs are orderings: watchers leaking (task 12), prompts lost at start (task 11), name reuse at start (4 failed jobs), steer to a done pane (6), stale verdicts (task 01). That is the case `create-formal-verification-skill` describes (TLA+ over the job / worker / watcher lifecycle). Large, and worth it only after B1-B6. Not for target repos.

## 6. pstack skills: ship, invoke, or point

orka should not depend on pstack being installed. Where it uses a skill, it either embeds a short adapted text (with attribution, as `RESEARCH_REPORT` does) or tells the agent the absolute path of `SKILL.md` when the plugin exists.

| skill | where | how | why |
|---|---|---|---|
| `in-your-own-words`, `sharpen` | orchestrator intake | ship: ~6 adapted lines in `orchestratorPrompt` | tiny, no tooling; feeds `intent.md` |
| `correct` | post-job correct pass (`--playbook correct`) | ship an adapted brief; cite the source | the core of "correct the environment" |
| `create-verification-skill` | once per target repo, as a job | invoke by path (`Read <pstack>/skills/create-verification-skill/SKILL.md`); fall back to an embedded summary | heavy, repo-specific output, proven once |
| `maintain-verification-skill` | periodic job | invoke by path | upkeep of B3 |
| `architect` | orchestrator, `--architect` only | point; embed only "two structurally different sketches, screen red flags" | full skill needs arena and non-Claude runners |
| `blast-radius` | verifier on orka-repo jobs, optional | point; reuse its certainty ladder for B4 | the ladder is the useful part |
| `recall` | audit playbook (overment rec 4) | point | orka's own records beat transcript mining for jobs |
| `create-formal-verification-skill` | orka repo only (B7) | invoke by path, later | orderings are orka's real bug class |
| `show-me-your-work` | already shipped as `orka log` | done | |
| `poteto-mode`, `figure-it-out`, `swarm`, `arena`, `interrogate`, `reflect` | none | point Olaf to them for interactive work | Cursor-shaped routing, multi-model defaults, too big for a pane prompt. Section 8.3 takes four mechanisms from the `orchestrate` and `autopilot` playbooks, not the skills |
| `unslop`, `technical-writing`, `no-comments` | none | skip | Olaf's own style rules cover this |

## 7. Ranked follow-up tasks

Names, not numbers: `tasks/16-*` to `tasks/30-*` are already claimed by the collab design and the overment doc.

| rank | task | one line | size |
|---|---|---|---|
| 1 | `gates-before-verifier` | `gates` in config; orka runs them after builders, caches base results per `(baseCommit, command)`, digest shows them, verifier stops re-running them | M |
| 2 | `worktree-setup-and-doctor` | `setup` commands run in each new worktree; `orka doctor <id>` read-only health check at start and in the digest; a verifier `blocked` outcome that goes to the environment, not the builders | S-M |
| 3 | `motion-lab-correct-pass` | prototype the correct loop by hand on motion-lab: AGENTS.md with a rule table, fix `npm run check` no-arg, wire `link-node-modules.sh`, lens golden crop test that fails on `453f076`, framing lint for the 65-80% rule | M |
| 4 | `approve-and-lock` | `orka approve <id> <paths>` writes hashes to `orka.approved.json`; gates fail on change without `UNLOCK:` in the brief | M |
| 5 | `intake-and-standing-orders` | orchestrator writes `intent.md` (restatement, falsifiable done predicate, external oracle, choices left open) before splitting; `.orka/standing.md` per repo, appended by `orka steer --standing`, pasted by orka into every worker and verifier brief and follow-up round | S |
| 6 | `orka-stats` | per-repo and per-week: rounds, first-pass rate, steers, post-pass steers, probe share, from existing records (port of `poteto-x-orka/*.mjs`) | S |
| 7 | `correct-playbook` | `--playbook correct` built from what task 3 learned; orka offers it when a job ends with steers | M |
| 8 | `verify-skill-per-repo` | one job per target repo runs `create-verification-skill`; verifier reads `.agents/skills/verify-*/` when present; decide on folding `orca.features.md` | M |
| 9 | `evidence-tier` | overment rec 3, with blast-radius's ladder as tier names | S-M |
| 10 | `steer-to-done-pane` | `orka steer` to a job whose orchestrator is done reopens the round instead of failing (6 failures in one job) | S |
| 11 | `parallel-cap` | collab `tasks/29`; removes RAM steers | S |
| 12 | `plan-file-from-architect` | collab `tasks/25` with `--architect` producing it; code jobs only | M |
| 13 | `formal-model-of-job-lifecycle` | TLA+ model of job / worker / watcher / done, via `create-formal-verification-skill` | L |

**Top 5, with the reason:**

1. **`gates-before-verifier`**: the clearest layer-2 gap with numbers behind it (12 of 95 failures static, 22 re-proofs, lint run in 10 of 33). It is a CLI change, so it does not depend on prompt compliance, which section 2.2 suggests does not move outcomes.
2. **`worktree-setup-and-doctor`**: 3.6× the probe share in motion-lab versus diagram-framework, 24 hand symlinks, 7 `ELOOP`s, two `.env` steers. The fix script already exists and is not wired. Revised after section 8: add a `blocked` verifier outcome (pstack's `verifier-blocked`), so an environment failure goes to the doctor instead of to the builders as a code failure.
3. **`motion-lab-correct-pass`**: poteto's advice is to prototype rather than defer; doing `correct` by hand once on the repo with the most rework (82 verifier rounds, 12 steered jobs) shows what the playbook should contain before orka encodes it.
4. **`approve-and-lock`**: the only proposal aimed at the human-review layer's biggest waste, regressions of work Olaf already approved.
5. **`intake-and-standing-orders`**: smallest change, aimed at the largest steer class (taste and intent). Revised after section 8: it also carries pstack Orchestrate's standing orders, because today a steer reaches only the orchestrator pane and is lost by the next job, and the same constraints come back as new steers (lens, RAM, `.env`). Ship it with `orka-stats` so its effect is measured, not assumed; for the prompt part, measure with an eval rerun of past jobs (P26) rather than before/after rates.

## 8. pstack README + guides

A second pass on the same commit `9b93e81`. The first pass read every `skills/*/SKILL.md` and `docs/harness/claude-code.md`. It missed everything else: `README.md`, the 11 pages of `docs/guide/`, the 23 `poteto-mode/playbooks/*.md` (it read only the `poteto-mode` SKILL.md that routes to them), `poteto-mode/references/bugbot-triage.md`, the 32 `references/` files under other skills, `agents/` (2), the `automations/benny/` pack (its 3 SKILL.md files plus references and templates), and the scripts (`orch/orch.ts` + `store.ts`, `check-plan.mjs`, `watch-pr/`, `worktree-audit.sh`, `show-me-your-work/scripts/log.sh`, `statechart/scripts/`). All of them are read here. The why-source playbooks, the TypeScript patterns and the statechart internals were skimmed, because they do not bear on orka.

### 8.1 One line per doc

**README and guide**
- `README.md`: install (`/add-plugin pstack`; Claude Code: `/plugin marketplace add cursor/plugins`, `/plugin install pstack@cursor-plugins`, commands become `/pstack:<name>`), then two steps: `/setup-pstack`, then `/poteto-mode` for anything that needs rigor. Code delegates go to grok and judgment to opus by default. "i don't believe in planning. the best spec is code." Claude Code installs a generated copy from `harness/pstack/`.
- `guide/README.md`: if you remember one thing, give the agent a goal and a way to check it.
- `01-setup.md`: `/setup-pstack` picks a reasoning budget and a model per role. At the end it offers once to run `create-verification-skill` if the repo has no `verify-*` skill or harness ("of everything in this guide, the verification skill pays off the most"), then offers `create-formal-verification-skill` for concurrency, retries, state machines and parsers.
- `02-poteto-mode.md`: a prompt carries up to five things (goal, a done check that can fail, the proof to show, what you know, real constraints). Leave out the how and your theory of the cause. For a noisy report the first step is a restatement. "new task" re-routes. Give parallel agents their own machine (cloud) or worktree.
- `03-understand.md`: read before editing. Investigation (read-only), `/how`, `/why`, `/teach`, `/recall`, Session pickup ("the prior trail is authoritative").
- `04-design.md`: `/architect` (it runs `/arena`), `/arena` vs `/swarm` (arena repeats one brief and grafts; swarm partitions slices or race arms), `/interrogate` on a diff, never on an abstract plan. Prototype instead of debating. Write the README first for shared code. Plan last, after the design settles. A ladder of how much design a task deserves; most changes need none.
- `05-build-and-clean.md`: prompt each build playbook with what you observed. `/tdd` only with a cheap test path. Clean the diff before commit (`/deslop`, `/unslop`, `/no-comments`, the last by a reviewer that did not write the comments).
- `06-verify-and-ship.md`: state the finish condition up front; match the check to the change (CLI runs the real command, UI walks the flow, perf compares profiles). Create the verification skill and treat it as infrastructure: commit it, then build a control CLI (few composable commands, `--dry-run`, errors that say what to do, JSON output) and one command that brings the environment up the same way every time. Run `/maintain-verification-skill` at least daily from a scheduled automation. Formal verification for promises tests rarely reach. Open the PR, Babysit to merge-ready, Shipping lands only the contiguous verified run, and "the agent that judges a change is never the one that wrote it".
- `07-overnight.md`: earn trust before the loop (did it once by hand, the agent has your tools, every stage proves its work and can stop the line, repeated failures turned into tools). The overnight contract: goal, done predicate, permissions, escape hatch. One change, one check, one log row per iteration. Morning audit through `/show-me-your-work` with a cross-model reviewer and an Attention section. Queues go to Autopilot-full or Autopilot-stack; programs to Orchestrate. Cursor Projects: one persistent coordinator thread per body of work, cloud subagents. Automations: every stage can stop the line and hands over evidence. A duration is not a finish condition.
- `08-principles.md`: steer with principle names; a citation without the decision it changed means the rule was named, not applied.
- `09-make-it-yours.md`: start small, add a skill or check when a failure shows up twice. `/automate-me`, `/reflect` (approve only what changes a future decision), `/correct` (architecture, types or lint, test, docs last; "human review isn't on the list"). Test a skill change blind with the Eval playbook. Never edit a skill mid-task.
- `10-recipes-and-pitfalls.md`: recipes plus 14 pitfalls, the ones relevant to orka: a vague finish condition, parallel agents in one worktree, looping before you trust the loop, reporting success off a green build, correcting the same mistake by hand.

**Playbooks** (`skills/poteto-mode/playbooks/`)
- `orchestrate`: a standing coordinator that never writes code; `preferences.md` standing orders pasted verbatim into every spawn and resume; the 9-field brief (orka's 8 plus `STANDING`); a pilot unit before fan-out; continuous landing; a verdict ledger keyed by PR + head SHA; liveness from side effects; retry by failure mode; escalation batched into `gates.md`. Detail in 8.3.
- `autopilot-full`: one owner per PR carries it from build to merge; a swarm that never wrote the code verifies the code-ready head; a minor fix or rebase gets a single verifier, only new behavior gets a new swarm; a `/loop 1h` audit tick judges every agent by side effects against a stuck-after runtime taken from past runs of its kind.
- `autopilot-stack`: the same owners, but the root alone owns chain topology and the operator lands.
- `autonomous-run`: a predicate first, then a wake mechanism (watcher on an event, heartbeat fallback), the smallest change per iteration, revert what didn't help, never relax the predicate.
- `shipping`: one fresh verifier per PR (`PASS`, `PASS+NOTES`, `FAIL`); land the contiguous verified run from the bottom; `git patch-id` decides whether an older verdict still covers a rebased head.
- `multi-phase-plan`: the plan is the deliverable, checked by `check-plan.mjs`. Every PR section has unit, live (ten lanes, one a regression lane against trunk) and perf boxes. "Tests alone are not sufficient verification."
- `babysit`: one babysitter per stack, work the lowest unmerged PR only, conflicts then threads then CI, classify CI before any retry (one retry; an identical second failure is not flake), triage bot comments skeptically.
- `opening-a-pr`: worktree off main, small ordered commits, a one-minute PR body (Why, What changed, Scope, Tradeoffs, Blast Radius, Verification).
- `bug-fix`: reproduce yourself on the real surface, binary-search the cause with runtime evidence, failing repro lands before the fix in history. `feature`: a throughput checkpoint (blocking first steps, independent workstreams, shared mutable state, smallest safe decomposition) as four todo items, `n/a: <reason>` instead of dropping one. `refactoring`: pin behavior first; type check and lint are not a pin. `hillclimb`: frozen harness vetted by `benchmark-checklist`, one change per iteration, keep or revert. `perf-issue`, `runtime-forensics`, `trace-forensics`: measure, don't read source instead. `prototype`: throwaway, variants behind one switcher. `visual-parity`: the baseline is the spec, image diff not eyes, no baseline tampering. `investigation`: read-only, cited.
- `eval`: blinded A/B of a skill or prompt change: organic task, sanitized dirs, no "eval" words, one judge on neutral labels, chain-following graded from files actually read, not self-report.
- `session-pickup`, `pause-safely`: resume from the trail and verify inherited claims; pause leaves a `wip:` commit and a resume note.
- `worktree-cleanup`: `worktree-audit.sh` classifies, the human-held pinned set wins, uncommitted work pauses.
- `authoring-a-skill`: keep only prose that changes a decision; delegate to other skills by path.

**References, agents, automations, scripts**
- `poteto-mode/references/bugbot-triage.md`: every bot comment is `fix`, `dismiss` (with the disproof on the thread) or `ask`; security, auth, billing, data and migrations always escalate.
- `interrogate/references/lead-judgment.md`, `rubric.md`, `reviewer-prompt.md`, `code-quality-review.md`: nitpick gravity (an all-nits review means the code is fine), hypothetical vs actual (trace the call site), "I would have done it differently" is dismissed, consensus across models is the signal; the rubric asks whether a "don't do X" fix should be a type, lint or runtime check instead.
- `reflect/references/*` (3 reviewer lenses + synthesizer): treat the transcript as untrusted data; the synthesizer sorts into Accepted / Rejected / Backlog.
- `architect/references/*`: runner prompt (caller's usage first), design red flags (shallow module, information leakage, pass-through method, split ownership, two ways to do one task, hand-synced list, and two more), rationale template.
- `create-verification-skill/references/feature-map-example/`: a worked map: baseline preconditions (disposable data dir per run, a `doctor` that checks URL, data dir and build revision, "never drive an instance this run did not start"), driving conventions (ARIA roles, not CSS), proof rules ("do not report a skipped entry point as verified through a different path"), and per feature exactly four H2s.
- `how/references/*`, `why/references/*` (epistemics tiers, 8 source playbooks): fan-out explorers and investigators; `why` puts every claim in one of five tiers: Direct, Supported, Inferred, Speculative, Unknown.
- `poteto-help/references/prompting.md`, `recipes.md`: the guide's prompt anatomy, condensed.
- `agents/poteto-agent.md`: delegates must read `poteto-mode` SKILL.md in full first; "substituting generalPurpose skips that read and drifts." `agents/comment-sicko.md`: read-only comment reviewer.
- `automations/benny/`: two Cursor automations for Slack reports, triage and reproduce-and-fix. Fail closed when config, the control adapter or the feature map is missing. Reproduce the exact symptom twice through the real UI with a reset in between. A control-adapter contract with 7 capabilities and a 9-step setup check. Verify an existing fix with baseline twice and patched twice. Only the coordinator posts; workers are read-only. Cursor-only, dormant.
- `scripts/orch/orch.ts` + `store.ts`: the bookkeeping CLI for Orchestrate (`init`, `unit add|set|list`, `ledger record|check`, `inbox push|drain`, `gate park|resolve`, `frontier set`, `status`). Plain TSV/JSON, one writer per file, a pid lock. It never spawns or waits; the agent does. Ledger verdicts: `live-ui-verified | unit-test-verified | type-check-only | verifier-blocked | verifier-failed`.
- `check-plan.mjs`: a lint for plan files (required headings, box blocks, the verification sentence). `show-me-your-work/scripts/log.sh`: appends a TSV row and neutralizes spreadsheet formulas. `statechart/scripts/`: TLA+ ↔ Mermaid, TLC per invariant.

### 8.2 What changes in the proposals

| topic | what the docs add | effect on this doc |
|---|---|---|
| Install and setup | Setup ends with a one-time offer to generate the verification skill, then the formal one. Claude Code installs a generated harness copy; models are per role in `~/.claude/rules/pstack-models.md`. | B3 gets an entry point: the first `orka run` in a repo with no `.agents/skills/verify-*/` prints a one-time offer to start the verify-skill job (P28). Open question 7 stands: orka should still embed the 3-4 texts rather than require the plugin. |
| Recommended order | understand (how, why) → design (architect, prototype; plan last) → build → clean → verify → PR → babysit → ship; overnight only after trust; correct and eval to make it yours. | Matches section 4's intake → architect → split. One correction: pstack reviews diffs, not plans ("adversarial review of a plan with no code invents risks"). The `--architect` step (rank 12) should settle open questions by prototype and send `interrogate`-style review to the diff, not to `plan.json`. |
| Projects | One persistent coordinator thread per body of work; cloud subagents keep running with the laptop closed. | orka's unit is a job (median 29 min, p90 270 min). Multi-day programs are what Olaf's Grok Bot layer does today when it writes `.orca/briefs/`. No program layer for orka now. |
| Healthchecks and routines | Doctor sections in the verify skill; a feature-map doctor that checks URL, data dir and build revision; benny's 9-step adapter setup check before anything is enabled; `maintain-verification-skill` daily from a scheduled automation; Autopilot's `/loop 1h` audit tick. "Routines" in pstack means Cursor Automations, which the Claude Code adapter skips. | B2 (`orka doctor`) gets a concrete checklist: tools on PATH, `node_modules` resolves, `.env` reachable, RAM/disk, and "the app this run started is the one being driven". B3's maintenance runs as a cron'd `orka run` (Olaf's VPS has cron; Cursor routines don't apply). A stuck check for orka's own panes (P24). |
| Verification skills, created and kept up | Generated from the repo, proven end to end once before handoff; committed as infrastructure; then a control CLI so agents stop writing throwaway scripts; maintained daily; `maintain` never edits product code and reports a product regression instead of hiding it with a doc edit. | B3 unchanged in shape. Add: a control CLI is the lever once agents keep re-scripting the same drive (motion-lab's render commands are a candidate). The maintain job's output is one PR confined to the skill's directory. |
| Formal verification | Pick the costliest promise tests rarely reach; show each property failing on a broken variant; record the covered code and the commit; maintain after refactors. Statecharts make it readable for non-specialists. | B7 unchanged: orka itself only, after B1-B6. |
| Reviewing work | The judge is never the author; verify each unit on its current head (patch-id); a verdict says how far it was proved; `verifier-blocked` is not a pass and is not `verifier-failed`; scale verification to the unit ("a verifier agent whose entire product would be rerunning one command is ceremony"); audit lanes distrust the PR body; bot and human comments are triaged fix / dismiss / ask; nitpick gravity. | Three edits. (1) B4: use the ledger's verdict names, not blast-radius's ladder (P23). (2) A new `blocked` verifier outcome that routes to the environment, not to builders (P21); today `verifierPrompt` says "Inconclusive or could not test is a fail" (:1483). (3) B1: when a job's VERIFY is only gates, orka runs the gates and skips the verifier (P22). |
| Measuring a prompt change | The Eval playbook: same task, blinded variants, one judge, chain-following from files read. | TL;DR 1 and open question 5 compared rates before and after a date, with a model change mixed in. The fair test is an eval: rerun 3-5 past jobs from their base commit under prompt A and B with the verifier model fixed (P26). |

### 8.3 Orchestrators and multi-agent work: what to copy

pstack prescribes three multi-agent shapes: **Orchestrate** (a program under one standing coordinator), **Autopilot-full / -stack** (a queue of PRs, one owner each, a verifier swarm), and the leaf tools **swarm** (partition and aggregate) and **arena** (same brief N times, graft). `poteto-mode` routing is the front door that picks among them. Mapped onto orka's three roles:

| pstack mechanism | orka role | orka today | copy? |
|---|---|---|---|
| Standing orders (`preferences.md`): numbered constraints pasted verbatim into every spawn and resume; "when you catch yourself restating an instruction, append the line before you act" | orchestrator → every worker and verifier | `orka steer` sends a message to the orchestrator pane and stores it in `job.steers` (:2266-2291). No prompt reads it back, and nothing carries it to the next job on the same repo. Constraints repeat: "lens untouched" ×3, RAM ×3, `.env` ×2 (2.3). | **Yes.** `.orka/standing.md` per repo; `orka steer --standing` appends a line; orka (not the orchestrator) pastes it into every worker and verifier brief and every follow-up round. The correct pass (B6) promotes lines to checks and deletes them. Folded into top-5 item 5 (P20). |
| The brief: GOAL / SCOPE / CONTEXT / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT / STANDING; "missing fields are a refuse-to-spawn condition"; size the brief to the unit | orchestrator → worker | Same 8 fields (:1594); a missing field is a warning (:1956), "starting anyway". | Add STANDING (above). Keep the warning: refuse-to-spawn would fail the 1-line units pstack itself collapses. |
| Coordinator never writes code; one writer per branch; workers never rebase or merge | orchestrator, worker | Prompt rules plus one worktree per job; ownership by files is prompt text (2.5). | Already the shape. Nothing new. |
| Verification scaled to the unit; verifier on a different model family; ledger keyed by head SHA; `blocked` ≠ `failed`; a new head voids the row | verifier | One verifier per round, Claude-only (haiku for CLI, sonnet for UI); patch-id staleness on the verdict (:1320-1370); inconclusive = fail. | **Partly.** Head-SHA keying exists. Add `blocked` (P21), the verdict names (P23), and skip-verifier-for-gates-only (P22). Family diversity is not available in a Claude-only orka; the nearest substitute is a verifier model different from the worker's, which the haiku/sonnet defaults already give. |
| Liveness by side effects, stuck-after runtime from past runs of the same kind; never resume an agent to check on it | orchestrator (or orka's watcher) | `verifier.stall` is null in all 125 records (2.2). | **Yes, small.** Compute p90 runtime per role and repo from job records; the watcher flags a pane with no commit, result file or decision row past it (P24). |
| Retry by failure mode (cap or OOM: smaller scope; network: as is; tool error: other model; unknown: once; two retries then abandon) | orchestrator | 6 failed, 10 stopped of 125; 4 failures were agent-name reuse (P15). | **Yes, as prompt text plus P15.** OOM → smaller scope matches the RAM steers. |
| Pilot one unit end to end before fan-out; land by ~70% of the budget | orchestrator | 7 of 49 splits are parallel. | **No.** With so little fan-out, a pilot is the first sequential unit already. |
| Inbox drain, `units.tsv`, `frontier.json`, sub-coordinators, rolling window of ~10 children, cloud workers | orchestrator | n/a | **No.** It is built for dozens to hundreds of cloud agents. Olaf's VPS has 7.6 GB and splits are forced serial by RAM (20 of 49). The collab `parallel-cap` is the right-sized version. |
| Owner per PR through merge; swarm verify at code-ready head; minor fix gets one verifier; `/loop 1h` audit tick | worker (owner), verifier (swarm) | One job = one branch; Olaf merges. | **Only the verify-once rule.** It confirms what orka does with patch-id: re-verify a changed head with one round, not a fresh full pass. Orka never merges, so the owner-merges part does not apply. |
| `swarm` (partition, aggregate PASS / ISSUES / BLOCKED) | verifier | One verifier. | **Later, for read-only lanes only.** A verify pass split by feature-map entry fits diagram-framework once B3 exists; RAM rules out parallel renders. |
| `arena` (N candidates, cross-family judge, graft) | orchestrator (design) | n/a | **No.** It needs model diversity Claude Code lacks (adapter maps grok to "inherit") and RAM for N worktrees. "Two structurally different sketches" (section 6) remains the cheap version. |
| `poteto-mode` routing to 23 playbooks, steps copied verbatim into the todo list, skipped steps kept with `skip: <reason>` | orchestrator | `--playbook feature|bug-fix|investigation|hillclimb` (:1413). | **The `skip: <reason>` rule only.** Orka's orchestrator could log each flow step it skips as a decision row; a silently dropped step (for example `npm run lint`, 2.4) becomes visible. Routing itself stays with Olaf's flag. |
| Bug-fix: reproduce twice (benny); failing repro lands before the fix; verify an existing fix on baseline and patched builds, twice each | worker (repro), verifier | Bug-fix playbook: one repro worker, `repro.json`, verifier re-runs it (:1425-1429). | **Yes, small.** Require two independent repro runs in `repro.json`, and have the verifier run the repro on the base commit too (P27). |

Net: pstack does not prescribe a workflow orka should copy whole. Orchestrate and the autopilots assume cloud VMs, multiple model families and GitHub stacks. Orka's constraint is one VPS, and Olaf does the merging. The parts that transfer are the standing orders, the verdict vocabulary with `blocked`, liveness from past runtimes, and retry by failure mode. Each is small, and none needs new agents.

## 9. Open questions

1. **Does orka write into target repos?** The collab design says orka writes nothing into them (AGENTS.md section). B5 (`orka.approved.json`), B6 (rule tables, lints) and the correct pass all need commits in the target repo. Proposal: only via a job branch Olaf merges. Olaf's call.
2. **Gate failure policy.** Should a branch-only gate failure block the verifier from starting, or start it with the failure in the brief? Blocking is cheaper; it can loop if the gate itself is flaky.
3. **Intake: proceed or wait?** `intent.md` without a pause keeps never-block-on-the-human. A pause for creative jobs might save whole taste rounds. Unknown which is cheaper; needs a trial.
4. **Lock granularity for visual work.** A file hash breaks on any re-render; a reference crop with a PSNR floor is fuzzier. Which does Olaf want for clips?
5. **First-pass rate confound.** The flat 67% may hide a weaker verifier (haiku default since task 13) offsetting better briefs. A fair test reruns a few past jobs with the old and new verifier model. Not done here.
6. **Steer labels are approximate.** The counts in 2.3 come from regex plus a hand check. If Olaf wants to rank by them, label the 107 steers by hand first (about 30 minutes).
7. **Installing pstack user-wide** adds ~60 skills to every session's skill list. The context cost is unmeasured. Embedding the 3-4 texts orka needs avoids that.
8. **Probe share is correlation.** motion-lab also renders more, and some probes were ordered by steers. The AGENTS.md effect would need a before/after on motion-lab itself.
