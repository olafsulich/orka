# Orca improvements from pstack and Limen

Research only. Date 2026-10-18. Orca line numbers are from `bin/orca.mjs` at HEAD `f721fb3`. Nothing was run or measured; sizes are file sizes.

Paths: P = `/home/olaf/projects/cursor-plugins/pstack/skills`, L = `/home/olaf/projects/limen`. Every cited path was checked with `test -e` before writing.

## 1. pstack

**What it is.** A skill pack for Cursor (source `/home/olaf/projects/cursor-plugins/pstack`, HEAD `c1c0a32`, 2026-09-14, upstream github.com/cursor/plugins/tree/main/pstack, by Lauren Tan). It is markdown the agent loads, not a runtime: no scheduler, no CLI. Its claim is that verification is the limiting step, so an agent must close its own loop with evidence before parallelism is safe.

**Workflow.**
- Front door `/poteto-mode` (`P/poteto-mode/SKILL.md`, 18.7 KB): matches the task to one of 23 playbooks (`P/poteto-mode/playbooks/*.md`), copies the steps into a todo list (`skip: <reason>` if skipped), names the principles behind each decision. Sticky until "new task".
- The lead owns design and verification and delegates code. Explicit model per role; subagents run in the background and get file pointers, not inlined context. The lead reviews the diff and writes its own summary. Reversible work never blocks on the human; irreversible actions pause.
- Orchestration (`P/poteto-mode/playbooks/orchestrate.md`): a structured brief per unit, fresh respawn instead of resume-chaining, events queued rather than interrupts.

**Prompts and skills.** 23 `principle-*` skills (for example `principle-prove-it-works`, `principle-attack-the-premise`, `principle-fix-root-causes`, `principle-never-block-on-the-human`) and 24 task skills (`interrogate`, `show-me-your-work`, `arena`, `swarm`, `create-verification-skill`, `maintain-verification-skill`, and others).

**Gates.**
- Repro first and a failing test before the fix commit (`playbooks/bug-fix.md`).
- An independent verdict per PR, re-checked against the patch before shipping (`playbooks/shipping.md`).
- Multi-model adversarial review with lead triage into Act on / Consider / Noted / Dismissed (`P/interrogate/SKILL.md`).
- A decision log audited against the transcript by a different model family (`P/show-me-your-work/SKILL.md`).
- "Trust artifacts, not self-reports."

**Fit with orca.** Orca already has the closed loop (one fresh verifier per round, stall detection, base-commit comparison). The gaps are brief quality, review diversity, a mechanical verdict-freshness check and memory.

**Not worth adopting.** The 23-playbook auto-matcher (about 19 KB always loaded), Cursor-specific mechanics (`Task` tool, cloud agents), writing-style rules, and the multi-day store layout of `orchestrate.md`.

## 2. Limen

- Upstream: https://github.com/overment/limen. Orca is not a fork; Limen is inspiration only. Local checkout `/home/olaf/projects/limen`.
- Inspiration point: `38b2dc9` (2026-09-14). Orca's earlier notes (`docs/research/limen-2026-10-10.md`, commit 22ef539) compared against `b58e2ae` (2026-10-10).
- New HEAD: `3241454` (2026-10-17, "Context graph: quote the current capability frame and cue"). Reached with `git fetch` and `merge --ff-only`; Olaf's two dirty files (`.pi/settings.json`, `package-lock.json`) were left untouched.
- Size: 846 commits since 38b2dc9, of which 53 are new since b58e2ae.

