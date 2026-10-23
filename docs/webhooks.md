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

Off unless `<repo>/.orka/secrets/finish-webhook.env` exists. A missing file does not send and does not error. orka does not read `~/.config`, `~/bin/herdr-finish-watch`, the process environment, or any other home path for a destination. Do not symlink the file out of `.orka`. An escaped symlink is refused.

The file is assignments, not a shell script. `export` and quotes are accepted. Mode 600. Do not commit it. `init` gitignores `.orka/`. The keys match `herdr-finish-wake.env`, so you can point orka at that Grok Bot URL for now:

```dotenv
WEBHOOK_URL=https://example.invalid/automations/webhook/REPLACE_ME
WEBHOOK_KEY=REPLACE_ME
```

`WEBHOOK_KEY` is the raw token, not a `Bearer ` prefix. orka sends `Authorization: Bearer <key>` and `X-Automation-Key: <key>`. The URL must be `https`, with no userinfo and no fragment. Copy `examples/finish-webhook.env`, replace the placeholders, and `chmod 600` the copy. The POST waits about 8 seconds. HTTP acceptance is not proof the bot woke.

A bad file or a failed POST is recorded at `<repo>/.orka/jobs/<id>.finish.json`. That record holds no secrets. Sender failure does not change the job status. One automatic attempt. `orka stop` or `orka done` on an already terminal job does not send again. If the env file was missing at stop, nothing is recorded; add the file and run `orka webhook <id>`.

`orka webhook <id>` retries a failed attempt and appends the result, so a retry is not a silent duplicate. If the last attempt was accepted, or is still `attempting` or `unknown` (the POST may have landed), it does not send unless you pass `--force`. `--force` records another attempt. `--dry-run` prints the payload and the URL origin, not the key or the URL path, and does not send.

```bash
orka webhook <id> --dry-run
orka stop <id> --dry-run
orka done <id> --dry-run
node --test test/finish-webhook.test.mjs
```

Agents must not run `herdr-finish-watch`, `orka webhook`, or `orka stop`. Only the orchestrator runs `orka done`, once, at the end, after Olaf's `orka approve`. The CLI sends the wake after it has saved the terminal status.

The needs-input alert uses the same env file; see [needs-input.md](needs-input.md).
