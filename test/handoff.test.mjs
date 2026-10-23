import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piSlug } from "../lib/context.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");
const FIX = join(import.meta.dirname, "fixtures", "context");
const TASK = "GOAL: build part one. SCOPE: src. ACCEPTANCE: tests pass.";
// fixtures/context/pi.jsonl: 89426 tokens on xai/grok-4.7; the fake pi registry gives it a 200k window = 45%.

// Fake herdr. State per agent name in the box: pane-<name>, status-<name> (default idle),
// prompts-<name> (one prompt per block, separated by a ----- line). A prompt sets the agent
// working. `agent rename A B` moves A's state to B. Knobs: rename-fail.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-handoff-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const st = join(base, "state");
  for (const d of [repo, bin, home, join(base, "run"), st]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
printf '%s\\n' "herdr $*" | head -c 300 >> "${log}"; echo >> "${log}"
S="${st}"
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[]}}';;
  "pane split") n=$(cat "$S/splits" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$S/splits"; echo "{\\"result\\":{\\"pane\\":{\\"pane_id\\":\\"p-$n\\"}}}";;
  "agent start") echo "$7" > "$S/pane-$3"; echo idle > "$S/status-$3"; echo '{"result":{}}';;
  "agent prompt") printf '%s\\n-----\\n' "$4" >> "$S/prompts-$3"; echo working > "$S/status-$3"; echo '{"result":{}}';;
  "agent rename")
    [ -e "${base}/rename-fail" ] && { echo '{"error":{"message":"rename refused"}}'; exit 1; }
    for f in pane status prompts; do [ -e "$S/$f-$3" ] && mv "$S/$f-$3" "$S/$f-$4"; done; echo '{"result":{}}';;
  "agent get")
    [ -e "$S/pane-$3" ] || { echo '{"error":{"message":"not found"}}'; exit 1; }
    echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$(cat "$S/status-$3")\\",\\"interactive_ready\\":true,\\"pane_id\\":\\"$(cat "$S/pane-$3")\\"}}}";;
  "pane read") printf '╭────╮\\n│ ❯ │\\n╰────╯\\n';;
  *) echo '{}';;
