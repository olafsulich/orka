# orca

Local jobs for one git repo. `orca init` marks the repo. `orca run` checks out a linked worktree and starts an agent there, in a Herdr pane. You decide what to merge.

Not a fork of [limen](https://github.com/overment/limen). Not the old `orch` script. Fresh Node ESM, zero dependencies. Local git only.

## How this differs from limen

Limen is a Pi coordinator you talk to. It plants tickets, a board, role prompts, reviewers, and advisors, and it can POST a finish webhook when a job ends.

Orca is the CLI. You file a job and run it. There is no coordinator conversation, no ticket board, and no package hooks in the target repo. A Claude job starts an orchestrator (default `opus`, Opus 5.5); that orchestrator may start workers (default `sonnet`, Sonnet 5.5) with `orca worker`. Either alias can be overridden per job. A Pi job is one worker. When the CLI marks a job `done`, `failed`, or `stopped`, it can POST a finish wake. Agents do not send it.

## How this differs from old orch

`orch` was one hardcoded repo (`diagram-framework`) and one `.orch/` directory. Agents edited the primary checkout. When the orchestrator reached done, a Herdr finish path could wake Grok Bot.

Orca works in any repo you `init`. Job state lives in that repo, under `.orca/`, which `init` gitignores. `run` creates branch `orca/<id>` in a linked worktree and starts the pane with that directory as cwd. The finish wake is orca's own POST. It does not run `herdr-finish-watch`.

## v0 skips

Tickets, reviewers, advisors, resume, prune, and diff. Those are not missing by accident.

## Finish wake

When the CLI marks a job `done`, `failed`, or `stopped`, it POSTs once:

```json
{"job":"<id>","status":"stopped","branch":"orca/<id>"}
```

`job` is the id. `status` is the status just saved. `branch` is the job branch. Those three fields are the whole body. It is not the old `herdr-finish-watch` body.

Today the CLI writes `stopped` from `orca stop`, and `failed` when `orca run` fails after the worktree or pane exists. Both call the same sender after the status is saved. Idle is not terminal. A summary file does not send the wake. You still `stop` a job you are done watching. `orca webhook` can also POST a job that is already `done`.

Off unless `<repo>/.orca/secrets/finish-webhook.env` exists. A missing file does not send and does not error. orca does not read `~/.config`, `~/bin/herdr-finish-watch`, the process environment, or any other home path for a destination. Do not symlink the file out of `.orca`. An escaped symlink is refused.

The file is assignments, not a shell script. `export` and quotes are accepted. Mode 600. Do not commit it. `init` gitignores `.orca/`. The keys match `herdr-finish-wake.env`, so you can point orca at that Grok Bot URL for now:

```dotenv
WEBHOOK_URL=https://example.invalid/automations/webhook/REPLACE_ME
WEBHOOK_KEY=REPLACE_ME
```

`WEBHOOK_KEY` is the raw token, not a `Bearer ` prefix. orca sends `Authorization: Bearer <key>` and `X-Automation-Key: <key>`. The URL must be `https`, with no userinfo and no fragment. Copy `examples/finish-webhook.env`, replace the placeholders, and `chmod 600` the copy. The POST waits about 8 seconds. HTTP acceptance is not proof the bot woke.

A bad file or a failed POST is recorded at `<repo>/.orca/jobs/<id>.finish.json`. That record holds no secrets. Sender failure does not change the job status. One automatic attempt. `orca stop` on an already terminal job does not send again. If the env file was missing at stop, nothing is recorded; add the file and run `orca webhook <id>`.

`orca webhook <id>` retries a failed attempt and appends the result, so a retry is not a silent duplicate. If the last attempt was accepted, or is still `attempting` or `unknown` (the POST may have landed), it does not send unless you pass `--force`. `--force` records another attempt. `--dry-run` prints the payload and the URL origin, not the key or the URL path, and does not send.

```bash
orca webhook <id> --dry-run
orca stop <id> --dry-run
node --test test/finish-webhook.test.mjs
```

Agents must not run `herdr-finish-watch`, `orca webhook`, or `orca stop`. The CLI sends the wake after it has saved the terminal status.

## Layout

Workers share the job worktree. They do not get sibling checkouts. Concurrent edits can clash; keep tasks from touching the same files. Sibling worktrees are later, if a job needs them.

```text
<repo>/.orca/config.json             local mark (gitignored)
<repo>/.orca/jobs/<id>.json          job record
<repo>/.orca/jobs/<id>.finish.json   finish-wake attempts (no secrets)
<repo>/.orca/jobs/<id>/              results/, notes/, summary.txt
<repo>/.orca/worktrees/<id>/         linked worktree, branch orca/<id>
<repo>/.orca/secrets/finish-webhook.env
```

`init` appends `.orca/` to the repo `.gitignore` if it is missing. Commit that line if you share the repo. Do not commit `.orca/`.

Commands resolve the primary checkout from the current directory, including from a job worktree (`git rev-parse --git-common-dir`). Pass `--cwd <repo>` from anywhere else.

## Commands

```bash
orca init [--cwd <repo>]
orca new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi] \
  [--orchestrator-model <alias>] [--worker-model <alias>]
orca run <id> [--dry-run] [--cwd <repo>] \
  [--orchestrator-model <alias>] [--worker-model <alias>]
orca worker --job <id> --name <agent> --task "..." [--model <alias>] [--dry-run]
orca status [id] [--cwd <repo>]
orca steer <id> "message"
orca stop <id> [reason] [--dry-run]
orca webhook <id> [--dry-run] [--force] [--cwd <repo>]
orca help
```

`--kind` defaults to `claude`.

`claude` jobs store `orchestratorModel` and `workerModel` on the job file. Defaults are `opus` (Opus 5.5) and `sonnet` (Sonnet 5.5). Those are aliases from `claude --help`, not pinned ids, so they track the latest model of that family. `new` sets them. A real `run` writes any override back onto the job before it starts. `--dry-run` prints the override and does not write it. `orca worker --model` overrides one worker; the job default stays `workerModel`. The lead alias is also stored as `model`, the same value as `orchestratorModel`.

`run` starts `claude --model <orchestratorModel>` in a new Herdr workspace whose cwd is the worktree. The orchestrator is not the implementer. It starts workers with `orca worker`, which splits a pane in that same workspace and runs `claude --model <workerModel>`. Herdr has no `--model` flag; the alias is an agent argument.

An alias is checked against `claude --help` before the job is stored or started. An unknown alias fails and lists the aliases `claude --help` names, when it names any. A full model name (`claude-…`) is accepted when help says a full name is accepted. `opus-5-5` is not an alias.

`pi` jobs: one `pi` process in that worktree. No Opus, no Sonnet, no workers, no model flags.

If the lead (or a worker) is still `idle` about 8 seconds after the prompt, orca sends the prompt once more. That is the startup swallow retry, not a second task.

`status` reads the job file. It does not poll Herdr. For one job it also prints the finish-wake record.

`steer` prompts the lead agent and records the message on the job.

`stop` closes the job's Herdr workspace (or interrupts the lead if there is no workspace) and sets `stopped`. It does not delete the worktree or the branch. The finish wake, if configured, is sent after that status is saved. `--dry-run` prints the plan and does not stop or send.

`webhook` previews or retries that POST. It does not change job status.

`claude` must already be on `PATH` inside the pane, and on `PATH` here so aliases can be checked. This CLI does not install it.

## Trust

orca does not mark a job `done` when the agent goes idle. The summary file is the completion note; `status` stays `running` until you `stop` it. A failed `run` leaves the worktree in place and marks the job `failed`. Both of those marks can POST the finish wake. Look at the branch before you merge. The worktree is not a sandbox.
