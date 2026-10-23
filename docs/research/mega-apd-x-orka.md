# Adam's "Towards Autonomous Product Development" × orka

Research only, 2026-10-22. No product code changed. Branch `research/mega-apd` from `main` at `b49d0a0`.

The question (Olaf): how to use Adam's approach in our way of working. Our chain is Olaf → Grok Bot agents (orka is one) → Claude or Pi seats in Herdr on the VPS → `orka` jobs (orchestrator → workers → verifier) across motion-lab, diagram-framework, orka and the other repos.

## Sources

- **The article**: https://mega.dev/autonomous-product-development, fetched 2026-10-22 (HTTP 200, 201 KB), raw HTML in [`mega-autonomous-product-development.html`](mega-autonomous-product-development.html). Text and the figure `alt` texts read in full. The figures are images; I used only their `alt` text. The Limen repo offered as a "bonus" is behind an email form; I did not unlock it (its public code is already covered on `design/context-and-collab`).
- **What we already know**: `docs/research/overment-vs-orca.md` (untracked on `main`), `docs/design/context-and-collab.md` §3 and "Limen, latest source" (branch `design/context-and-collab`), `docs/research/poteto-x-orka.md` (branch `research/poteto-x-orka`), `~/orka-findings/poteto.tsv` (P1-P19).
- **Our side, measured today**: `~/bin/orca-chain`, `~/projects/orca/.orca/chain.log`, `crontab -l`, `.orca/briefs/` in each target repo, `ls` of each target repo root, `docs/cleanup.md`, `docs/rename.md`.

### A date correction

The brief calls the overment-agents page "the older article". It is the other way round. This article's JSON-LD says `datePublished: 2026-09-08`. The overment-agents page analyses Adam's messages from **Sep 1 to Oct 20, 2026**. So this article is the **earlier, programmatic** text (what Adam set out to build). The overment-agents page is the **later, measured** account of how it ran. The design doc also calls this article "the newest public writing" (`context-and-collab.md`, "Limen, latest source"); that is wrong for the same reason. Below, "new" means "in this article and not in the overment-agents page or our three docs".

## TL;DR

1. **Most of the harness is already covered.** Vision + style guide injection, the board, short threads, Grok Bot → Herdr → Pi, coordinator/worker/reviewer/researcher roles, waves, and corrections to the same coordinator are all in `overment-vs-orca.md` and the Limen section. I do not repeat them.
2. **What is new is the *product* layer around the harness**: work triggered by events and schedules instead of by Adam; a list of low-risk background agents that run without supervision; a spec stage with researchers and a discussion gate *before* building; a concrete spec format (folders by feature, stage and date, commit refs instead of code, snapshots instead of links); docs and specs maintained by scheduled agents; and an explicit access boundary (dev logs, dev DB, past sessions: yes; prod DB, root: no).
3. **We already run unattended, but only on one repo and only for one shape of work.** `orca-chain` merged and pushed 12 orka tasks overnight on 2026-10-18/19 (`chain.log`: tasks 11, 12, 13, 04, 05, 06, 07, 09, 08, 10, 14, 15, 21:54Z → 03:23Z, zero retries, zero stops). Cron starts no jobs: the only entries are `orca-night-log` (RAM/load log) and `memwatch`.
4. **Our specs are not kept.** Grok Bot agents write the briefs (50 in motion-lab, 9 in diagram-framework), but `.orca/` is gitignored (`motion-lab/.gitignore:4`), so every brief is outside git, unversioned and unlinked to commits. No target repo has `orca.features.md` committed at its root, and none has a `vision.md`. motion-lab has `docs/HOUSE-STYLE.md`, diagram-framework has `AGENTS.md` and `ROADMAP.md`.
5. **Recommendation:** adopt Adam's *spec store + autonomy policy per repo + scheduled read-only agents*. Do not adopt "letting go of control" for taste work: poteto's data says taste and approved-work regressions are where Olaf's time goes (P8, P10), and those need locks, not more autonomy.

## 1. What is new in this article

