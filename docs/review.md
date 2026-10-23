# Review and sign-off

A job is not finished when the verifier passes. It waits for Olaf, and only his sign-off lets the orchestrator run `orka done`. The panes stay open while it waits, so he can still look at the work and ask for changes.

## The flow

1. **Review.** The verifier passed, the work is committed and `.orka/jobs/<id>/summary.txt` is written from the diff. The orchestrator runs `orka review <id>`. It refuses while the verifier verdict is `fail` or its pass is stale, and when summary.txt is missing. The job goes to `review`, decisions.tsv gets a `review` row, and the webhook (`.orka/secrets/finish-webhook.env`, if present) gets one POST:
   ```json
   {"job":"<id>","status":"review","branch":"orka/<id>","playbook":"feature","verifier":"...","kind":"review","title":"...","summary":"<summary.txt, up to 2000 chars>","question":"Sign off \"...\"? Approve the result: orka approve <id>. Request changes: orka steer <id> \"<what to change>\"."}
   ```
   `round` and `followUp` are added from round 2 on, as in the finish wake. The needs-input watcher stays quiet while the job is in review.
2. **Decide.**
   - `orka approve <id> ["note"]` is the sign-off. It records `job.signoff {round, at, note}` and prompts the orchestrator `Olaf signed off the result[: note]. Run orka done <id> now.` The status stays `review` until `orka done`. If the orchestrator pane is gone or the prompt fails, the sign-off still stands and Olaf runs `orka done <id>` himself (approve exits 1 and says so).
   - `orka steer <id> "what to change"` is a change request. The job goes back to `running`, any sign-off is cleared, and the orchestrator makes the changes, runs the verifier again, rewrites summary.txt and runs `orka review` again.
   - `orka stop <id>` ends it.
3. **Done.** `orka done <id>` marks the job done, sends the finish wake and cleans up only this job: its browsers, servers, worker panes and its worktree (`git worktree remove`, never forced; a dirty worktree is kept and reported). The branch stays. Other jobs are never touched; old worktrees of past done jobs go only with `orka cleanup` ([cleanup.md](cleanup.md)).

## What orka done refuses

`orka done` needs a sign-off for the current round (`job.signoff.round == job.round`). Without one it exits 1:

- on a running job: `no sign-off from Olaf. Run orka review <id> ... and wait for orka approve <id>.`
- on a job in review: `no sign-off from Olaf yet; the job is in review, waiting for orka approve <id>.`

Two ways out need no sign-off: `orka done <id> --give-up "<reason>"` (marks the job failed) and `orka stop <id>`. A follow-up round (a steer on a finished job) needs a new sign-off: the round-1 sign-off does not cover round 2.

## One verb, two meanings

`orka approve` acts on a job waiting for Olaf, and the job status says which approval it is:

| status | `orka approve <id>` | then |
| --- | --- | --- |
| `awaiting-direction` | approves the plan ([gate.md](gate.md)) | the orchestrator builds |
| `review` | signs off the result | the orchestrator runs `orka done` |
| anything else | exits 1 and names both | |

`orka status <id>`, `orka digest <id>` and `orka help` spell out which one applies: `gate: awaiting direction ... orka approve <id> approves the plan`, `review: awaiting Olaf's sign-off ... orka approve <id> signs off the result (then orka done)`. `orka approve` is refused inside a job pane (`ORKA_JOB` set), so an orchestrator cannot sign off its own work.
