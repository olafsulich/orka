# Commands

```bash
orka init [--cwd <repo>]
orka new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi] [--keep] \
  [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds N] \
  [--ui] [--playbook feature|bug-fix|investigation|hillclimb] [--no-gate]
orka new --spec specs/<feature>/spec.md [--title "..."] [--goal "extra"] [same flags as above]
orka spec init <feature> [--cwd <repo>]
orka run <id> [--dry-run] [--keep] [--cwd <repo>] \
  [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds N]
orka worker --job <id> --name <agent> --task "..." [--model <alias>] [--dry-run]
orka worker --job <id> --name verifier --role verifier --task "<built + acceptance criteria>"
orka status [id] [--cwd <repo>]
orka digest <id> [--cwd <repo>]
orka steer <id> [--to <worker>] "message"
orka wake <id> [--dry-run]
orka propose <id> [--dry-run]
orka approve <id> ["note"]
orka stop <id> [reason] [--dry-run] [--keep]
orka done <id> [reason] [--give-up "<reason>"] [--dry-run] [--keep] [--cwd <repo>]
orka strategy <id> [--premise "<shared premise>"] "<what changed>"
orka log <id> <phase> <decision> <why> <evidence> <result>
orka cleanup [--dry-run] [--older-than 12h] [--orphan-hours 2] [--cwd <repo>]
orka reap <id> [--worker <name>] [--dry-run] [--cwd <repo>]   # closes browsers only; panes stay
orka watch <id> [--dry-run] [--cwd <repo>]   # started by orka run, not for hand use
orka handoff <id> [<worker>|orchestrator] [--dry-run] [--cwd <repo>]   # one context-handoff pass; the watcher runs it every poll (5 s while a measured pane works)
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

`--spec <path>` builds the job from a committed spec: the title defaults to its `# ` heading and the goal is built from its What, Why, Limits and Done when sections (`--goal` text, if given, goes first). The spec must be committed at HEAD and have What and Done when filled in. Its text is pasted into every worker and verifier brief. `spec init <feature>` writes the template to `specs/<feature>/spec.md` in the current checkout; you fill it in and commit it. See [specs.md](specs.md).

