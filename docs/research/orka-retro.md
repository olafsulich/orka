# Orka retro: every job so far (2026-10-06 → 2026-10-22)

Research only. This covers all 125 orca/orka jobs in 6 repos, 839 worker transcripts, git history, `orca-chain` and `orca-night-log`. The method follows Matt Pocock's `retro` skill (mattpocock/skills, `skills/engineering/retro/SKILL.md`). That skill looks for candidates in the agent's *environment* (navigation, automated checks, reviewer rules, tool economy, information access) and ranks them by severity. Here "the environment" is the orchestrator: CLI, prompts, VPS and repo setup.

Machine-readable findings: `~/orka-findings/retro.tsv` (R1–R16). Scripts: `docs/research/orka-retro/collect_jobs.py`, `mine_transcripts.py`.

## TL;DR

- **The core loop works.** 107 of 125 jobs ended `done`. 90 of the 96 verified jobs ended with a `pass`, and 67% passed on the first round. The overnight `orca-chain` merged 12 backlog tasks in 5.5 h, all on the first attempt with zero retries. Wake delivery succeeded 184 of 187 times.
- **The VPS is now the bottleneck, not the agents.** 119 worktrees use 18 GB with only 7.2 GB of disk free. RAM fell under 1.2 GB in 51 night-log samples, with OOM-killed workers in 3 repos. Disk-full has stopped a job twice.
- **Verification is sound but slow when a check fails one instance at a time.** In 3 jobs the verifier found one more instance per round (8 rounds in one case). Two jobs closed `done` on a fail/null verdict because the job record lost later verifier rounds.
- **Visual jobs fail on taste memory, not on code.** Olaf drives motion-lab, thumb-lab and diagram-framework through many rounds (71 steers in motion-lab alone). Approved pieces get redone because nothing freezes them.

## Numbers

| Project | Jobs | done / failed / stopped / running | Verified jobs | Mean verifier rounds | Pass on round 1 | Median wall (min) | p90 wall (min) | Mean workers | Steers (jobs) | Follow-up rounds |
|---|---|---|---|---|---|---|---|---|---|---|
| motion-lab | 35 | 30 / 1 / 3 / 1 | 31 | 2.65 | 68% | 40 | 501 | 7.2 | 71 (12) | 35 |
| diagram-framework | 34 | 30 / 1 / 2 / 1 | 22 | 1.77 | 73% | 28 | 83 | 4.6 | 17 (8) | 1 |
| orca | 33 | 27 / 1 / 5 / 0 | 22 | 1.73 | 64% | 10 | 120 | 3.0 | 4 (4) | 0 |
| vault-audit | 11 | 9 / 2 / 0 / 0 | 10 | 1.40 | 60% | 36 | 163 | 9.1 | 3 (2) | 0 |
| thumb-lab | 8 | 8 / 0 / 0 / 0 | 8 | 2.75 | 62% | 24 | 494 | 10.5 | 12 (4) | 8 |
| motion-craft | 4 | 3 / 1 / 0 / 0 | 3 | 1.67 | 67% | 5 | 34 | 4.0 | 0 | 0 |
| **Total** | **125** | **107 / 6 / 10 / 2** | **96** | **2.08** | **67%** | **28** | **239** | **5.6** | **107 (30)** | **44** |

Other totals:
- **Verifier rounds per job:** 1 round 54, 2 rounds 21, 3–5 rounds 16, 7–14 rounds 5. 22 strategy changes were recorded, and stall detection never fired (`stall` is null on every job).
- **Failures (6):** 4 were a start blocked before the first turn (R8), 1 was a verifier fail on a missing mp4, and 1 was a verifier fail after 2 rounds of vault spot-checks. **Stops (10):** disk full ×1, RAM ×1, stale or workspace gone ×2, manual or "done by hand" ×6.
- **Give-ups** (`--give-up`): none recorded. Every non-done job was stopped by Olaf or the Engineer, or failed at start.
- **Worker sessions:** 839 sessions and 20,551 turns (Sonnet 465, Opus 277, Haiku 97). The median session has 17 turns, and the first Edit/Write comes at turn 12 after a median of 10 Bash calls.
- **Infra incidents:**
  - "Exit code 137" appears in 11 transcripts, and OOM kills are named in 3 steers.
  - Disk: "No space left on device" appears in 4 transcripts, plus one stop for disk full and one block on a full `/tmp`.
  - 116 sessions hit "command not found" (R9).
