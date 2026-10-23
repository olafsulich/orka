# Direction gate

For a new feature, the orchestrator plans first and waits for Olaf's direction before any builder starts. One cheap pause before building costs less than rounds of rework on the wrong approach.

## When it is on

On by default for `--playbook feature` (the default). Off, with the reason stored on `job.gate`:

| case | reason |
| --- | --- |
| `orka new --no-gate` (or `orka run --no-gate` on a queued job) | `--no-gate` |
| `--playbook bug-fix`, `investigation` or `hillclimb` | `playbook <name>` |
| `orka new --spec` whose spec header says `Kind: bugfix`, `fix` or `trivial` | `spec: Kind: ...` |
| title starts with fix, bug, bugfix, hotfix, typo or trivial | `intake: title names a fix or trivial change` |
| a goal line `Kind: bugfix`, `Kind: fix` or `Kind: trivial` | `intake: Kind: ...` |

Jobs filed before the gate existed have no `job.gate` and run ungated.

## The flow

1. **Plan.** The orchestrator prompt gets a DIRECTION GATE block. It reads what it needs and may start research workers (names starting with `research`). `orka worker` refuses builders and the verifier until the approach is approved: the CLI holds the gate, not the prompt.
2. **Propose.** It writes `.orka/jobs/<id>/approach.md` (What / How / Files / Risks, a few lines) and runs `orka propose <id>`. The job goes to `awaiting-direction`, decisions.tsv gets a `gate` row, and the webhook (`.orka/secrets/finish-webhook.env`, if present) gets one POST:
   ```json
   {"kind":"awaiting-direction","job":"<id>","title":"...","status":"awaiting-direction","branch":"orka/<id>","approach":"<approach.md, up to 2000 chars>","question":"Direction for \"...\"? Approve: orka approve <id>. Revise: orka steer <id> \"<what to change>\"."}
   ```
   The needs-input watcher stays quiet while the job waits, so there is no second "idle" ping.
3. **Decide.**
   - `orka approve <id> ["note"]` prompts the orchestrator `Direction approved by Olaf[: note]. Build it now...`, sets the job back to `running` and unlocks builders.
   - `orka steer <id> "what to change"` sends the revision. The job goes back to `running` (state `revising`, builders still refused); the orchestrator updates approach.md and runs `orka propose` again (proposal 2, another POST).
   - `orka stop <id>` ends it. `orka done` is refused while the job waits.

`orka status <id>` shows `gate: on, planning`, `gate: awaiting direction since <time> (proposal N)` plus the approach, `gate: approved <time>`, or `gate: off (<reason>)`.

## Naming

`orka approve` is dispatched on status: on a job in `awaiting-direction` it approves the plan (this page); on a job in `review` it signs off the finished result ([review.md](review.md)); on any other job it exits 1 and names both. Approve-and-lock of paths (`orka approve <id> <paths...>` in the poteto and retro notes) is not built; if it is, it needs another verb, such as `orka lock`.
