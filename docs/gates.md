# Static gates

Before every verifier round, orka runs the repo's cheap static checks itself in the job worktree. A red gate never costs a verifier agent, and the verifier no longer spends its round rerunning `npm test`.

## Which gates

- **`"gates"` in `.orka/config.json`** (per repo): a list of shell commands, run in order in the worktree, e.g. `["npm run lint", "npm test"]`. It replaces detection. `"gates": false` turns gates off.
- **Otherwise, `package.json` scripts**, fast ones first: `typecheck`, `type-check`, `lint`, `format:check`, `check`, `test`.
  - Oxlint/oxfmt setups are covered by these names (`"lint": "oxlint"`, `"format:check": "oxfmt --check"`, `"check": "oxlint && oxfmt --check"`).
  - The command is `<pm> run <script>` (`<pm> test` for test). The package manager comes from the lockfile: pnpm, yarn, bun, else npm.
  - npm's placeholder test (`echo "Error: no test specified" && exit 1`) is skipped.
- No package.json and no config means no gates: `orka worker` prints `gates: none (...)` and the verifier starts as before.

Limits: `"gateTimeout"` per gate (default `10m`) and `"gateBudget"` per round (default `20m`) in `.orka/config.json`. Each gate runs under GNU `timeout`, which makes it a process group and signals the whole group on timeout. Afterwards the group gets SIGTERM and then SIGKILL, so a test server or watcher a gate started does not outlive it. A process that starts its own session escapes this; `orka cleanup` still finds dev servers inside the worktree.

## A gate round

`orka worker --job <id> --name verifier --role verifier --task "..."` runs, in order:

1. Every gate, output to `.orka/jobs/<id>/results/gates/round-N/<name>.log`.
2. For a gate that failed: the same command once at `job.baseCommit`, in a temporary detached worktree (node_modules linked like a job worktree, removed afterwards). If it fails there too, it is `preexisting`: a warning, not a block. The base result is cached per `(baseCommit, command)` in `.orka/gates-base.json`, so a broken script on main is proved once, not every round.
3. A gate that failed only on the branch, or timed out, blocks. No verifier pane starts, `orka worker` exits 1, and it prints `gates round N: FAIL; no verifier started.` followed by each failing command, its exit code, log path and last 20 lines. The orchestrator routes that output to the owning builder and runs the same verifier command again later; the gates run first every time.
4. All green: the verifier starts. Its prompt says the gates already ran (see the digest) and not to rerun them.

Recorded:
- `results/gates/round-N.json`: every gate's command, status, exit, time, tail and base result;
- `job.gates {rounds, verdict, history: [{round, verdict, failing, warnings, accept, evidence}]}`;
- a `gate` row in `decisions.tsv`;
- `gates: round N fail blocking=test; no verifier started ...` plus each blocking gate's tail in `orka digest`, and `gates: round N <verdict>` in `orka status`.

Gate rounds are counted apart from verifier rounds: a red gate does not use up a `--max-rounds` round and does not count toward a stall.

## Acceptance by gate

When a job's whole acceptance is one command, a verifier agent would only rerun it. In that case:

- **When:** the verifier `--task` has one ACCEPTANCE item and it is one backticked command (`ACCEPTANCE: \`npm test -- dark\` passes`), or the orchestrator passes `--accept "<command>"`.
- **On a pass:** after green gates, orka runs the command with the same limits. On exit 0 it writes the round itself as `results/verifier.json` `{"name": "gate", "by": "gate", "verdict": "pass", "round": N, ...}` and starts no pane. `orka status` and the finish payload say `verified by gate: pass, round N`.
- **On a failure:** it blocks like a gate (no base check: acceptance is about this job's change).
- **UI jobs** (`jobType: ui`) always get the verifier.

`orka worker ... --role verifier --dry-run` prints the gates it would run and whether the acceptance would be decided by gate.