**Changes since b58e2ae.** The 10 Oct verdict still holds: Limen has no compactor.
- **Capability frame (F948):** `L/templates/capability.md` adds a frame to every agent's system prompt and a one-line cue per turn (decide yourself, proper design over patch, stay within the asked outcome). They ran a decisiveness A/B and softened "named seam is a fence" to "a start". Loaded by `capabilitySection` in `L/hook/communication.ts`.
- **Durable ping queue (F946):** finish/stall/Ask webhooks are written to disk first and a detached deliverer retries with backoff (2 min wait, 10 min max backoff, 24 h give up, 30 s per try), with per-target receipts. See `L/src/integrations/webhook-queue.ts`, `L/src/integrations/finish-receipt.ts`, `L/docs/finish-webhooks.md`.
- **Finish pings and refused keys (F947):** every coordinator turn end pings once (debounced); a refused key leaves `.limen/webhook-rejected` and `limen status` reports it (`L/src/commands/status.ts`, `L/src/commands/webhook.ts`, `L/hook/finish.ts`).
- **Scout role (F936):** `L/templates/scout.md` defines a 15-line / 1200-char evidence packet with `Observed|guessed` labels and a `Verified:` line holding a real output line. Limen's own pilot kept scouts only on trial. Wake text: `L/src/job/wake-text.ts`.
- **Usage in job detail:** `L/src/job/usage.ts` sums token usage from session jsonl and shows served versus requested model.
- **Sweep cost (F943/F944):** `sameBirth` caches a pid-birth match for 30 s on macOS only (`L/src/runtime/reap.ts`); busy-job activity writes are throttled to 1 s (`L/src/runtime/wrapper.ts`).
- **Worker template:** "a job leaves nothing without an owner" (`L/templates/worker.md`). New doc `L/docs/diagrams/context-injection.html`.
- Not relevant: Jevgrep, groups, keeper/board, OptChat, Pi/OMP engine work.

**Do not take (re-confirmed).** Compaction tree, Pi hooks, tool-call supervisor wrapper, session-copy `continue`, groups, keeper/board, scout as a separate role, a `finish` tool (orca workers write `results/*.json`).

## 3. Combined ranking

Effort S/M/L. Ranked by benefit per effort and by how mechanical the fix is. All "orca touches" are in this repo (`bin/orca.mjs` unless noted).

