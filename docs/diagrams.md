# Diagrams

Three diagrams explain orca in the README. They are rendered stills of diagram-framework clips; the sources are in `~/projects/diagram-framework/clips` (commit `abb09c8`).

| Image | What it shows |
| --- | --- |
| ![How orca works](orca-how-it-works.png) | `orca run` to a worktree and a Herdr pane, the orchestrator, workers, the verifier, and the finish wake. |
| ![The loop](orca-loop.png) | Orchestrator, workers, verifier rounds, the stall and strategy change, and `done` to the finish wake. |
| ![Context injection](orca-context-injection.png) | What each agent receives and when: orchestrator prompt, worker and verifier prompts, the digest on `steer`, notes, and the finish payload. |

The PNGs are generated; do not edit them by hand. Re-render them from the clips (`npm run stills -- <clip> --at …` in diagram-framework) and check them by eye before committing.