| # | Idea in the article | In overment-agents / our docs? |
|---|---|---|
| N1 | **Event and schedule triggers.** "Much of the work we assign to them could be triggered automatically by bug reports, support tickets, code-review requests, scheduled quality checks, monitoring alerts, incidents, and errors in logs." | No. overment-agents always starts with "Adam (one line, often by voice)". |
| N2 | **Low-risk background agents**, run without supervision because "those mistakes have limited consequences": feedback mining from usage data and meeting transcripts; dead code and refactor scans; perf monitoring on the dev app; making the test env closer to prod; edge-case hunting with screenshots that ends in an issue report. | Partly. overment-agents has "agents audit agents" (harness logs). Product-side scanners are new. |
| N3 | **A spec stage with researchers and a discussion gate.** "Each Coordinator's job is to spawn Researchers that gather the context it needs to draft the feature specifications. It then updates Grok Bot so we can discuss the proposed direction." Spec inputs: "the project's general vision, its change history and recent specifications, and an audio recording". "Agents may explore a few approaches and present them to us or choose the best one on their own." | No. overment-agents has the Grok Bot agent write a task file and the coordinator own the spec, but no explicit pause to discuss direction. |
| N4 | **Routing.** "Grok Bot checks the board and active Coordinators, then decides whether to spawn a new Coordinator or pass the task to an existing one." | Partly (corrections go to the same coordinator). The routing decision for *new* input is new. |
| N5 | **Hierarchical coordinators.** "These coordinators can also be managed by another agent." | No. |
| N6 | **Spec format.** Folders "that clearly indicate which feature each specification covers, the feature's current stage, and when work on it took place"; "flexible templates"; "reference commits rather than include code"; "prefer snapshots over external links". Decision log compressed by agents "as long as the original notes are preserved". | No. overment-agents only says a post-job step "adds what the workers found to the specs". |
| N7 | **Docs and specs on a schedule.** "We just need to set up agents to maintain them on a schedule." Docs built "from issues and all the resources attached to them", not only from code. | No. |
| N8 | **Quality coordinators at night.** "Dedicated Coordinators work in the background, often at night, according to schedules set by Grok Bot." | No. |
| N9 | **Access boundary.** Yes: the app (screenshots), product docs, SDK docs, dev and prod *logs*, dev DBs, "controlled, indirect access to production data", past agent sessions, past decisions, trackers, team chat, support tickets. No: "direct access to the production database or root permissions on a server." | No. |
| N10 | **Direct worker steering.** "Grok Bot can access their sessions and bring them into focus. This way, I can talk to any Worker and steer it directly." | No (overment-agents routes everything through the coordinator). |
| N11 | **Agents need their own email and messaging accounts.** | No. |
| N12 | **Foundations before the rebuild**: unified logging across API, Rust and Svelte; a test env wired to the app's webview; product primitives (Integrations, Secrets, Events, Values, Capability); a design system; docs on Astro with real UI components instead of screenshots. | Partly ("lab", "primitives: find, spec, call"). The logging and docs points are new. |

Not new: vision.md + styleguide injected by the Pi extension, the board file, short threads, roles, waves, Grok Bot over Tailscale. Claims I cannot check: "In five days, I delivered not only the app but also the entire website and API", "$750k through various campaigns".

## 2. The loop, step by step

Owner key: **O** = Olaf, **G** = a Grok Bot agent, **Orch** = orka orchestrator, **W** = worker, **V** = verifier, **CLI** = orka code, **Cron** = a schedule.

### 2.1 Idea

- **Adam:** a long voice note to Grok Bot; *or* an event (bug report, alert, log error) or a schedule, with no human (N1).
- **Us today:** Olaf talks to a Grok Bot agent. The only automated start is `orca-chain` reading a hand-made queue (`.orca/chain-queue`). Cron starts nothing.
- **Verdict: adapt.** Keep Olaf as the main source of ideas. Add schedules, not events: we have no users, tickets or prod alerts on these repos, so N1's event list mostly does not apply. The sources we do have are job records, steers and render or test failures. Owner: **G** decides; **Cron** fires.

### 2.2 Spec

- **Adam:** a coordinator spawns researchers, drafts the spec from vision + history + recent specs + the voice note, and comes back through Grok Bot to discuss the direction (N3). Specs live in feature folders (N6).
- **Us today:** **G** writes a brief into `.orca/briefs/<x>.md` (26 of 125 goals were brief pointers, poteto 2.5). The orchestrator splits at once; there is no intake (P11). Briefs are gitignored.
- **Verdict: copy the store, adapt the gate.**
  - *Copy:* a committed spec per feature (section 5). The brief becomes a pointer to it.
  - *Adapt the gate:* poteto's `intent.md` (intake without a pause) is right for fixes and follow-ups. For a **new feature** in a creative repo, add Adam's discussion gate: a `--playbook spec` job that only researches and writes the spec, and ends with the spec as the finish message. Building is a second job. The cost is one extra wake for Olaf; the evidence for paying it is poteto's "about 55 of 107 steers are taste or direction" and the five lens rounds.
  - Owner: **G** writes the first draft from Olaf's words, **Orch** (spec playbook) researches and completes it, **O** approves direction.

