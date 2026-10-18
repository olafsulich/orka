# 09 · Feature map as cross-job memory

Status: todo · Source: pstack · Doc: [#17](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
Every verifier rediscovers how to start, reach and prove each feature of a repo. A small committed map shortens verifier startup and makes checks consistent across jobs. It complements `orca.verify.json`.

## What
- A per-repo map file (proposed `.orca-features.md` or `orca.features.md` at the repo root, committed). Per feature it records:
  - how to reach it (URL or command);
  - how to drive it;
  - how to prove it works;
  - when it was last verified.
- `verifierPrompt` (bin/orca.mjs:1196) has the verifier read it first, and update the entries it touched on a pass, so the map follows the code.
- The worker brief (03) can point at it in CONTEXT.
- Include a staleness guard: an entry carries the commit it was last proven at, and the verifier re-proves an old entry rather than trusting it.

## Acceptance criteria
- The verifier prompt reads the map and updates it, and a test asserts this.
- A sample map is in `examples/`.
- A missing map is fine: the verifier creates it.

## Source refs
- `pstack/skills/create-verification-skill/SKILL.md`
- `pstack/skills/create-verification-skill/references/feature-map-example/README.md`
- `pstack/skills/maintain-verification-skill/SKILL.md`

## Olaf's notes
- "Yes."