| # | Idea | Source | Benefit to orca | Effort | Risk |
|---|------|--------|-----------------|--------|------|
| 1 | **Patch-id guard on verdicts.** Verifier result records head SHA and `git patch-id` of base..HEAD; `status`/`done` flag a pass whose patch no longer matches and demand a re-verify. Touches `verifierPrompt` (:1196), `computeVerifier` (:1139), `recordVerifier` (:1162), `cmdDone`, `test/verifier.test.mjs`. | pstack: `P/poteto-mode/playbooks/shipping.md` (step 3) | Builders share one worktree, so a late edit after a pass leaves a stale "verified" verdict that the finish webhook then reports. Enforced by the CLI, not by a prompt. | S-M | Low. Dirty tree needs `git diff HEAD` plus untracked files handled. |
| 2 | **Evidence standard in `verifierPrompt`.** Real user path, side effects checked, suspect the observation method first, proof written under `results/`, "inconclusive is not a pass". | pstack: `P/principle-prove-it-works/SKILL.md`, `P/create-verification-skill/SKILL.md`, `P/poteto-mode/playbooks/feature.md` | Better verifier quality at zero code cost. | S | Low. |
| 3 | **Structured worker brief** (GOAL / SCOPE / CONTEXT / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT) required in `orchestratorPrompt` (:1240), footer in `workerPrompt` (:979); optional warning when SCOPE or ACCEPTANCE is missing. | pstack: `P/poteto-mode/playbooks/orchestrate.md` ("The brief") | Workers cannot ask questions, so a vague task fails quietly. ACCEPTANCE lines also feed the verifier. | S | Low. Collapse the template for one-command tasks. |
| 4 | **Durable webhook retry.** On `failed`/`unknown`, the existing watcher retries with bounded backoff (30 s, 2 m, 10 m; give up 24 h), reusing the attempt record. Touches finish-webhook send code (~L424-615), `lib/watch.mjs`, `test/finish-webhook.test.mjs`. | Limen: `L/src/integrations/webhook-queue.ts`, `L/docs/finish-webhooks.md` | A lost "job done" ping is currently retried only by hand (`orca webhook`). | M | Low-medium. Duplicate delivery if the first send did arrive; keep the "already recorded" guard and do not auto-retry `unknown` unless the receiver is idempotent (unknown). |
| 5 | **Refused-key marker in `orca status`.** Persist a marker on HTTP 401/403 from the receiver until a later send is accepted. | Limen: `L/src/commands/status.ts`, `L/src/commands/webhook.ts` | A dead key shows as scattered per-job failures today. | S | Low. |
| 6 | **Decision log** (`orca log <id> <phase> <decision> <why> <evidence> <result>` appending to `.orca/jobs/<id>/decisions.tsv`; last N rows in the digest; checked against `results/*.json` before `done`). Touches new command, `lib/digest.mjs`, `cmdStrategy`. | pstack: `P/show-me-your-work/SKILL.md`, `P/show-me-your-work/scripts/log.sh`, `P/show-me-your-work/references/decision-log-template.tsv` | Memory that survives orchestrator compaction and a reviewable history after `done`. | S-M | Low. Cap it in the digest. |
| 7 | **Research packet format for research workers**: at most 15 lines / 1200 chars, `Observed\|guessed` labels, `Verified: <cmd> -> <real line> \| none`. Prompt only; do not add a scout role. | Limen: `L/templates/scout.md`, `L/src/job/wake-text.ts` | The digest carries denser, labelled evidence. | S | Low. |
| 8 | **Attack the premise at stall**: before a strategy change, write the shared premise of the failed fixes in one sentence and take a census; record both in `orca strategy`. Touches the stall paragraph of `orchestratorPrompt`. | pstack: `P/principle-attack-the-premise/SKILL.md`, `P/principle-fix-root-causes/SKILL.md` | Current stall guidance lists tactics, not "question the assumption". | S | Low. |
| 9 | **Small portable prompt rules**: irreversible actions still pause (extend `portPromptLines`, :927); the orchestrator reviews the diff and writes its own `summary.txt`; move the duplicated "never close panes" line into a shared constant. | pstack: `P/principle-never-block-on-the-human/SKILL.md`, `P/poteto-mode/SKILL.md`, `P/principle-encode-lessons-in-structure/SKILL.md` | Removes drift between prompts and one boundary case. | S | Low. |
| 10 | **Cross-model reviewer (`--role reviewer`, opt-in `--review`)**: read-only, different model than the builders, findings triaged by the orchestrator into Act on / Consider / Noted / Dismissed; run after the verifier pass. | pstack: `P/interrogate/SKILL.md`, `P/interrogate/references/reviewer-prompt.md`, `P/interrogate/references/lead-judgment.md`, `P/interrogate/references/rubric.md` | Catches design and root-cause problems the mechanical verifier does not. Fills the planned slot in `docs/research/limen-2026-10-10.md`. | M | Medium: noise and token cost. Limen cut its own review pre-pass after a pilot. |
| 11 | **Token and model line per job** (served vs requested model, summed tokens) via a new `lib/usage.mjs`. | Limen: `L/src/job/usage.ts` | Cost data for model choice; catches silent model fallback. | M | Medium: the Claude jsonl `usage` shape is unverified, files can be large (stream them), and pane to session mapping is not recorded today. |
| 12 | **"Leave nothing without an owner"** sentence in `workerPrompt`; check whether the 10 Oct "reading budget" sentence already landed. | Limen: `L/templates/worker.md` | Pairs with the `ORCA_JOB` browser reaping in f721fb3. | S | Low. |
| 13 | **Pause/resume note**: orchestrator writes `.orca/jobs/<id>/resume.md` before `stop`; `steer` reads it. No auto-commit. | pstack: `P/poteto-mode/playbooks/pause-safely.md`, `P/poteto-mode/playbooks/session-pickup.md` | The cheap half of resume, which the README lists as a v0 skip. | S-M | Low. |
| 14 | **Repro-first for defect jobs**: first worker reproduces and records failing evidence; verifier checks it now passes. | pstack: `P/poteto-mode/playbooks/bug-fix.md`, `P/principle-sequence-verifiable-units/SKILL.md` | A check that never failed proves nothing. | S-M | Medium: misclassifying non-bugs; keep it optional. |
| 15 | **Standing orders and fresh-over-resume**: per-job `standing` block repeated in every worker task; failed work gets a fresh worker rather than a chain of corrections. | pstack: `P/poteto-mode/playbooks/orchestrate.md`, `P/poteto-mode/SKILL.md` | Directives decay across resumes. | S prompt / M field | Low. |
| 16 | **Capability frame sentence** (decide design calls yourself within the asked outcome). | Limen: `L/templates/capability.md`, `L/hook/communication.ts` | Fewer questions handed back. | S | Medium: Limen A/B'd it, orca cannot yet; trial on one job. |
| 17 | **Feature map as cross-job memory** (per feature: how to reach, drive, prove; verifier updates it). | pstack: `P/create-verification-skill/SKILL.md`, `P/create-verification-skill/references/feature-map-example/README.md`, `P/maintain-verification-skill/SKILL.md` | Cuts verifier startup cost; complements `orca.verify.json`. | M | Medium: stale maps. |
| 18 | **Playbooks by job type** (`orca new --playbook investigation\|bug-fix\|hillclimb`), explicit flag only. | pstack: `P/poteto-mode/playbooks/investigation.md`, `P/poteto-mode/playbooks/bug-fix.md`, `P/poteto-mode/playbooks/hillclimb.md`, `P/poteto-mode/playbooks/feature.md` | Research jobs like this one would skip the verifier and require citations. | M | Medium: routing is pstack's most fragile part. |
| 19 | **Sweep cost caching** in the watch loop. | Limen: `L/src/runtime/reap.ts`, `L/src/runtime/wrapper.ts` | Only if watcher CPU on the VPS is measurably high; Limen itself does not cache on Linux. | S-M | Low. Measure first. |
| 20 | **Injection-point diagram** in the style of `docs/orca-how-it-works.png`. | Limen: `L/docs/diagrams/context-injection.html` | Documentation only. | S | None. |
| 21 | **Best-of-N race (arena-lite)** with sibling worktrees. | pstack: `P/arena/SKILL.md`, `P/swarm/SKILL.md` | Depth for risky designs; removes shared-worktree clashes. | L | High: worktree cleanup, branch ownership, merge. Defer. |

