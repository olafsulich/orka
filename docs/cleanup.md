# Cleanup

Finished jobs must not pile up stale panes, but you may still want to give feedback to the orchestrator after `orka done`. So cleanup is delayed and split in two.

**Right away** on `orka done`, `orka stop` and the `failed` path of `orka run` (after the status is saved and the finish webhook delivered), orka frees only what nobody can still use:

- the job's `agent-browser` sessions (`agent-browser --session <s> close`);
- dev or preview servers whose process cwd is inside the job worktree (never the orka process or its ancestors; a process is treated as a server by a heuristic on its command line);
- the panes of finished workers and the verifier (`herdr pane close <pane>`, for each worker pane recorded in `job.workers`).

- the worktree, on `orka done` only (see [Worktrees of done jobs](#worktrees-of-done-jobs)).

What was closed is stored in `job.cleanup` (`browsers`, `servers`, `panes`, `worktree`). The orchestrator pane and the Herdr workspace stay open. Records and branches are never deleted. One line is printed per thing closed:

```text
cleanup: closed browser orka-1a2b3c4d-docs
cleanup: stopped server pid 4242 (node dev.mjs)
cleanup: closed worker pane <p> (w1)
```

**Later**, `orka cleanup [--dry-run] [--older-than 12h] [--cwd <repo>]` closes the workspace (`herdr workspace close`) of every job that is `done`, `stopped` or `failed`, not `keep`, and idle longer than the threshold. Idle is measured from the latest of the finish time, steers, verifier rounds and follow-up rounds, so a job you just steered is not stale. The threshold is `--older-than` (`30m`, `12h`, `2d`; a bare number is refused), else `"staleAfter"` in `.orka/config.json` (for example `"staleAfter": "6h"`), else 12 hours. A workspace is closed once; `job.workspaceClosed` records it. The same command also closes `orka-` prefixed `agent-browser` sessions of jobs that are not running and orphaned sessions whose owning process is dead. `--dry-run` prints `would close` lines, and `cleanup: nothing to close` is printed when there is nothing.

Only an explicit `orka cleanup` sweeps other jobs. `orka new` and `orka run` never do, and `orka done` cleans only its own job (above). There is no cron and no polling. In scripts and tests, wrap `orka cleanup` in `timeout` (for example `timeout 120 orka cleanup --dry-run`).

`orka cleanup --dry-run` lists every `would close`, `would kill` and `would remove worktree <path> (<size>, branch <branch> kept)` line, then `would free <size> of done-job worktrees`.

Sessions have deterministic names. The prefix is `orka-` plus the first 8 hex chars of `sha1(job.id)` (`orca-` for jobs created before the rename, on an `orca/<id>` branch). A worker's session is `<prefix>-<worker>`; `orka verify` uses `<prefix>-verify`; the verifier worker uses `<prefix>-verifier`. The rule is one `agent-browser` session per worker, named that way, never a shared or default one. orka records the names it hands out on `job.browserSessions`.

`--keep` opts out of everything. On `orka done` and `orka stop` it skips the immediate cleanup for that call. On `orka new` or `orka run` it stores `keep: true` on the job, which skips immediate cleanup on every terminal path and exempts the job from the stale sweep. `--dry-run` on `done` and `stop` prints what would be closed.

## Leftover processes

Closing a pane does not stop a process that detached from it: a dev server started with `nohup` or `&`, a `tsx watch`, a `tail -f`, a test fixture. All of them carry the job's `ORKA_JOB` tag. `orka cleanup` kills every tagged process of a `done` or `stopped` job (not `failed`, not `keep`) once the job's workspace is closed, either earlier or by the same pass, with all its children (SIGTERM, then SIGKILL after 3 seconds). It skips a process that still runs under a Herdr pane, browsers (the browser sweep above owns those), orka's own CLI processes (watchers have their own sweep), zombies, and orka itself and its parents. The pass looks again after it closes the workspaces, so a pane process that was reparented on close is caught too. Each root gets one line, `cleanup: killed leftover pid <pid> (<job> <worker>: <command>)`, or `would kill` with `--dry-run`. Untagged processes are never selected.

## Claude scratch folders

Claude Code keeps a scratch folder for each working directory under `<tmpdir>/claude-<uid>/`, named after the path with every character other than a letter or digit turned into `-`. On this VPS `/tmp` is a tmpfs, so those folders hold RAM: one job's folder held 679 MB. `orka cleanup` removes the folder of a job's own worktree (under `.orka/worktrees/`) once the job is `done`, `stopped` or `failed`, not `keep`, and its workspace is closed (earlier, or by the same pass). At that point no pane of the job can still use it. The panes of a workspace closed in the same pass get 5 seconds to exit; a folder that a process still works in (cwd in the worktree or the folder) is kept and reported: `cleanup: kept Claude scratch <dir> (pid N still works in it: ...)`. Removal prints `cleanup: removed Claude scratch <dir> (<size>, <id>)` and records `job.scratchRemoved`; `--dry-run` prints `would remove`. A path longer than 200 characters is skipped, because Claude shortens those names. `ORKA_CLAUDE_TMP` overrides the root (tests point it at a sandbox). `orka done` never removes the folder, because the orchestrator pane stays open after it.

## Browser processes

Agents do not always use the named `agent-browser` session: Playwright scripts, `chrome-devtools-mcp`, and ad-hoc sessions start Chrome directly, and a detached daemon is reparented to init, so closing sessions by name alone leaked browsers. Every job pane now runs with `ORKA_JOB=<id>` (plus `ORKA_WORKER=<name>`, or `orchestrator`), and every browser it starts inherits that tag. orka kills a job's tagged browser processes on `done`, `stop` and `failed`. `orka reap <id> [--worker <name>]` closes one worker's browsers mid-job without touching its pane, and the orchestrator runs it when a worker or the verifier finishes. `orka cleanup` also reaps tagged browsers of this repo's finished jobs. It never touches untagged processes, a running or queued job's processes, a `--keep` job's processes, or a job from another repo.

## Worktrees of done jobs

`orka done` removes the job's worktree with `git worktree remove` (never `--force`) once its servers and browsers are gone. The branch `orka/<id>` stays, so you can still look at it and merge it. Only `done` does this: a `failed`, `stopped`, `running` or `queued` job keeps its worktree, and so does a `--keep` job. A worktree with uncommitted changes is kept and reported (`cleanup: kept worktree <path> (N uncommitted changes; commit or discard, then orka cleanup)`), so no work is lost; the orchestrator prompt says to commit before `orka done`. `orka cleanup` sweeps the worktrees of done jobs from the past the same way. Only a registered worktree under `.orka/worktrees/` is ever removed; `job.worktreeRemoved` records it, and `orka status` says `(removed <time>; branch kept)`.

A follow-up `orka steer` on a done job whose worktree was removed checks the branch out again at the same path before the message is sent.

## Shared dependencies

A new job worktree does not install its own `node_modules`. When the main checkout has a `node_modules` directory and the worktree's lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, `npm-shrinkwrap.json`; `package.json` when there is none) is byte-identical to the main checkout's, orka links `node_modules` to the main checkout's. When the lockfile differs, it runs a real install in the worktree instead (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` or `bun install --frozen-lockfile`; 10 minute limit, a failure is reported, not fatal). Lines start with `deps:` and go to stderr; `job.deps` records what was done.

This runs at `orka run` and again at every `orka worker`, so a link that went missing is relinked, a link that points nowhere is relinked (or, when the main checkout has no `node_modules` any more, replaced by a real install), and a worker that changed the lockfile gets a real install on the next worker start. A worktree `node_modules` that is a real directory is never touched. A symlink is not matched by `node_modules/` in `.gitignore`, so orka adds `/node_modules` to the repo's local `.git/info/exclude` (never committed) when needed. Workers are told the dir is shared and to replace the link before changing dependencies. Removing a worktree unlinks the link first; the main checkout's `node_modules` is never deleted.

## Verifier Chrome

orka records the browser processes it sees for a job (pid, start time, worker, session) in `.orka/jobs/<id>/browser-pids.json`: at every `orka worker`, `orka status <id>`, `orka digest` and `orka reap`, and on every watcher poll. The needs-input watcher of a running job does the same on every poll (at most 30 seconds apart), and when the verifier writes a new `results/verifier.json` it kills that verifier's Chrome right away: the round is over. The verifier also ends each round with `orka reap <id> --worker <name>`, which records and kills every Chrome of its round (its pane stays open); the orchestrator reaps finished workers the same way, a new verifier round reaps the previous one, and `done`, `stop` and `failed` reap the whole job.

`orka cleanup` also kills Chrome whose owning job or pane no longer exists:

- a running job's worker or orchestrator pane is gone (recorded `closed`, or missing from `herdr pane list`), matched by `ORKA_WORKER` tag or session name;
- the `ORKA_JOB` tag names a job this repo no longer has, and the process (or its browser parent) runs with its cwd inside this repo's `.orka/worktrees/`;
- a recorded pid of a finished job or of a gone pane, when the process with that pid has the same start time (a recycled pid never matches) and is still a browser.

Nothing unattributed is ever selected, so a Chrome orka did not start is never killed. To look for leftovers, use a bracketed pattern so `pgrep` never matches its own shell: `pgrep -af '[a]gent-browser-chrome'`.

## Memory guard

Before `orka worker` starts a worker or verifier pane, it reads `MemAvailable` from `/proc/meminfo` and counts Orka's own live panes on the host: pane shells started by the Herdr server that carry the `ORKA_JOB` (or `ORCA_JOB`) tag, from any repo. Olaf's other Herdr panes do not count. When `/proc` cannot be read, it counts the panes this repo's running jobs hold. It also reads memory pressure: `some avg10` in `/proc/pressure/memory`, the share of the last 10 seconds in which some task waited for memory. When memory is below the limit, the pane count is at the limit, the pressure is over its limit, or earlier starts are already waiting, it queues: one file per waiting process in `.orka/queue/`, oldest first, and polls until there is room and it is first in line. Past the wait limit it refuses with exit 1 and tells the orchestrator to try again later. A waiter killed by its caller's timeout leaves the queue. Every queue, start and refusal is a `memory-guard` row in `decisions.tsv`. `orka status` prints `host: memory <N>MB available (pressure <N>%), live panes <N>, queue <N> (guard: min <N>MB, max <N> panes)` and one `queued:` line per waiting start. Panes are still never closed mid-job: the guard only delays starts.

`orka status` also prints `job memory: <job> [<status>] 1.2G (w1 700M, verifier 500M), ...`. That is the memory of every process tagged with the job, from any repo, summed per job and per `ORKA_WORKER`, largest first, the top three. A job of another repo shows no status. `orka status <id>` shows only that job. The figure is PSS from `/proc/<pid>/smaps_rollup` (VmRSS when that cannot be read), so memory that Chrome processes share is split between them instead of counted once per process. When the guard queues a start or refuses it for low memory, and when `orka doctor` warns about memory, the message names the finished jobs of this repo that still hold memory (`finished jobs still hold 1.2G (<id> [done] 1.2G); timeout 120 orka cleanup --dry-run --older-than 0s lists what closing their workspaces frees`). Nothing is closed for you: you decide.

Limits (`"memoryGuard"` in `.orka/config.json`, env wins):

| Setting | Env | Default |
| --- | --- | --- |
| `minAvailableMb` | `ORKA_MIN_MEM_MB` | 1024 |
| `maxPanes` | `ORKA_MAX_PANES` | 20 |
| `maxMemPsi` (percent; 0 turns it off; without PSI it never blocks) | `ORKA_MAX_MEM_PSI` | 10 |
| `wait` | `ORKA_GUARD_WAIT` | `8m` |
| `poll` | `ORKA_GUARD_POLL` | `15s` |
| `enabled: false` | `ORKA_MEMORY_GUARD=off` | on |

There is no disk guard; the VPS agent owns disk.
