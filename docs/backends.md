# Terminal backends: herdr and hc

Orka starts and drives every pane through a terminal backend:

| Backend | What it is | Who sees the agents |
|---|---|---|
| `herdr` (default) | the herdr TUI server (`herdr` 0.9) | the herdr TUI (`herdr agent list`) |
| `hc` | herdr-core (`hc`, 0.1.13+), the runtime behind the Herdr desktop app | `hc ls`, and the Herdr app on any machine that has this host added |

The two do not share agents: a job started on herdr is invisible in the Herdr app, and one started on hc is invisible in the herdr TUI.

## Choosing one

`ORKA_BACKEND=hc orka run <id>` starts the job on hc. Without it (or with `ORKA_BACKEND=herdr`) jobs run on herdr. `orka run` stores the choice as `job.backend`, and every later command on that job (`worker`, `steer`, `stop`, `done`, `resume`, the watcher, handoffs, cleanup) uses the job's backend whatever `ORKA_BACKEND` says then. Jobs from before backends existed have no `job.backend` and stay on herdr.

On hc, `orka run` prints the orchestrator's terminal: `... backend=hc terminal=t3`.

The hc backend runs Claude Code agents only. Pi reports no status to hc, so `orka run` refuses a `--kind pi` job on hc before it makes anything.

## How hc maps onto orka (lib/term.mjs)

`lib/term.mjs` keeps herdr's verb set as orka's interface: on herdr each call runs as it always did; on hc each verb is translated to herdr-core's JSON-RPC API (`hc connect`).

| herdr verb orka uses | hc |
|---|---|
| `workspace create`, `pane split` | no empty panes in hc: orka records a pending pane (cwd, env, workspace, parent) in `$XDG_RUNTIME_DIR/orka-hc/<pane>.json` and returns its id (`hp-…`; workspaces are `hw-…`) |
| `agent start <name> --pane P -- args` | `terminal.run` of `claude args` with P's cwd and env, labels `orka_agent`, `orka_pane`, `orka_ws`, `orka_job`, hc name = the agent name; then waits for Claude's own status `idle` |
| worker / verifier / successor pane | the same, with `parent` = the terminal of the pane it was split from (the orchestrator, for workers), `outlive_parent` and `no_notify` (hc types no notes into the orchestrator) |
| `agent get`, `agent list` | `terminal.list` / `terminal.get`: status is Claude's OSC 7501 report (`idle`, `working`, `done`, `blocked`) |
| `agent prompt` | `terminal.send` |
| `agent send-keys` | `terminal.keys` (key names lower-cased) |
| `agent wait --until …` | polls `terminal.get` |
| `agent rename` | relabels `orka_agent` (an hc name is fixed at start) |
| `pane read` | `terminal.read` |
| `pane get`, `pane list` | the terminal behind the `orka_pane` label is live |
| `pane close` | `terminal.kill`, then `terminal.rm` |
| `workspace close` | kill and remove every terminal labelled with that `orka_ws`; nothing else |

Finish and needs-input detection is unchanged: the watcher reads the same statuses (`done`, `blocked`, `idle`) and the same pane text, now from hc.

Panes on hc are children of `herdr-core hold`; the memory guard and the leftover sweep count those as panes too.

## Limits

- Claude only (see above).
- After a context handoff the old agent keeps its hc name (the successor gets the agent name only as a label and, when free, as its hc name). `hc ls` can then show the retired agent under the original name.
- `orka worker --pane <id>` takes only a pane orka opened on hc, not an arbitrary terminal.
- hc terminals start with the core's environment plus what orka passes (PATH, ORKA_JOB, ORKA_WORKER, ports, git hooks); the core's own PATH is usually minimal, so orka always passes its PATH.
- Pending pane files live in `$XDG_RUNTIME_DIR` (cleared on reboot); an agent that already runs does not need them.
