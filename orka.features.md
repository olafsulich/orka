# Feature map

## General
- Keep in mind:
  - orka starts a verifier round by resetting job.verifier.stall to null (after recording the prior round); the verifier prompt reads the stall before that reset, so tests must read the prompt, not the saved job
  - test/playbooks.test.mjs fails in any worktree whose path contains the word stall (regex /stall/i on the prompt); fixed in 0962cc8 by normalising the bin path (ORKA -> BIN) in promptOf
- Last verified: 2026-11-18 at 0962cc86ee9231ae066ffb1da7a47d367c08d4d0 (verifier 20261118230720259-stall-after-n-consecutiv, round 1): test/playbooks.test.mjs, test/feature-map.test.mjs, test/feature-map-keep.test.mjs: 26 pass, 0 fail (run inside a worktree whose path contains "stall")

## Stall detection (stallOf, --stall-after, verifier class sweep)
- Reach: `node bin/orka.mjs new --kind claude --title t --goal g --stall-after 4 --cwd <repo>` (repo after `orka init`); a stall then shows in `orka status <id>`
- Drive: `node --import ./scripts/hermetic-env.mjs --test test/stall-rounds.test.mjs` (feeds results/verifier.json round by round through the real bin/orka.mjs with herdr and claude stubbed on PATH)
- Prove: 10 of 10 pass, including the diagram-framework-shaped fixture (5 fail rounds, disjoint check names: stall kind "rounds" at round 3, still stalled at round 5); `--stall-after 4` delays it to round 4; a pass round resets the count; kind "checks" still fires at round 2; the verifier prompt has "Class sweep" only for kind "rounds". Non-integer and <2 values are rejected before any job is created (see results/stall-after-validation.txt)
- Last verified: 2026-11-18 at 0962cc86ee9231ae066ffb1da7a47d367c08d4d0 (verifier 20261118230720259-stall-after-n-consecutiv, round 1)
- Keep in mind:
  - The fixture drops the real round-5 pass of diagram-framework job 20261017100043258-agent-setup-dark-diagram (real history: fail 2-4, pass 5, fail 6-7, pass 8). Under the real history the rounds stall fires at round 4, not round 3.
  - stallOf returns null when a round in the window is missing from history (gate rounds without a verdict break the count)
  - Real-herdr path not exercised: the tests use herdr and claude stubs; orka status and worker prompts are the real bin/orka.mjs code
# Features

## Orchestrator write guard (Claude PreToolUse)
- Reach: `node lib/orchestrator-guard.mjs claude <jobDir> <worktree>` with a PreToolUse JSON on stdin (no URL; CLI hook, run by Claude Code from `context/claude-settings-lead.json`)
- Drive: pipe `{"tool_name":"Edit","tool_input":{"file_path":"<worktree>/README.md"},"cwd":"<worktree>"}` into the command with a scratch jobDir
- Prove: `npm test -- test/orchestrator-guard.test.mjs` (10 pass); by hand: Edit in worktree -> exit 2 + stderr "orka: the orchestrator pane may not Edit ..." + one `guard` / `refused Edit` / `refused` row in `<jobDir>/decisions.tsv`; Write to `<jobDir>/summary.txt` -> exit 0, no row
- Last verified: 2026-11-22 at commit `32b0b4f4ca1e9189bf293c78f5df1b6cf800e218`
- Keep in mind:
  - it matches only Edit, Write, MultiEdit and NotebookEdit; Bash is not watched (the prompt and docs/autonomy.md say so)
  - the guard log header is written once; a refusal row needs `decisions.tsv` inside the job dir

## Thin orchestrator prompt and lead settings
- Reach: `npm test -- test/thin-orchestrator.test.mjs` (the lead pane wiring is built by `paneExtras` in `bin/orka.mjs`; `grep -n "solo" bin/orka.mjs` prints nothing)
- Drive: the test calls the real `orchestratorPrompt` for each playbook and the real `paneExtras` for lead and worker panes
- Prove: 7 pass; lead `claude-settings-lead.json` has PreToolUse matcher `Edit|Write|MultiEdit|NotebookEdit`, worker `claude-settings.json` has no PreToolUse, `pi-lead.mjs` imports `piGuardExtension`
- Last verified: 2026-11-22 at commit `32b0b4f4ca1e9189bf293c78f5df1b6cf800e218`
- Keep in mind:
  - the Pi lead path is proven by the extension contract (`piGuardExtension` with a fake `pi.on`), not by a live pi process
  - no solo playbook exists; the multi-worker model is unchanged

## Orchestrator docs (thin role)
- Reach: `grep -n orchestrator-guard README.md docs/*.md` (hits docs/autonomy.md, docs/workers.md, docs/layout.md, docs/models.md)
- Drive: read docs/autonomy.md "Orchestrator guard" section
- Prove: `npm test -- test/readme-docs.test.mjs` (8 pass)
- Last verified: 2026-11-22 at commit `32b0b4f4ca1e9189bf293c78f5df1b6cf800e218`
- Keep in mind:
  - docs say "There is no solo mode" and say the guard is not a sandbox
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
