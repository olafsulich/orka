# 14 · Browser verification hygiene + agent-browser upgrade

Status: done · Source: Olaf 2026-10-18

## Why
Verification leaves Chrome behind, and the verifier uses agent-browser without the practices its own skill recommends. That costs RAM on a tight VPS and makes UI verdicts weaker.

**Evidence (VPS, 2026-10-18 21:38 UTC):**
- 43 chrome/chromium processes in total, about 1.4 GB RSS summed (shared pages counted more than once), from 5 browser roots.
- 1 root is live and belongs to the render-top3 job (motion-lab vitest/playwright, `ORCA_JOB=20261018180646035-render-optimization-top3` on its parent). It is not a leak.
- 4 roots are orphans: `agent-browser` Chrome (`--user-data-dir=/tmp/agent-browser-chrome-*`) started Oct 17 at 10:48, 11:00, 12:03 and 12:13 UTC. They were reparented to init (ppid 1) and carry **no `ORCA_JOB` tag**.
  - The two later ones fall inside the diagram-framework `20261017115749722-agent-setup-v4-1-smooth` job window. The two earlier ones can't be mapped.
  - `orca cleanup`'s tag-based reaping (`lib/browsers.mjs` `findTaggedBrowsers`, f721fb3) cannot see them. The likely cause is that the agent-browser daemon launches Chrome without passing on the pane's environment.

## What
**(a) Hygiene**
- **Audit** every path that should close browsers:
  - the verifier/worker `agent-browser --session <prefix>-<name> close` the prompts ask for;
  - `orca reap --worker`;
  - `releaseJob` on done/stop/fail;
  - `orca cleanup` (`cmdCleanup`, `reapBrowsers`, `killBrowserProcs`, `lib/browsers.mjs`).

  Record which ones actually kill Chrome.
- **Fix attribution.** Don't rely only on the env tag. Map the agent-browser session name (`orca-<sha8>-<worker>`) to its daemon and Chrome. Use `agent-browser session list`/`close` if it exists, and the `--user-data-dir`, process tree and daemon socket otherwise. That way orca can reap a job's Chrome even when it is untagged.
- **Reap at the right times:** when a verifier round ends (on `orca worker --role verifier` for the next round, and on `done`), and on done/stop/fail.
- **Orphan sweep.** `orca cleanup` also lists and kills orphan `agent-browser-chrome-*` roots: ppid 1, older than N hours, and not mapped to a running job's session. Support `--dry-run`.
- **Regression test.** Use a fake agent-browser/Chrome process tree. After a verifier round and after `done`, no job Chrome remains. A running job's browser is never touched.

**(b) Verification quality with agent-browser** (0.37.1, global at `~/.nvm/versions/node/v24.20.0/lib/node_modules/agent-browser`)
- **Read** the package's own guidance:
  - `skills/agent-browser/SKILL.md`;
  - `skill-data/core/SKILL.md` (540 lines: the core loop, "Always use your own session", reading a page and snapshots/refs, waiting, screenshots, multiple browsers, persisting sessions);
  - `README.md`.
- **Compare** with how `verifierPrompt`, `workerPrompt` and `orca verify` (`orca.verify.json` steps) use it today. Today that is one named session and the open/visible/text steps.
- **Adopt the best practices** in the UI-job verifier prompt, kept short:
  - its own session, closed at the end;
  - snapshot, then act on refs instead of guessed selectors;
  - explicit waits per the skill's "Waiting" section, with no sleeps;
  - screenshots saved under `results/` as evidence;
  - console and network errors checked.
- **Ship or link the skill.** Either point browser-verifier workers at the installed `SKILL.md` path (resolved at runtime, so it follows upgrades), or copy a trimmed excerpt into `roles/` or a constant. Pick one and justify it. This applies only to UI jobs (see 13's job type). CLI verifiers don't get it.
- Extend `orca verify` steps if the skill shows clear wins (e.g. a wait-for step, or screenshot-on-fail), with tests.

## Acceptance criteria
- In a test job, no orphan Chrome is left after a verifier round or after `done`, `stop` or failure. `orca cleanup --dry-run` lists orphan agent-browser Chrome roots, and `orca cleanup` kills them, leaving live jobs alone.
- The UI-job verifier prompt reflects the agent-browser skill (session, snapshot/refs, waits, screenshot evidence, close). Tests assert this. The CLI-job prompt is unchanged.
- `npm test` is green, with no leaked watchers (see 12).

## Source refs
- `~/.nvm/versions/node/v24.20.0/lib/node_modules/agent-browser/skills/agent-browser/SKILL.md`
- `~/.nvm/versions/node/v24.20.0/lib/node_modules/agent-browser/skill-data/core/SKILL.md`
- `~/.nvm/versions/node/v24.20.0/lib/node_modules/agent-browser/README.md`
- orca f721fb3 (`ORCA_JOB` / `ORCA_WORKER` tagging and browser reaping)

## Olaf's notes
- "Audit whether orca leaves Chrome running after verification. Improve verification using agent-browser's own skill."

## Found 2026-10-19 (night)

`orca cleanup` "close browser orca-*" for stale agent-browser sessions *starts* a fresh agent-browser daemon + Chrome per session and then hangs: one cleanup on motion-lab spawned ~11 untagged Chromes (~3 GB RAM) and never exited. Closing a stale session must never launch a browser (check whether its daemon/Chrome is alive first; otherwise just delete its state), cleanup must have a timeout, and every browser orca starts must carry ORCA_JOB so orphans are findable.

## Done

**Audit (which close paths kill Chrome), from the hygiene audit:**
- Prompt `agent-browser --session X close`: only if the agent obeys; the daemon may leave Chrome. Unchanged.
- `orca verify` close at start/end: before, the pre-run close on a dead session launched daemon + Chrome (the 2026-10-19 bug); now the pre-run close only deletes dead state and the final close is real plus a kill of session leftovers.
- `orca reap [--worker]`, `releaseJob` (done/stop/fail): before, killed Chrome only if it carried `ORCA_JOB` (the daemon drops env, so untagged Chrome survived) and could spawn browsers; now tag + session-name process tree, no spawn.
- New verifier round: before, nothing; now reaps the previous verifier/verify sessions.
- `orca cleanup`: before, "close" per stale session spawned ~11 Chromes and hung; now dead sessions are only state-deleted, 120s budget, tag + session reap, plus an orphan sweep (`--dry-run`).

**(a)** `lib/browsers.mjs` attributes daemon/Chrome to `orca-<sha8>-<worker>`; tests in `test/browser-hygiene.test.mjs` (commit d01d4b9).

**(b)** UI-job verifier prompt (`job.jobType === "ui"`) gets a 6-line block (`browserVerifierLines` in `bin/orca.mjs`): own session closed last, snapshot then act on `@eN` refs, explicit waits (no sleeps), screenshots under `results/`, console and network checked. CLI prompt is byte-identical to before.
- **Link, not ship.** The installed `skills/agent-browser/SKILL.md` is only a stub that says to run `agent-browser skills get core`, so the prompt points at that command. It serves text matching the installed version, so it follows upgrades; a copied excerpt (540-line core skill) would go stale and bloat the prompt.
- **No new `orca verify` steps.** The step runner is open/visible/text; a wait-for or screenshot-on-fail step is not a clear win yet (verifiers can wait and screenshot via agent-browser directly), so it is left out.
- Tests: `test/verifier-browser-prompt.test.mjs` (UI prompt has the practices; CLI prompt has none of it and equals the UI prompt minus the block).
- `npm test`: 232 pass, 0 fail
