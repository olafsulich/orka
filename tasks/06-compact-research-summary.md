# 06 · Compact research summary prompt

Status: done · Source: Limen (modified) · Doc: [#7](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
Research-style workers write long, unlabelled reports. That bloats the orchestrator's context, and guesses look like facts. We want dense, labelled reports. There is no research worker type, and this doesn't add one.

## What
- Add a short "research report" block, used when a worker's task is research or investigation (the orchestrator adds it to the brief, or 10's `investigation` playbook adds it automatically). It asks the worker to:
  - lead with the answer;
  - label each claim `Observed` or `Guessed`;
  - give the command or file that verifies each observed claim (`Verified: <cmd> -> <real output line>`, or `none`);
  - cut narration;
  - stay compact.
- **No hard line or character cap.**
- Locations: a constant next to `workerPrompt` (bin/orca.mjs:979), referenced from `orchestratorPrompt` (:1240).

## Acceptance criteria
- The block exists once, as a shared constant, and a test asserts it.
- No line or character limit is enforced in code or prompt.
- Non-research worker prompts are unchanged.

## Source refs
- `limen/templates/scout.md` (the format only, not its 15-line / 1200-char cap)
- `limen/src/job/wake-text.ts`

## Olaf's notes
- "I wouldn't restrict it to 15 lines, but we might have a prompt that would try to summarize the research in a compact way."

## Done
Added shared `RESEARCH_REPORT` constant next to `workerPrompt` in `bin/orca.mjs` (lead with the answer; label claims Observed/Guessed; `Verified: <cmd> -> <real output line>` or `none`; cut narration; compact; no line/char cap). `orchestratorPrompt` tells the orchestrator to append it verbatim to research/investigation worker briefs; `workerPrompt` is unchanged. New `test/research-report.test.mjs` (2 tests); `npm test`: 194 pass, 0 fail.
