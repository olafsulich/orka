# 11 · Reliable worker prompt delivery

Status: done · Source: incident 2026-10-18 (task 03 job)

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

## Done
`promptWithRetry` now waits for `interactive_ready` + `idle` (`ORCA_READY_WAIT_MS`, 120 s), then makes up to 3 attempts (`ORCA_PROMPT_ATTEMPTS`, `ORCA_PROMPT_WAIT_MS`, `ORCA_PROMPT_BACKOFF_MS`, `ORCA_PROMPT_POLL_MS`). Gate (`isAgentReady`) = `interactive_ready === true` AND `agent_status === idle`; a missing key or status, an error, blocked, working or done keeps polling until the deadline, then fails with `delivery failed` naming the last status and interactive_ready. Delivered (`isDelivered`) = `working`, or `blocked` after the prompt was sent (the agent got the prompt and waits on a permission dialog; re-prompting into it is harmful); blocked before the prompt is never ready. Pane text alone never counts. It returns `{ok, attempts, reason}`. `orca worker` records `delivery: ok|failed` (+ `deliveryReason`) and exits non-zero on failure; `status` shows `delivery=`, the digest shows `DELIVERY FAILED` via the worker note. `orca run` (job fails, `leadDelivery`) and `orca steer` (`steers[].delivery`) use the same path. When a re-issued task gets a new worker (builder-2), an earlier same-task pane is closed only if provably unused (positive proof `delivery: failed` — a missing or ok delivery is never enough — no results/notes file, idle, empty input, prompt absent from pane); recorded as `closedUnused`, shown in `status`.
Tests: new `test/delivery.test.mjs` (22, fake herdr only; incl. a table over interactive_ready true/false/absent x status idle/working/blocked/absent/error where only (true, idle) prompts, and after-prompt working/blocked delivered, idle forever = 3 attempts then failed); `test/naming.test.mjs` idle-retry test changed (idle is now a failure after 3 prompts); stubs in `verifier-model`/`naming`/`digest`/`integration-lifecycle` tests now serve idle+ready until prompted, then working. Verifier round 4 fixes: a failed steer is shown in `orca status` (`steer: <msg> delivery=failed [reason]`) and the digest last-steer line ends `DELIVERY FAILED: steer never started the agent; re-send it`; the digest worker note `DELIVERY FAILED ... re-issue the task` appears only when delivery failed and there is neither a results nor a notes file (otherwise the normal note, plus `(delivery retried by hand)` on a note). `npm test`: 158 passing, 0 failing (was 138).
Re-issue duplicate close (`provablyUnused`) also checks live state, and keeps the pane on any doubt: it closes only if delivery is recorded `failed`, there is no results/notes file, `herdr agent get` succeeds now with status exactly `idle`, and `pane read` succeeds showing no ⏺/⎿ marker, no submitted prompt echo and an empty input box. A hand re-delivery that did work (idle again, markers over an empty box) is kept; agent get/pane read errors, working or blocked keep the pane. Tests added for each.
Round 5: digest shows `orchestrator: DELIVERY FAILED: <stopReason>` when `leadDelivery` is failed (nothing otherwise); tests: `orca run` + digest on a never-working orchestrator, and a normal job has no such line. `npm test`: 159 passing, 0 failing.
Round 6: `orca status` agent line shows `delivery=failed [reason]` for a failed orchestrator prompt; one table test closes {worker, orchestrator run, steer} x {status, digest} (failed and delivered). `npm test`: 160 passing, 0 failing.