esac
`,
  );
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  chmodSync(join(bin, "herdr"), 0o755);
  chmodSync(join(bin, "agent-browser"), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const registry = (window) => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "models-store.json"), JSON.stringify({ xai: { models: [{ id: "grok-4.7", contextWindow: window }] } }));
  };
  registry(200000);
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1",
    ORKA_PROMPT_POLL_MS: "10", ORKA_PROMPT_WAIT_MS: "250", ORKA_PROMPT_BACKOFF_MS: "20", ORKA_READY_WAIT_MS: "1500", ORKA_HANDOFF_NUDGE_GRACE_MS: "1",
  };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  const file = (f) => (existsSync(join(st, f)) ? readFileSync(join(st, f), "utf8") : "");
  return {
    base, repo, home, orka, registry,
    setStatus: (name, s) => writeFileSync(join(st, `status-${name}`), s),
    setPane: (name, pane) => writeFileSync(join(st, `pane-${name}`), pane),
    noRegistry: () => rmSync(join(home, ".pi", "agent", "models-store.json"), { force: true }),
    prompts: (name) => file(`prompts-${name}`).split("-----\n").filter((p) => p.trim()),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    config: (handoff) => {
      const path = join(repo, ".orka", "config.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), handoff }));
    },
  };
}

function makeJob(t) {
  const id = t.orka(["new", "--kind", "pi", "--title", "h", "--goal", "g", "--no-gate"]).stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  const worktree = join(t.repo, "wt");
  mkdirSync(worktree, { recursive: true });
  Object.assign(job, { status: "running", pane: "p-orch", agent: "orch", worktree });
  writeFileSync(path, JSON.stringify(job));
  t.setPane("orch", "p-orch");
  t.setStatus("orch", "working");
  const dir = join(t.repo, ".orka", "jobs", id);
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  // The worker's pi transcript, at the path pi uses for --session-id.
  const transcriptFor = (sessionId) => {
    const folder = join(t.home, ".pi", "agent", "sessions", piSlug(worktree));
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(FIX, "pi.jsonl"), join(folder, `2026-10-22T10-00-00-000Z_${sessionId}.jsonl`));
  };
  const transcript = (name) => transcriptFor(read().workers.find((x) => x.name === name).sessionId);
  // The orchestrator, as orka run starts it: a session id and its transcript.
  const lead = () => {
    const job = read();
    job.sessionId = "lead-session-1";
    writeFileSync(path, JSON.stringify(job));
    transcriptFor(job.sessionId);
  };
  return { id, dir, path, read, transcript, transcriptFor, lead, decisions: () => (existsSync(join(dir, "decisions.tsv")) ? readFileSync(join(dir, "decisions.tsv"), "utf8").split("\n").slice(1).filter(Boolean) : []) };
}

function startWorker(t, j, name = "builder", extra = []) {
  const r = t.orka(["worker", "--job", j.id, "--name", name, "--task", TASK, ...extra]);
  assert.equal(r.status, 0, r.stderr);
  t.setStatus(name, "idle");
  j.transcript(name);
}

test("orka worker starts the pane with --session-id and records it", () => {
  const t = scratch();
  const j = makeJob(t);
  startWorker(t, j);
  const w = j.read().workers[0];
  assert.match(w.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(w.startedAt);
  assert.ok(t.calls().some((c) => c.startsWith("herdr agent start builder --kind pi --pane p-1") && c.includes(`-- --session-id ${w.sessionId} --skill `) && c.endsWith("plugin/skills/handoff")), t.calls().join("\n"));
});

test("below the threshold: measured and recorded, nobody prompted", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.5 });
  startWorker(t, j);
  const r = t.orka(["handoff", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /builder: 89426\/200000 tokens 45% \(pi registry xai\/grok-4.7\) -> keep \(45% < 50%\)/);
  assert.equal(t.prompts("builder").length, 1); // only the task
  assert.equal(j.read().workers[0].context.pct, 0.447);
  assert.match(t.orka(["status", j.id]).stdout, /worker: builder .* ctx=45% of 200k \(pi registry xai\/grok-4.7\)/);
});

test("past the threshold but blocked: waits", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  t.setStatus("builder", "blocked");
  assert.match(t.orka(["handoff", j.id]).stdout, /45% \(pi registry xai\/grok-4.7\) blocked -> keep \(45% but blocked\)/);
  assert.equal(t.prompts("builder").length, 1);
});

test("full handoff: note asked, old agent renamed and kept open, fresh agent picks up the note", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  const first = j.read().workers[0];
  const note = join(j.dir, "handoff", "builder-1.md");

  assert.equal(t.orka(["handoff", j.id]).status, 0);
  const asked = t.prompts("builder");
  assert.equal(asked.length, 2);
  assert.equal(asked[1].split("\n")[0], `/skill:handoff ${note} role=worker`);
  assert.match(asked[1], /45% \(89k of 200k tokens, cap 40%\)/);
  let w = j.read().workers[0];
  assert.equal(w.handoff.state, "writing");
  assert.equal(w.handoff.n, 1);
  assert.equal(w.handoff.note, note);
  assert.match(t.orka(["status", j.id]).stdout, /handoff=writing/);

  // No note yet: nothing moves.
  t.setStatus("builder", "idle");
  t.orka(["handoff", j.id]);
  assert.ok(!t.calls().some((c) => c.startsWith("herdr agent rename")));

  writeFileSync(note, "Changes: src/a.js\nRemaining slice: part two\n");
  const r = t.orka(["handoff", j.id]);
  assert.equal(r.status, 0, r.stderr);
  const calls = t.calls();
  assert.ok(calls.includes("herdr agent rename builder builder-h1"), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("herdr pane split --pane p-1 --direction down")));
  assert.ok(!calls.some((c) => c.startsWith("herdr pane close")), "no pane is closed mid-job");

  const job = j.read();
  assert.equal(job.workers.length, 2);
  const [old, fresh] = job.workers;
  assert.equal(old.name, "builder-h1");
  assert.equal(old.pane, "p-1");
  assert.equal(old.closed, undefined);
  assert.deepEqual({ by: old.retired.by, n: old.retired.n }, { by: "builder", n: 1 });
  assert.equal(old.handoff.state, "done");
  assert.equal(fresh.name, "builder");
  assert.equal(fresh.pane, "p-2");
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.equal(fresh.task, TASK);
  assert.equal(fresh.result, first.result);
  assert.equal(fresh.delivery, "ok");
  assert.deepEqual(fresh.handoffs.map((h) => [h.n, h.from, h.pane, h.sessionId, h.note]), [[1, "builder-h1", "p-1", first.sessionId, note]]);
  assert.equal(job.handoffs.length, 1);
  assert.equal(job.handoffs[0].worker, "builder");
  assert.ok(calls.some((c) => c.startsWith("herdr agent start builder --kind pi --pane p-2") && c.includes(`--session-id ${fresh.sessionId} --skill `)), calls.join("\n"));

  const successor = t.prompts("builder");
  assert.equal(successor.length, 1);
  assert.match(successor[0], /You are a worker for orka job/);
  assert.match(successor[0], /HANDOFF \(h1\)/);
  assert.ok(successor[0].includes(`Read ${note} first`));
  // The old agent's prompts moved with its name; it got nothing new.
  assert.equal(t.prompts("builder-h1").length, 2);

  const rows = j.decisions();
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\thandoff\task builder for handoff note h1\t/);
  assert.match(rows[1], /\thandoff\tbuilder-h1 -> fresh builder \(h1\)\t.*45% when the note was done; old pane p-1 stays open/);
  const digest = t.orka(["digest", j.id]).stdout;
  assert.match(digest, /- builder-h1 handed off at 45% to builder, pane open/);
  assert.match(digest, /builder-h1 -> fresh builder/);
  assert.match(t.orka(["status", j.id]).stdout, /worker: builder-h1 pane=p-1 .*handed-off->builder \(h1, pane open\)/);

  // The successor is measured again under the same name; a second handoff would be h2.
  t.setStatus("builder", "idle");
  j.transcript("builder");
  t.orka(["handoff", j.id]);
  assert.equal(j.read().workers[1].handoff.note, join(j.dir, "handoff", "builder-2.md"));
});

test("herdr status done (finished turn, not looked at) is a safe point like idle", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  t.setStatus("builder", "done");
  assert.match(t.orka(["handoff", j.id]).stdout, /45% \(pi registry xai\/grok-4.7\) done -> hand off/);
  assert.equal(t.prompts("builder").length, 2);
  writeFileSync(join(j.dir, "handoff", "builder-1.md"), "note");
  t.setStatus("builder", "done");
  t.orka(["handoff", j.id]);
  assert.equal(j.read().workers[0].name, "builder-h1");
  assert.equal(j.read().workers.length, 2);
});

test("done after a handoff closes both panes; before that none is closed", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  t.orka(["handoff", j.id]);
  writeFileSync(join(j.dir, "handoff", "builder-1.md"), "note");
  t.setStatus("builder", "idle");
  t.orka(["handoff", j.id]);
  assert.ok(!t.calls().some((c) => c.startsWith("herdr pane close")));
  const r = t.orka(["done", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /closed worker pane p-1 \(builder-h1\)/);
  assert.match(r.stdout, /closed worker pane p-2 \(builder\)/);
});

test("exempt: verifier, a worker with a result file, handoff false", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.01 });
  startWorker(t, j, "verifier", ["--role", "verifier"]);
  startWorker(t, j, "done-one");
  writeFileSync(join(j.dir, "results", "done-one.json"), '{"ok":true}');
  assert.match(t.orka(["handoff", j.id]).stdout, /no pane to measure/);
  assert.equal(t.prompts("verifier").length, 1);
  assert.equal(t.prompts("done-one").length, 1);

  startWorker(t, j, "builder");
  t.config(false);
  assert.match(t.orka(["handoff", j.id]).stdout, /no pane to measure/);
  assert.equal(t.prompts("builder").length, 1);
});

test("a rename herdr refuses abandons the handoff: no new pane, name kept, reason recorded", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  t.orka(["handoff", j.id]);
  writeFileSync(join(j.dir, "handoff", "builder-1.md"), "note");
  t.setStatus("builder", "idle");
  writeFileSync(join(t.base, "rename-fail"), "");
  t.orka(["handoff", j.id]);
  const job = j.read();
  assert.equal(job.workers.length, 1);
  assert.equal(job.workers[0].name, "builder");
  assert.equal(job.workers[0].handoff.state, "failed");
  assert.match(job.workers[0].handoff.reason, /rename refused/);
  assert.ok(!t.calls().some((c) => c.startsWith("herdr pane split --pane p-1")));
  assert.match(j.decisions().at(-1), /handoff of builder abandoned/);
  // Failed once: not asked again on the next pass.
  t.orka(["handoff", j.id]);
  assert.equal(t.prompts("builder").length, 2);
});

test("mid-turn: a working agent past the cap gets a queued message, then hands off at its next stop", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  t.setStatus("builder", "working");
  const r = t.orka(["handoff", j.id]);
  assert.match(r.stdout, /45% \(pi registry xai\/grok-4.7\) working -> hand off \(queued mid-turn\)/);
  const note = join(j.dir, "handoff", "builder-1.md");
  const asked = t.prompts("builder");
  assert.equal(asked.length, 2);
  assert.match(asked[1], /next clean stopping point/);
  assert.ok(asked[1].includes(`/skill:handoff ${note} role=worker`));
  // Sent while working: no ready wait, no interrupt key.
  assert.ok(!t.calls().some((c) => /send-keys builder (ctrl\+c|Escape)/.test(c)));
  const w = j.read().workers[0];
  assert.equal(w.handoff.state, "nudged");
  assert.equal(w.handoff.mode, "queue");
  assert.equal(w.handoff.pct, 0.447);
  assert.match(j.decisions()[0], /queued mid-turn/);
  assert.match(t.orka(["status", j.id]).stdout, /handoff=nudged/);
  // Still working, no note: nothing more is sent.
  t.orka(["handoff", j.id]);
  assert.equal(t.prompts("builder").length, 2);
  // The agent ran the skill at its stopping point and ended the turn.
  writeFileSync(note, "Remaining slice: part two\n");
  t.setStatus("builder", "idle");
  t.orka(["handoff", j.id]);
  const job = j.read();
  assert.equal(job.workers[0].name, "builder-h1");
  assert.equal(job.workers[1].handoffs[0].mode, "queue");
  assert.equal(job.workers[1].handoffs[0].pctEnd, 0.447);
});

test("mid-turn: nudged but idle without a note runs the skill command directly after the grace", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  t.setStatus("builder", "working");
  t.orka(["handoff", j.id]);
  t.setStatus("builder", "idle");
  t.orka(["handoff", j.id]); // first idle sighting starts the grace
  assert.equal(t.prompts("builder").length, 2);
  t.orka(["handoff", j.id]);
  const asked = t.prompts("builder");
  assert.equal(asked.length, 3);
  assert.match(asked[2], /^\/skill:handoff .*builder-1\.md role=worker/);
  assert.equal(j.read().workers[0].handoff.state, "writing");
});

test("window unknown: no automatic handoff, logged once, status says so; orka handoff <id> <name> still works", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.01 });
  t.noRegistry();
  startWorker(t, j);
  const r = t.orka(["handoff", j.id]);
  assert.match(r.stdout, /builder: 89426 tokens, window unknown -> keep \(window unknown\)/);
  t.orka(["handoff", j.id]);
  assert.equal(t.prompts("builder").length, 1);
  const rows = j.decisions();
  assert.equal(rows.length, 1);
  assert.match(rows[0], /no automatic handoff for builder\twindow unknown \(pi, model grok-4.7\)/);
  assert.match(t.orka(["status", j.id]).stdout, /worker: builder .*ctx=window-unknown \(89k tokens, no auto handoff\)/);
  // By hand: asked at once, no threshold.
  const m = t.orka(["handoff", j.id, "builder"]);
  assert.match(m.stdout, /builder: 89426 tokens, window unknown idle -> hand off \(asked by hand\)/);
  assert.match(t.prompts("builder")[1], /^\/skill:handoff .*builder-1\.md role=worker\norka: a handoff was asked for by hand/);
});

test("handoff.contextWindow is used only when the runtime reports nothing", () => {
  const t = scratch();
  const j = makeJob(t);
  t.noRegistry();
  t.config({ contextWindow: { grok: 100000 } });
  startWorker(t, j);
  assert.match(t.orka(["handoff", j.id, "--dry-run"]).stdout, /89426\/100000 tokens 89% \(handoff.contextWindow\)/);
  t.registry(500000);
  assert.match(t.orka(["handoff", j.id, "--dry-run"]).stdout, /89426\/500000 tokens 18% \(pi registry xai\/grok-4.7\)/);
});

test("cap: after handoff.maxHandoffs a successor past the threshold is left alone, logged once", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4, maxHandoffs: 1 });
  startWorker(t, j);
  t.orka(["handoff", j.id]);
  writeFileSync(join(j.dir, "handoff", "builder-1.md"), "note");
  t.setStatus("builder", "idle");
  t.orka(["handoff", j.id]);
  t.setStatus("builder", "idle");
  j.transcript("builder");
  assert.match(t.orka(["handoff", j.id]).stdout, /builder: .* -> keep \(cap of 1 handoffs reached\)/);
  t.orka(["handoff", j.id]);
  assert.equal(t.prompts("builder").length, 1); // only the successor's task
  assert.equal(j.decisions().filter((r) => /no more handoffs for builder/.test(r)).length, 1);
});

test("orchestrator handoff (default on): note with job state, renamed and kept open, fresh lead resumes; workers untouched", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j, "builder");
  writeFileSync(join(j.dir, "results", "builder.json"), '{"ok":true}'); // a finished worker: not measured
  startWorker(t, j, "verifier", ["--role", "verifier"]);
  j.lead();
  t.setStatus("orch", "idle");
  const before = t.calls().length;
  const r = t.orka(["handoff", j.id]);
  assert.match(r.stdout, /orch \(orchestrator\): 89426\/200000 tokens 45% \(pi registry xai\/grok-4.7\) idle -> hand off/);
  const note = join(j.dir, "handoff", "orchestrator-1.md");
  assert.match(t.prompts("orch")[0], new RegExp(`^/skill:handoff ${note.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} role=orchestrator`));
  assert.equal(j.read().lead.handoff.state, "writing");

  writeFileSync(note, "Plan: two parts\nWorkers: builder owns src (done)\n");
  t.setStatus("orch", "idle");
  t.orka(["handoff", j.id]);
  const calls = t.calls().slice(before);
  assert.ok(calls.includes("herdr agent rename orch orch-h1"), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("herdr pane split --pane p-orch --direction down")));
  assert.ok(!calls.some((c) => c.startsWith("herdr pane close")), "no pane is closed mid-job");
  // Worker and verifier panes: not prompted, not renamed, not closed.
  assert.ok(!calls.some((c) => / (builder|verifier)( |$)/.test(c)), calls.join("\n"));
  assert.equal(t.prompts("builder").length, 1);
  assert.equal(t.prompts("verifier").length, 1);

  const job = j.read();
  assert.equal(job.agent, "orch");
  assert.equal(job.pane, "p-3");
  assert.notEqual(job.sessionId, "lead-session-1");
  assert.deepEqual(job.retiredLeads.map((x) => [x.name, x.pane, x.sessionId, x.n]), [["orch-h1", "p-orch", "lead-session-1", 1]]);
  assert.equal(job.lead.handoffs[0].note, note);
  assert.equal(job.lead.handoffs[0].pct, 0.447);
  assert.equal(job.handoffs.at(-1).worker, "orchestrator");
  assert.equal(job.leadDelivery, "ok");
  assert.ok(calls.some((c) => c.startsWith("herdr agent start orch --kind pi --pane p-3") && c.includes(`--session-id ${job.sessionId}`)));
  const fresh = t.prompts("orch");
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /You are the orchestrator for orka job/);
  assert.match(fresh[0], /HANDOFF \(h1\): you take over as orchestrator/);
  assert.ok(fresh[0].includes(note) && fresh[0].includes(j.path) && fresh[0].includes("decisions.tsv"));
  assert.equal(t.prompts("orch-h1").length, 1); // the old lead got nothing new
  assert.match(j.decisions().at(-1), /orch-h1 -> fresh orch \(h1\)\t.*old pane p-orch stays open/);
  const status = t.orka(["status", j.id]).stdout;
  assert.match(status, /orchestrator: orch-h1 pane=p-orch handed-off->orch \(h1, pane open\)/);

  // orka done closes the old orchestrator pane with the worker panes, never the current one.
  const done = t.orka(["done", j.id]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /closed old orchestrator pane p-orch \(orch-h1\)/);
  assert.ok(!t.calls().includes("herdr pane close p-3"));
});

test("orchestrator handoff off with handoff.orchestrator false; working lead gets a queued ask", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4, orchestrator: false });
  j.lead();
  t.setStatus("orch", "idle");
  assert.match(t.orka(["handoff", j.id]).stdout, /no pane to measure/);
  assert.equal(t.prompts("orch").length, 0);
  t.config({ threshold: 0.4 });
  t.setStatus("orch", "working");
  assert.match(t.orka(["handoff", j.id]).stdout, /orch \(orchestrator\): .* working -> hand off \(queued mid-turn\)/);
  assert.match(t.prompts("orch")[0], /next clean stopping point.*role=orchestrator/s);
  assert.equal(j.read().lead.handoff.state, "nudged");
});

test("the watcher follows the orchestrator to its new pane and asks no question while it hands off", async () => {
  const { watchJob } = await import("../lib/watch.mjs");
  const jobs = [
    { id: "1", status: "running", pane: "p1", lead: { handoff: { state: "writing" } } },
    { id: "1", status: "running", pane: "p1", lead: { handoff: { state: "writing" } } },
    { id: "1", status: "running", pane: "p2", lead: { handoffs: [{ n: 1 }] } },
    { id: "1", status: "done" },
  ];
  let i = 0;
  const posted = [];
  const read = [];
  const logs = [];
  const deps = {
    loadJob: async () => jobs[Math.min(i++, jobs.length - 1)],
    waitAgent: async () => "idle",
    readPane: async (p) => (read.push(p), "question?"),
    post: async (x) => posted.push(x),
    log: (m) => logs.push(m),
    sleep: async () => {},
  };
  await watchJob({ jobId: "1", agent: "orch", pane: "p1", deps, waitMs: 1, graceMs: 1 });
  assert.equal(posted.length, 0);
  assert.ok(logs.some((m) => /orchestrator pane is now p2 \(was p1\)/.test(m)), logs.join("\n"));
});

test("the watcher runs the handoff tick every poll, and a throwing tick does not stop it", async () => {
  const { watchJob } = await import("../lib/watch.mjs");
  let polls = 0;
  let ticks = 0;
  const logs = [];
  const deps = {
    loadJob: async () => (polls++ < 3 ? { id: "1", status: "running" } : { id: "1", status: "done" }),
    waitAgent: async () => "working",
    readPane: async () => "",
    post: async () => {},
    tick: () => {
      ticks += 1;
      if (ticks === 1) throw new Error("boom");
    },
    log: (m) => logs.push(m),
    sleep: async () => {},
  };
  const r = await watchJob({ jobId: "1", agent: "orch", pane: "p", deps, waitMs: 1 });
  assert.equal(r.exit, "terminal");
  assert.equal(ticks, 3);
  assert.ok(logs.some((m) => /boom/.test(m)));
});

// The handoff tick and the browser housekeeping are separate hooks: one deps key each, so neither
// replaces the other in the deps object orka watch builds.
test("the watcher runs housekeep once per poll, apart from the handoff tick", async () => {
  const { watchJob } = await import("../lib/watch.mjs");
  let polls = 0;
  const calls = { tick: 0, housekeep: 0 };
  const deps = {
    loadJob: async () => (polls++ < 3 ? { id: "1", status: "running" } : { id: "1", status: "done" }),
    waitAgent: async () => "working",
    readPane: async () => "",
    post: async () => {},
    tick: () => void (calls.tick += 1),
    housekeep: () => void (calls.housekeep += 1),
    sleep: async () => {},
  };
  await watchJob({ jobId: "1", agent: "orch", pane: "p", deps, waitMs: 1 });
  assert.deepEqual(calls, { tick: 3, housekeep: 3 });
  const src = readFileSync(new URL("../bin/orka.mjs", import.meta.url), "utf8");
  const watchDeps = src.slice(src.indexOf("async function cmdWatch"), src.indexOf("watch.watchJob({", src.indexOf("async function cmdWatch")));
  assert.equal(watchDeps.match(/^\s+tick:/gm)?.length, 1, "orka watch passes one tick");
  assert.equal(watchDeps.match(/^\s+housekeep:/gm)?.length, 1, "orka watch passes one housekeep");
});

test("busy poll: waits run in busyMs slices, busy is re-asked each slice and ticks; idle keeps one tick per waitMs", async () => {
  const { watchJob } = await import("../lib/watch.mjs");
  const run = async ({ busy, busyMs, statuses, polls = 1 }) => {
    let loads = 0;
    let ticks = 0;
    let asks = 0;
    const waits = [];
    const deps = {
      loadJob: async () => (loads++ < polls ? { id: "1", status: "running" } : { id: "1", status: "done" }),
      waitAgent: async (_a, _s, ms) => (waits.push(ms), statuses.shift() || "working"),
      readPane: async () => "",
      post: async () => {},
      tick: () => void (ticks += 1),
      busy: () => (asks += 1, busy(asks)),
      log: () => {},
      sleep: async () => {},
    };
    await watchJob({ jobId: "1", agent: "orch", pane: "p", deps, waitMs: 30000, graceMs: 60000, busyMs });
    return { waits, ticks, asks };
  };
  // Lead working the whole time, a pane busy: six 5 s slices per poll, a tick after each but the last.
  let r = await run({ busy: () => true, busyMs: 5000, statuses: [] });
  assert.deepEqual(r.waits, Array(6).fill(5000));
  assert.equal(r.ticks, 1 + 5);
  // Nothing busy: still sliced and probed, but the tick runs only once per 30 s poll.
  r = await run({ busy: () => false, busyMs: 5000, statuses: [] });
  assert.equal(r.ticks, 1);
  assert.equal(r.asks, 5);
  // A worker that starts in the middle of a wait is picked up at the next slice.
  r = await run({ busy: (n) => n >= 3, busyMs: 5000, statuses: [] });
  assert.equal(r.ticks, 1 + 3);
  // busyMs 0: one plain 30 s wait, no probe.
  r = await run({ busy: () => true, busyMs: 0, statuses: [] });
  assert.deepEqual(r.waits, [30000]);
  assert.equal(r.asks, 0);
  // Lead idle while a worker is busy: the 60 s idle grace runs in 12 slices and ticks between them.
  r = await run({ busy: () => true, busyMs: 5000, statuses: ["idle", ...Array(11).fill("idle"), "working"] });
  assert.deepEqual(r.waits.slice(0, 13), [5000, ...Array(12).fill(5000)]);
  assert.equal(r.ticks, 1 + 11);
});
