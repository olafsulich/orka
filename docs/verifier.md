# Verifier worker

After all builders report, the orchestrator starts exactly one verifier: `orka worker --job <id> --name verifier --role verifier --task "..."`. The name must be `verifier`. It works for `claude` and `pi` jobs and uses the job's verifier model (see [models.md](models.md)). Each start increments `job.verifier.rounds`. There is no cap by default. If the job has `maxRounds`, a start with `rounds >= maxRounds` is refused with an error. The prompt says `round N`, or `round N of M` when a ceiling is set.

The verifier gets a fresh context in the same worktree. It runs:

- `orka verify <id>`;
- the project's own checks (`npm test`, `npm run check`, when present in `package.json`);
- targeted `agent-browser` checks against the goal's acceptance criteria, in one session named `<prefix>-verifier`, closed at the end.

It must not edit product code. For every failing check it tests whether the failure is pre-existing: `orka verify <id> --base`, or the same project command at the base commit. It may author or extend `orka.verify.json` only to cover the goal's acceptance criteria. It never weakens or deletes a check to make it pass. When it cannot test at all because of the environment it writes `"verdict": "blocked"` with the evidence instead: not a code failure, not a round, and orka runs `orka doctor` ([doctor.md](doctor.md)). It writes `results/verifier.json` and `notes/verifier.txt`, then prompts the orchestrator like any worker.

```json
{
  "name": "verifier",
  "role": "verifier",
  "round": 2,
  "verdict": "pass",
  "checks": [{ "name": "npm test", "outcome": "pass", "scope": "job", "notes": "..." }],
  "failures": [],
  "warnings": [
    { "check": "editor #scrub on /clips/flowchart/", "evidence": "#scrub not visible", "base": "<sha>", "proof": "fails on base via orka verify --base" }
  ],
  "summary": "..."
}
```

`verdict` is `pass` or `fail`. `outcome` is `pass`, `fail`, or `skipped`. `scope` is `job` or `preexisting`.

`failures` are blocking: they cover what this job changed. Each is `{check, evidence}` with a stable check name and the exact error, step, url, or command output. A failure is a `warnings` entry only if it is shown mechanically to fail on the base commit too (`orka verify --base`, or the same command at the base). Otherwise it blocks. `verdict` is `pass` when `failures` is empty, even with warnings. Plain string failures are still accepted (the string is the check name).

Example: a diagram-only job failed `orka verify` step 9/82 because `#scrub` was missing on `/clips/flowchart/`. That check also fails on base, so it is a warning, not a blocker.

Naming: every round is started with `--name verifier`. Round 1 is `verifier`, then `verifier-2`, `verifier-3`, and so on (the first name no worker of the job and no herdr agent holds), so a finished verifier pane never has to be closed. Every round writes the same `results/verifier.json`; when the next round starts, orka moves the previous file to `results/verifier.round-<N>.json`, so a stale result is never read as the new verdict. Notes go to `notes/<actual name>.txt`.

herdr agent names are global across workspaces and jobs, so orka checks `herdr agent list` (and `agent get`) before choosing a name, and if `agent start` still answers "already used" it takes the next suffix and retries. If a start fails for good, orka closes only the pane it had just split for it (never a pane passed with `--pane`). Model aliases read from `claude --help` (120s timeout) are cached in `<repo>/.orka/cache/claude-models.json` (gitignored with the rest of `.orka/`, never a home path) for 24h and re-read once when an alias is unknown.

Prompt delivery: after `herdr agent prompt`, orka waits up to 60s for the agent to report `working` (unknown or error statuses are tolerated). While it does not, orka reads the pane; if the input box still holds the pasted prompt (`[Pasted text ...]` or text after the `❯` line) it presses Enter with `herdr agent send-keys <name> Enter`, with backoff, and never pastes again. It re-prompts only when the input box is empty and the prompt is nowhere in the pane.

Builders follow the same rule: if `--name api` is already used by a worker of the job (or an existing herdr agent), orka starts `api-2` (then `api-3`...) and prints the real name. `verifier` and `verifier-N` are reserved for `--role verifier`. Nobody closes panes while a job runs: the prompts of the orchestrator, builders and verifiers say so, and orka frees the panes on `done`/`stop`.

Loop: on `fail` the orchestrator reads `results/verifier.json`, routes each blocking failure with its evidence to the builder that owns those files (warnings are ignored for routing), then starts the verifier again. It runs `orka status <id>` after each round. There is no round limit unless `--max-rounds` was set.

Stall: if the same blocking check fails in two consecutive rounds, `status` reports a stall. The orchestrator must not repeat the instruction. It changes strategy (rewrite the worker prompt with the evidence verbatim, split the work differently, start a fresh worker instead of resuming, or take another approach), records it with `orka strategy <id> [--premise "<shared premise>"] "<change>"`, and re-verifies. It stops only when the same failure survived 3 different strategy changes, or the fix needs a human decision or a secret, with `orka done <id> --give-up "<plain reason>"`. The orchestrator never marks its own work verified, never runs `orka verify`, and never edits checks.

The job record carries the outcome:

```json
{"verifier":{"rounds":3,"verdict":"pass",
 "history":[{"round":1,"verdict":"fail","failing":["npm test"],"warnings":[],"at":"<iso>"},
            {"round":2,"verdict":"fail","failing":["npm test"],"warnings":["editor #scrub"],"at":"<iso>"},
            {"round":3,"verdict":"pass","failing":[],"warnings":["editor #scrub"],"at":"<iso>"}],
 "stall":{"checks":["npm test"],"rounds":[1,2]},
 "strategyChanges":[{"round":2,"change":"fresh worker with verifier evidence","at":"<iso>"}],
 "stopReason":"<only when given up>"}}
```

`stall` is set when the failing sets of two consecutive rounds intersect, and holds the shared checks and the two rounds. orka records a round as soon as it can: when the next verifier round starts, on `orka status`, and in `orka done`.

`orka done` records the verdict and history for the latest round. A final `fail` marks the job `failed` (`verifier failed after N rounds: <blocking checks>`); otherwise `done`. With no verifier run, behaviour is unchanged. The finish wake line and `orka status` report `verified by verifier: pass, round 2` (or `verifier: fail, round 3`), and nothing when no verifier ran. The same text is the `verifier` field of the finish wake payload, alongside the `verification` object.

**Patch-id guard.** When orka first reads a round's `results/verifier.json` it records `head` (SHA) and `patchId` on `job.verifier`: `git diff <baseCommit>` of the worktree (dirty tree and untracked files included, `orka.verify.json` excluded) through `git patch-id --stable`. orka computes both itself; a value in the agent's file is ignored. Every later `status`/`done` compares the current patch id with the stored one. If a `pass` no longer matches, `orka status` shows `verifier: pass (STALE, code changed since round N)`, and `orka done` refuses: it prints a message telling the orchestrator to re-run the verifier, exits non-zero, leaves the job running and sends no wake or webhook. `orka done --give-up` is unaffected. A pass with no later edit, and results from before this check (or a job with no `baseCommit`/worktree), behave as before. The baseline is taken when orka first reads the result, so run `orka status` right after the verifier reports.
