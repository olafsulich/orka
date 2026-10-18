# 02 · Verifier upgrade: evidence standard, own prompt, cheaper model

Status: todo · Source: pstack + Olaf · Doc: [#2](../research/IMPROVEMENTS-pstack-limen.md#3-combined-ranking)

## Why
The verifier exists, but its prompt doesn't demand strong evidence, and it runs on the builders' model (Sonnet). We want a stricter verifier that can run on a cheaper model.

## Current state (checked at 04c900a)
- **A separate verifier prompt already exists.** `verifierPrompt` (bin/orca.mjs:1196-1238) is distinct from `workerPrompt` (:979). `cmdWorker` picks it when `--role verifier` (:1586). So (a) is already done, and this task only extends that prompt.
- **The verifier model is the worker model.** `cmdWorker` takes `alias = workerAlias(job, args)` (:1550) → `--model` or `job.workerModel` (:1527-1533). There is no `verifierModel` field. The orchestrator can pass `--model` by hand, but nothing tells it to.
- **Haiku ids.** The installed Claude Code (2.1.302, `~/.local/bin/claude`) accepts `haiku` (it resolved to `claude-haiku-5-5`), `claude-haiku-5-5` and `claude-haiku-4-5`. All three were tested with `claude -p --model <id>` on 2026-10-18.
  - `claude --help` only lists `fable`, `opus` and `sonnet`, so orca's `assertClaudeModel` (:204-216) **rejects the alias `haiku`**.
  - It does accept the full name `claude-haiku-5-5` (`isFullModelName`, :200).

## What
1. **Evidence standard** in `verifierPrompt`:
   - test the real user path;
   - check side effects (files, network, state), not just the exit code;
   - suspect the observation method first;
   - save proof under `results/` (screenshots, command output);
   - "inconclusive" or "could not test" is a fail, not a pass.
2. **Verifier model:**
   - add `--verifier-model <alias>` on `orca new`/`orca run`, stored as `job.verifierModel` (default: `workerModel`, so nothing changes unless it's set);
   - `cmdWorker --role verifier` uses it;
   - print it in `status` and dry-run.
3. **Allow `haiku` in `assertClaudeModel`.** Use a small extra-alias list (`haiku`) or accept any alias the CLI resolves. Document it in the README Commands section.

## Acceptance criteria
- The prompt contains the evidence rules, and `test/verifier.test.mjs` asserts them.
- `orca new --verifier-model haiku` (or `claude-haiku-5-5`) is stored, and a verifier pane starts `claude --model haiku`. Builders keep `workerModel`.
- A job without the flag behaves as today.
- `npm test` is green.

## Source refs
- `pstack/skills/principle-prove-it-works/SKILL.md`
- `pstack/skills/create-verification-skill/SKILL.md`
- `pstack/skills/poteto-mode/playbooks/feature.md`

## Olaf's notes
- "We might want to pick a different, cheaper model for verification. With Claude we could perhaps use Haiku 5.5."
- "Maybe we want a separate prompt for the verifier, if we don't have it yet." It exists already (see above).
- Before making Haiku the default, try it on one real job to check it actually catches failures.
