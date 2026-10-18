# 10 · Playbooks by job type

Status: todo · Source: pstack · Doc: [#18](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
Every job runs the same build → verify loop. A research job doesn't need a browser verifier; it needs citations. A bug fix needs a repro first. An explicit playbook flag picks the right loop with no auto-routing.

## What
- `orca new|run --playbook feature|bug-fix|investigation|hillclimb`. The default `feature` is today's behaviour. The value is stored as `job.playbook`.
  - Flag code lives in `cmdNew` (bin/orca.mjs:1353) and `cmdRun` (:1469).
- `orchestratorPrompt` (:1240) adds a short per-playbook block:
  - **investigation:** no verifier. Research summaries (06) with citations, and the orchestrator checks the citations before done.
  - **bug-fix:** repro first (08).
  - **hillclimb:** a metric, a baseline and iterations kept only when the metric improves.
- Keep the blocks short, as constants in one place. No auto-matcher.

## Acceptance criteria
- An invalid playbook value fails with the list of valid ones.
- Each playbook changes only its block of the prompt. Tests cover all four.
- `status` and the finish payload show the playbook.

## Source refs
- `pstack/skills/poteto-mode/playbooks/investigation.md`
- `pstack/skills/poteto-mode/playbooks/bug-fix.md`
- `pstack/skills/poteto-mode/playbooks/hillclimb.md`
- `pstack/skills/poteto-mode/playbooks/feature.md`

## Olaf's notes
- "Yes."