- **Wake:** 187 attempts gave 184 HTTP 200, 1×401 (2026-10-06, resent by hand), 1×400 (never resent) and 1 timeout. 15 jobs in 2 repos had no webhook at all (R7). No null-verdict wake was found. The two null verdicts are on job records (R3).
- **Folder trust / dialogs:** 4 starts were blocked (`status=Blocked`, no transcript) and 1 worker was blocked on an outside-cwd read prompt (R8). The cause of the 4 blocked starts is **inferred, not seen**: it may be the folder-trust dialog.
- **Branches:** 38 of 124 job branches were never merged (thumb-lab 7/8). There were no reverts on any main.
- **Chain:** 14 resource waits of 5 min each (70 min) while 2.9–3.6 GB of RAM was free. The cause was a load gate of 6 on 4 vCPU. Every chain log line is written twice.

## What went well

- **The verifier loop catches real problems, and the strategy rule then changes course.** 26 jobs failed round 1 and then passed. Those jobs logged useful pivots, for example "fresh worker computes every punch-in camera from node/zone geometry and proves it with a numeric frame audit" (`diagram-framework/.orca/jobs/20261017100043258-agent-setup-dark-diagram.json`, `strategyChanges`).
- **Unattended runs work on CLI work.** The chain ran tasks 11 → 15 overnight on 2026-10-18/19 (`.orca/chain.log`): 12 merges, 12 pushes, and no red tests.
- **The decision log is in use where it exists.** It has 203 rows across 10 jobs since task 04: split 49, strategy 45, routing 44, phase 36.
- **Backlog fixes held up.** After task 11 (prompt delivery) shipped on 2026-10-18, no lost-prompt steers appear. Before it there were 2 (orca task-03 and thumb-lab).

## What went badly

Quotes are short and come from job records, `steers[]` or `strategyChanges[]` in `<repo>/.orca/jobs/<id>.json`.

1. "Olaf is frustrated: the lens was ALREADY correct in grok-bot-intro v2 … Do NOT redesign it." (motion-lab `20261011180234577-grok-bot-clip-sfx`). Approved work regressed (R5).
2. "Workers b1 (p9) and b4 (pC) were killed by the OOM killer earlier, and two freshly started worker panes (pH, pJ) never received a prompt." (thumb-lab `20261009064403223`). RAM (R2), and also task 11.
3. "Workers w09-legacy … show Killed claude processes (VPS has ~8 GB RAM, likely too many concurrent Opus sessions)" (vault-audit `20261013110317976-vault-p2-stage-b`, 37 workers). RAM (R2).
4. "You have been idle since yesterday 18:41 UTC waiting on the verifier." (orca `20261007175644063`). Idle orchestrator (R11).
5. "Verifier round 2 (run in the existing verifier pane; orca's round counter still shows 1)" (vault-audit `20261013141523299`). Record drift (R3).
6. "Display gaps found one surface per round … fresh builder closes the full matrix" (orca `20261018204954447-task-11`, round 6 of 8). The verifier finds one instance per round (R4).
7. "(applied by orchestrator; orca steer cannot deliver to its own pane)", repeated on 8 steers (motion-lab `20261020160725760`). No self-round (R6).
8. "Diagram worker was blocked on a Claude outside-cwd read prompt — I accepted Yes." (orca `20261006195125491`). Dialog blocks (R8).
9. Olaf's verdict relayed in a steer: "way far from usable … a plain basic animation with code" (motion-lab `20261008205219938`, round 3 of 5, 25 h job). Taste is unknown up front, so many rounds follow (R12).

## Patterns

The retro categories are adapted to an orchestrator:

