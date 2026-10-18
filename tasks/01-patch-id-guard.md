# 01 · Patch-id guard on verifier verdicts

Status: todo · Source: pstack · Doc: [#1](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
Builders share one worktree. If anyone edits code after the verifier passed, `orca done` still reports "verified" and the finish webhook repeats it. The CLI should refuse a verdict that no longer describes the code.

## What
- The verifier result records `head` (SHA) and `patchId` (`git diff <baseCommit> | git patch-id --stable`, dirty tree and untracked files included).
  - Have orca compute it when it reads the result, not trust the agent's value. Verifier side: `verifierPrompt` (bin/orca.mjs:1196).
- `computeVerifier` (:1139) and `recordVerifier` (:1162) compare the stored patch id with the current one. On a mismatch the state is `stale`.
- `cmdStatus` (:1618) shows `verifier: pass (STALE, code changed since round N)`.
- `cmdDone` (:1884) does not report "verified" for a stale pass. It tells the orchestrator to re-run the verifier (or finishes with `verifier: stale` in the payload; pick one and document it).
- Tests in `test/verifier.test.mjs`.

## Acceptance criteria
- A pass followed by an edit makes `status` show stale, and `done` does not send "verified by verifier: pass".
- A pass with no later edit behaves exactly as today.
- Dirty-tree and untracked-file edits count as changes.
- `npm test` is green.

## Source refs
- `pstack/skills/poteto-mode/playbooks/shipping.md` (step 3: re-check the verdict against the patch)

## Olaf's notes
- "Yes let's do it."
