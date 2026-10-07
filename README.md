# orca

Local jobs for one git repo. `orca init` marks the repo. `orca run` checks out a linked worktree and starts an agent there, in a Herdr pane. You decide what to merge.

Not a fork of [limen](https://github.com/overment/limen). Not the old `orch` script. Fresh Node ESM, zero dependencies. Local git only.

## How it works

![How orca works](docs/orca-how-it-works.png)

You run `orca run`. The CLI checks out branch `orca/<id>` in a linked worktree and spawns a Herdr pane there. The pane runs an orchestrator that splits the goal and starts one worker per task, several in parallel when tasks are independent, all in the same worktree. A Claude job uses `opus` for the orchestrator and `sonnet` for workers; a Pi job uses Pi for both. After the builders report, the orchestrator starts one dedicated verifier worker (`orca worker --role verifier`). It runs `orca verify`, the project's own checks, and targeted `agent-browser` checks against the goal's acceptance criteria, and writes a pass/fail verdict. On fail the orchestrator routes each blocking failure, with the verifier's evidence, back to the builder that owns it and starts the verifier again. There is no round cap unless you set `--max-rounds N`. If the same check fails two rounds in a row, orca flags a stall and the orchestrator must change strategy (and record it with `orca strategy`) instead of repeating itself. It gives up with `orca done --give-up` only when it truly cannot progress. Failures that also fail on the base commit are warnings, not blockers. The orchestrator itself never runs `orca verify`. When the CLI marks the job `done`, `failed`, or `stopped`, it can POST `{job, status, branch}` (plus `verifier` and `verification` when a verifier ran) to Grok Bot (`orca-finish-wake`).

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

When a verifier gave a verdict, the body also carries `verifier`:

```json
{"job":"<id>","status":"done","branch":"orca/<id>","verifier":"verified by verifier: pass, round 2",
 "verification":{"verdict":"pass","rounds":2,"strategyChanges":["rewrote the worker prompt with the verifier's evidence"],
  "blocking":[],"warnings":[{"check":"editor #scrub on /clips/flowchart/","evidence":"element not found"}]}}
```

`job` is the id. `status` is the status just saved. `branch` is the job branch. `verifier` is sent only when `job.verifier` has a verdict: `verified by verifier: pass, round 2` or `verifier: fail, round 3`. `verification` is sent with it: `verdict`, `rounds`, `strategyChanges` (strings), `blocking` and `warnings` (each `{check, evidence}`), and `stopReason` when the job gave up. Without a verifier the body is exactly `{job, status, branch}`. It is not the old `herdr-finish-watch` body.

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
  [--orchestrator-model <alias>] [--worker-model <alias>] [--max-rounds N]
orca run <id> [--dry-run] [--keep] [--cwd <repo>] \
  [--orchestrator-model <alias>] [--worker-model <alias>] [--max-rounds N]
orca worker --job <id> --name <agent> --task "..." [--model <alias>] [--dry-run]
orca worker --job <id> --name verifier --role verifier --task "<built + acceptance criteria>"
orca status [id] [--cwd <repo>]
orca steer <id> "message"
orca stop <id> [reason] [--dry-run] [--keep]
orca done <id> [reason] [--give-up "<reason>"] [--dry-run] [--keep] [--cwd <repo>]
orca strategy <id> "<what changed>"
orca cleanup [--dry-run] [--older-than 12h] [--cwd <repo>]
orca watch <id> [--dry-run] [--cwd <repo>]   # started by orca run, not for hand use
orca webhook <id> [--dry-run] [--force] [--cwd <repo>]
orca verify <id> [--base] [--dry-run] [--cwd <repo>]
orca help
```

`--kind` defaults to `claude`. `--max-rounds N` (positive integer) on `new` or `run` stores `job.maxRounds`, an opt-in ceiling on verifier rounds; by default there is none. `--role` on `orca worker` is `builder` (default) or `verifier`.

`claude` jobs store `orchestratorModel` and `workerModel` on the job file. Defaults are `opus` (Opus 5.5) and `sonnet` (Sonnet 5.5). Those are aliases from `claude --help`, not pinned ids, so they track the latest model of that family. `new` sets them. A real `run` writes any override back onto the job before it starts. `--dry-run` prints the override and does not write it. `orca worker --model` overrides one worker; the job default stays `workerModel`. The lead alias is also stored as `model`, the same value as `orchestratorModel`.

`run` starts `claude --model <orchestratorModel>` in a new Herdr workspace whose cwd is the worktree. The orchestrator is not the implementer. It starts workers with `orca worker`, which splits a pane in that same workspace and runs `claude --model <workerModel>`. Herdr has no `--model` flag; the alias is an agent argument.

An alias is checked against `claude --help` before the job is stored or started. An unknown alias fails and lists the aliases `claude --help` names, when it names any. A full model name (`claude-…`) is accepted when help says a full name is accepted. `opus-5-5` is not an alias.

`pi` jobs: `run` starts a Pi orchestrator (`pi`, role orchestrator) in that workspace. It is not the implementer. It starts Pi workers with `orca worker`, each in a split pane running `pi` in the same worktree. No Opus, no Sonnet. `--orchestrator-model`, `--worker-model` and `orca worker --model` are refused for `pi`.

For both kinds the orchestrator splits the goal into tasks and starts one worker per task. Independent tasks start in parallel (several `orca worker` calls). Workers share one worktree, so no two workers get the same files.

If the lead (or a worker) is still `idle` about 8 seconds after the prompt, orca sends the prompt once more. That is the startup swallow retry, not a second task.

`status` reads the job file. It does not poll Herdr. For one job it also prints the finish-wake record, and verify once it has run or a checks file is present. If a verifier ran it also prints the rounds, the last failing checks, the stall (if any), and the strategy changes, and records the latest round first.

`steer` prompts the lead agent and records the message on the job. It also works on a `done`, `failed` or `stopped` job whose orchestrator pane still exists: that starts a follow-up round (see Follow-up rounds).

`stop` interrupts the lead and its workers and sets `stopped`. It leaves the Herdr workspace open (see Cleanup). It does not delete the worktree or the branch. The finish wake, if configured, is sent after that status is saved, then terminal cleanup runs (see Cleanup). `--dry-run` prints the plan and does not stop or send.

`done` marks a running job `done` (reason defaults to `completed`) and sends the finish wake once, then frees what the job no longer needs (see Cleanup): browser sessions, worktree dev servers and finished worker panes. The orchestrator pane and the workspace stay open so you can still give feedback. A queued job is refused with exit 1, since nothing ran. If a verifier ran, `done` reads `results/verifier.json` and records the verdict on `job.verifier`; a final verdict of `fail` marks the job `failed` (reason `verifier failed after N rounds: <blocking checks>`) instead of `done`. `--give-up "<reason>"` marks the job `failed` with that reason and stores it as `job.verifier.stopReason`; the orchestrator uses it only when it cannot progress. An already `done`, `failed`, or `stopped` job prints that status, exits 0, and sends nothing. `--dry-run` prints the plan and the finish payload, and does not change status or send.

`strategy` appends `<what changed>` to `job.verifier.strategyChanges` for the current round and prints the count. The orchestrator runs it after changing approach on a stall.

`webhook` previews or retries that POST. It does not change job status.

`cleanup` closes the workspaces of finished jobs that have been idle for a while. See Cleanup.

`watch` is the needs-input watcher that `run` starts in the background. See Needs-input watcher.

`verify` runs project browser checks in the job worktree. See Verify. It does not set the job to `done`; `orca done` does. The verifier worker runs it, not the orchestrator. `--base` runs the same checks against the base commit instead (see Verify).

`claude` must already be on `PATH` inside the pane, and on `PATH` here so aliases can be checked. This CLI does not install it. `agent-browser` must be on `PATH` for `verify` and the verifier. This CLI does not install that either.

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

`orca verify <id> --base` runs the same checks file in a temporary detached worktree at the commit the job branch started from (`job.baseCommit`; older jobs fall back to `git merge-base <branch> main`). The worktree is removed afterwards. It writes `results/verify-base.json` and leaves `job.verify` alone:

```json
{"base":"<sha>","steps":[{"index":9,"name":"...","outcome":"fail"}]}
```

A step that fails on base too is pre-existing, not caused by the job.

orca does not watch workers. The orchestrator no longer runs `orca verify`; the verifier worker does (see below). You can run it yourself any time the worktree exists. `status` prints `verify` once it has run, or `not run` when a checks file is present and verify has not.

## Verifier worker

After all builders report, the orchestrator starts exactly one verifier: `orca worker --job <id> --name verifier --role verifier --task "..."`. The name must be `verifier`. It works for `claude` and `pi` jobs and uses the job's worker model. Each start increments `job.verifier.rounds`. There is no cap by default. If the job has `maxRounds`, a start with `rounds >= maxRounds` is refused with an error. The prompt says `round N`, or `round N of M` when a ceiling is set.

The verifier gets a fresh context in the same worktree. It runs:

- `orca verify <id>`;
- the project's own checks (`npm test`, `npm run check`, when present in `package.json`);
- targeted `agent-browser` checks against the goal's acceptance criteria, in one session named `<prefix>-verifier`, closed at the end.

It must not edit product code. For every failing check it tests whether the failure is pre-existing: `orca verify <id> --base`, or the same project command at the base commit. It may author or extend `orca.verify.json` only to cover the goal's acceptance criteria. It never weakens or deletes a check to make it pass. It writes `results/verifier.json` and `notes/verifier.txt`, then prompts the orchestrator like any worker.

```json
{
  "name": "verifier",
  "role": "verifier",
  "round": 2,
  "verdict": "pass",
  "checks": [{ "name": "npm test", "outcome": "pass", "scope": "job", "notes": "..." }],
  "failures": [],
  "warnings": [
    { "check": "editor #scrub on /clips/flowchart/", "evidence": "#scrub not visible", "base": "<sha>", "proof": "fails on base via orca verify --base" }
  ],
  "summary": "..."
}
```

`verdict` is `pass` or `fail`. `outcome` is `pass`, `fail`, or `skipped`. `scope` is `job` or `preexisting`.

`failures` are blocking: they cover what this job changed. Each is `{check, evidence}` with a stable check name and the exact error, step, url, or command output. A failure is a `warnings` entry only if it is shown mechanically to fail on the base commit too (`orca verify --base`, or the same command at the base). Otherwise it blocks. `verdict` is `pass` when `failures` is empty, even with warnings. Plain string failures are still accepted (the string is the check name).

Example: a diagram-only job failed `orca verify` step 9/82 because `#scrub` was missing on `/clips/flowchart/`. That check also fails on base, so it is a warning, not a blocker.

Loop: on `fail` the orchestrator reads `results/verifier.json`, routes each blocking failure with its evidence to the builder that owns those files (warnings are ignored for routing), then starts the verifier again. It runs `orca status <id>` after each round. There is no round limit unless `--max-rounds` was set.

Stall: if the same blocking check fails in two consecutive rounds, `status` reports a stall. The orchestrator must not repeat the instruction. It changes strategy (rewrite the worker prompt with the evidence verbatim, split the work differently, start a fresh worker instead of resuming, or take another approach), records it with `orca strategy <id> "<change>"`, and re-verifies. It stops only when the same failure survived 3 different strategy changes, or the fix needs a human decision or a secret, with `orca done <id> --give-up "<plain reason>"`. The orchestrator never marks its own work verified, never runs `orca verify`, and never edits checks.

The job record carries the outcome:

```json
{"verifier":{"rounds":3,"verdict":"pass",
 "history":[{"round":1,"verdict":"fail","failing":["npm test"],"warnings":[],"at":"<iso>"},
            {"round":2,"verdict":"fail","failing":["npm test"],"warnings":["editor #scrub"],"at":"<iso>"},
            {"round":3,"verdict":"pass","failing":[],"warnings":["editor #scrub"],"at":"<iso>"}],
 "stall":{"checks":["npm test"],"rounds":[1,2]},
 "strategyChanges":[{"round":2,"change":"fresh worker with verifier evidence","at":"<iso>"}],
 "stopReason":"<only when given up>"}}
```

`stall` is set when the failing sets of two consecutive rounds intersect, and holds the shared checks and the two rounds. orca records a round as soon as it can: when the next verifier round starts, on `orca status`, and in `orca done`.

`orca done` records the verdict and history for the latest round. A final `fail` marks the job `failed` (`verifier failed after N rounds: <blocking checks>`); otherwise `done`. With no verifier run, behaviour is unchanged. The finish wake line and `orca status` report `verified by verifier: pass, round 2` (or `verifier: fail, round 3`), and nothing when no verifier ran. The same text is the `verifier` field of the finish wake payload, alongside the `verification` object.

## Cleanup

Finished jobs must not pile up stale panes, but you may still want to give feedback to the orchestrator after `orca done`. So cleanup is delayed and split in two.

**Right away** on `orca done`, `orca stop` and the `failed` path of `orca run` (after the status is saved and the finish webhook delivered), orca frees only what nobody can still use:

- the job's `agent-browser` sessions (`agent-browser --session <s> close`);
- dev or preview servers whose process cwd is inside the job worktree (never the orca process or its ancestors; a process is treated as a server by a heuristic on its command line);
- the panes of finished workers and the verifier (`herdr pane close <pane>`, for each worker pane recorded in `job.workers`).

What was closed is stored in `job.cleanup` (`browsers`, `servers`, `panes`). The orchestrator pane and the Herdr workspace stay open. Records, worktrees and branches are never deleted. One line is printed per thing closed:

```text
cleanup: closed browser orca-1a2b3c4d-docs
cleanup: stopped server pid 4242 (node dev.mjs)
cleanup: closed worker pane <p> (w1)
```

**Later**, `orca cleanup [--dry-run] [--older-than 12h] [--cwd <repo>]` closes the workspace (`herdr workspace close`) of every job that is `done`, `stopped` or `failed`, not `keep`, and idle longer than the threshold. Idle is measured from the latest of the finish time, steers, verifier rounds and follow-up rounds, so a job you just steered is not stale. The threshold is `--older-than` (`30m`, `12h`, `2d`; a bare number is refused), else `"staleAfter"` in `.orca/config.json` (for example `"staleAfter": "6h"`), else 12 hours. A workspace is closed once; `job.workspaceClosed` records it. The same command also closes `orca-` prefixed `agent-browser` sessions of jobs that are not running and orphaned sessions whose owning process is dead. `--dry-run` prints `would close` lines, and `cleanup: nothing to close` is printed when there is nothing.

The same stale-workspace sweep runs opportunistically and quietly at the start of `orca new` and `orca run` (one line on stderr, only when it closed something; never on stdout, which `new` uses for the id). There is no cron and no polling.

Sessions have deterministic names. The prefix is `orca-` plus the first 8 hex chars of `sha1(job.id)`. A worker's session is `<prefix>-<worker>`; `orca verify` uses `<prefix>-verify`; the verifier worker uses `<prefix>-verifier`. The rule is one `agent-browser` session per worker, named that way, never a shared or default one. orca records the names it hands out on `job.browserSessions`.

`--keep` opts out of everything. On `orca done` and `orca stop` it skips the immediate cleanup for that call. On `orca new` or `orca run` it stores `keep: true` on the job, which skips immediate cleanup on every terminal path and exempts the job from the stale sweep. `--dry-run` on `done` and `stop` prints what would be closed.

## Follow-up rounds

`orca steer <id> "message"` accepts a finished job as long as its orchestrator agent pane still exists (not if the workspace was already swept). It prompts the orchestrator, sets the status back to `running`, increments `job.round`, and updates the activity time. When the orchestrator calls `orca done` again, the finish wake is sent again for the new round instead of being suppressed as already sent. The payload adds `"round": N` and `"followUp": true` (round 1 payloads are unchanged), for example:

```json
{"job":"<id>","status":"done","branch":"orca/<id>","round":2,"followUp":true}
```

`<id>.finish.json` keeps a per-round record: `rounds: [{round, status, at, followUp}]`, and every attempt carries its `round`. `job.finishRounds` lists the same rounds on the job. A `done` on a job that was not steered is still a no-op.

## Ports

`orca new` allocates a block of 4 ports for the job with `lib/ports.mjs` (derived from the job id, checked free, never shared with another unfinished job) and stores `job.port` (the first) and `job.ports`. They are exported as `ORCA_PORT`, `ORCA_PORTS` and `PORT` into the orchestrator and worker panes (the Herdr workspace and pane split `--env`) and into `orca verify` scripts. Herdr's `agent start` has no env option, so every prompt also states the ports. In `orca.verify.json`, `${ORCA_PORT}`, `${ORCA_PORT_2}` (the second port, and so on) and `{{port}}` expand in every url and command. `orca status` prints the port. Jobs created before this have no port and keep working (`orca run` allocates one).

The orchestrator, worker and verifier prompts say: use your job port(s) for any dev or preview server; decide operational questions yourself by taking the safe recommended option (stop a stale server left by a finished orca job, or pick your own port) instead of asking; ask only when a genuine human decision or a secret is required.

## Needs-input watcher

A job must never sit silently waiting for an answer. `orca run` starts a detached watcher (`orca watch <id>`, log at `.orca/jobs/<id>/watcher.log`, pid in `job.watcherPid`). When the orchestrator agent is `blocked`, or `idle` for over a minute without the job being finished, it POSTs through the same `finish-webhook.env` config:

```json
{"kind":"needs-input","job":"<id>","title":"<title>","status":"blocked","question":"<text of the question on the pane>","pane":"<orchestrator pane>"}
```

`status` is `blocked` or `idle`. Each waiting episode is posted once. The watcher exits when the job is `done`, `failed` or `stopped` (`markTerminal` also stops it), when the agent is gone, or on its own `SIGTERM`. With no webhook configured it logs and skips. `orca watch <id> --dry-run` prints what it would do. Claude Code's own housekeeping popups ("Teach auto mode about your environment?", session feedback survey) are not questions: the watcher dismisses them itself with `herdr agent send-keys`, logs `housekeeping-dismissed <id> <name>`, and sends no alert. The known popups live in `HOUSEKEEPING_POPUPS` in `lib/watch.mjs` (name, matcher regex, dismiss keys); the matcher only sees the last 15 non-empty pane lines and must target the dialog's own title, so add an entry there only with an exact dialog title. A follow-up `steer` on a finished job starts a new watcher. Workers never post; only `orca done`, `stop` and a failed `run` send the finish wake.

## Trust

orca does not mark a job `done` when the agent goes idle. The summary file is the completion note; `status` stays `running` until the orchestrator runs `orca done <id>` (or you `stop` it). A failed `run` leaves the worktree in place and marks the job `failed`. Done, failed, and stopped marks can all POST the finish wake. Look at the branch before you merge. The worktree is not a sandbox.