- **Information access (biggest):** Workers cannot see what the VPS can afford, so they spawn until the OOM killer stops them. They also cannot see what Olaf already approved (R2, R5). Both facts live only in Olaf's head or in a steer that has scrolled away.
- **Automated checks:** Three checks belong in code but live in prose today: "do not touch the approved lens", "is the last verdict a pass before done", and "is there disk/RAM for another worker" (R1–R3, R5). Declarative `orca verify` exists in 1 of 6 repos, and there it failed 14 of 25 runs, mostly on an unrelated studio server (R13).
- **Reviewer (verifier) rules:** The verifier reports the first failing instance, not the class (R4). Stall detection is keyed on the same check name, so a class that fails under a new name each round never trips it.
- **Tool economy:** About 12 turns go by before the first edit (confirms PLAN-usage / overment gap 2). Missing `file`, `rg`, ImageMagick and `jq` add detours (R9). Very wide jobs (7 jobs with 16–45 workers) are where RAM fails.
- **Navigation of rounds:** The round model is inconsistent: one long job in motion-lab versus one job per round in diagram-framework (R12). The long jobs hold the most steers, panes and regressions. The short ones leave unmerged single-commit branches (R14).

## Ranked improvements

Severity × frequency, cheapest first when tied. "Confirms" marks issues that are already known.

| # | Finding | Fix | Layer | Size |
|---|---|---|---|---|
| 1 | R1: worktrees never pruned, 18 GB used, 7.2 GB free | `orka prune` (terminal + merged/old, largest first, dry-run default) plus a disk preflight in `orka new` | codebase | M |
| 2 | R2: no RAM/concurrency gate, so OOM kills and hand-written memory steers | `orka worker` waits or refuses on low MemAvailable or a live-claude cap; reuse `orca-chain`'s gate | codebase | M |
| 3 | R3: verifier history drifts, 2 jobs closed `done` on a fail/null verdict | `orka done` refuses unless the last verdict is pass or `--accept "<reason>"`; register in-pane re-runs | codebase | S |
| 4 | R5: approved output redone | `orka approve <id> <paths>` adds a frozen list to the digest, plus a blocking verifier check | codebase | M |
| 5 | R4: one instance per round | Verifier lists the whole failing class, and a second failing round triggers a class sweep (extends task 05) | prose | S |
| 6 | R9: `file`, `rg`, ImageMagick, `jq` missing | Install them, plus one "tools on PATH" line in the shared rules | human | S |
| 7 | R7: 15 jobs never woke anyone | `orka init`/`new`/`status` say "webhook: off"; `orka init --webhook-from` | codebase | S |
| 8 | R8: blocked starts (4 of 6 failures) | Report the dialog text on Blocked, pre-trust the worktree, retry once | codebase | S |
| 9 | R6: orchestrator cannot open its own follow-up round | `orka round <id> --brief <file>` | codebase | S |
| 10 | R12: two round models | `orka new --continue <id>` carries the digest, decisions and approved list | codebase | M |
| 11 | R11: orchestrator idle for hours | Confirms overment gap 7: watcher alert when idle with no live worker | codebase | S |
| 12 | R10: about 12 turns before the first edit | Confirms overment gap 2 / tasks 17 | prose | S |
| 13 | R13–R16: verify servers, parked branches, chain log/gate, wake retry | See TSV | mixed | S–M |

How this may land with others: R2 and R1 change behaviour on a VPS shared with other Opus seats. A RAM gate will make jobs *wait*, and Grok Bot's status messages should say why. R3's refusal will block a few `done` calls that today pass silently, so the `--accept` reason must be cheap to give.

## Open questions

- **Blocked starts:** Is the cause the folder-trust dialog? No transcript exists, so the dialog was never captured. One test launch in a fresh worktree path would settle it.
- **Haiku verifier:** Is it stricter or noisier? Haiku passes 52% on round 1 (27 jobs, 2.56 rounds); Sonnet passes 75% (51 jobs, 1.8 rounds). This is confounded: CLI jobs default to Haiku, and CLI jobs pass less on round 1 (56%) than UI jobs (81%).
- **thumb-lab branches:** 7 of 8 branches are unmerged. Were the outputs taken some other way (copied images), or abandoned? Olaf knows.
- **Pi:** 8 jobs, all between 2026-10-06 and 2026-10-12. None reached a verifier pass, and Pi use stopped after that. Was it dropped on purpose? Pi session logs (10 orca dirs in `~/.pi/agent/sessions`) were not mined.
- **Turn costs:** Bash calls before the first edit are a rough measure of rediscovery. Some of that exploration is needed. Splitting it by command type would need a second pass.