## 4. Top 3 to do first

1. **Patch-id guard (#1).** It closes a real correctness hole in the shared-worktree model: a verdict can describe code that is no longer there, and the finish webhook then reports it as verified. The CLI can enforce it, so it does not rely on prompt compliance.
2. **Structured worker brief with the verifier evidence standard (#3 and #2, one prompt change).** Prompt-only, S effort, low risk, and they improve both ends of the loop: workers that cannot ask questions get a complete brief, and the verifier stops accepting weak evidence. Land them together to avoid two prompt-edit rounds.
3. **Durable webhook retry plus refused-key marker (#4 and #5).** The finish ping is how Olaf learns a job is done; Limen hit a lost-ping incident class on 17 Oct. Orca records attempts but retries only by hand. Check receiver idempotency first (unknown), and do not auto-retry `unknown` until it is confirmed.

Next: #6 decision log, #7 research packet, #8 attack the premise; #10 reviewer after the verifier is hardened.

## 5. Unknowns

- Whether orca's webhook receiver is idempotent (needed for #4).
- The Claude session jsonl `usage` shape and per-worker session mapping (#11).
- Whether the 10 Oct worker reading-budget sentence landed in `workerPrompt` (#12).
- pstack part 3 of the guide is unpublished, so memory guidance beyond the feature map is unknown.
- Limen's dirty files (`.pi/settings.json`, `package-lock.json`) were not inspected.