`status` reads the job file. It does not poll Herdr. For one job it also prints the finish-wake record, and verify once it has run or a checks file is present. If a verifier ran it also prints the rounds, the last failing checks, the stall (if any), and the strategy changes, and records the latest round first.
`status` reads the job file. The only Herdr call is `herdr pane list`, for the host line: free memory (MemAvailable), live agent panes and the `orka worker` queue of the memory guard (see [cleanup.md](cleanup.md#memory-guard)). For one job it also prints the finish-wake record, and verify once it has run or a checks file is present. If a verifier ran it also prints the rounds, the last failing checks, the stall (if any), and the strategy changes, and records the latest round first.

`digest` prints a capped snapshot of the job and does not change it.

`steer` on a running job writes the message (with a capped digest for the lead) to the target's steer inbox: delivered at once when the target is idle, else by its hook between tool calls or by the watcher once idle. `--to <worker>` messages a worker the same way. It records only the message on the job; digest and status count what is still undelivered. `wake` runs one pass of the watcher's finish wakes and inbox delivery ([workers.md](workers.md)). It also works on a `done`, `failed` or `stopped` job whose orchestrator pane still exists: that starts a follow-up round (see [follow-up.md](follow-up.md)).

`propose` is run by the orchestrator of a gated job after planning: it reads `approach.md` from the job dir, sets `awaiting-direction` and POSTs the approach once. `approve` resumes that job; `steer` on it asks for a revised approach instead. Builders and the verifier are refused until approval; `--no-gate` on `new` (or `run`) skips the gate. See [gate.md](gate.md).

`stop` interrupts the lead and its workers and sets `stopped`. It leaves the Herdr workspace open (see [cleanup.md](cleanup.md)). It does not delete the worktree or the branch. The finish wake, if configured, is sent after that status is saved, then terminal cleanup runs (see [cleanup.md](cleanup.md)). `--dry-run` prints the plan and does not stop or send.

`done` marks a running job `done` (reason defaults to `completed`) and sends the finish wake once, then frees what the job no longer needs (see [cleanup.md](cleanup.md)): browser sessions, worktree dev servers and finished worker panes. The orchestrator pane and the workspace stay open so you can still give feedback. A queued job is refused with exit 1, since nothing ran. If a verifier ran, `done` reads `results/verifier.json` and records the verdict on `job.verifier`; a final verdict of `fail` marks the job `failed` (reason `verifier failed after N rounds: <blocking checks>`) instead of `done`. `--give-up "<reason>"` marks the job `failed` with that reason and stores it as `job.verifier.stopReason`; the orchestrator uses it only when it cannot progress. On a job made with `--spec`, it then appends the job's lessons to the spec and commits that file on the job branch (see [specs.md](specs.md#lessons)). An already `done`, `failed`, or `stopped` job prints that status, exits 0, and sends nothing. `--dry-run` prints the plan and the finish payload, and does not change status or send.
`done` marks a running job `done` (reason defaults to `completed`) and sends the finish wake once, then frees what the job no longer needs (see [cleanup.md](cleanup.md)): browser sessions, worktree dev servers, finished worker panes, and the worktree itself (the branch stays; a worktree with uncommitted changes is kept). The orchestrator pane and the workspace stay open so you can still give feedback. A queued job is refused with exit 1, since nothing ran. If a verifier ran, `done` reads `results/verifier.json` and records the verdict on `job.verifier`; a final verdict of `fail` marks the job `failed` (reason `verifier failed after N rounds: <blocking checks>`) instead of `done`. `--give-up "<reason>"` marks the job `failed` with that reason and stores it as `job.verifier.stopReason`; the orchestrator uses it only when it cannot progress. An already `done`, `failed`, or `stopped` job prints that status, exits 0, and sends nothing. `--dry-run` prints the plan and the finish payload, and does not change status or send.

`log` appends a TSV row (timestamp, phase, decision, why, evidence, result) to `.orka/jobs/<id>/decisions.tsv`; tabs and newlines in arguments are escaped. The orchestrator logs each split, routing and strategy decision. `status <id>` shows the row count and `digest` the last 3 rows.

`strategy` also logs a row (phase `strategy`) and appends `<what changed>` to `job.verifier.strategyChanges` for the current round and prints the count. The orchestrator runs it after changing approach on a stall.

`webhook` previews or retries that POST. It does not change job status.

`cleanup` sweeps finished jobs: their browsers, the worktrees of done jobs, and the workspaces idle for a while. It also runs at the start of every `orka new` and `orka run`. `--dry-run` lists what it would delete, with sizes. See [cleanup.md](cleanup.md).

`watch` is the needs-input watcher that `run` starts in the background. See [needs-input.md](needs-input.md).

`handoff` measures each builder worker's and the orchestrator's context against the window its runtime reports, and hands a pane past `handoff.threshold` to a fresh one (at once when idle, at the next clean stopping point when working). A name hands that pane off now. See [handoff.md](handoff.md).

`verify` runs project browser checks in the job worktree. See [verify.md](verify.md). It does not set the job to `done`; `orka done` does. The verifier worker runs it, not the orchestrator. `--base` runs the same checks against the base commit instead (see [verify.md](verify.md)).

`autonomy` shows or sets the repo's level (L0 read-only, L1 branch and commit (default), L2 push and PR, L3 merge and push main), kept in orka's own config, never in the repo. `push` and `land` refuse above the level and log the refusal to decisions.tsv; job panes get git hooks that do the same for commits, merges and pushes. `chain` runs `<state>/chain-queue` one job at a time and lands each pass as far as the level allows. See [autonomy.md](autonomy.md).

`claude` must already be on `PATH` inside the pane, and on `PATH` here so aliases can be checked. This CLI does not install it. `agent-browser` must be on `PATH` for `verify` and the verifier. This CLI does not install that either.

`--ui` (claude only) marks the job as a UI job, which changes the default verifier model (see [models.md](models.md)). `--playbook` picks the orchestrator flow: `feature` (default), `bug-fix` (a repro worker first, saved to `results/repro.json`, and the verifier re-runs it), `investigation` (findings with citations, no separate verifier), or `hillclimb` (one metric, a recorded baseline, keep a change only when it improves). `orka reap <id> [--worker <name>]` closes one worker's browsers without touching its pane (see [cleanup.md](cleanup.md)). `orka cleanup --orphan-hours N` sets the age of orphan browser roots swept (default 2).
