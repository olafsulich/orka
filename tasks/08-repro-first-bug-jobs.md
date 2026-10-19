# 08 · Repro-first for bug jobs

Status: done · Source: pstack · Doc: [#14](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
A check that never failed proves nothing. For bug-fix jobs, the bug should be reproduced and recorded failing before the fix. The verifier then confirms the same reproduction now passes.

## What
- For a bug-fix job (via 10's `--playbook bug-fix`, or a prompt rule when the goal is a defect):
  - the first worker reproduces the bug and saves the failing evidence to `results/repro.json` (command or steps, plus the real failing output);
  - ideally it adds a failing test, committed before the fix.
- The verifier task includes "re-run the repro from results/repro.json; it must now pass", via `verifierPrompt` (bin/orca.mjs:1196).
- The verifier fails a repro that can't be reproduced. It doesn't pass it silently.
- Optional and off by default. It applies only to bug-fix jobs.

## Acceptance criteria
- With the bug-fix playbook, the orchestrator prompt requires a repro worker first, and the verifier prompt requires the re-run. Tests assert this.
- Non-bug jobs are unchanged.

## Source refs
- `pstack/skills/poteto-mode/playbooks/bug-fix.md`
- `pstack/skills/principle-sequence-verifiable-units/SKILL.md`

## Olaf's notes
- "OK." Best done after or together with 10 (playbooks).

## Done
Added opt-in `orca new|run --playbook feature|bug-fix` (stored as `job.playbook`, default feature, invalid value fails listing the valid ones). With bug-fix, `orchestratorPrompt` requires a repro worker first that saves failing evidence to `results/repro.json` (ideally a failing test committed before the fix) and no fix worker before it exists; `verifierPrompt` re-runs the repro, which must now pass, and a missing or irreproducible repro is a blocking failure. Feature prompts are unchanged byte for byte. New `test/repro-first.test.mjs` (6 tests); `npm test`: 210 pass, 0 fail.