### 2.3 Build

- **Adam:** coordinators run workers in waves; Grok Bot can focus any worker for direct steering (N10); hierarchical coordinators (N5).
- **Us today:** one orchestrator per job, builders split by file in one worktree; median 2 builders; 7 of 49 splits parallel (poteto 2.5), mostly because of RAM and shared files.
- **Verdict:**
  - *Waves:* we already have them in practice (sequential chains, 20 of 49). **Skip** a new concept.
  - *Direct worker steering:* **adapt.** Herdr panes already let Olaf look at a worker. What is missing is a safe way to message one without confusing its orchestrator. Low priority; a `--to <worker>` on `orka steer` that also logs the steer to the job would do it. Not in the top 5.
  - *Hierarchical coordinators:* **skip.** The Grok Bot agent is already the layer above the orchestrator. RAM (7.6 GB, two builders at most in practice) makes a coordinator-of-coordinators pointless here.

### 2.4 Verify

- **Adam (this article):** "agents can not only run tests but also interact with the app and validate its behavior and appearance against defined checks and metrics." The later page adds the evidence ladder.
- **Us today:** separate verifier, patch-id guard, `orka verify --base`, stall handling. Gaps from poteto: gates live in the prompt (P2), no evidence tier (P17), approved work regresses (P8), worktrees not runnable (P5).
- **Verdict: nothing new to copy here.** Do poteto's gates, doctor and approve-and-lock first. They are the precondition for any step below that runs without Olaf.

### 2.5 Land

- **Adam:** coordinators merge (Limen `land` is a plain `git merge`, no push, per the Limen section). "Some changes may not even require human supervision, depending on the project we're working on and our policies."
- **Us today:** two policies that are not written down anywhere. On the orka repo, `orca-chain` merges `--no-ff`, runs `npm test` and **pushes `origin main`** on a verifier pass (`~/bin/orca-chain` header). Everywhere else, Olaf merges by hand ("you decide what to merge", README).
- **Verdict: adapt Adam's "policies" into an explicit autonomy level per repo** (section 3). This is the one place the article changes what we should build: the policy already exists for orka, it is just hard-coded in a shell script.

### 2.6 Learn

