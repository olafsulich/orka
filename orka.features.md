# Feature map

## General
- Keep in mind:
  - Run tests only via npm test (hermetic env preload); the ended-without-result wake needs a first tick to stamp job.wakeSeen before the grace can elapse

## Watcher idle alerts: waiting, stuck, needs-input
- Reach: `orka watch <id>` (detached watcher on a running job); the decision logic is `watchJob` in lib/watch.mjs, wired to `workersLive` in bin/orka.mjs (cmdWatch deps)
- Drive: no UI. Fake herdr + watchJob deps in test/needs-input.test.mjs (lead idle, `workersLive` true/false, pane with or without a question)
- Prove: `npm test -- test/needs-input.test.mjs` (23/23 at 34ec74f, 2026-11-22); expects `waiting <id>: workers live` and no post when workers are live; one `kind: "stuck"` post when no worker is live and the pane shows no question; `kind: "needs-input"` when the pane shows a question
- Last verified: 2026-11-22 at 34ec74f (verifier, round 2; re-proved from 0af2f0c)
- Keep in mind:
  - `deps.workersLive` absent = legacy path; production always supplies it, so a question-less idle lead posts `stuck`
  - Mismatch, open: docs/webhooks.md says a throwing `workersLive` keeps the legacy needs-input post, but lib/watch.mjs treats a throw as not live, so a question-less pane posts `stuck`. The throw test only uses a pane with a question, so it does not catch this
  - Verified with the watchJob harness only; no live herdr watcher run (the live `orka watch` path was not exercised in rounds 1 or 2)

## Ended-without-result wake
- Reach: `orka wake <id>` (one pass of the watcher's wake tick, bin/orka.mjs wakeTick) and `orka wake <id> --live` (prints `workers live: true|false`). Direct CLI reach on the live job was NOT run in round 2: the permission classifier denied the call, so this entry is proven through the spawnSync harness only
- Drive: `npm test -- test/ended-without-result.test.mjs` builds a scratch repo with a fake herdr (status-<name>, pane-<name>, text-<name> files) and runs the real CLI via spawnSync; `ago()` backdates job.wakeSeen past the grace
- Prove: same command, 4/4 at 34ec74f (2026-11-22). Expects one wake with "ended its turn without a result" plus the last pane lines, `job.wakes.endedWithoutResult.<name>` set, no second wake, no wake within grace, no wake when the result file exists, `--dry-run` writes nothing
- Last verified: 2026-11-22 at 34ec74f (verifier, round 2; re-proved from 0af2f0c)
- Keep in mind:
  - The grace starts only when a tick first sees the worker ended (job.wakeSeen); `WAKE_GRACE_MS` env overrides the 60s default
  - A worker that is done or idle with no result counts as live (workersLive true) until its wake is delivered or held, so the lead is never posted `stuck` in that window
