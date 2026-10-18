# 03 · Structured worker brief

Status: done · Source: pstack · Doc: [#3](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
Workers can't ask questions, so a vague task fails quietly. The orchestrator should write every worker task in a fixed brief. Its ACCEPTANCE lines then feed the verifier task.

## What
- In `orchestratorPrompt` (bin/orca.mjs:1240), require this template for every `orca worker --task`:
  `GOAL / SCOPE (files it owns) / CONTEXT (file pointers, not pasted text) / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT`.
  - It collapses to GOAL + ACCEPTANCE for one-command tasks.
- In `workerPrompt` (:979), add a footer: "if SCOPE or ACCEPTANCE is missing, do the narrowest reading and say so in result".
- The verifier `--task` collects the builders' ACCEPTANCE lines.
- Optional: `cmdWorker` (:1535) prints a warning, not an error, when a builder task has no `SCOPE:` or `ACCEPTANCE:`.

## Verifier per job or per worker? (Olaf's question)
**One verifier per job, run in rounds, not one per worker.** Evidence (bin/orca.mjs at 04c900a):
- :1276-1277: the orchestrator prompt says "When every builder has reported, start ONE verifier… `orca worker --job <id> --name verifier --role verifier`".
- :1064: a verifier worker must be named `verifier`. Later rounds become `verifier-2`, `verifier-3`… (:1035).
- :1075-1076: there's a single `results/verifier.json` per job. Older rounds are archived as `verifier.round-N.json` (:1079-1082).
- :1067-1069 and :1600-1601: `job.verifier` holds one round counter, verdict and history for the whole job. `--max-rounds` caps rounds per job.

So the verifier checks all builders' work together against the job goal.

## Acceptance criteria
- The orchestrator prompt contains the template and the "collapse for trivial tasks" rule. A test asserts it.
- The verifier task instructions reference the builders' ACCEPTANCE lines.
- `npm test` is green.

## Source refs
- `pstack/skills/poteto-mode/playbooks/orchestrate.md` ("The brief")

## Olaf's notes
- "Sounds good." The orchestrator writes the brief.
- Land this together with 02 to avoid two prompt-edit rounds.

## Done
`orchestratorPrompt` now requires the GOAL / SCOPE / CONTEXT / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT brief (collapsing to GOAL + ACCEPTANCE for one-command tasks) and tells the orchestrator to build the verifier `--task` from the builders' ACCEPTANCE lines. `workerPrompt` has the narrowest-reading footer. `cmdWorker` prints a non-fatal stderr warning for builder tasks without `SCOPE:` or `ACCEPTANCE:` (also in `--dry-run`; verifiers are not warned). 3 new tests in `test/verifier-model.test.mjs`; `npm test` 138 pass, 0 fail (was 135).
