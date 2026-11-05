# Finish wake and webhooks

When the CLI marks a job `done`, `failed`, or `stopped`, it POSTs once:

```json
{"job":"<id>","status":"stopped","branch":"orka/<id>"}
```

When a verifier gave a verdict, the body also carries `verifier`:

```json
{"job":"<id>","status":"done","branch":"orka/<id>","verifier":"verified by verifier: pass, round 2",
 "verification":{"verdict":"pass","rounds":2,"strategyChanges":["rewrote the worker prompt with the verifier's evidence"],
  "blocking":[],"warnings":[{"check":"editor #scrub on /clips/flowchart/","evidence":"element not found"}]}}
```

`job` is the id. `status` is the status just saved. `branch` is the job branch (`orka/<id>`; jobs created before the rename keep `orca/<id>`). The shape, field names, URL and key are unchanged by the rename. `verifier` is sent only when `job.verifier` has a verdict: `verified by verifier: pass, round 2` or `verifier: fail, round 3`. `verification` is sent with it: `verdict`, `rounds`, `strategyChanges` (strings), `blocking` and `warnings` (each `{check, evidence}`), and `stopReason` when the job gave up. Without a verifier the body is exactly `{job, status, branch}`. It is not the old `herdr-finish-watch` body.

Today the CLI writes `done` from `orka done`, `stopped` from `orka stop`, and `failed` when `orka run` fails after the worktree or pane exists. All call the same sender after the status is saved. Idle is not terminal. A summary file does not send the wake. The success path is the orchestrator running `orka review <id>` after verify and the summary (one POST with `"status":"review"`, see [review.md](review.md)), then `orka done <id>` after Olaf's sign-off; that marks the job `done` and fires the wake once. `orka webhook` can also POST a job that is already `done`.

## Where the POST goes

Each job has one destination, fixed at `orka new`. First match wins:

1. `orka new --wake <bot>`: `~/.config/<bot>-finish-wake.env`. The name must match `^[a-z0-9-]+$`. Or `orka new --wake-file <path>`: that file; a relative path is resolved against the current directory and stored absolute. Passing both is refused.
2. `ORKA_WAKE=<bot>` in the environment of `orka new`. It is stored on the job like `--wake`. orka reads it only at `new` (and in `orka chain`, see below), never when it sends. There is no `ORCA_WAKE`.
3. The repo file, `<repo>/.orka/secrets/finish-webhook.env`, for a job with neither. Off unless it exists: a missing repo file does not send and does not error.

```bash
orka new --wake orka --title "..." --goal "..."
orka status <id>        # wake: orka
```

The job's destination serves every notification about it: the finish wake, needs-input, `orka propose` and `orka review`.

A wake file must be usable at `orka new`: if it is missing, unreadable, not mode 600, or invalid, `orka new` exits 1 and creates no job. If it is gone at send time, nothing is sent and orka never falls back to the repo file, since that file may belong to another bot. The finish attempt is recorded as `failed` with the wake name and path; restore the file and run `orka webhook <id>`.

`orka chain` alerts belong to no job, so they go to `ORKA_WAKE` when it is set, else the repo file. Its jobs get `ORKA_WAKE` through `orka new`.

`orka status <id>` and `orka digest <id>` show `wake:` and `wake-file:`. Status prints `wake: repo default` for a job on the repo file.

orka does not read `~/bin/herdr-finish-watch`, `WEBHOOK_URL` from the process environment, or any other home path for a destination. Do not symlink the repo file out of `.orka`. An escaped symlink is refused.

## The env file

The file is assignments, not a shell script. `export` and quotes are accepted. Mode 600. Do not commit it. `init` gitignores `.orka/`. The keys match `herdr-finish-wake.env`, so you can point orka at that Grok Bot URL for now:

```dotenv
WEBHOOK_URL=https://example.invalid/automations/webhook/REPLACE_ME
WEBHOOK_KEY=REPLACE_ME
```

`WEBHOOK_KEY` is the raw token, not a `Bearer ` prefix. orka sends `Authorization: Bearer <key>` and `X-Automation-Key: <key>`. The URL must be `https`, with no userinfo and no fragment. Copy `examples/finish-webhook.env`, replace the placeholders, and `chmod 600` the copy. The POST waits about 8 seconds. HTTP acceptance is not proof the bot woke.

A bad file or a failed POST is recorded at `<repo>/.orka/jobs/<id>.finish.json`. That record holds no secrets. Each attempt names its destination (`wake` for a named wake, `wakeFile` for the path used) with `outcome`, `http` and `detail`, never the URL or the key. Sender failure does not change the job status. One automatic attempt. `orka stop` or `orka done` on an already terminal job does not send again. If the repo file was missing at stop, nothing is recorded; add the file and run `orka webhook <id>`.

`orka webhook <id>` retries a failed attempt and appends the result, so a retry is not a silent duplicate. If the last attempt was accepted, or is still `attempting` or `unknown` (the POST may have landed), it does not send unless you pass `--force`. `--force` records another attempt. `--dry-run` prints the payload and the URL origin, not the key or the URL path, and does not send.

```bash
orka webhook <id> --dry-run
orka stop <id> --dry-run
orka done <id> --dry-run
node --test test/finish-webhook.test.mjs
```

Agents must not run `herdr-finish-watch`, `orka webhook`, or `orka stop`. Only the orchestrator runs `orka done`, once, at the end, after Olaf's `orka approve`. The CLI sends the wake after it has saved the terminal status.

The needs-input alert uses the same destination; see [needs-input.md](needs-input.md).
