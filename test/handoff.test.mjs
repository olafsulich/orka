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
// fixtures/context/pi.jsonl: 89426 tokens of the default 200k window = 45%.

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
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1",
    ORKA_PROMPT_POLL_MS: "10", ORKA_PROMPT_WAIT_MS: "250", ORKA_PROMPT_BACKOFF_MS: "20", ORKA_READY_WAIT_MS: "1500",
  };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  const file = (f) => (existsSync(join(st, f)) ? readFileSync(join(st, f), "utf8") : "");
  return {
    base, repo, home, orka,
    setStatus: (name, s) => writeFileSync(join(st, `status-${name}`), s),
    prompts: (name) => file(`prompts-${name}`).split("-----\n").filter((p) => p.trim()),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    config: (handoff) => {
      const path = join(repo, ".orka", "config.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), handoff }));
    },
  };
}

function makeJob(t) {
  const id = t.orka(["new", "--kind", "pi", "--title", "h", "--goal", "g"]).stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  const worktree = join(t.repo, "wt");
  mkdirSync(worktree, { recursive: true });
  Object.assign(job, { status: "running", pane: "p-orch", agent: "orch", worktree });
  writeFileSync(path, JSON.stringify(job));
  const dir = join(t.repo, ".orka", "jobs", id);
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  // The worker's pi transcript, at the path pi uses for --session-id.
  const transcript = (name) => {
    const w = read().workers.find((x) => x.name === name);
    const folder = join(t.home, ".pi", "agent", "sessions", piSlug(worktree));
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(FIX, "pi.jsonl"), join(folder, `2026-10-22T10-00-00-000Z_${w.sessionId}.jsonl`));
  };
  return { id, dir, read, transcript, decisions: () => (existsSync(join(dir, "decisions.tsv")) ? readFileSync(join(dir, "decisions.tsv"), "utf8").split("\n").slice(1).filter(Boolean) : []) };
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
  startWorker(t, j);
  const r = t.orka(["handoff", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /builder: 89426\/200000 tokens 45% -> keep \(45% < 50%\)/);
  assert.equal(t.prompts("builder").length, 1); // only the task
  assert.equal(j.read().workers[0].context.pct, 0.447);
  assert.match(t.orka(["status", j.id]).stdout, /worker: builder .* ctx=45%/);
});

test("past the threshold but working: waits", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ threshold: 0.4 });
  startWorker(t, j);
  t.setStatus("builder", "working");
  assert.match(t.orka(["handoff", j.id]).stdout, /45% working -> keep \(45% but working\)/);
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
  assert.match(asked[1], new RegExp(`Write the note to: ${note.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  assert.match(asked[1], /Remaining slice/);
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
  assert.ok(calls.some((c) => c.startsWith("herdr agent start builder --kind pi --pane p-2") && c.includes(`--session-id ${fresh.sessionId} --skill `)));

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
  assert.match(rows[1], /\thandoff\tbuilder-h1 -> fresh builder \(h1\)\t.*old pane p-1 stays open/);
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
  assert.match(t.orka(["handoff", j.id]).stdout, /45% done -> hand off/);
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
  assert.match(t.orka(["handoff", j.id]).stdout, /no worker to measure/);
  assert.equal(t.prompts("verifier").length, 1);
  assert.equal(t.prompts("done-one").length, 1);

  startWorker(t, j, "builder");
  t.config(false);
  assert.match(t.orka(["handoff", j.id]).stdout, /no worker to measure/);
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
  assert.match(j.decisions().at(-1), /handoff abandoned/);
  // Failed once: not asked again on the next pass.
  t.orka(["handoff", j.id]);
  assert.equal(t.prompts("builder").length, 2);
});

test("handoff.orchestrator is only a flag: logged, orchestrator untouched", () => {
  const t = scratch();
  const j = makeJob(t);
  t.config({ orchestrator: true });
  const r = t.orka(["handoff", j.id]);
  assert.match(r.stdout, /orchestrator handoff is not built yet/);
  assert.ok(!t.calls().some((c) => / orch( |$)/.test(c)));
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
