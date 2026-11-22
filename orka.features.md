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
