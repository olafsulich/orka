# orca

Local jobs for one git repo. `orca init` marks the repo. `orca run` checks out a linked worktree and starts an agent there, in a Herdr pane. You decide what to merge.

Not a fork of [limen](https://github.com/overment/limen). Not the old `orch` script. Fresh Node ESM, zero dependencies, local git only. Details live in [docs/](docs/README.md). Backlog: [tasks/](tasks/).

## How orca works

![How orca works](docs/orca-how-it-works.png)

**Orchestrator, workers, verifier.** `orca run` starts an orchestrator that splits the goal and starts one worker per task, in parallel when tasks are independent. After the builders report, it starts one verifier, in rounds. The verifier runs `orca verify`, the project's checks and targeted browser checks, and writes a pass/fail verdict. On fail the orchestrator routes each blocking failure back to the builder that owns it. If the same check fails two rounds in a row, orca flags a stall and the orchestrator must change strategy (`orca strategy`) instead of repeating itself. Only the orchestrator runs `orca done`. See [verifier.md](docs/verifier.md), [verify.md](docs/verify.md).

![Orchestrator, workers and verifier rounds](docs/orca-loop.png)

**Panes and Herdr.** Each job gets a Herdr workspace; workers and the verifier are split panes in it. orca frees finished worker panes and browsers on `done`/`stop` and reaps a worker's browsers mid-job (`orca reap`). The orchestrator pane stays open for feedback until `orca cleanup` closes stale workspaces. See [cleanup.md](docs/cleanup.md), [ports.md](docs/ports.md).

**Worktrees.** Each job runs on branch `orca/<id>` in a linked worktree under `.orca/worktrees/<id>`. All workers share that checkout, so keep their tasks off the same files. Nothing is merged for you: look at the branch, then merge it yourself. See [layout.md](docs/layout.md).

**Watcher and webhook.** `orca run` starts a needs-input watcher that POSTs when the orchestrator is blocked or idle on a question. When the CLI marks a job `done`, `failed` or `stopped`, it POSTs the finish wake once. Both are off unless `.orca/secrets/finish-webhook.env` exists. See [needs-input.md](docs/needs-input.md), [webhooks.md](docs/webhooks.md), [follow-up.md](docs/follow-up.md).

**Context injection.** Each agent gets its context at a fixed point: the orchestrator prompt at `run`, a worker or verifier prompt at `orca worker`, a capped digest plus your message on `steer`, notes and results files when a worker reports, and the finish payload at the end.

![What each agent receives and when](docs/orca-context-injection.png)

Diagram sources: [diagrams.md](docs/diagrams.md).

## What you can use

Commands (full flags in [commands.md](docs/commands.md)):

| Command | What it does |
| --- | --- |
| `orca init` | mark the repo, gitignore `.orca/` |
| `orca new` | file a job (title, goal) |
| `orca run <id>` | worktree, pane, orchestrator, watcher |
| `orca worker` | start a builder or verifier worker |
| `orca status` / `digest` | show a job / capped snapshot |
| `orca steer <id> "msg"` | message the lead; follow-up round on a finished job |
| `orca stop` / `done` | end a job; send the finish wake |
| `orca strategy` / `log` | record a strategy change / a decision |
| `orca verify <id>` | browser checks in the worktree |
| `orca reap` / `cleanup` | free browsers / close stale workspaces |
| `orca webhook <id>` | preview or retry the finish POST |
| `orca watch <id>` | needs-input watcher (started by `run`) |

Key flags:

| Flag | Meaning |
| --- | --- |
| `--kind claude\|pi` | agent kind (default `claude`) |
| `--*-model <alias>` | orchestrator, worker or verifier model |
| `--max-rounds N` | opt-in ceiling on verifier rounds |
| `--ui`, `--playbook` | UI job; feature, bug-fix, investigation, hillclimb |
| `--keep` | skip cleanup for this job |
| `--dry-run` | print the plan, change nothing |
| `--cwd <repo>` | run from outside the repo |

Roles:

| Role | Does |
| --- | --- |
| builder | implements one task in the shared worktree |
| verifier | checks the result, never edits product code |

Models (details in [models.md](docs/models.md)):

| Role | Default |
| --- | --- |
| orchestrator | `opus` |
| worker | `sonnet` |
| verifier | `haiku` (CLI job), `sonnet` (UI job) |
| Pi job | `pi` for all roles, no model flags |

Webhooks (details in [webhooks.md](docs/webhooks.md)):

| Webhook | When |
| --- | --- |
| finish wake | job `done`, `failed` or `stopped` |
| needs-input | orchestrator blocked or idle on a question |
| `orca webhook <id>` | retry or preview; `--force` re-sends |
| env | `WEBHOOK_URL`, `WEBHOOK_KEY` in `.orca/secrets/finish-webhook.env` |

Config:

| File | Purpose |
| --- | --- |
| `.orca/config.json` | local mark; `verify`, `verifierModel`, `staleAfter` |
| `orca.verify.json` | browser checks at the worktree root; commit it |
| ports | 4 per job: `ORCA_PORT`, `ORCA_PORTS` |

More: [comparisons.md](docs/comparisons.md) (limen, old orch, v0 skips).
