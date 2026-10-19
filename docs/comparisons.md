# Comparisons and v0 skips

## How this differs from limen

Limen is a Pi coordinator you talk to. It plants tickets, a board, role prompts, reviewers, and advisors, and it can POST a finish webhook when a job ends.

Orca is the CLI. You file a job and run it. There is no coordinator conversation, no ticket board, and no package hooks in the target repo. A Claude job starts an orchestrator (default `opus`, Opus 5.5); that orchestrator starts workers (default `sonnet`, Sonnet 5.5) with `orca worker`, in parallel when tasks are independent. Either alias can be overridden per job. A Pi job is a Pi orchestrator starting Pi workers. When the CLI marks a job `done`, `failed`, or `stopped`, it can POST a finish wake. Agents do not send it.

## How this differs from old orch

`orch` was one hardcoded repo (`diagram-framework`) and one `.orch/` directory. Agents edited the primary checkout. When the orchestrator reached done, a Herdr finish path could wake Grok Bot.

Orca works in any repo you `init`. Job state lives in that repo, under `.orca/`, which `init` gitignores. `run` creates branch `orca/<id>` in a linked worktree and starts the pane with that directory as cwd. The finish wake is orca's own POST. It does not run `herdr-finish-watch`.

## v0 skips

Tickets, reviewers, advisors, resume, prune, and diff. Those are not missing by accident.
