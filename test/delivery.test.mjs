import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";
import { renderDigest } from "../lib/digest.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");
const TASK = "GOAL: build the delivery feature carefully. SCOPE: bin. ACCEPTANCE: tests pass.";

// Fake herdr. Knobs are files in the box:
//   ready-after   `agent get` calls on an agent before it is interactive_ready + idle (default 0)
//   never         agent names that never go working
//   raw-get       verbatim `agent get` reply while the agent has not been prompted
//   after-status  agent_status once prompted (default working)
//   after-status-<name>  same, for one agent; get-error-for  agent names whose `agent get` errors
//   pane-read-error  `pane read` fails
//   pane-text     what `pane read` shows (default: an empty claude input box)
// An agent goes working once it has been prompted. Per-agent get counts and the get count seen at
// prompt time are recorded so tests can prove ordering.
function scratch(env = {}) {
  const base = mkdtempSync(join(tmpdir(), "orka-delivery-"));
  process.on("exit", () => rmScratch(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run"), join(base, "state")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  const st = join(base, "state");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
echo "herdr $*" >> "${log}"
S="${st}"
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[]}}';;
  "pane split") n=$(cat "$S/splits" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$S/splits"; echo "{\\"result\\":{\\"pane\\":{\\"pane_id\\":\\"p-$n\\"}}}";;
  "agent start") echo "$7" > "$S/pane-$3"; echo '{"result":{}}';;
  "agent prompt")
    c=$(cat "$S/gets-$3" 2>/dev/null || echo 0); echo "$c" > "$S/at-prompt-$3"
    echo x >> "$S/prompts-$3"; echo '{"result":{}}';;
  "agent get")
    [ -e "${base}/get-error" ] && { echo '{"error":{"message":"agent not described yet"}}'; exit 1; }
    grep -qx "$3" "${base}/get-error-for" 2>/dev/null && { echo '{"error":{"message":"agent gone"}}'; exit 1; }
    [ -e "$S/pane-$3" ] || { echo '{"error":{"message":"not found"}}'; exit 1; }
    c=$(cat "$S/gets-$3" 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > "$S/gets-$3"
    if [ -e "${base}/raw-get" ] && [ ! -e "$S/prompts-$3" ]; then cat "${base}/raw-get"; exit 0; fi
    need=$(cat "${base}/ready-after" 2>/dev/null || echo 0)
    pane=$(cat "$S/pane-$3")
    if [ "$c" -le "$need" ]; then echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"idle\\",\\"interactive_ready\\":false,\\"pane_id\\":\\"$pane\\"}}}"; exit 0; fi
    status=idle
    if [ -e "$S/prompts-$3" ] && ! grep -qx "$3" "${base}/never" 2>/dev/null; then status=$(cat "${base}/after-status-$3" 2>/dev/null || cat "${base}/after-status" 2>/dev/null || echo working); fi
    echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$status\\",\\"interactive_ready\\":true,\\"pane_id\\":\\"$pane\\"}}}";;
  "pane read") [ -e "${base}/pane-read-error" ] && { echo '{"error":{"message":"no pane"}}'; exit 1; }; if [ -e "${base}/pane-text" ]; then cat "${base}/pane-text"; else printf '╭────╮\\n│ ❯ │\\n╰────╯\\n'; fi;;
  *) echo '{}';;
