# Verify

`orca verify <id>` drives `agent-browser` from checks the project supplies. It does not know your app's URL, host, or port. Nothing in orca is tied to one repo's dev server.

Checks are read from the job worktree, so the branch under test is what runs. Default file: `orca.verify.json` at that root. Commit it if later jobs should run it. Do not put it under `.orca/`. `init` gitignores `.orca/`, and a gitignored file is not in a new worktree.

To put the file somewhere else, set `verify` in the primary checkout's `.orca/config.json` to a path relative to the worktree:

```json
{ "verify": "scripts/check.json" }
```

`"verify": false` disables checks even if a file exists. An explicit path that is missing fails and records `failed`. A missing default file skips.

Skip is not a pass and not a failure. Exit 0. The job records `verify.status` `skipped`. A JSON checks file must assert something. Empty, invalid, or failing checks fail closed: exit 1, `verify.status` `failed`. The log is `<repo>/.orca/jobs/<id>/verify.log`.

Nothing is assumed to be serving. The file names the URL. Start the app first, or point `verify` at a script that starts it and then calls `agent-browser`.

JSON is the shape an agent should write. An array step is an `agent-browser` command. `is visible` exits 0 when the element is hidden, so orca requires that state to be true. Object steps cover the asserts exit codes get wrong:

```json
{
  "steps": [
    ["open", "http://127.0.0.1:3000/"],
    ["wait", "--text", "Ready"],
    { "visible": "h1" },
    { "text": "h1", "includes": "Ready" }
  ]
}
```

Also: `click`, `fill` as `[selector, text]`, `press`, `wait`, `waitText`, `title`, `titleIncludes`, `urlIncludes`, `count` plus `equals` (a number), and `get` plus `equals` or `includes` for `text`, `title`, `url`, `count`, `value`, `attr`. A top-level `note` is ignored. Any other field fails. `examples/orca.verify.json` is an example only. orca does not run it.

A non-JSON checks file is a script. orca runs it in the worktree with `AGENT_BROWSER_SESSION` set to the job's verify session (`<prefix>-verify`, see Cleanup), plus `ORCA_JOB`, `ORCA_REPO`, `ORCA_WORKTREE`, and `ORCA_BRANCH`. It closes that session when the script exits. The script must exit non-zero when a check fails. Use this when the check has to boot a server. Prefer JSON when the app is already up. A script is stopped after 600s. A JSON step is stopped after 90s.

`orca verify <id> --base` runs the same checks file in a temporary detached worktree at the commit the job branch started from (`job.baseCommit`; older jobs fall back to `git merge-base <branch> main`). The worktree is removed afterwards. It writes `results/verify-base.json` and leaves `job.verify` alone:

```json
{"base":"<sha>","steps":[{"index":9,"name":"...","outcome":"fail"}]}
```

A step that fails on base too is pre-existing, not caused by the job.

orca does not watch workers. The orchestrator no longer runs `orca verify`; the verifier worker does (see [verifier.md](verifier.md)). You can run it yourself any time the worktree exists. `status` prints `verify` once it has run, or `not run` when a checks file is present and verify has not.
