# 11 · Reliable worker prompt delivery

Status: todo · Source: incident 2026-10-18 (task 03 job)

## Why
In job `20261018192404434-task-03-structured-worke`, `orca worker` reported success twice (`builder`, then `builder-2`), but both panes sat at an empty claude prompt for over 45 minutes. The orchestrator waited for a note that could never arrive.

The pane starts a shell that types `claude --model sonnet`. Under heavy load (load ~27 on 4 vCPU from leaked watchers, see 12), the prompt was most likely sent before claude was ready. `promptWithRetry` then gave up silently: it returns when `promptSeenInPane` matches, or when the status is anything but `idle`, and never confirms the agent is `working`.

## What
- In `promptWithRetry` (bin/orca.mjs) and its caller `cmdWorker`:
  - **Wait until ready:** before the first prompt, poll `herdr agent get` until `interactive_ready` is true and `agent_status` is `idle`, with the claude input box visible. Use a bounded timeout (e.g. 120 s, env-overridable).
  - **Verify the start:** success means `agent_status` became `working`, not that the prompt text appeared in the pane.
  - **Retry:** if the agent is not `working` after N seconds, re-send the prompt, up to 3 attempts with backoff. Don't count `promptSeenInPane` as delivered while the agent is idle at an empty prompt.
  - **Fail loudly:** after the last attempt, exit `orca worker` non-zero with a clear message. Record `delivery: failed` on the worker, and make `orca status` and the digest show it, so the orchestrator re-issues the task instead of waiting.
- Apply the same logic to the orchestrator prompt in `orca run` and to `steer`.

## Acceptance criteria
- With a fake herdr that is slow to become ready, the prompt is sent only once the agent is ready.
- A prompt that never makes the agent `working` is retried, then reported as failed (non-zero exit; status and digest show it).
- The normal fast path is unchanged.
- Tests cover all three cases, and `npm test` is green.

## Olaf's notes
- Seen live on 2026-10-18. The task 03 builder had to be re-delivered by hand (`herdr agent prompt builder-2 …`) once the pane was idle and `interactive_ready`.
