# Context handoff

A builder worker that has used half of its context window is replaced by a fresh agent that continues from a short note. The old pane stays open. Design and sources: `docs/design/context-and-collab.md` section 2 and "Limen, latest source" (branch `design/context-and-collab`).

## Measuring

- Every pane starts with `--session-id <uuid>` (claude and pi both take it). The id is on the worker record (`sessionId`, `startedAt`); the orchestrator's is `job.sessionId`.
- Transcript: Claude `~/.claude/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`; Pi `~/.pi/agent/sessions/--<cwd with / as ->--/<ts>_<id>.jsonl`. If the expected folder is missing, every folder is searched for the id.
- Context = the input side of the last assistant turn: Claude `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; Pi `input + cacheRead + cacheWrite`. Only the file's tail is read.
- Window: the transcript has no window size. Table in `lib/context.mjs` (`WINDOWS`): `[1m]` models 1M, Claude models 200k, anything else 200k. Override with `handoff.contextWindow`: a number for every model, or `{"opus": 1000000, "/^grok-/": 256000}` (substring or `/regex/` on the model id).

## When

The watcher (`orka watch`, every poll, 30 s) runs one pass. `orka handoff <id>` runs the same pass by hand; `--dry-run` prints each worker's tokens, percent, status and the decision, and changes nothing.

A worker is handed off when all hold:
- role builder (the verifier is exempt: it is fresh each round), not closed, not already handed off, started with a session id;
- no `results/<name>.json` yet (a finished worker has nothing left to continue);
- context >= `handoff.threshold` of the full window (default `0.5`);
- herdr `agent_status` is exactly `idle` (never `working` or `blocked`).

`"handoff": false` (or `"enabled": false`) turns it off. `"orchestrator": true` is only a flag today: the watcher logs that orchestrator handoff is not built and leaves the orchestrator alone.

## Steps

1. orka prompts the worker to write `<jobdir>/handoff/<name>-<n>.md` and end its turn. The prompt is Matt Pocock's `handoff` skill adapted to orka (fixed path, orka triggers it, reference artifacts by path or SHA, never paste, redact secrets, ~200 words) with Limen's final-message checklist as sections: Changes, Checks run, Commits, Still running, Notes, Remaining slice, Next commands. State: `handoff.state = "writing"`.
2. Next passes wait until the note exists and the agent is idle again (15 min limit, `ORKA_HANDOFF_NOTE_WAIT_MS`; then the handoff is marked failed and not retried).
3. `herdr agent rename <name> <name>-h<n>` (cut to 32 characters). The old record gets the new name and `retired: {at, by, n}`.
4. A new pane is split below the old one in the same worktree, and a fresh agent starts there as `<name>` (same kind, model, task, new session id). Its prompt is the normal worker prompt plus: read the note first, do its Remaining slice, do not redo what it lists, leave the old pane alone. Results and notes paths are the same as before.
5. Recorded: `handoffs: [{n, from, pane, sessionId, tokens, window, pct, at, note}]` on the new worker, the same plus `worker` in `job.handoffs`, and two `decisions.tsv` rows (note asked, successor started), so the digest shows them. `orka status` shows `ctx=NN%` per worker and `handed-off->builder (h1, pane open)` on the old one.

If the rename fails, nothing else happens (`handoff.state = "failed"`, reason recorded, the worker keeps its name). If the split or the start fails, the rename is undone.

## Panes

The old pane is never closed by the handoff. It stays open and idle until `orka done`, `orka stop` or cleanup closes every worker pane in `job.workers`, as for any finished worker. Each handoff keeps one more idle agent process (~300 MB) until then.

## Not built

- Orchestrator handoff (flag only).
- A nudge for a worker that stays `working` past the cap, and a `PreCompact` safety net.
- Steer waiting on an in-flight handoff, and `handoffs` in the finish webhook payload.