- **Adam:** specs, decision log and docs are updated by agents on a schedule (N6, N7); agents scan the infrastructure "to improve feedback loops" (the article's version of "agents audit agents").
- **Us today:** humans write research notes (this one included) that become `tasks/NN`. The verifier is meant to update `orca.features.md` on a pass, but no target repo has one committed at its root. Steers are never turned into checks (P10).
- **Verdict: copy, scheduled.** A nightly read-only job per active repo that (a) appends lessons from the day's job records to the feature specs, (b) runs poteto's correct pass as a *proposal* on a branch. Owner: **Cron** starts, **Orch** runs, **O** merges.

## 3. Autonomy levels and approval gates

Adam names policies but not levels. Proposed levels, set per repo in `.orka/config.json` (`"autonomy": "L1"`), enforced by the CLI, not the prompt:

| level | what may run without Olaf | gate to go further | today |
|---|---|---|---|
| L0 read-only | scans and reports: edge cases with screenshots, dead code, perf, job-record audit, spec and doc drift. Output is a file or an issue note on a branch. | none | nothing runs this way |
| L1 branch | build + verify on `orka/<id>`. | Olaf merges | default for all repos except orka |
| L2 gated land | merge to main when: verifier pass, gates green (poteto B1), patch-id current, no `orka.approved.json` path touched without `UNLOCK:`, tests green after merge. No push. | Olaf pushes or reviews the morning summary | orka, via `orca-chain` (but it also pushes) |
| L3 land + push | L2 + push. | none | orka today, implicitly |

Suggested settings, to be confirmed by Olaf:
- **orka: L2.** It has tests and a CLI-acceptance verifier. 12 of 12 overnight tasks landed without a stop. Drop the push, or keep it and call it L3 on purpose.
- **diagram-framework: L1, L2 for jobs whose only checks are `orka verify` + tests** (it is the one repo with `orca.verify.json` and a verify skill).
- **motion-lab, thumb-lab, motion-craft: L1 always.** Their output is judged by taste, and that is where the regressions are (P8). Unattended work there stays at L0 or at L1 *renders for review*.
- **vault-audit: L0 only.** It touches the vault, whose rules forbid deleting notes and writing `.obsidian/`.

Gates, in order: **G-spec** (direction, new features only, section 2.2) → **G-gates** (CLI checks before the verifier) → **G-verdict** (verifier pass, patch-id) → **G-land** (the level above) → **G-taste** (Olaf; locked by `orka approve`).

## 4. What runs overnight or unattended

Adam: quality coordinators at night on schedules set by Grok Bot (N8); docs and specs on a schedule (N7). Us: `orca-chain` on one repo, on demand, from a hand-filled queue.

Proposal, all bounded by RAM (`MIN_MEM_MB=1200` in `orca-chain`, `memwatch` at 500/900 MB):

1. **Generalise `orca-chain` into `orka chain`** with a per-repo queue and the autonomy level from section 3 deciding whether it merges. One job at a time, as now.
2. **A nightly L0 slot per active repo**, one job, read-only, rotating: job-record audit (overment gap 5), spec/feature-map refresh (2.6), and for diagram-framework an edge-case hunt with agent-browser screenshots. Output: a branch with a report, and one finish message.
3. **A morning summary** to the Grok Bot agent: what landed, what is on a branch for review, what the L0 jobs found. This is overment's "human-ready finish message" (rec 1) applied to the night as a whole.
4. **Grok Bot owns the schedule** (as in the article), but the schedule is a committed file (`.orka/schedule.json` or the crontab), not something only the bot remembers. Unknown: whether Olaf's Grok Bot routines can start shell jobs on the VPS today; `docs/rename.md:35` says routines exist, I did not read them.

Not overnight: anything in motion-lab or thumb-lab that needs Olaf's eye to accept, beyond rendering candidates for the morning.

## 5. Specs and the feature map

Adam's three files: global context (`vision.md`, styleguide; human-owned), `board` (agent-kept), specs (agent-kept: description, reasoning, lessons).

| | Adam | us | verdict |
|---|---|---|---|
| vision | `vision.md`, injected | none in any target repo; diagram-framework `ROADMAP.md` "Now" paragraph is close | **copy**, as a section of `AGENTS.md` (the design doc's choice), not a separate injected file: orka will not install a Pi extension |
| style guide | `styleguide`, injected each session | motion-lab `docs/HOUSE-STYLE.md`; taste lint `npm run lint` (not run by the harness, P4) | **adapt**: point to it from `AGENTS.md`, and enforce what can be enforced as lint (poteto B6) |
| board | file, current + planned | `orka status`; `chain-queue`; `ROADMAP.md` | **adapt**: generated from job records + spec stages, never hand-edited by agents (overment gap 8) |
| specs | feature folders, stage, dates, commit refs, snapshots | briefs in gitignored `.orca/briefs/` | **copy** |
| feature map | an image of capabilities in the article; not a file format | `orca.features.md` (reach/drive/prove, commit-stamped) designed in task 09, not committed in any target repo | **merge** with specs: one `specs/<feature>/` folder holds the spec and its reach/drive/prove block |

Proposed layout in each target repo (committed, so specs get history and commit refs):

```
specs/
  <feature-slug>/
    spec.md        # stage: idea | spec | building | shipped | parked; dates; goal; decisions; lessons; commits
    refs/          # snapshots (Olaf's screenshots, reference stills) instead of links
```

- `orka new --spec specs/<slug>` replaces `Follow .orca/briefs/<x>.md`. The brief text can stay in the job; the durable parts go into the spec.
- The verifier's feature-map write goes into the spec's prove block, with the commit.
- A post-job step appends "lessons" (≤5 lines) and the merge commit. Cap the file; a nightly job compresses old lessons and keeps the originals in git history (Adam's "as long as the original notes are preserved").
- This needs orka (or a job) to write into target repos, which is open question 1 in the poteto doc.

## 6. Product feedback loops

The article's loops assume a product with users: usage data, support tickets, prod logs. Ours are a studio and render pipelines whose "users" are Olaf and his viewers.

- **Copy:** feedback from the work itself. Steers → correct pass (poteto B6). Verifier failures by class → lint candidates (poteto 2.2 "framing" rule). Job records → audit (overment gap 5).
- **Adapt:** the edge-case hunter, for diagram-framework's studio editor only (agent-browser, screenshots, an issue note per finding). L0.
- **Skip for now:** meeting-transcript mining, prod logs, support tickets, agent email accounts (N11). No source exists for them here. Viewer feedback (YouTube comments, retention) is a real source for the video repos, but that is a content decision for Olaf, not a harness one.
- **Unified logging** (N12) is worth noting for motion-lab: poteto found agents rediscovering the environment in 14.2% of tool calls there. One log location per run would cut part of that. Guessed, not measured.

## 7. Where this meets poteto

| poteto finding | article idea | combined proposal |
|---|---|---|
| P11 no intake | N3 spec stage + discussion gate | intake (`intent.md`) for fixes; `--playbook spec` + G-spec for new features |
| P8 approved work regresses; P10 steers never become checks | "letting go of control" | do **not** let go on taste; lock it (`orka approve`) and only then raise autonomy |
| P2/P4 gates in prompt, taste lint unused | "validate … against defined checks and metrics" | gates in CLI are the precondition for L2 |
| P5/P6/P7 environment rediscovery | N9 access list, N12 unified logging | `AGENTS.md` + doctor + one log location; same fix |
| P17 no evidence tier | (ladder is on the later page) | unchanged |
| P18 no metric | "agents scan the infrastructure to improve feedback loops" | `orka stats` feeds the nightly audit |
| P12/P13 RAM forces serial | waves, hierarchy | skip hierarchy; one-job-at-a-time chain is right for this VPS |

## 8. Top 5 to adopt

1. **Commit specs in each target repo** (`specs/<feature>/spec.md` with stage, dates, decisions, lessons, commit refs, `refs/` snapshots); `orka new --spec`; the feature-map block lives inside. **M.** Why: today every brief is gitignored, so nothing Olaf or Grok Bot decided survives in git, and the feature map is unused.
2. **Autonomy level per repo, enforced by the CLI** (L0-L3, section 3), and `orka chain` generalised from `~/bin/orca-chain` to read it. **M.** Why: the policy already exists and works for orka (12/12 overnight), but it is hidden in a shell script and pushes without saying so.
3. **Nightly L0 slot**: one read-only job per night per active repo (audit of job records, spec refresh, diagram-framework edge-case hunt), ending in a single morning summary. **M.** Why: Adam's lowest-risk, highest-volume idea; it uses records orka already writes; it cannot break main.
4. **`--playbook spec` with a direction gate for new features** (researchers → spec → finish message, no building). **S-M.** Why: taste and direction are the largest steer class (≈55/107); one cheap pause before building is cheaper than five render rounds.
5. **Post-job lessons into the spec, compressed nightly** (Adam's "agents keep forgetting to update the specifications", fixed by a step the CLI runs, not a prompt line). **S.** Why: closes the learn step; overment gap 9 with a home for the output.

Prerequisites from poteto that come first: `gates-before-verifier`, `worktree-setup-and-doctor`, `approve-and-lock`. L2 on any repo besides orka should wait for them.

## 9. Open questions for Olaf

1. **Push.** `orca-chain` pushes `origin main` with no human. Keep that for orka (L3), or stop at merge (L2)?
2. **Which repos may land unattended?** Proposed: orka L2, diagram-framework L1/L2, the video repos L1, vault-audit L0. How this lands with others: none of these repos have other committers today as far as I can see; if MEGA students or collaborators get access to any of them, an auto-merging bot should be announced first.
3. **Specs in git.** OK to commit `specs/` in target repos (via job branches you merge)? It changes the "orka writes nothing into target repos" stance from the design doc.
4. **Spec gate.** Pause for direction on new features only, or for every creative job?
5. **Grok Bot routines.** Can they start `orka` on a schedule today, and where are they defined? I did not read them.
6. **Viewer feedback** (comments, retention) as an input to motion-lab and thumb-lab specs: in scope or not?
7. **The article's numbers** (five days, $750k) are unverified claims; I did not use them as evidence.
