# Models

`claude` jobs store `orchestratorModel` and `workerModel` on the job file. Defaults are `opus` (Opus 5.5) and `sonnet` (Sonnet 5.5). Those are aliases from `claude --help`, not pinned ids, so they track the latest model of that family. `new` sets them. A real `run` writes any override back onto the job before it starts. `--dry-run` prints the override and does not write it. `orca worker --model` overrides one worker; the job default stays `workerModel`. The lead alias is also stored as `model`, the same value as `orchestratorModel`.

`run` starts `claude --model <orchestratorModel>` in a new Herdr workspace whose cwd is the worktree. The orchestrator is not the implementer. It starts workers with `orca worker`, which splits a pane in that same workspace and runs `claude --model <workerModel>`. Herdr has no `--model` flag; the alias is an agent argument.

## Verifier model

`--verifier-model <alias>` on `new` or `run` stores `job.verifierModel`; `orca worker --role verifier` starts `claude --model <verifierModel>`. Builders keep `workerModel`. `status`, `run --dry-run` and the orchestrator prompt show it. An explicit `orca worker --model` still overrides one worker. Precedence: `orca worker --model` > `--verifier-model` > `"verifierModel"` in `<repo>/.orca/config.json` > job-type default. The resolved value is recorded on the job when it is created (or when `run` replaces it).

The verifier default depends on job type: `haiku` for a CLI job, `sonnet` for a UI job (`--ui`, browser steps in `orca.verify.json` or the config `verify` file, or a goal that asks for agent-browser/UI verification); precedence is `orca worker --model` > `--verifier-model` > config `verifierModel` > the type default, and `status`, `--dry-run` and the prompt show the source.

`haiku` is not listed by `claude --help`, so orca keeps a small extra-alias list (`haiku`) that is merged with the aliases read from `claude --help`. Unknown aliases are still rejected.

An alias is checked against `claude --help` before the job is stored or started. An unknown alias fails and lists the aliases `claude --help` names, when it names any. A full model name (`claude-…`) is accepted when help says a full name is accepted. `opus-5-5` is not an alias.

`pi` jobs: `run` starts a Pi orchestrator (`pi`, role orchestrator) in that workspace. It is not the implementer. It starts Pi workers with `orca worker`, each in a split pane running `pi` in the same worktree. No Opus, no Sonnet. `--orchestrator-model`, `--worker-model` and `orca worker --model` are refused for `pi`.

For both kinds the orchestrator splits the goal into tasks and starts one worker per task. Independent tasks start in parallel (several `orca worker` calls). Workers share one worktree, so no two workers get the same files.

If the lead (or a worker) is still `idle` about 8 seconds after the prompt, orca sends the prompt once more. That is the startup swallow retry, not a second task.
