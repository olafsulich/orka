# Cleanup

Finished jobs must not pile up stale panes, but you may still want to give feedback to the orchestrator after `orka done`. So cleanup is delayed and split in two.

**Right away** on `orka done`, `orka stop` and the `failed` path of `orka run` (after the status is saved and the finish webhook delivered), orka frees only what nobody can still use:

- the job's `agent-browser` sessions (`agent-browser --session <s> close`);
- dev or preview servers whose process cwd is inside the job worktree (never the orka process or its ancestors; a process is treated as a server by a heuristic on its command line);
- the panes of finished workers and the verifier (`herdr pane close <pane>`, for each worker pane recorded in `job.workers`).

What was closed is stored in `job.cleanup` (`browsers`, `servers`, `panes`). The orchestrator pane and the Herdr workspace stay open. Records, worktrees and branches are never deleted. One line is printed per thing closed:

```text
cleanup: closed browser orka-1a2b3c4d-docs
cleanup: stopped server pid 4242 (node dev.mjs)
cleanup: closed worker pane <p> (w1)
```

**Later**, `orka cleanup [--dry-run] [--older-than 12h] [--cwd <repo>]` closes the workspace (`herdr workspace close`) of every job that is `done`, `stopped` or `failed`, not `keep`, and idle longer than the threshold. Idle is measured from the latest of the finish time, steers, verifier rounds and follow-up rounds, so a job you just steered is not stale. The threshold is `--older-than` (`30m`, `12h`, `2d`; a bare number is refused), else `"staleAfter"` in `.orka/config.json` (for example `"staleAfter": "6h"`), else 12 hours. A workspace is closed once; `job.workspaceClosed` records it. The same command also closes `orka-` prefixed `agent-browser` sessions of jobs that are not running and orphaned sessions whose owning process is dead. `--dry-run` prints `would close` lines, and `cleanup: nothing to close` is printed when there is nothing.

The same stale-workspace sweep runs opportunistically and quietly at the start of `orka new` and `orka run` (one line on stderr, only when it closed something; never on stdout, which `new` uses for the id). There is no cron and no polling.

Sessions have deterministic names. The prefix is `orka-` plus the first 8 hex chars of `sha1(job.id)` (`orca-` for jobs created before the rename, on an `orca/<id>` branch). A worker's session is `<prefix>-<worker>`; `orka verify` uses `<prefix>-verify`; the verifier worker uses `<prefix>-verifier`. The rule is one `agent-browser` session per worker, named that way, never a shared or default one. orka records the names it hands out on `job.browserSessions`.

`--keep` opts out of everything. On `orka done` and `orka stop` it skips the immediate cleanup for that call. On `orka new` or `orka run` it stores `keep: true` on the job, which skips immediate cleanup on every terminal path and exempts the job from the stale sweep. `--dry-run` on `done` and `stop` prints what would be closed.

## Browser processes

Agents do not always use the named `agent-browser` session: Playwright scripts, `chrome-devtools-mcp`, and ad-hoc sessions start Chrome directly, and a detached daemon is reparented to init, so closing sessions by name alone leaked browsers. Every job pane now runs with `ORKA_JOB=<id>` (plus `ORKA_WORKER=<name>`, or `orchestrator`), and every browser it starts inherits that tag. orka kills a job's tagged browser processes on `done`, `stop` and `failed`. `orka reap <id> [--worker <name>]` closes one worker's browsers mid-job without touching its pane, and the orchestrator runs it when a worker or the verifier finishes. `orka cleanup` also reaps tagged browsers of this repo's finished jobs. It never touches untagged processes, a running or queued job's processes, a `--keep` job's processes, or a job from another repo.
