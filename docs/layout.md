# Layout and trust

## Layout

Workers share the job worktree. They do not get sibling checkouts. Concurrent edits can clash; keep tasks from touching the same files. Sibling worktrees are later, if a job needs them.

```text
<repo>/.orka/config.json             local mark (gitignored)
<repo>/.orka/jobs/<id>.json          job record
<repo>/.orka/jobs/<id>.finish.json   finish-wake attempts (no secrets)
<repo>/.orka/jobs/<id>/              results/, notes/, summary.txt, verify.log
<repo>/.orka/worktrees/<id>/         linked worktree, branch orka/<id>
<worktree>/orka.verify.json          optional browser checks (commit this; not under .orka/)
<repo>/.orka/secrets/finish-webhook.env
```

A repo that already has `.orca/` (from before the rename) keeps it: every path above is then under `.orca/`, and `.orka/` is not created. See [rename.md](rename.md).

`init` appends `.orka/` (or `.orca/` in such a repo) to the repo `.gitignore` if it is missing. Commit that line if you share the repo. Do not commit `.orka/`.

Commands resolve the primary checkout from the current directory, including from a job worktree (`git rev-parse --git-common-dir`). Pass `--cwd <repo>` from anywhere else.

## Trust

orka does not mark a job `done` when the agent goes idle. The summary file is the completion note; `status` stays `running` until the orchestrator runs `orka review <id>`, then `review` until you sign off with `orka approve <id>` and the orchestrator runs `orka done <id>` (or you `stop` it). See [review.md](review.md). A failed `run` leaves the worktree in place and marks the job `failed`. `orka done` removes a done job's worktree and keeps the branch (see [cleanup.md](cleanup.md#worktrees-of-done-jobs)); `node_modules` in a worktree is a symlink to the main checkout's (see [cleanup.md](cleanup.md#shared-dependencies)). Done, failed, and stopped marks can all POST the finish wake. Look at the branch before you merge. The worktree is not a sandbox.
