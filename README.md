# orca

Local jobs for one git repo. `orca init` marks the repo. `orca run` checks out a linked worktree and starts an agent there, in a Herdr pane. You decide what to merge.

Not a fork of [limen](https://github.com/overment/limen). Not the old `orch` script. Fresh Node ESM, zero dependencies. Local git only.

## How it works

![How orca works](docs/orca-how-it-works.png)

You run `orca run`. The CLI checks out branch `orca/<id>` in a linked worktree and spawns a Herdr pane there. The pane runs an orchestrator that splits the goal and starts one worker per task, several in parallel when tasks are independent, all in the same worktree. A Claude job uses `opus` for the orchestrator and `sonnet` for workers; a Pi job uses Pi for both. Optional `orca verify` drives `agent-browser` from `orca.verify.json`. When the CLI marks the job `done`, `failed`, or `stopped`, it can POST `{job, status, branch}` to Grok Bot (`orca-finish-wake`).

## How this differs from limen

Limen is a Pi coordinator you talk to. It plants tickets, a board, role prompts, reviewers, and advisors, and it can POST a finish webhook when a job ends.

Orca is the CLI. You file a job and run it. There is no coordinator conversation, no ticket board, and no package hooks in the target repo. A Claude job starts an orchestrator (default `opus`, Opus 5.5); that orchestrator starts workers (default `sonnet`, Sonnet 5.5) with `orca worker`, in parallel when tasks are independent. Either alias can be overridden per job. A Pi job is a Pi orchestrator starting Pi workers. When the CLI marks a job `done`, `failed`, or `stopped`, it can POST a finish wake. Agents do not send it.

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

Today the CLI writes `done` from `orca done`, `stopped` from `orca stop`, and `failed` when `orca run` fails after the worktree or pane exists. All call the same sender after the status is saved. Idle is not terminal. A summary file does not send the wake. The success path is the orchestrator running `orca done <id>` after verify and the summary; that marks the job `done` and fires the wake once. `orca webhook` can also POST a job that is already `done`.

Off unless `<repo>/.orca/secrets/finish-webhook.env` exists. A missing file does not send and does not error. orca does not read `~/.config`, `~/bin/herdr-finish-watch`, the process environment, or any other home path for a destination. Do not symlink the file out of `.orca`. An escaped symlink is refused.

The file is assignments, not a shell script. `export` and quotes are accepted. Mode 600. Do not commit it. `init` gitignores `.orca/`. The keys match `herdr-finish-wake.env`, so you can point orca at that Grok Bot URL for now:

```dotenv
WEBHOOK_URL=https://example.invalid/automations/webhook/REPLACE_ME
WEBHOOK_KEY=REPLACE_ME
```

`WEBHOOK_KEY` is the raw token, not a `Bearer ` prefix. orca sends `Authorization: Bearer <key>` and `X-Automation-Key: <key>`. The URL must be `https`, with no userinfo and no fragment. Copy `examples/finish-webhook.env`, replace the placeholders, and `chmod 600` the copy. The POST waits about 8 seconds. HTTP acceptance is not proof the bot woke.

A bad file or a failed POST is recorded at `<repo>/.orca/jobs/<id>.finish.json`. That record holds no secrets. Sender failure does not change the job status. One automatic attempt. `orca stop` or `orca done` on an already terminal job does not send again. If the env file was missing at stop, nothing is recorded; add the file and run `orca webhook <id>`.

`orca webhook <id>` retries a failed attempt and appends the result, so a retry is not a silent duplicate. If the last attempt was accepted, or is still `attempting` or `unknown` (the POST may have landed), it does not send unless you pass `--force`. `--force` records another attempt. `--dry-run` prints the payload and the URL origin, not the key or the URL path, and does not send.

```bash
orca webhook <id> --dry-run
orca stop <id> --dry-run
orca done <id> --dry-run
node --test test/finish-webhook.test.mjs
```

Agents must not run `herdr-finish-watch`, `orca webhook`, or `orca stop`. Only the orchestrator runs `orca done`, once, at the end. The CLI sends the wake after it has saved the terminal status.

## Layout

Workers share the job worktree. They do not get sibling checkouts. Concurrent edits can clash; keep tasks from touching the same files. Sibling worktrees are later, if a job needs them.

```text
<repo>/.orca/config.json             local mark (gitignored)
<repo>/.orca/jobs/<id>.json          job record
<repo>/.orca/jobs/<id>.finish.json   finish-wake attempts (no secrets)
<repo>/.orca/jobs/<id>/              results/, notes/, summary.txt, verify.log
<repo>/.orca/worktrees/<id>/         linked worktree, branch orca/<id>
<worktree>/orca.verify.json          optional browser checks (commit this; not under .orca/)
<repo>/.orca/secrets/finish-webhook.env
```

`init` appends `.orca/` to the repo `.gitignore` if it is missing. Commit that line if you share the repo. Do not commit `.orca/`.

Commands resolve the primary checkout from the current directory, including from a job worktree (`git rev-parse --git-common-dir`). Pass `--cwd <repo>` from anywhere else.

## Commands

```bash
orca init [--cwd <repo>]
orca new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi] [--keep] \
  [--orchestrator-model <alias>] [--worker-model <alias>]
orca run <id> [--dry-run] [--keep] [--cwd <repo>] \
  [--orchestrator-model <alias>] [--worker-model <alias>]
orca worker --job <id> --name <agent> --task "..." [--model <alias>] [--dry-run]
orca status [id] [--cwd <repo>]
orca steer <id> "message"
orca stop <id> [reason] [--dry-run] [--keep]
orca done <id> [reason] [--dry-run] [--keep] [--cwd <repo>]
orca cleanup [--dry-run] [--cwd <repo>]
orca webhook <id> [--dry-run] [--force] [--cwd <repo>]
orca verify <id> [--dry-run] [--cwd <repo>]
orca help
```

`--kind` defaults to `claude`.

`claude` jobs store `orchestratorModel` and `workerModel` on the job file. Defaults are `opus` (Opus 5.5) and `sonnet` (Sonnet 5.5). Those are aliases from `claude --help`, not pinned ids, so they track the latest model of that family. `new` sets them. A real `run` writes any override back onto the job before it starts. `--dry-run` prints the override and does not write it. `orca worker --model` overrides one worker; the job default stays `workerModel`. The lead alias is also stored as `model`, the same value as `orchestratorModel`.

`run` starts `claude --model <orchestratorModel>` in a new Herdr workspace whose cwd is the worktree. The orchestrator is not the implementer. It starts workers with `orca worker`, which splits a pane in that same workspace and runs `claude --model <workerModel>`. Herdr has no `--model` flag; the alias is an agent argument.

An alias is checked against `claude --help` before the job is stored or started. An unknown alias fails and lists the aliases `claude --help` names, when it names any. A full model name (`claude-…`) is accepted when help says a full name is accepted. `opus-5-5` is not an alias.

`pi` jobs: `run` starts a Pi orchestrator (`pi`, role orchestrator) in that workspace. It is not the implementer. It starts Pi workers with `orca worker`, each in a split pane running `pi` in the same worktree. No Opus, no Sonnet. `--orchestrator-model`, `--worker-model` and `orca worker --model` are refused for `pi`.

For both kinds the orchestrator splits the goal into tasks and starts one worker per task. Independent tasks start in parallel (several `orca worker` calls). Workers share one worktree, so no two workers get the same files.

If the lead (or a worker) is still `idle` about 8 seconds after the prompt, orca sends the prompt once more. That is the startup swallow retry, not a second task.

`status` reads the job file. It does not poll Herdr. For one job it also prints the finish-wake record, and verify once it has run or a checks file is present.

`steer` prompts the lead agent and records the message on the job.

`stop` closes the job's Herdr workspace (or interrupts the lead if there is no workspace) and sets `stopped`. It does not delete the worktree or the branch. The finish wake, if configured, is sent after that status is saved, then terminal cleanup runs (see Cleanup). `--dry-run` prints the plan and does not stop or send.

`done` marks a running job `done` (reason defaults to `completed`) and sends the finish wake once, then runs terminal cleanup (see Cleanup), which closes the job's browser sessions and Herdr workspace. It does not interrupt the lead before that. A queued job is refused with exit 1, since nothing ran. An already `done`, `failed`, or `stopped` job prints that status, exits 0, and sends nothing. `--dry-run` prints the plan and the finish payload, and does not change status or send.

`webhook` previews or retries that POST. It does not change job status.

`cleanup` is a one-shot sweep of the repo's finished jobs. See Cleanup.

`verify` runs project browser checks in the job worktree. See Verify. It does not set the job to `done`; `orca done` does.

`claude` must already be on `PATH` inside the pane, and on `PATH` here so aliases can be checked. This CLI does not install it. `agent-browser` must be on `PATH` for `verify`. This CLI does not install that either.

## Verify

`orca verify <id>` drives `agent-browser` from checks the project supplies. It does not know your app's URL, host, or port. Nothing in orca is tied to one repo's dev server.

Checks are read from the job worktree, so the branch under test is what runs. Default file: `orca.verify.json` at that root. Commit it if later jobs should run it. Do not put it under `.orca/`. `init` gitignores `.orca/`, and a gitignored file is not in a new worktree.

To put the file somewhere else, set `verify` in the primary checkout's `.orca/config.json` to a path relative to the worktree:

```json
{ "verify": "scripts/check.json" }
```

`"verify": false` disables checks even if a file exists. An explicit path that is missing fails and records `failed`. A missing default file skips.

Skip is not a pass and not a failure. Exit 0. The job records `verify.status` `skipped`. A JSON checks file must assert something. Empty, invalid, or failing checks fail closed: exit 1, `verify.status` `failed`. The log is `<repo>/.orca/jobs/<id>/verify.log`.

Nothing is assumed to be serving. The file names the URL. Start the app first, or point `verify` at a script that starts it and then calls `agent-browser`.

JSON is the shape an agent should write. An array step is an `agent-browser` command. `is visible` exits 0 when the element is hidden, so orca requires that state to be true. Object steps cover the asserts exit codes get wrong:

```json
{
  "steps": [
    ["open", "http://127.0.0.1:3000/"],
    ["wait", "--text", "Ready"],
    { "visible": "h1" },
    { "text": "h1", "includes": "Ready" }
  ]
}
```

Also: `click`, `fill` as `[selector, text]`, `press`, `wait`, `waitText`, `title`, `titleIncludes`, `urlIncludes`, `count` plus `equals` (a number), and `get` plus `equals` or `includes` for `text`, `title`, `url`, `count`, `value`, `attr`. A top-level `note` is ignored. Any other field fails. `examples/orca.verify.json` is an example only. orca does not run it.

A non-JSON checks file is a script. orca runs it in the worktree with `AGENT_BROWSER_SESSION` set to the job's verify session (`<prefix>-verify`, see Cleanup), plus `ORCA_JOB`, `ORCA_REPO`, `ORCA_WORKTREE`, and `ORCA_BRANCH`. It closes that session when the script exits. The script must exit non-zero when a check fails. Use this when the check has to boot a server. Prefer JSON when the app is already up. A script is stopped after 600s. A JSON step is stopped after 90s.

orca does not watch workers. The orchestrator is told to run `orca verify <id>` after workers report and before the summary.  You can run it yourself any time the worktree exists. `status` prints `verify` once it has run, or `not run` when a checks file is present and verify has not.

## Cleanup

orca cleans up after itself so finished jobs do not leave Herdr workspaces or browser sessions running.

Terminal cleanup runs on `orca done`, `orca stop`, and the `failed` path of `orca run`. It runs after the status and summary are saved and the finish webhook has been delivered. It closes every `agent-browser` session whose name starts with the job prefix (`agent-browser --session <s> close`), then closes the job's Herdr workspace (`herdr workspace close`). It only closes the `workspace` recorded on that job's record, never one found by label. The job record, worktree, and branch are kept. One line is printed per thing closed:

```text
cleanup: closed browser orca-1a2b3c4d-docs
cleanup: closed workspace <w>
```

Output is printed before the workspace closes, because closing it kills the calling orchestrator pane.

Sessions have deterministic names. The prefix is `orca-` plus the first 8 hex chars of `sha1(job.id)`. A worker's session is `<prefix>-<worker>`; `orca verify` uses `<prefix>-verify`. The rule is one `agent-browser` session per worker, named that way, never a shared or default one. orca records the names it hands out on `job.browserSessions`.

Opt out with `--keep`. On `orca done` and `orca stop` it skips cleanup for that call. On `orca new` or `orca run` it stores `keep: true` on the job, which skips cleanup on every terminal path. `--dry-run` on `done` and `stop` prints what cleanup would close.

`orca cleanup [--dry-run] [--cwd <repo>]` is a one-shot sweep, not a cron or a poller. For jobs of the repo it:

- closes the Herdr workspace of every job that is `done`, `stopped`, or `failed`, unless the job has `keep`;
- closes `orca-` prefixed `agent-browser` sessions whose job is not running;
- closes orphaned `agent-browser` sessions whose owning process is dead. If that cannot be determined, this step is skipped.

It prints each item closed, or `would close` with `--dry-run`, and `cleanup: nothing to close` when there is nothing.

## Trust

orca does not mark a job `done` when the agent goes idle. The summary file is the completion note; `status` stays `running` until the orchestrator runs `orca done <id>` (or you `stop` it). A failed `run` leaves the worktree in place and marks the job `failed`. Done, failed, and stopped marks can all POST the finish wake. Look at the branch before you merge. The worktree is not a sandbox.
