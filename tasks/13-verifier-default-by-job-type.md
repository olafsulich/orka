# 13 · Verifier model default by job type

Status: done · Source: Olaf decision 2026-10-18 (after Haiku verifier trials)

## Why
Olaf decided that Haiku is the default verifier for CLI and prompt jobs, which is cheap and good enough there. Sonnet stays the verifier for UI and browser jobs, where checking real user flows needs a stronger model. Today the default is static (task 02), so orca should pick it from the job type.

## What
- **Job type detection** in `cmdNew` / `cmdRun` (bin/orca.mjs). A job is `ui` when any of these holds:
  - a `--ui` flag, or a playbook that implies UI (task 10);
  - the worktree or repo has an `orca.verify.json`, or a `.orca/config.json` `"verify"` path, with browser steps (`open` and similar);
  - the goal or acceptance explicitly asks for agent-browser / UI verification.

  Otherwise the job is `cli`. Store the result as `job.jobType` with the reason it was detected.
- **Default verifier model:** `ui` gets `sonnet`, `cli` gets `haiku`.
- **Precedence**, highest first:
  1. `orca worker --role verifier --model`
  2. `--verifier-model` on `new`/`run`
  3. `.orca/config.json` `"verifierModel"`
  4. the job-type default

  Keep `haiku` alias validation from task 02.
- **Visible everywhere:** show the choice and its source in `orca status`, `--dry-run` and the orchestrator prompt, e.g. `verifier=haiku (default: cli job)` or `verifier=sonnet (default: ui job, orca.verify.json has browser steps)`.
- Update the README models section in one line. The detailed docs go in task 15.

## Acceptance criteria
- A CLI job with no flags or config gets `haiku`. A job with `--ui`, or with browser steps in `orca.verify.json`, gets `sonnet`.
- `--verifier-model` and config `verifierModel` override the type default, in that order. An explicit `--model` on the verifier worker still wins.
- Status, dry-run and the prompt show the model and its source.
- Tests cover detection, precedence and display, using a fake herdr. Tests spawn no leaked watchers (see 12).
- `npm test` is green.

## Olaf's notes
- "Haiku is the default verifier for CLI and prompt jobs, and Sonnet for UI and browser jobs."

## Done
- `detectJobType` in `bin/orca.mjs` runs in `cmdNew` (and `--ui` on `run`): `--ui`, browser steps in `orca.verify.json` or the config `verify` file, or a goal that asks for agent-browser/UI verification gives `ui`; otherwise `cli`. Stored as `job.jobType`, `job.jobTypeReason`, `job.verifierSource`. The playbook trigger is a no-op hook (task 10 not built).
- Defaults: cli `haiku`, ui `sonnet`. Precedence: `worker --model` > `--verifier-model` > config `verifierModel` > type default; alias validation kept. A stored default no longer follows `--worker-model`.
- `status`, `--dry-run` and the orchestrator prompt print `verifier=<model> (<source>)`. README: one line in the Verifier model section.
- Tests: new `test/verifier-default.test.mjs` (9), `test/verifier-model.test.mjs` updated (11); fake herdr, no watchers.
