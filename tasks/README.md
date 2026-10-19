# orca improvement backlog

From the pstack and Limen research, [research/IMPROVEMENTS-pstack-limen.md](../research/IMPROVEMENTS-pstack-limen.md), filtered by Olaf's decisions on 2026-10-18. Do them in order, one at a time. Mark the status here and in the file.

Source-ref paths: `pstack/…` = `/home/olaf/projects/cursor-plugins/pstack/…`, `limen/…` = `/home/olaf/projects/limen/…`. Line numbers are for `bin/orca.mjs` at `04c900a`.

| id | title | status | source | doc # |
|----|-------|--------|--------|-------|
| [01](01-patch-id-guard.md) | Patch-id guard on verifier verdicts | done | pstack | 1 |
| [02](02-verifier-upgrade.md) | Verifier upgrade: evidence standard, own prompt, cheaper model | done | pstack + Olaf | 2 |
| [03](03-structured-worker-brief.md) | Structured worker brief | done | pstack | 3 |
| [04](04-decision-log.md) | Decision log (`orca log`) | done | pstack | 6 |
| [05](05-attack-the-premise.md) | Attack the premise at a stall | done | pstack | 8 |
| [06](06-compact-research-summary.md) | Compact research summary prompt (no hard cap) | done | Limen (modified) | 7 |
| [07](07-shared-prompt-rules.md) | Small shared prompt rules | done | pstack | 9 |
| [08](08-repro-first-bug-jobs.md) | Repro-first for bug jobs | done | pstack | 14 |
| [09](09-feature-map.md) | Feature map as cross-job memory | done | pstack | 17 |
| [10](10-playbooks.md) | Playbooks by job type | done | pstack | 18 |
| [11](11-worker-prompt-delivery.md) | Reliable worker prompt delivery (wait for ready, verify start, retry) | done | incident 2026-10-18 | - |
| [12](12-tests-leak-watchers.md) | Tests leak `orca watch` processes: kill in teardown, self-exit guard, reaper | done | incident 2026-10-18 | - |
| [13](13-verifier-default-by-job-type.md) | Verifier model default by job type (haiku for CLI, sonnet for UI) | done | Olaf | - |
| [14](14-browser-verification-hygiene.md) | Browser verification hygiene + agent-browser upgrade | done | Olaf | - |
| [15](15-readme-clarity.md) | README clarity: how it works and what you can use, with diagram-framework graphs | todo | Limen + Olaf | 20 |

## Skipped

- #4 Durable webhook retry: skipped (Olaf: "Nah").
- #5 Refused-key marker in `orca status`: skipped.
- #10 Cross-model reviewer: skipped for now.
- #11 Token and model line per job: skipped.
- #12 "Leave nothing without an owner" worker rule: skipped.
- #13 Pause and resume note: skipped.
- #15 Standing orders and fresh-over-resume: skipped.
- #16 Capability frame sentence: skipped.
- #19 Sweep cost caching in the watcher: skipped for now.
- #21 Best-of-N race in worktrees: skipped.
