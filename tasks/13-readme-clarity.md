# 11 · README overhaul plus diagrams

Status: todo · Source: Limen + Olaf · Doc: [#20](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking) (expanded)

## Why
The README is a 316-line reference. Its one picture (`docs/orca-how-it-works.png`) shows the flow, but there's no clear explanation of each piece. A newcomer, or Olaf in a month, should understand the whole workflow from the top section.

## What
- A new top section, "The workflow, piece by piece", with one short paragraph each (clear, not deep) on:
  - **orchestrator, workers and the verifier**: roles, the one verifier per job in rounds (see 03), stalls and strategy;
  - **panes / Herdr**: workspace, split panes, panes staying open, reap and cleanup;
  - **worktrees**: `orca/<id>` branch, shared checkout, merging is Olaf's call;
  - **the watcher and finish webhook**: needs-input watcher, `orca-finish-wake`, `orca webhook` retry;
  - **CLI commands**: a one-line table, with the detailed reference kept below;
  - **models**: opus/sonnet defaults, overrides, Pi, the verifier model once 02 lands;
  - **context injection points**: what each agent receives and when (orchestrator prompt, worker/verifier prompt, digest on steer, worker notes, finish payload).
- Images generated with `~/projects/diagram-framework`, in the style of `docs/orca-how-it-works.png` (source `clips/orca-how-it-works/index.html`). Use `npm run stills -- <clip> --at …`, look at the PNGs, then commit them to `docs/`. At minimum:
  1. refresh the how-it-works diagram;
  2. orchestrator / worker / verifier loop with rounds;
  3. context-injection diagram.
- Update the README for features from tasks 01-10 as they land. Do this task last, or revisit it at the end.

## Acceptance criteria
- Every piece listed above has its own short subsection.
- At least 3 diagram-framework PNGs are in `docs/`, all rendered and checked by eye.
- The detailed reference sections are kept and still accurate.
- The clip sources are committed in diagram-framework.

## Source refs
- `limen/docs/diagrams/context-injection.html`

## Olaf's notes
- "Yes. We also want to improve the README and explain every piece of this workflow (OK, not in too much detail, but we want it pretty clear). We should use our diagram-framework to generate images for the README."
