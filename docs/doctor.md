# orka doctor and the blocked verdict

Many failed rounds are not code failures: a missing CLI, a broken `node_modules`, a port in use, a browser that will not start, Claude's folder-trust dialog. Those go to the environment, never back to the builders.

## orka doctor

```bash
orka doctor [--cwd <repo>]            # the host and the repo
orka doctor --job <id> [--fix]        # plus that job's worktree and ports; recorded on the job
```

It prints one line per check (`ok`, `warn` or `FAIL`), with the fix under every problem, and exits 1 when anything fails. Checks:

| check | fails or warns when | fix it prints |
| --- | --- | --- |
| CLIs | `git`, `herdr`, `claude`, `rg`, `jq`, `file`, ImageMagick (`magick` or `identify`) missing: FAIL; `agent-browser`, `pi` missing: warn | the package to install (`sudo apt install ripgrep` ...); orka never installs it and never uses sudo |
| node | older than 22, or not on PATH | `nvm install 22` |
| node_modules | the main checkout lacks it (when package.json has dependencies), or the job worktree's link is missing or broken, or its lockfile differs | `orka doctor --job <id> --fix` relinks; a differing lockfile names the install command |
| ports (`--job`) | one of the job's ports is held (`ss -ltnp`) | stop the stale server, or use another job port |
| disk | under 2 GB free: FAIL; over 90% used: warn | `timeout 120 orka cleanup --dry-run` |
| memory | MemAvailable under the memory guard's minimum: warn | wait, or close idle panes of finished jobs |
| claude trust | the repo root is not trusted in `~/.claude.json` (`projects[<repo>].hasTrustDialogAccepted`); skipped for pi jobs | once, by hand: `cd <repo> && claude`, "Yes, I trust this folder", `/exit`. Claude offers no supported way to pre-trust from the command line, so orka only reports it and never accepts the dialog |
| chrome | orphan agent-browser Chrome roots (no running job, older than 2h): warn | `timeout 120 orka cleanup` |

`--fix` needs `--job` and does only safe, repo-local repairs: it relinks the job worktree's `node_modules` to the main checkout (the same repair `orka worker` does). Anything outside the repo is reported, never changed.

With `--job` the result is recorded on the job (`job.doctor {at, why, ok, failed, warnings, fixes}`), adds a `doctor` row to decisions.tsv, and appears in `orka digest`.

On the VPS (2026-10-23, read-only, `orka doctor --cwd ~/projects/orca`): rg, jq, file and ImageMagick are FAIL (missing); git, herdr, claude, agent-browser, pi, node v24.20.0, disk 7.9 GB free (90% used), memory, Claude trust of the repo and Chrome are ok.

## The blocked verdict

The verifier writes `"verdict": "blocked"` with `"blocked": {"reason": "<one line>", "evidence": "<exact error>"}` and empty failures when it could not test at all because of the environment. orka then:

- **records the round** (`verifier: blocked by the environment, round N (not a code failure; see orka doctor)`). It does not count toward `--max-rounds` and does not take part in stall detection (a stall needs the same failing check in two consecutive rounds; a blocked round has none);
- **runs `orka doctor --job` once per blocked round**, logs it (a `doctor` row: `verifier round N blocked: <reason>`) and puts it in the digest (`verifier blocked (environment, not code; do not route to builders): ...`, the doctor result, and its fixes);
- **refuses to finish:** `orka done` and `orka review` refuse a blocked verdict (`orka done --give-up` still works).

The orchestrator prompt says: route nothing to the builders. If a fix is repo-local, run `orka doctor <id> --fix` or do it, then start the verifier again. Anything else (a system package, the trust dialog, sudo) goes to Olaf.

## A pane that does not start

When `orka run` cannot start or prompt the orchestrator, or `orka worker` cannot start or prompt a worker (the trust dialog shows up as `agent name already used ... status=Blocked`), orka runs the doctor for the job, records it, and adds what it found to the error message.
