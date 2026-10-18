# 12 · Tests leak `orca watch` processes

Status: todo · Source: incident 2026-10-18

## Why
The test runs from the task 01 and 02 jobs left 21 detached `orca.mjs watch` processes behind (`--cwd /tmp/orca-*` and the task-02 worktree). They pushed the VPS load to ~27 on 4 vCPU and likely caused the worker prompt delivery failures (see 11). The parent agent killed them by hand.

## What
- **Tests kill every watcher they spawn.**
  - Integration tests that run `orca run` / `orca steer` (they reach `startWatcher` → `watch.spawnWatcher`) either disable the watcher (e.g. `ORCA_NO_WATCH=1`, honoured in `startWatcher`) or record `job.watcherPid` and kill it in teardown (`t.after`/`finally`).
  - Each test's `/tmp/orca-*` scratch repo is removed as well.
- **Guard in the watcher itself.** `orca watch` exits on its own when:
  - its repo, job file or worktree no longer exists;
  - the job is terminal and has no pane;
  - its lead pane is gone for more than M minutes.
  Check this in the `cmdWatch` loop and `lib/watch.mjs`.
- **Reaper.** `orca cleanup` also kills orphan `orca.mjs watch` processes whose job is terminal, missing or not the recorded `watcherPid`. Support `--dry-run`, and print what it killed.
- **Regression test.** Run the suite, then assert that no new `orca.mjs watch` process with a `/tmp/orca-*` cwd survives.

## Acceptance criteria
- After `npm test`, `pgrep -af "orca.mjs watch"` shows no test-spawned watcher.
- A watcher whose repo or job is deleted exits by itself within one poll interval.
- `orca cleanup --dry-run` lists orphan watchers, and `orca cleanup` kills them, without touching live jobs' watchers.
- `npm test` is green.

## Olaf's notes
- Seen live on 2026-10-18 (21 leaked watchers, load ~27).
