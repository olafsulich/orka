# 05 · Attack the premise at a stall

Status: todo · Source: pstack · Doc: [#8](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
When a stall is flagged (the same check fails two rounds in a row, `stallOf`, bin/orca.mjs:1129), the prompt lists tactics to try. It never says "question the assumption all the failed fixes share".

## What
- In the stall paragraph of `orchestratorPrompt` (:1281-1283), before changing strategy:
  1. write in one sentence the premise the failed fixes share;
  2. list what else could explain the failure (a census);
  3. pick the strategy that drops that premise.
- `orca strategy <id> "<change>"` records it as `premise: … | change: …`. This can stay prompt-only, or add an optional `--premise` flag to `cmdStrategy` (:1676).
- If 04 has landed, log it as a decision row too.

## Acceptance criteria
- The stall paragraph contains the premise step. A test asserts it.
- `orca status` shows the premise alongside the strategy change.

## Source refs
- `pstack/skills/principle-attack-the-premise/SKILL.md`
- `pstack/skills/principle-fix-root-causes/SKILL.md`

## Olaf's notes
- "Sounds good."
