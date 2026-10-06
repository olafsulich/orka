# orca

Local jobs for one git repo. `orca init` marks the repo. `orca run` checks out a linked worktree and starts an agent there, in a Herdr pane. You decide what to merge.

Not a fork of [limen](https://github.com/overment/limen). Not the old `orch` script. Fresh Node ESM, zero dependencies. Local git only.

## How this differs from limen

Limen is a Pi coordinator you talk to. It plants tickets, a board, role prompts, reviewers, and advisors, and it can POST a finish webhook when a job ends.

Orca is the CLI. You file a job and run it. There is no coordinator conversation, no ticket board, and no package hooks in the target repo. A Claude job starts an Opus orchestrator; that orchestrator may start Sonnet workers with `orca worker`. A Pi job is one worker. Finish webhooks are not wired.

A worktree separates the job from the primary checkout. It is not a sandbox. The agent runs as you.

## How this differs from old orch

`orch` was one hardcoded repo (`diagram-framework`) and one `.orch/` directory. Agents edited the primary checkout. When the orchestrator reached done, a Herdr finish path could wake Grok Bot.

Orca works in any repo you `init`. Job state lives in that repo, under `.orca/`, which `init` gitignores. `run` creates branch `orca/<id>` in a linked worktree and starts the pane with that directory as cwd. There is no finish wake.

## v0 skips

Tickets, reviewers, advisors, resume, prune, diff, and finish webhooks. Those are not missing by accident.

**Next:** when a job reaches `done`, `failed`, or `stopped`, POST `{job, status, branch}` to targets listed in `<repo>/.orca/secrets/finish-webhook.env` (mode 600, already gitignored). Off unless that file exists. Do not read a home directory for this. Nothing sends yet.

## Layout

Workers share the job worktree. They do not get sibling checkouts. Concurrent edits can clash; keep tasks from touching the same files. Sibling worktrees are later, if a job needs them.

```text
<repo>/.orca/config.json             local mark (gitignored)
<repo>/.orca/jobs/<id>.json          job record
<repo>/.orca/jobs/<id>/              results/, notes/, summary.txt
<repo>/.orca/worktrees/<id>/         linked worktree, branch orca/<id>
<repo>/.orca/secrets/                reserved for the finish-webhook file
```

`init` appends `.orca/` to the repo `.gitignore` if it is missing. Commit that line if you share the repo. Do not commit `.orca/`.

Commands resolve the primary checkout from the current directory, including from a job worktree (`git rev-parse --git-common-dir`). Pass `--cwd <repo>` from anywhere else.

## Commands

```bash
orca init [--cwd <repo>]
orca new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi]
orca run <id> [--dry-run] [--cwd <repo>]
orca worker --job <id> --name <agent> --task "..." [--dry-run]
orca status [id] [--cwd <repo>]
orca steer <id> "message"
orca stop <id> [reason]
orca help
```

`--kind` defaults to `claude`.

`claude` jobs: `run` starts `claude --model opus` in a new Herdr workspace whose cwd is the worktree. The orchestrator is not the implementer. It starts workers with `orca worker`, which splits a pane in that same workspace and runs `claude --model sonnet`. Herdr has no `--model` flag; the alias is an agent argument.

`pi` jobs: one `pi` process in that worktree. No Opus, no Sonnet, no workers.

If the lead (or a worker) is still `idle` about 8 seconds after the prompt, orca sends the prompt once more. That is the startup swallow retry, not a second task.

`status` reads the job file. It does not poll Herdr.

`steer` prompts the lead agent and records the message on the job.

`stop` closes the job's Herdr workspace (or interrupts the lead if there is no workspace) and sets `stopped`. It does not delete the worktree or the branch.

`claude` must already be on `PATH` inside the pane. This CLI does not install it.

## Trust

orca does not mark a job `done` when the agent goes idle. The summary file is the completion note; `status` stays `running` until you `stop` it. A failed `run` leaves the worktree in place and marks the job `failed`. Look at the branch before you merge. The worktree is not a sandbox.
