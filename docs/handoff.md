# Context handoff

A pane that has used 40% of its context window (`handoff.threshold`, default 0.4) is replaced by a fresh agent that continues from a note the old agent wrote itself. This covers builder workers and the orchestrator. The old pane stays open. Design and sources: `docs/design/context-and-collab.md` section 2 and "Limen, latest source" (branch `design/context-and-collab`).

## Measuring

- Every pane starts with `--session-id <uuid>` (claude and pi both take it). The id is on the worker record (`sessionId`, `startedAt`); the orchestrator's is `job.sessionId`.
- Transcript: Claude `~/.claude/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`; Pi `~/.pi/agent/sessions/--<cwd with / as ->--/<ts>_<id>.jsonl`. If the expected folder is missing, every folder is searched for the id.
- Tokens = the input side of the last assistant turn: Claude `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; Pi `input + cacheRead + cacheWrite`. Only the file's tail is read. The transcript is written per message, so this is live mid-turn too.

## Window

The transcript holds no window size, and orka never guesses one. Per pane, the first hit wins:

1. What the runtime reports.
   - Claude: every claude pane starts with `--settings <jobdir>/context/claude-settings.json`, whose `statusLine` runs `lib/statusline.mjs`. Claude Code pipes its statusline JSON to it on every message. That JSON has `context_window.context_window_size`, the window Claude computed for the session's model and betas. The script writes `<jobdir>/context/<session-id>.json` and then draws the user's own statusLine (from their settings files) unchanged, or `ctx NN% of Wk` when they have none.
   - Claude, no capture yet: a model id with `[1m]` (Claude's 1M suffix, e.g. `--model opus[1m]`) means 1,000,000.
   - Pi: the session's provider and model (on every assistant turn), looked up in Pi's model registry `~/.pi/agent/models-store.json` and `~/.pi/agent/models.json` (`contextWindow`).
2. `handoff.contextWindow`, an explicit user override: a number for every model, or `{"opus": 1000000, "/^grok-/": 256000}` (substring or `/regex/` on the model id).
3. Nothing: the window is unknown. `orka status` shows `ctx=window-unknown`, one `decisions.tsv` row says so, and the pane is never handed off automatically. `orka handoff <id> <name>` still works.

`orka status` shows `ctx=NN% of <W>k (<source>)` per worker and on the orchestrator's `agent:` line. Measured on Claude Code 2.1.309 (statusline `context_window.context_window_size`, real orka panes, no `[1m]` suffix):

| Model id | Window |
|---|---|
| `claude-haiku-5-5` | 1,000,000 |
| `claude-opus-5-5` | 1,000,000 |
| `claude-sonnet-5-5` | 1,000,000 |

The captures are in `test/fixtures/context/statusline-measured.json`. At the default 0.4 every Claude pane hands off near 400k tokens; a Pi pane on `xai/grok-4.7` (500k) near 200k, on `openai-codex/gpt-5.5` (272k) near 109k.

## When

Two paths ask a pane for its note. The pane's own hook is the first; the watcher's poll is the fallback.

### The hook (after every tool call)

- **Claude:** every claude pane's `--settings` file (`<jobdir>/context/claude-settings.json`, next to the statusLine) has a `PostToolUse` hook, matcher `*`: `node lib/handoff-hook.mjs claude <job file> <job dir> <config>`. It reads the hook input (`session_id`, `transcript_path`), measures tokens from the transcript tail and the window the same way the watcher does (statusline capture, `[1m]`, `handoff.contextWindow`), and at or past the threshold answers `{"decision":"block","reason":"orka: your context is at NN% ... Hand off now: ... run /orka:handoff <note> role=<role> ..."}`. Claude Code hands that reason to the model right after the tool result, inside the same turn.
- **Pi:** every pi pane loads a per-job extension with `-e <jobdir>/context/pi-handoff.mjs`, which binds `piExtension()` from `lib/handoff-hook.mjs` to the job's files. Pi's extension API (pi 0.87, `docs/extensions.md` in the installed package): on `tool_result` it reads `ctx.getContextUsage()` (`tokens`, `contextWindow`; Pi's own live estimate) and `ctx.sessionManager.getSessionId()`, and at or past the threshold sends `pi.sendMessage({customType: "orka-handoff", content}, {deliverAs: "steer"})`: delivered after the current tool calls, before the next model call. The window is the runtime model's `contextWindow` (Pi's registry, e.g. grok-4.7 500k, gpt-5.5 272k), nothing hardcoded.
- **Once per crossing:** the first ask writes `<jobdir>/context/<session-id>.hook.json` (`n`, `note`, `tokens`, `window`, `source`, `pct`, `at`); while it exists the hook stays quiet for that session. The successor has a new session id, so it starts clean.
- The hook never asks the verifier, a retired or finished worker (result file written), a pane whose handoff the watcher already asked for (`nudged`/`writing`/`failed`), a pane at the cap, or any pane of a job that is not `running`. A hook error is swallowed; the poll still runs.

### The poll (fallback, and what finishes every handoff)

The watcher (`orka watch`) runs one pass every poll: every `handoff.busyPollMs` (default 5 s) while the orchestrator or a measured builder is working (one `herdr agent list` tells), every 30 s otherwise. The 60 s idle grace before a needs-input alert is cut into the same slices, so a busy worker is still measured while the lead waits. `orka handoff <id>` runs the same pass by hand; `--dry-run` prints each pane's tokens, window, source, status and decision, and changes nothing. `orka handoff <id> <worker>|orchestrator` asks that pane now, with no threshold and no cap.

When a pane's hook marker exists and the pane has no handoff yet, the watcher adopts it as a `nudged` handoff with `mode: "hook"` (one `decisions.tsv` row: asked by its own claude/pi hook) instead of asking again. Otherwise a pane is due when all hold:
- it is a builder worker (the verifier is exempt, since it is fresh each round) that is not closed or retired, has a session id and has no `results/<name>.json` yet; or it is the orchestrator, unless `"orchestrator": false`;
- context >= `handoff.threshold` of the detected window (default `0.4`);
- fewer than `handoff.maxHandoffs` handoffs of this task so far (default 3; when reached, one `decisions.tsv` row says so).

What happens then depends on the herdr status:
- `idle` or `done` (a finished turn nobody looked at): orka types the skill command, `/orka:handoff <note> role=<worker|orchestrator>` (claude) or `/skill:handoff ...` (pi). State `writing`.
- `working`: orka types a message without waiting for idle. Claude and Pi queue it and give it to the model after the current tool call, so the turn is not interrupted. The message asks the agent to run the handoff skill at its next clean stopping point, then end its turn. State `nudged`. If the agent ends its turn without a note, orka runs the skill command itself after `ORKA_HANDOFF_NUDGE_GRACE_MS` (20 s) of idle.
- `blocked` or unknown: wait.

Either way, the watcher then waits for the note, starts the successor, and runs the skill itself if the agent ends its turn without a note (after `ORKA_HANDOFF_NUDGE_GRACE_MS`).

Overshoot: with the hook, the ask arrives right after the first tool call past the cap; without it, a working pane is measured within about `busyPollMs` of each new turn in its transcript. Two limits remain for both:
- One parallel batch is atomic. Claude runs `PostToolUse` per tool, but the transcript usage (the input side of the last assistant turn) only moves when the next model call happens, so a single batch of 30 large reads (5% to 73%) is measured before and after, never halfway. Pi's `getContextUsage()` also estimates the trailing tool results, but the steer is delivered only after the whole batch.
- The ask is queued after the current tool call, and the agent decides when it has reached a clean stopping point. Haiku finished its batch, or its whole step, before writing the note.

Smoke with the hooks (2026-10-23, default threshold 0.4, one worker reading 40 files of ~19k tokens one per message):

| Pane | Window (source) | Hook asked | Note written | Successor |
|---|---|---|---|---|
| Claude haiku worker | 1000k (claude statusline) | 40.6% | 43.2% | started, h1 recorded `mode: hook` |
| Pi grok-4.7 worker | 500k (pi runtime xai/grok-4.7) | 43.0% | 43.8% | started, h1 recorded `mode: hook` |

Claude showed `PostToolUse:Read hook returned blocking error` with the ask and ran `Skill(orka:handoff)` as its next step. Pi showed the `[orka-handoff]` steer and wrote the note. The watcher's poll saw the Pi worker at 39.3% four seconds before the hook fired at 43% (one read later); it adopted the hook's ask and did not ask again.

Earlier, poll only, haiku, threshold 0.5, reads in parallel batches of 10 (~22% each):

| Pane | 30 s poll (before) asked / note | 5 s busy poll asked / note |
|---|---|---|
| orchestrator | 95% / 95% | 58% / 95% |
| worker | 52% / 59% (one read per call) | 58% / finished its task at 65% before writing the note |

## The note

The note is written by the agent with the handoff skill orka ships in `plugin/skills/handoff/SKILL.md`: Matt Pocock's `handoff` skill (mattpocock/skills, MIT), with orka's note path, a ~200-word cap and fixed sections per role. claude panes load it with `--plugin-dir plugin` (as `orka:handoff`), pi panes with `--skill plugin/skills/handoff`.

- Worker: Changes, Checks run, Commits, Still running, Notes, Remaining slice, Next commands (Limen's final-message checklist).
- Orchestrator: Plan, Workers (who owns what, state), Verifier (rounds, last verdict), Steers (open ones), Waiting on, Next steps, Next commands.

The note goes to `<jobdir>/handoff/<name>-<n>.md` (`orchestrator-<n>.md` for the lead). Next passes wait until it exists and the agent is idle or done again (15 min limit, `ORKA_HANDOFF_NOTE_WAIT_MS`; then the handoff is marked failed and not retried).

## Successor

1. The old agent's context is measured again (`pctEnd`: how far it went past the cap, note included).
2. `herdr agent rename <name> <name>-h<n>` (cut to 32 characters).
3. A new pane is split below the old one in the same worktree, and a fresh agent starts there as `<name>` (same kind and model, new session id, same skill and statusline).
4. Worker: the normal worker prompt plus: read the note first, do its Remaining slice, do not redo what it lists, leave the old pane alone. Orchestrator: the normal orchestrator prompt plus: the job is already running; read the note, the job JSON and `decisions.tsv`, run `orka digest`; do not restart, re-task or close any worker or verifier pane; continue from the note's Next steps. `job.pane` and `job.sessionId` move to the new pane before the prompt, and the watcher follows the new pane. It sends no needs-input while the lead's handoff is in flight.
5. Recorded: `handoffs: [{n, from, pane, sessionId, tokens, window, source, pct, pctEnd, mode, at, note}]` on the new worker (on `job.lead.handoffs` for the orchestrator, plus `job.retiredLeads`), the same plus `worker` in `job.handoffs`, and `decisions.tsv` rows (note asked, successor started), so the digest shows them.

If the rename fails, nothing else happens (`handoff.state = "failed"`, reason recorded). If the split or the start fails, the rename is undone.

## Panes

No handoff closes a pane. Old worker and old orchestrator panes stay open and idle until `orka done`, `orka stop` or cleanup closes them with the other worker panes (never the current orchestrator pane). Each handoff keeps one more idle agent process (~300 MB) until then.

## Config

```json
"handoff": { "threshold": 0.4, "orchestrator": true, "maxHandoffs": 3, "busyPollMs": 5000, "contextWindow": 1000000 }
```

`"handoff": false` (or `"enabled": false`) turns it off. `"busyPollMs": 0` keeps the 30 s poll while panes work. Every key is optional.

## Not built

- A `PreCompact` safety net.
- A hook for the verifier (exempt by design).
- Steer waiting on an in-flight handoff, and `handoffs` in the finish webhook payload.