esac
`,
  );
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  chmodSync(join(bin, "herdr"), 0o755);
  chmodSync(join(bin, "agent-browser"), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const fast = { ORKA_PROMPT_POLL_MS: "10", ORKA_PROMPT_WAIT_MS: "250", ORKA_PROMPT_BACKOFF_MS: "20", ORKA_READY_WAIT_MS: "1500" };
  const full = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ...fast, ...env };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...full } });
  orka(["init"]);
  const t = {
    base, repo, orka,
    set: (f, v) => writeFileSync(join(base, f), v),
    state: (f) => (existsSync(join(st, f)) ? readFileSync(join(st, f), "utf8") : ""),
    prompts: (name) => t.state(`prompts-${name}`).split("\n").filter(Boolean).length,
    log: () => readFileSync(log, "utf8"),
  };
  return t;
}

function makeJob(t) {
  const id = t.orka(["new", "--kind", "pi", "--title", "d", "--goal", "g"]).stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-orch", agent: "orch", worktree: join(t.repo, "wt") });
  writeFileSync(path, JSON.stringify(job));
  mkdirSync(join(t.repo, ".orka", "jobs", id, "results"), { recursive: true });
  mkdirSync(join(t.repo, ".orka", "jobs", id, "notes"), { recursive: true });
  return { id, dir: join(t.repo, ".orka", "jobs", id), read: () => JSON.parse(readFileSync(path, "utf8")) };
}

const worker = (t, id, name = "builder") => t.orka(["worker", "--job", id, "--name", name, "--task", TASK]);

test("fast path: ready agent that goes working after one prompt records delivery ok", () => {
  const t = scratch();
  const j = makeJob(t);
  const r = worker(t, j.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.prompts("builder"), 1);
  assert.equal(j.read().workers[0].delivery, "ok");
  assert.match(t.orka(["status", j.id]).stdout, /worker: builder .*delivery=ok/);
});

test("slow start: the prompt is sent only after interactive_ready and idle", () => {
  const t = scratch();
  t.set("ready-after", "6");
  const j = makeJob(t);
  const r = worker(t, j.id);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Number(t.state("at-prompt-builder")) >= 6, `prompt sent after ${t.state("at-prompt-builder")} gets`);
  assert.equal(t.prompts("builder"), 1);
  assert.equal(j.read().workers[0].delivery, "ok");
});

test("an agent that never gets ready is not prompted; the worker fails loudly", () => {
  const t = scratch({ ORKA_READY_WAIT_MS: "150" });
  t.set("ready-after", "100000");
  const j = makeJob(t);
  const r = worker(t, j.id);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not ready after/);
  assert.equal(t.prompts("builder"), 0);
  assert.equal(j.read().workers[0].delivery, "failed");
});

test("agent get erroring (no status) is not ready: nothing is prompted, the worker fails with delivery failed", () => {
  const t = scratch({ ORKA_READY_WAIT_MS: "200" });
  t.set("get-error", "1");
  const j = makeJob(t);
  const r = worker(t, j.id);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not ready after/);
  assert.equal(t.prompts("builder"), 0);
  assert.equal(j.read().workers[0].delivery, "failed");
});

test("a prompt that never makes the agent working is retried 3 times, then fails and shows in status and digest", () => {
  const t = scratch();
  t.set("never", "builder\n");
  const j = makeJob(t);
  const r = worker(t, j.id);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not start/);
  assert.match(r.stderr, /never started working after 3 prompt attempts/);
  assert.equal(t.prompts("builder"), 3);
  const w = j.read().workers[0];
  assert.equal(w.delivery, "failed");
  assert.match(t.orka(["status", j.id]).stdout, /worker: builder .*delivery=failed/);
  assert.match(t.orka(["digest", j.id]).stdout, /DELIVERY FAILED/);
});

test("ORKA_PROMPT_ATTEMPTS overrides the attempt count", () => {
  const t = scratch({ ORKA_PROMPT_ATTEMPTS: "2" });
  t.set("never", "builder\n");
  const j = makeJob(t);
  assert.notEqual(worker(t, j.id).status, 0);
  assert.equal(t.prompts("builder"), 2);
});

test("the prompt text showing in the pane while idle does not count as delivered", () => {
  const t = scratch();
  t.set("never", "builder\n");
  t.set("pane-text", `${TASK}\n`);
  const j = makeJob(t);
  const r = worker(t, j.id);
  assert.notEqual(r.status, 0);
  assert.equal(j.read().workers[0].delivery, "failed");
});

test("re-issuing a task closes the earlier pane only when it provably never started", () => {
  const t = scratch();
  t.set("never", "builder\n");
  const j = makeJob(t);
  assert.notEqual(worker(t, j.id).status, 0);
  const again = worker(t, j.id);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /using builder-2/);
  assert.match(again.stdout, /closed unused duplicate worker builder pane=p-1/);
  assert.match(t.log(), /^herdr pane close p-1$/m);
  assert.ok(!/^herdr pane close p-2$/m.test(t.log()));
  const [first, second] = j.read().workers;
  assert.equal(first.delivery, "failed");
  assert.ok(first.closedUnused.reason.includes("builder-2"));
  assert.equal(second.delivery, "ok");
  assert.ok(!second.closedUnused);
  assert.match(t.orka(["status", j.id]).stdout, /worker: builder .*delivery=failed closed-unused/);
});

// A first builder whose delivery failed, then (optionally) state changes by hand, then re-issue.
function reissue(setup) {
  const t = scratch();
  t.set("never", "builder\n");
  const j = makeJob(t);
  assert.notEqual(worker(t, j.id).status, 0);
  setup(t, j);
  const again = worker(t, j.id);
  assert.equal(again.status, 0, again.stderr);
  return { t, j, again };
}

const WORKED_PANE = "╭────╮\n⏺ Write(bin/x.mjs)\n  ⎿ Wrote 40 lines to bin/x.mjs\n╭────╮\n│ ❯ │\n╰────╯\n";

test("hand re-delivery: the builder worked (tool markers over an empty box, now idle) and is kept", () => {
  const { t, j } = reissue((t) => {
    writeFileSync(join(t.base, "state", "prompts-builder"), "x\n");
    t.set("never", "");
    t.set("after-status-builder", "idle");
    t.set("pane-text", WORKED_PANE);
  });
  assert.ok(!/^herdr pane close/m.test(t.log()), "worked builder was closed");
  assert.ok(!j.read().workers[0].closedUnused);
  assert.ok(!j.read().workers[0].closed);
});

test("delivery failed, startup screen only, empty input, idle, no results: still closed and shown in status", () => {
  const { t, j } = reissue(() => {});
  assert.match(t.log(), /^herdr pane close p-1$/m);
  assert.ok(j.read().workers[0].closedUnused);
  assert.match(t.orka(["status", j.id]).stdout, /closed-unused/);
});

test("agent get error or pane read error at re-issue keeps the pane", () => {
  const a = reissue((t) => t.set("get-error-for", "builder\n"));
  assert.ok(!/^herdr pane close/m.test(a.t.log()), "closed with agent get failing");
  assert.ok(!a.j.read().workers[0].closedUnused);
  const b = reissue((t) => t.set("pane-read-error", ""));
  assert.ok(!/^herdr pane close/m.test(b.t.log()), "closed with pane read failing");
  assert.ok(!b.j.read().workers[0].closedUnused);
});

test("agent working or blocked at re-issue keeps the pane", () => {
  for (const status of ["working", "blocked"]) {
    const { t, j } = reissue((t) => {
      writeFileSync(join(t.base, "state", "prompts-builder"), "x\n");
      t.set("never", "");
      t.set("after-status-builder", status);
    });
    assert.ok(!/^herdr pane close/m.test(t.log()), `closed while ${status}`);
    assert.ok(!j.read().workers[0].closedUnused);
  }
});

test("a duplicate that wrote notes or results is never closed", () => {
  for (const file of [["notes", "builder.txt"], ["results", "builder.json"]]) {
    const t = scratch();
    t.set("never", "builder\n");
    const j = makeJob(t);
    assert.notEqual(worker(t, j.id).status, 0);
    writeFileSync(join(j.dir, ...file), "{}");
    assert.equal(worker(t, j.id).status, 0);
    assert.ok(!/^herdr pane close/m.test(t.log()), `closed despite ${file.join("/")}`);
    assert.ok(!j.read().workers[0].closedUnused);
  }
});

test("a duplicate whose agent is working or already delivered is never closed", () => {
  const t = scratch();
  const j = makeJob(t);
  assert.equal(worker(t, j.id).status, 0);
  assert.equal(worker(t, j.id).status, 0);
  assert.ok(!/^herdr pane close/m.test(t.log()), "delivered worker was closed");
  // Legacy failed worker whose agent is working right now (hand-delivered): still kept.
  const t2 = scratch();
  t2.set("never", "builder\n");
  const j2 = makeJob(t2);
  assert.notEqual(worker(t2, j2.id).status, 0);
  writeFileSync(join(t2.base, "state", "prompts-builder"), "x\nx\nx\nx\n");
  t2.set("never", "");
  assert.equal(worker(t2, j2.id).status, 0);
  assert.ok(!/^herdr pane close/m.test(t2.log()), "working worker was closed");
});

test("a duplicate with no delivery field (older record) is never closed", () => {
  const t = scratch();
  t.set("never", "builder\n");
  const j = makeJob(t);
  assert.notEqual(worker(t, j.id).status, 0);
  const path = join(t.repo, ".orka", "jobs", `${j.id}.json`);
  const job = j.read();
  delete job.workers[0].delivery;
  delete job.workers[0].deliveryReason;
  writeFileSync(path, JSON.stringify(job));
  assert.equal(worker(t, j.id).status, 0);
  assert.ok(!/^herdr pane close/m.test(t.log()), "worker without delivery field was closed");
  assert.ok(!j.read().workers[0].closedUnused);
});

test("steer uses the same delivery: waits for ready, fails when the agent never starts", () => {
  const t = scratch();
  const j = makeJob(t);
  writeFileSync(join(t.base, "state", "pane-orch"), "p-orch\n");
  t.set("ready-after", "5");
  const ok = t.orka(["steer", j.id, "go on"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(Number(t.state("at-prompt-orch")) >= 5);
  const t2 = scratch();
  const j2 = makeJob(t2);
  writeFileSync(join(t2.base, "state", "pane-orch"), "p-orch\n");
  t2.set("never", "orch\n");
  const bad = t2.orka(["steer", j2.id, "go on"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /steer not delivered/);
  assert.equal(t2.prompts("orch"), 3);
  assert.equal(j2.read().steers.at(-1).delivery, "failed");
  assert.match(t2.orka(["status", j2.id]).stdout, /steer: go on delivery=failed \[/);
  assert.match(t2.orka(["digest", j2.id]).stdout, /last steer: go on \(0 earlier\) DELIVERY FAILED: steer never started the agent; re-send it/);
  assert.doesNotMatch(t.orka(["status", j.id]).stdout, /steer:/);
  assert.match(t.orka(["digest", j.id]).stdout, /last steer: go on \(0 earlier\)\n/);
});

test("digest: delivery failed + results file shows no re-issue text; with nothing at all it still says DELIVERY FAILED", () => {
  const t = scratch();
  t.set("never", "builder\n");
  const j = makeJob(t);
  worker(t, j.id);
  assert.match(t.orka(["digest", j.id]).stdout, /DELIVERY FAILED: prompt never started the agent; re-issue the task/);
  mkdirSync(join(j.dir, "results"), { recursive: true });
  writeFileSync(join(j.dir, "results", "builder.json"), JSON.stringify({ ok: true, result: "done" }));
  const out = t.orka(["digest", j.id]).stdout;
  assert.doesNotMatch(out, /DELIVERY FAILED|re-issue/);
  assert.match(out, /builder ok=true/);
});

test("orka run marks the job failed when the orchestrator prompt never starts the agent", () => {
  const t = scratch();
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: t.repo });
  const id = t.orka(["new", "--kind", "pi", "--title", "r", "--goal", "g"]).stdout.trim();
  const jobName = `j${id.replace(/[^a-z0-9]/g, "")}`.slice(0, 32);
  t.set("never", `${jobName}\n`);
  writeFileSync(
    join(t.base, "bin", "herdr"),
    readFileSync(join(t.base, "bin", "herdr"), "utf8").replace(
      `"agent list")`,
      `"workspace create") echo '{"result":{"root_pane":{"pane_id":"p-root"}}}';;\n  "agent list")`,
    ),
  );
  const r = t.orka(["run", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /orchestrator prompt not delivered/);
  assert.equal(t.prompts(jobName), 3);
  const job = JSON.parse(readFileSync(join(t.repo, ".orka", "jobs", `${id}.json`), "utf8"));
  assert.equal(job.leadDelivery, "failed");
  assert.equal(job.status, "failed");
  const digest = t.orka(["digest", id]).stdout;
  assert.match(digest, /^orchestrator: DELIVERY FAILED: orchestrator prompt not delivered: .*never started working/m);
});

test("digest of a job with a delivered orchestrator prompt has no orchestrator line", () => {
  const t = scratch();
  const j = makeJob(t);
  assert.doesNotMatch(t.orka(["digest", j.id]).stdout, /orchestrator:/);
  const ok = { id: "x", status: "running", leadDelivery: "ok", stopReason: "stopped by hand" };
  assert.doesNotMatch(renderDigest(ok), /orchestrator:/);
  assert.match(renderDigest({ ...ok, leadDelivery: "failed" }), /^orchestrator: DELIVERY FAILED: stopped by hand$/m);
});

const reply = (agent) => JSON.stringify({ result: { agent: { pane_id: "p-1", ...agent } } });

test("gate table: only interactive_ready true + idle sends a prompt; every other reply fails with delivery failed", () => {
  const readies = [true, false, undefined];
  const statuses = ["idle", "working", "blocked", undefined, "done"];
  const cases = [...readies.flatMap((r) => statuses.map((s) => [r, s])), ["error", "error"]];
  for (const [ready, status] of cases) {
    const t = scratch({ ORKA_READY_WAIT_MS: "150" });
    if (ready === "error") t.set("get-error", "1");
    else {
      const agent = {};
      if (ready !== undefined) agent.interactive_ready = ready;
      if (status !== undefined) agent.agent_status = status;
      t.set("raw-get", reply(agent));
    }
    const j = makeJob(t);
    const r = worker(t, j.id);
    const label = `ready=${ready} status=${status}`;
    if (ready === true && status === "idle") {
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.equal(t.prompts("builder"), 1, label);
    } else {
      assert.notEqual(r.status, 0, label);
      assert.equal(t.prompts("builder"), 0, `${label} was prompted`);
      assert.match(r.stderr, /delivery failed/, label);
      if (ready !== "error") assert.match(r.stderr, new RegExp(`last status ${status}, interactive_ready ${ready}`), label);
      assert.equal(j.read().workers[0].delivery, "failed", label);
    }
  }
});

test("after the prompt: working is delivered, blocked is delivered (permission dialog), idle forever fails after 3 attempts", () => {
  for (const [after, ok] of [["working", true], ["blocked", true], ["idle", false]]) {
    const t = scratch();
    t.set("after-status", after);
    const j = makeJob(t);
    const r = worker(t, j.id);
    assert.equal(r.status === 0, ok, `${after}: ${r.stderr}`);
    assert.equal(t.prompts("builder"), ok ? 1 : 3, after);
    assert.equal(j.read().workers[0].delivery, ok ? "ok" : "failed", after);
  }
});

// Matrix: {worker, orchestrator run, steer} x {status, digest}, failed and delivered.
const withWorkspace = (t) =>
  writeFileSync(
    join(t.base, "bin", "herdr"),
    readFileSync(join(t.base, "bin", "herdr"), "utf8").replace(
      `"agent list")`,
      `"workspace create") echo '{"result":{"root_pane":{"pane_id":"p-root"}}}';;\n  "agent list")`,
    ),
  );

const surfaces = {
  worker: (t, failed) => {
    const j = makeJob(t);
    if (failed) t.set("never", "builder\n");
    assert.equal(worker(t, j.id).status === 0, !failed);
    return j.id;
  },
  orchestrator: (t, failed) => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: t.repo });
    const id = t.orka(["new", "--kind", "pi", "--title", "r", "--goal", "g"]).stdout.trim();
    if (failed) t.set("never", `j${id.replace(/[^a-z0-9]/g, "")}`.slice(0, 32) + "\n");
    withWorkspace(t);
    assert.equal(t.orka(["run", id]).status === 0, !failed);
    return id;
  },
  steer: (t, failed) => {
    const j = makeJob(t);
    writeFileSync(join(t.base, "state", "pane-orch"), "p-orch\n");
    if (failed) t.set("never", "orch\n");
    assert.equal(t.orka(["steer", j.id, "go on"]).status === 0, !failed);
    return j.id;
  },
};

test("delivery matrix: worker / orchestrator run / steer each show failure in status and digest, and nothing when delivered", () => {
  for (const [name, make] of Object.entries(surfaces)) {
    for (const failed of [true, false]) {
      const t = scratch();
      const id = make(t, failed);
      const status = t.orka(["status", id]).stdout;
      const digest = t.orka(["digest", id]).stdout;
      if (failed) {
        assert.match(status, /delivery=failed/, `${name}: status\n${status}`);
        assert.match(digest, /DELIVERY FAILED/, `${name}: digest\n${digest}`);
      } else {
        assert.doesNotMatch(status, /delivery=failed/, `${name} delivered: status`);
        assert.doesNotMatch(digest, /DELIVERY FAILED/, `${name} delivered: digest`);
      }
    }
  }
});
