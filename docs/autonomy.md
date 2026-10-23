# Autonomy levels

Each target repo has an autonomy level. The CLI enforces it, not the prompt.

| level | allows | refused |
| --- | --- | --- |
| L0 | read-only: the job may run and write files, but not commit | any commit, merge, push |
| **L1** (default) | branch and commit on the job branch | push, PR, commit or merge on main |
| L2 | L1 plus push of job branches and PRs (`orka push`) | commit, merge or push on main |
| L3 | L2 plus merge into main and push of main (`orka land`) | nothing |

## Where it lives

On orka's side, never in the target repo: `~/.config/orka/config.json` (or `$XDG_CONFIG_HOME/orka/config.json`, or `$ORKA_CONFIG_DIR/config.json`), keyed by the repo's real path:

```json
{ "repos": { "/home/olaf/projects/motion-lab": { "autonomy": "L1" } } }
```

```bash
orka autonomy                 # this repo's level and where it came from
orka autonomy set L2          # Olaf only: refused inside a job pane (ORKA_JOB set)
```

A repo with no entry is L1. orka never raises a level on its own.

## How it is enforced

- **orka commands.** `orka push <id> [--pr]` needs L2 (it pushes `orka/<id>` to origin; `--pr` also runs `gh pr create`). `orka land <id> [--push]` needs L3: it merges the job branch `--no-ff` into main in the primary checkout, runs `npm test` when the repo has a test script (twice before giving up), aborts the merge on a conflict or red tests, and with `--push` pushes main. Below the level they exit 1 with `orka: refused <action>: <repo> is at autonomy L1 (default); <action> needs L2 ...`.
- **Git in job panes.** Every orchestrator, worker and verifier pane gets `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=<repo>/.orka/hooks`. orka writes `pre-commit`, `pre-merge-commit` and `pre-push` there at `orka run` and `orka worker`. Each asks `orka autonomy check <action>` and then runs the repo's own hook of the same name (from its `core.hooksPath`, or `.git/hooks`), so husky and similar keep working. A commit on main counts as `commit-main`, a merge commit on main as `merge`, a push of `refs/heads/main` (or master, or origin's HEAD branch) as `push-main`.
- **Logged.** Every refusal with a job (from `ORKA_JOB` in the pane, or the command's id) appends a row to `.orka/jobs/<id>/decisions.tsv`: phase `autonomy`, `refused <action>`, `repo at L1; push needs L2`, the hook and branch.
- **Prompts** state the level once, so agents do not try. The hooks are what enforces it.

Limits: a hook is a guard, not a sandbox. `git push --no-verify`, another `-c core.hooksPath`, or a fast-forward of main (no hook fires) get past it. The prompts forbid these; a jailbreak-proof boundary would need a separate git user or remote permissions.

## orka chain

The old `~/bin/orca-chain` as a command. It runs `<state>/chain-queue` one job at a time:

```
# lines: NN [verifier-model]   (tasks/NN-*.md; the first line runs next)
16 haiku
17
```

Per task: wait for RAM and load (`ORKA_CHAIN_MIN_MEM_MB`, default 1200; `ORKA_CHAIN_MAX_LOAD`, default 6) → `orka new` + `orka run` → poll the job until it is terminal (`ORKA_CHAIN_POLL_MS`, default 60s; a webhook after 4h) → on done + verifier pass + not stale, land as far as the level allows:

| level | on a pass |
| --- | --- |
| L0, L1 | keep the branch for review (logged to the job's decisions.tsv) |
| L2 | `orka push <id> --pr` |
| L3 | `orka land <id> --push` (merge, npm test, push main) |

A failed job is retried once with its failure summary; a second failure skips the task. A failed land or push, or a failed `orka new`, stops the chain (exit 2, webhook). After each job: `timeout 120 orka cleanup --older-than 1m`. One chain per repo (`chain.lock` holds the pid). Files: `chain-current`, `chain.log` next to the queue. `--dry-run` prints the plan and changes nothing.

Not ported from the shell script: the global `pkill` of agent-browser Chrome and of `/tmp/orka-*` test watchers (they could hit another seat's jobs; `orka cleanup` reaps this repo's own browsers and orphans), and the orka-specific goal lines for tasks 14 and 15.
