# Terminal backends: herdr and hc

Orka starts and drives every pane through a terminal backend:

| Backend | What it is | Who sees the agents |
|---|---|---|
| `hc` (default) | herdr-core (`hc`, 0.1.13+), the runtime behind the Herdr desktop app | `hc ls`, and the Herdr app on any machine that has this host added |
| `herdr` (deprecated) | the herdr TUI server (`herdr` 0.9) | the herdr TUI (`herdr agent list`) |

The two do not share agents: a job started on herdr is invisible in the Herdr app, and one started on hc is invisible in the herdr TUI.

## Choosing one

New jobs run on hc. `ORKA_BACKEND=herdr orka run <id>` is the deprecated fallback to the herdr TUI; it stays for jobs already running there and for Pi older than 1.1.0, and will go away. `orka run` stores the choice as `job.backend`, and every later command on that job (`worker`, `steer`, `stop`, `done`, `resume`, the watcher, handoffs, cleanup) uses the job's backend whatever `ORKA_BACKEND` says then. Jobs from before backends existed have no `job.backend` and stay on herdr.

On hc, `orka run` prints the orchestrator's terminal: `... backend=hc terminal=t3`.

The hc backend runs Claude Code and Pi agents (see [Pi on hc](#pi-on-hc)). orka never falls back to herdr on its own.

orka never starts herdr-core itself. Any hc command, even `hc server status` or `hc connect`, starts a core when none runs, so before every hc call orka checks for the core's socket (`$XDG_RUNTIME_DIR/herdr-core/<HC_SESSION or default>.sock`). Without it `orka run` fails at once ("herdr-core is not running ...") and later calls report hc as unavailable. `orka doctor` checks the socket and the `herdr-core serve` process the same read-only way.

## How hc maps onto orka (lib/term.mjs)

`lib/term.mjs` keeps herdr's verb set as orka's interface (so `herdr agent prompt`, `herdr pane close` and similar in the other docs mean that verb on the job's backend): on herdr each call runs as it always did; on hc each verb is translated to herdr-core's JSON-RPC API (`hc connect`).

| herdr verb orka uses | hc |
|---|---|
| `workspace create`, `pane split` | no empty panes in hc: orka records a pending pane (cwd, env, workspace, parent) in `$XDG_RUNTIME_DIR/orka-hc/<pane>.json` and returns its id (`hp-…`; workspaces are `hw-…`) |
| `agent start <name> --kind claude\|pi --pane P -- args` | `terminal.run` of `claude args` or `pi args` with P's cwd and env (pi also gets `PI_PROGRAM_STATUS=1`), labels `orka_agent`, `orka_pane`, `orka_ws`, `orka_job` and the [app's](#jobs-in-the-herdr-app) `herdr.space` / `herdr.tab`, hc name = the agent name; then waits for the agent's own status `idle` |
| worker / verifier / successor pane | the same, with `parent` = the terminal of the pane it was split from (the orchestrator, for workers), `outlive_parent` and `no_notify` (hc types no notes into the orchestrator) |
| `agent get`, `agent list` | `terminal.list` / `terminal.get`: status is the agent's own OSC 7501 report (`idle`, `working`, `done`, `blocked`, `error`) |
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

## Jobs in the Herdr app

The Herdr app shows an hc terminal only when it carries the labels `herdr.space=<id>` and `herdr.tab=<id>`; unlabelled terminals stay hidden (herdr-app's `src/SKILL.md` and `defaults/AGENTS.md`). An id the app does not know becomes a new space or tab. So on hc every orka job is **one space**, and its orchestrator, each worker and the verifier are **a tab each**:

| Label orka sets at `terminal.run` | Value |
|---|---|
| `herdr.space` | `sp` + 32 hex, from the job id: the same for every agent of a job |
| `herdr.tab` | `tb` + 32 hex, from the job id and the agent's pane: a successor after a handoff gets a tab of its own |
| `orka_space_name`, `orka_tab_name` | the names orka wants: `orka <job slug>` (the id without its timestamp) and the role (`orchestrator`, the worker's name, `verifier`) |

The app names a space it made this way after its first terminal's folder (here the worktree) and its tabs `1, 2, ...`. Names are set with the app's `space.rename` / `tab.rename`, which store them in the layout the app keeps in the core's `herdr-app` document (`doc.get` / `doc.set`; `{ spaces: [{ id, name, folder, tabs: [{ id, name, root }] }] }`). There is no label for a name. So once an agent is ready, orka waits up to `ORKA_HC_NAME_WAIT_MS` (5000) for the app to place its terminal, then writes the names into that document:

- only the `name` of spaces and tabs whose ids orka's labels carry, and only while that name is empty: a name someone gave in the app stays;
- with `doc.set`'s version check, retried on a conflict; the app takes the write like a rename from another screen;
- best effort: a failure never fails a launch. With no layout document (no app has ever drawn this machine) there is no wait. A tab not placed in time is named by the next agent start on this machine, from its labels.

orka never writes the `where` label: the app writes it (`<space> / <tab>`, which `hc ls` shows) from its layout, and the worker shows under its orchestrator in the app's Agents list because hc's `parent` is the orchestrator. A space closes when its last tab does, so `orka done` / `workspace close` (kill and remove) clears the job out of the app. hc's own notes to the parent stay off (`no_notify`): orka's watcher reports workers.

`ORKA_HC_SPACES=off` keeps jobs out of the app (no `herdr.*` labels, no layout writes).

## Pi on hc

Pi has reported its state with OSC 7501, the Program Status Protocol herdr-core reads, since **Pi 1.1.0** (2026-10-07): `working` while a run or compaction is in progress, `done` when a run finished, `idle` at start or after a cancel, `blocked` while an extension dialog or a login waits for you (the message is the dialog title), `error` when a run ended with an error that is not retried. Reports carry no prompts or model output. So hc tracks Pi like Claude Code, natively; no Pi extension is involved.

- The herdr TUI's own Pi integration (`herdr integration install pi`, `~/.pi/agent/extensions/herdr-agent-state.ts`, v8) reports to the herdr TUI's socket only and does nothing in an hc terminal. It can stay installed: under hc it is a no-op, under the herdr TUI it still works.
- Pi normally reports only after the terminal answers its support query (`OSC 7501 ; ?`); herdr-core answers it. orka also sets `PI_PROGRAM_STATUS=1` in its Pi panes, so Pi reports without depending on that probe.
- `orka run` checks `pi --version` (with the pane's PATH) for a `--kind pi` job on hc. Older than 1.1.0: it refuses before it makes anything, with the update command (`npm i -g @earendil-works/pi-coding-agent@latest`) and the herdr fallback. `orka doctor` shows the same as `pi status`.
- Pi 1.x differs from 0.8x in ways a user notices: the TUI runs fullscreen by default (`tuiMode: "regular"` restores scrollback) and some extension APIs changed (1.0.3, 1.2.0). orka's own Pi hook uses only `tool_result`, `getContextUsage` and `sendMessage(..., { deliverAs: "steer" })`, which 1.4.0 still has.
- Updating Pi with `npm i -g` rewrites the files running Pi sessions load lazily (Pi's own changelog notes codemode failing after an update removed the running install). Installing the new version beside the old one and pointing `pi` at it leaves running seats alone; they pick it up on their next start.

### Telling when a Pi seat is done or blocked (for a seat watcher)

For a script outside orka watching a Pi seat started with hc, for example from the Mac with `hc run --on hetzner --bg ...`:

1. **One-time setup on the machine Pi runs on:** Pi 1.1.0 or later (`pi --version`). herdr-core starts programs with its own minimal PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:...`), where neither `pi` nor the `node` its `#!/usr/bin/env node` needs is found, and `hc run` has no `--env`. So start the seat through `env`:
   ```sh
   hc run --on hetzner --bg --name <seat> --cwd <dir> \
     env PATH=/home/olaf/.local/bin:/home/olaf/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin \
         PI_PROGRAM_STATUS=1 pi [--session-id <id>] [pi args]
   ```
   `PI_PROGRAM_STATUS=1` is optional with herdr-core (it answers Pi's probe) but makes reporting independent of the probe.
2. **Check that it reports:** `hc get hetzner/<t> --json` shows `"reported": true` and `"status": {"app": "pi", "state": "idle"}` a few seconds after start. `reported: false` with `status: null` means an old Pi or `PI_PROGRAM_STATUS=0`.
3. **Done or blocked:** read `hc get hetzner/<t> --json` (or JSON-RPC `terminal.get` through `hc connect`; `hc ls --json` is a compact view without status):
   - `.state`: `live` or `finished` (the program exited: `.exit_code`, `.reason`).
   - `.status.state`: `working`, `done`, `idle`, `blocked`, `error`; `.status.msg` is the session name, the dialog title (blocked) or the first error line (error).
   - `.turn`: goes up each time the status leaves `working`. Record it when the task is sent (`hc send` returns `turn` too); the seat finished that task when `.turn` is higher and `.status.state` is `done` (or `error`). `blocked` needs a person; `idle` after a turn means it was cancelled.
4. **Waiting without polling:** `hc wait hetzner/<t> --timeout 180 --json` returns when the turn ends (`reason: status`, with `status` and `turn`) or the program exits (`reason: exit`). `reason: timeout` (`ended: false`) is a check-in: wait again. `hc events --terminal hetzner/<t> --json` streams one JSON line per change instead.
5. **The answer text:** `hc read hetzner/<t> --lines 60`, or Pi's session file (`~/.pi/agent/sessions/--<cwd with / as ->--/<timestamp>_<session-id>.jsonl` on the machine Pi runs on; pass `--session-id` at start to know the id).
6. **Do not** health-check with `hc server status` or other hc commands against a machine whose core may be down: any hc command starts a core when none runs.

## Limits

- After a context handoff the old agent keeps its hc name (the successor gets the agent name only as a label and, when free, as its hc name). `hc ls` can then show the retired agent under the original name.
- `orka worker --pane <id>` takes only a pane orka opened on hc, not an arbitrary terminal.
- hc terminals start with the core's environment plus what orka passes (PATH, ORKA_JOB, ORKA_WORKER, ports, git hooks); the core's own PATH is usually minimal, so orka always passes its PATH. `ORKA_PANE_ENV=NAME,NAME` copies more of orka's own variables into every hc pane, for example `ORKA_PANE_ENV=NODE_EXTRA_CA_CERTS` for a finish webhook behind a private CA; panes started from a pane pass the same ones.
- Pending pane files live in `$XDG_RUNTIME_DIR` (cleared on reboot); an agent that already runs does not need them.
