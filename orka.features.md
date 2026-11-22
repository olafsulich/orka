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
