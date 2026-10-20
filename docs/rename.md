# orca → orka

orka was called orca until 2026-10-20. The CLI, prompts and docs now say orka. Nothing an older orca wrote has to change: no state is moved or migrated, and running jobs keep working across the rename.

## What is new

| Thing | New jobs and repos |
| --- | --- |
| command | `orka` (`bin/orka.mjs`; `bin/orka` is a symlink so a pane PATH finds it) |
| state dir | `.orka/` |
| checks file / feature map | `orka.verify.json` / `orka.features.md` |
| job branch | `orka/<id>` |
| Herdr workspace label | `orka-<id>` |
| browser sessions | `orka-<8 hex of sha1(id)>-<worker>` |
| env vars | `ORKA_JOB`, `ORKA_WORKER`, `ORKA_PORT`, `ORKA_PORTS`, `ORKA_REPO`, `ORKA_WORKTREE`, `ORKA_BRANCH`, and the `ORKA_*` test/tuning knobs |

## What keeps working

- **`orca` command.** `bin/orca.mjs` is a deprecated alias (package.json `bin.orca`). Same commands, same stdout and exit codes; it adds one line, `orca is deprecated; use orka (same commands)`, on stderr only.
- **State dir.** If `.orka/` exists it is used. Else, if `.orca/` exists, it keeps being used: jobs, worktrees, `config.json`, `secrets/finish-webhook.env`, `chain.log`, caches. Else `.orka/` is created. An existing `.orca/` is never moved, and `.orka/` is never created next to it.
- **Files in a worktree.** `orka.verify.json` if present, else an existing `orca.verify.json`, else `orka.verify.json`. Same for `orka.features.md` / `orca.features.md`.
- **Branches and worktrees.** Lookups use the branch and worktree stored on the job record, so `orca/<id>` jobs are found as before. A record with no `branch` field is treated as `orca/<id>`.
- **Herdr.** Workspaces are found by the id stored on the job, so old `orca-<id>` workspaces still close; agent names (`j<digits>`) did not change.
- **Browser sessions.** Jobs on an `orca/<id>` branch keep the `orca-<sha8>` session prefix to the end; the old `orca-verify-<id>` sessions are still swept.
- **Env vars.** Every variable orka exports is set under both names (`ORKA_JOB` and `ORCA_JOB`, ...). Every variable orka reads accepts either name; `ORKA_*` wins when both are set. In a checks file, `${ORCA_PORT}` and `${ORCA_PORT_2}` still expand.
- **Process matching.** Reap, cleanup and the browser sweep match both `ORKA_JOB` and `ORCA_JOB` tags and both `orka.mjs` and `orca.mjs` watcher processes.
- **Finish webhook.** Payload shape, field order, field names, headers, URL and key are byte-for-byte the same. The only value that differs is `branch` for a new job (`orka/<id>`), because that is the job's branch; old jobs still send `orca/<id>`.

## When the `orca` alias can go

Remove `bin/orca.mjs`, `bin.orca` in package.json, and its test only when all of these hold:

1. No repo has a `queued` or `running` job created through `orca` (`grep -l '"status": "\(running\|queued\)"' <repo>/.orca/jobs/*.json` is empty in every repo you use).
2. `pgrep -af 'orca[.]mjs'` finds nothing.
3. Nothing calls `orca` any more: the `~/bin/orca` symlink, `~/bin/orca-chain`, `~/bin/orca-night-log`, `~/bin/memwatch`, cron entries and Grok Bot routines have moved to `orka`.
4. The deprecation line has not shown up in any log (watcher logs, `chain.log`) for 30 days.

Removing the alias does not remove the `.orca/`, `orca.*` file, `orca/<id>` branch or `ORCA_*` fallbacks; those stay while any repo still holds `.orca/` state.
