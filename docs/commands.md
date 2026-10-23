# Commands

```bash
orka init [--cwd <repo>]
orka new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi] [--keep] \
  [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds N] \
  [--ui] [--playbook feature|bug-fix|investigation|hillclimb]
orka run <id> [--dry-run] [--keep] [--cwd <repo>] \
  [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds N]
orka worker --job <id> --name <agent> --task "..." [--model <alias>] [--dry-run]
orka worker --job <id> --name verifier --role verifier --task "<built + acceptance criteria>"
orka status [id] [--cwd <repo>]
orka digest <id> [--cwd <repo>]
orka steer <id> "message"
orka stop <id> [reason] [--dry-run] [--keep]
orka done <id> [reason] [--give-up "<reason>"] [--dry-run] [--keep] [--cwd <repo>]
orka strategy <id> [--premise "<shared premise>"] "<what changed>"
orka log <id> <phase> <decision> <why> <evidence> <result>
orka cleanup [--dry-run] [--older-than 12h] [--orphan-hours 2] [--cwd <repo>]
orka reap <id> [--worker <name>] [--dry-run] [--cwd <repo>]   # closes browsers only; panes stay
orka watch <id> [--dry-run] [--cwd <repo>]   # started by orka run, not for hand use
orka webhook <id> [--dry-run] [--force] [--cwd <repo>]
orka verify <id> [--base] [--dry-run] [--cwd <repo>]
orka autonomy [--cwd <repo>]
orka autonomy set <L0|L1|L2|L3> [--cwd <repo>]
orka push <id> [--pr] [--dry-run] [--cwd <repo>]
orka land <id> [--push] [--dry-run] [--cwd <repo>]
orka chain [--dry-run] [--cwd <repo>]
orka help
```

`--kind` defaults to `claude`. `--max-rounds N` (positive integer) on `new` or `run` stores `job.maxRounds`, an opt-in ceiling on verifier rounds; by default there is none. `--role` on `orka worker` is `builder` (default) or `verifier`.

`status` reads the job file. It does not poll Herdr. For one job it also prints the finish-wake record, and verify once it has run or a checks file is present. If a verifier ran it also prints the rounds, the last failing checks, the stall (if any), and the strategy changes, and records the latest round first.

`digest` prints a capped snapshot of the job and does not change it.

`steer` prompts the lead agent with a capped digest plus the message, and records only that message on the job. It also works on a `done`, `failed` or `stopped` job whose orchestrator pane still exists: that starts a follow-up round (see [follow-up.md](follow-up.md)).

`stop` interrupts the lead and its workers and sets `stopped`. It leaves the Herdr workspace open (see [cleanup.md](cleanup.md)). It does not delete the worktree or the branch. The finish wake, if configured, is sent after that status is saved, then terminal cleanup runs (see [cleanup.md](cleanup.md)). `--dry-run` prints the plan and does not stop or send.

`done` marks a running job `done` (reason defaults to `completed`) and sends the finish wake once, then frees what the job no longer needs (see [cleanup.md](cleanup.md)): browser sessions, worktree dev servers and finished worker panes. The orchestrator pane and the workspace stay open so you can still give feedback. A queued job is refused with exit 1, since nothing ran. If a verifier ran, `done` reads `results/verifier.json` and records the verdict on `job.verifier`; a final verdict of `fail` marks the job `failed` (reason `verifier failed after N rounds: <blocking checks>`) instead of `done`. `--give-up "<reason>"` marks the job `failed` with that reason and stores it as `job.verifier.stopReason`; the orchestrator uses it only when it cannot progress. An already `done`, `failed`, or `stopped` job prints that status, exits 0, and sends nothing. `--dry-run` prints the plan and the finish payload, and does not change status or send.

`log` appends a TSV row (timestamp, phase, decision, why, evidence, result) to `.orka/jobs/<id>/decisions.tsv`; tabs and newlines in arguments are escaped. The orchestrator logs each split, routing and strategy decision. `status <id>` shows the row count and `digest` the last 3 rows.

`strategy` also logs a row (phase `strategy`) and appends `<what changed>` to `job.verifier.strategyChanges` for the current round and prints the count. The orchestrator runs it after changing approach on a stall.

`webhook` previews or retries that POST. It does not change job status.

`cleanup` closes the workspaces of finished jobs that have been idle for a while. See [cleanup.md](cleanup.md).

`watch` is the needs-input watcher that `run` starts in the background. See [needs-input.md](needs-input.md).

`verify` runs project browser checks in the job worktree. See [verify.md](verify.md). It does not set the job to `done`; `orka done` does. The verifier worker runs it, not the orchestrator. `--base` runs the same checks against the base commit instead (see [verify.md](verify.md)).

`autonomy` shows or sets the repo's level (L0 read-only, L1 branch and commit (default), L2 push and PR, L3 merge and push main), kept in orka's own config, never in the repo. `push` and `land` refuse above the level and log the refusal to decisions.tsv; job panes get git hooks that do the same for commits, merges and pushes. `chain` runs `<state>/chain-queue` one job at a time and lands each pass as far as the level allows. See [autonomy.md](autonomy.md).

`claude` must already be on `PATH` inside the pane, and on `PATH` here so aliases can be checked. This CLI does not install it. `agent-browser` must be on `PATH` for `verify` and the verifier. This CLI does not install that either.

`--ui` (claude only) marks the job as a UI job, which changes the default verifier model (see [models.md](models.md)). `--playbook` picks the orchestrator flow: `feature` (default), `bug-fix` (a repro worker first, saved to `results/repro.json`, and the verifier re-runs it), `investigation` (findings with citations, no separate verifier), or `hillclimb` (one metric, a recorded baseline, keep a change only when it improves). `orka reap <id> [--worker <name>]` closes one worker's browsers without touching its pane (see [cleanup.md](cleanup.md)). `orka cleanup --orphan-hours N` sets the age of orphan browser roots swept (default 2).
