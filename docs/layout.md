# Layout and trust

## Layout

Workers share the job worktree. They do not get sibling checkouts. Concurrent edits can clash; keep tasks from touching the same files. Sibling worktrees are later, if a job needs them.

```text
<repo>/.orca/config.json             local mark (gitignored)
<repo>/.orca/jobs/<id>.json          job record
<repo>/.orca/jobs/<id>.finish.json   finish-wake attempts (no secrets)
<repo>/.orca/jobs/<id>/              results/, notes/, summary.txt, verify.log
<repo>/.orca/worktrees/<id>/         linked worktree, branch orca/<id>
<worktree>/orca.verify.json          optional browser checks (commit this; not under .orca/)
<repo>/.orca/secrets/finish-webhook.env
```

`init` appends `.orca/` to the repo `.gitignore` if it is missing. Commit that line if you share the repo. Do not commit `.orca/`.

Commands resolve the primary checkout from the current directory, including from a job worktree (`git rev-parse --git-common-dir`). Pass `--cwd <repo>` from anywhere else.

## Trust

orca does not mark a job `done` when the agent goes idle. The summary file is the completion note; `status` stays `running` until the orchestrator runs `orca done <id>` (or you `stop` it). A failed `run` leaves the worktree in place and marks the job `failed`. Done, failed, and stopped marks can all POST the finish wake. Look at the branch before you merge. The worktree is not a sandbox.
