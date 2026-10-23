# Follow-up rounds

`orka steer <id> "message"` accepts a finished job as long as its orchestrator agent pane still exists (not if the workspace was already swept). It prompts the orchestrator, sets the status back to `running`, increments `job.round`, and updates the activity time. The round ends like round 1: `orka review`, Olaf's `orka approve` (a new sign-off; the old one covers only its round), then `orka done`. When the orchestrator calls `orka done` again, the finish wake is sent again for the new round instead of being suppressed as already sent. The payload adds `"round": N` and `"followUp": true` (round 1 payloads are unchanged), for example:

```json
{"job":"<id>","status":"done","branch":"orka/<id>","round":2,"followUp":true}
```

`<id>.finish.json` keeps a per-round record: `rounds: [{round, status, at, followUp}]`, and every attempt carries its `round`. `job.finishRounds` lists the same rounds on the job. A `done` on a job that was not steered is still a no-op.

Steer sends a capped digest plus the message. The stored steer is the message only. The webhook body is unchanged (still job, status, branch, and round/followUp after round 1). No digest field.
