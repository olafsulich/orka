# 15 · README clarity: how orca works and what you can use, with diagrams

Status: done · Source: Olaf + Limen · Doc: [#20](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking) (expanded)

## Why
The README is a 316-line reference that mixes concepts, flags and edge cases. It should be a clear front door: how orca works, and what is available to use. The detail moves to `docs/`.

## What
- **Trim and restructure `README.md` around two parts:**
  - **(a) How orca works.** One short paragraph each, clear but not deep:
    - orchestrator, workers and the verifier (one verifier per job, in rounds; stall and strategy);
    - panes / Herdr (workspace, split panes, reap, cleanup);
    - worktrees (`orca/<id>` branch, shared checkout; merging is Olaf's call);
    - the needs-input watcher and the finish webhook;
    - context injection points: what each agent receives and when (orchestrator prompt, worker/verifier prompt, digest on steer, notes, finish payload).
  - **(b) What you can use.** Short tables:
    - commands (one line each);
    - key flags;
    - roles (builder, verifier);
    - models (opus/sonnet defaults, overrides, Pi, and the verifier model once 02 lands);
    - webhooks (finish wake, needs-input, `orca webhook`, env);
    - config (`.orca/config.json`, `orca.verify.json`, ports).
- **Move detail to `docs/`.** Move the long sections (Verify, Verifier worker, Finish wake, Cleanup, Follow-up rounds, Ports, Needs-input watcher) into topic files such as `docs/verify.md`, `docs/webhooks.md`, `docs/cleanup.md` and `docs/models.md`. The README links to them, and nothing accurate is lost.
- **No backlog or roadmap in the README.** Tasks live only in `tasks/`. At most, add one link: "Backlog: tasks/".
- **Graphs come from `~/projects/diagram-framework`,** in the style of `docs/orca-how-it-works.png` (source `clips/orca-how-it-works/index.html`). Render with `npm run stills -- <clip> --at …`, look at the PNGs, then commit them to `docs/`. At minimum:
  1. a refreshed how-it-works diagram;
  2. the orchestrator → workers → verifier loop with rounds;
  3. a context-injection diagram.
- Do this task last, so it reflects tasks 01-14 as they land.

## Acceptance criteria
- The README has exactly the two main parts (a) and (b), plus a short intro and links to `docs/`.
- The README is much shorter than today (target ≤ ~120 lines, excluding tables).
- Every removed detail exists in a `docs/*.md` file and is still accurate.
- No task list, backlog or roadmap appears in the README.
- At least 3 diagram-framework PNGs are in `docs/`, rendered and checked by eye. Their clip sources are committed in diagram-framework.

## Source refs
- `limen/docs/diagrams/context-injection.html`

## Olaf's notes
- "Improve the README and explain every piece of this workflow (OK, not in too much detail, but pretty clear). Use our diagram-framework to generate images for the README."
- "Add a task for making the README more clear (do not store tasks there). It has a lot of info now; we want to focus on how it works and what things are available to use, leveraging diagram-framework for graphs."

## Done
README.md is now an intro plus two sections (How orca works, What you can use) with short tables and the 3 diagrams (`docs/orca-how-it-works.png`, `orca-loop.png`, `orca-context-injection.png`; clip sources in diagram-framework `clips`, commit abb09c8). 91 lines, 47 outside tables. All long detail moved to `docs/` (commands, models, verify, verifier, webhooks, needs-input, follow-up, cleanup, ports, layout, diagrams), with `--ui`, `--playbook`, `--premise`, `orca reap` and `--orphan-hours` added. New `test/readme-docs.test.mjs` (5 tests). `npm test`: 237 pass, 0 fail.
