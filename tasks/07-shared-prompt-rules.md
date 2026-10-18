# 07 · Small shared prompt rules

Status: todo · Source: pstack · Doc: [#9](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
Three small gaps:
- the irreversible-action boundary isn't stated;
- the orchestrator's summary is built from workers' self-reports;
- the "never close panes" rule is copied across prompts and can drift.

## What
- In `portPromptLines` (bin/orca.mjs:927), which every prompt shares, add: "Reversible work never waits on a human. Irreversible actions (push, delete outside the worktree, external sends, purchases) stop and ask."
- In `orchestratorPrompt` (:1240), before `orca done`: run `git diff <baseCommit>` (stat plus a skim) and write `summary.txt` from the diff, not from the workers' claims.
- Move "Never close panes…" (:1004 worker, :1235 verifier, :1262 orchestrator) into one shared constant.

## Acceptance criteria
- Each rule appears once, as a shared constant used by every prompt. Tests assert this.
- No other behaviour changes, and `npm test` is green.

## Source refs
- `pstack/skills/principle-never-block-on-the-human/SKILL.md`
- `pstack/skills/poteto-mode/SKILL.md`
- `pstack/skills/principle-encode-lessons-in-structure/SKILL.md`

## Olaf's notes
- "OK."
