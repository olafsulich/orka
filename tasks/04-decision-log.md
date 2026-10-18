# 04 · Decision log

Status: todo · Source: pstack · Doc: [#6](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
The orchestrator's reasoning is lost when its context compacts, and after `done` there's no reviewable record of why things went the way they did.

## What
- New command: `orca log <id> <phase> <decision> <why> <evidence> <result>`. It appends a TSV row (plus a timestamp) to `.orca/jobs/<id>/decisions.tsv`.
- `lib/digest.mjs` (`renderDigest`, :164) shows the last N rows, within `DIGEST_MAX`.
- `cmdStrategy` (bin/orca.mjs:1676) also appends a row (phase `strategy`).
- `orchestratorPrompt` (:1240): log each split, routing and strategy decision.
- `status <id>` shows the row count. The help text and README list the command.

## Acceptance criteria
- `orca log` appends a row. Tabs and newlines in the arguments are escaped.
- The digest shows the last rows and stays under its cap.
- `orca strategy` writes a row.
- Tests cover all of the above, and `npm test` is green.

## Source refs
- `pstack/skills/show-me-your-work/SKILL.md`
- `pstack/skills/show-me-your-work/scripts/log.sh`
- `pstack/skills/show-me-your-work/references/decision-log-template.tsv`

## Olaf's notes
- "Sounds good."
