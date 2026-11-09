# Workers: finish wake and steer inbox

The path between workers and the orchestrator is run by orka, not by the agents. Workers only write their files. orka tells the orchestrator when they are done, and it delivers messages to a pane between that pane's tool calls. The design follows Limen's completion wake and steer inbox (https://github.com/overment/limen).

## Finish wake

A builder writes `results/<name>.json` (`{"worker","ok","result"}`) and `notes/<name>.txt`. The verifier writes `results/verifier.json`. Neither messages the orchestrator: their prompts say so. A builder result may also carry `keepInMind`, which orka merges into the feature map at the wake ([feature-map.md](feature-map.md)).

Before it writes the result, a builder runs the repo's gates from the GATES block in its brief, fixes failures in its own SCOPE, reports failures in other workers' files without touching them, and records the last run in the result's `"gates"` field. `orka digest` shows one gates line per builder. Research workers and the verifier get no GATES block. Details: [gates.md](gates.md#builders-run-the-gates-too).

The watcher (`orka watch`, every poll) and `orka wake <id>` (one pass by hand, `--dry-run` to preview) send one wake per result file:

- **When:** the worker's turn has ended (herdr status is not `working` or `blocked`) and its result file exists. Retired handoff panes are skipped; their successor writes the result.
- **To whom:** the current orchestrator, meaning the name in `job.agent` and the pane in `job.pane`, so a wake follows an orchestrator handoff. While the orchestrator's own handoff is in flight (`nudged`/`writing`), the wake is held and goes to the successor once it is up.
- **How:**
  - an idle or done orchestrator gets it as a prompt;
  - a working one gets it typed mid-turn (Claude and Pi queue it after the current tool call; nothing is interrupted);
  - `blocked` or unknown: held.
- **Once:** the key is the worker name plus the result file's mtime and size, recorded in `job.wakes`. A rewritten result (a re-tasked worker, the next verifier round) wakes again. Every wake adds a `wake` row to `decisions.tsv`.
- **Bounded text** (`lib/wake.mjs`):
  ```
  orka wake: worker alpha finished (ok).
  Commits:
  a9cb3d7 add alpha.txt
  Result:
  <first 15 lines of the result, at most 1200 characters; "... (full text in <path>)" when cut>
  Full result: <path>. Undelivered steers in the inbox: N.
  Run orka digest <id> before you route or start the next step.
  ```
  Commits are the worker's (`git log --since` its start, up to 10), or `Commits: none`. The verifier's state reads `verdict pass` or `verdict fail, N blocking failure(s)`.

## Steer inbox

`orka steer <id> "message"` on a running job, and `orka steer <id> --to <worker> "message"` (the orchestrator's way to message a worker), write one file to `.orka/jobs/<id>/steer/inbox/<target>/`, where the target is `orchestrator` or the worker's name. Delivery, in order:

1. **At once**, when the target is idle or done and not handing off: `orka steer` prompts it. A failed direct delivery is reported (`steer not delivered`, exit 1) and not re-queued, so a prompt that is still sitting in an input box is never sent twice.
2. **Between tool calls**, while it works: the pane's Claude `PostToolUse` hook (in the same `--settings` file as the handoff hook) or Pi extension (`tool_result`) claims the files and hands them to the model with the tool result. Claude gets them as the hook's `decision: block` reason; Pi as a `[orka-inbox]` steer message.
3. **By the watcher**, once the target is idle with messages still waiting: `herdr agent prompt`.

A delivery claims the files by renaming them into `steer/delivered/<target>/`, with `deliveredAt` and `via` (`orka steer`, `claude hook`, `pi hook` or `watcher`), so two deliverers never send the same message. Delivery always goes to whoever holds the name now: a retired handoff pane, or a pane whose own handoff is in flight, takes nothing; its successor gets the messages. A steer for the orchestrator carries the capped digest, as before. A worker steer reads `orka inbox: a message for you from the orchestrator: ...`.

`orka digest` (`steer inbox: N undelivered (orchestrator 1, builder 2)`) and `orka status` show what is still waiting. `job.steers` records each steer with `delivery` (`delivered`, `inbox` or `failed`) and its file.

Rules kept: Olaf talks only to the orchestrator. orka never steers a worker on its own initiative; the inbox only carries messages Olaf or the orchestrator sent. No pane is closed mid-job.

A steer on an `awaiting-direction` or finished job (follow-up round) still goes straight to the orchestrator pane, which is idle there.
