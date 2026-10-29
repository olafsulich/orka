import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// Fake herdr: an agent is gone while dead-<name> exists, a pane exists while pane-<id> exists.
// A started agent is idle and ready until prompted, then working. A real git repo.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-resume-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const home = join(base, "home");
  for (const d of [repo, bin, home, join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(base, "watchers.json"), "[]");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "workspace create") n=$(cat "${base}/ws" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${base}/ws"; echo "{\\"result\\":{\\"root_pane\\":{\\"pane_id\\":\\"p-ws$n\\"},\\"workspace\\":{\\"workspace_id\\":\\"w$n\\"}}}";;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-new"}}}';;
  "pane get") if [ -e "${base}/pane-$3" ]; then echo '{"result":{"pane":{}}}'; else echo '{"error":{"code":"pane_not_found","message":"pane not found"}}'; exit 1; fi;;
  "pane read") echo '{"result":{"text":"$ "}}';;
  "agent start") rm -f "${base}/dead-$3" "${base}/prompted"; echo '{"result":{}}';;
  "agent get")
    if [ -e "${base}/dead-$3" ]; then echo '{"error":{"code":"agent_not_found","message":"no"}}'; exit 1; fi
    if [ -e "${base}/prompted" ]; then echo '{"result":{"agent":{"agent_status":"working","pane_id":"p-x"}}}'; exit 0; fi
    echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true,"pane_id":"p-x"}}}';;
  "agent prompt") touch "${base}/prompted"; echo '{"result":{}}';;
  *) echo '{"result":{}}';;
esac
`,
  );
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet', 'haiku' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "pi", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_RUNTIME_DIR: join(base, "run"),
    AGENT_BROWSER_SOCKET_DIR: "",
    ORKA_BACKEND: "herdr", ORKA_NO_WATCH: "1",
    ORKA_MEMORY_GUARD: "off",
    ORKA_FAKE_WATCHERS: join(base, "watchers.json"),
    ORKA_READY_WAIT_MS: "2000",
    ORKA_PROMPT_WAIT_MS: "2000",
  };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const jobFile = (id) => join(repo, ".orka", "jobs", `${id}.json`);
  const read = (id) => JSON.parse(readFileSync(jobFile(id), "utf8"));
  const patch = (id, fields) => writeFileSync(jobFile(id), JSON.stringify({ ...read(id), ...fields }, null, 2));
  const started = (...extra) => {
    const id = orka(["new", "--title", "resume me", "--goal", "Add a mul function.", "--no-gate", ...extra]).stdout.trim();
    const r = orka(["run", id]);
    assert.equal(r.status, 0, r.stderr);
    return id;
  };
  // The orchestrator's pane is gone: its agent no longer exists, and the calls log starts empty.
  const kill = (id) => {
    writeFileSync(join(base, `dead-${read(id).agent}`), "");
    rmSync(join(base, "prompted"), { force: true });
    writeFileSync(log, "");
  };
  const transcript = (sessionId) => {
    const dir = join(home, ".claude", "projects", "-some-slug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), "{}\n");
  };
  const decisions = (id) => {
    const p = join(repo, ".orka", "jobs", id, "decisions.tsv");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  return { base, repo, orka, read, patch, started, kill, transcript, decisions, alivePane: (p) => writeFileSync(join(base, `pane-${p}`), ""), calls: () => readFileSync(log, "utf8") };
}

test("resume reopens the session of a dead-pane running job in a new pane and rewires agent and pane", () => {
  const t = scratch();
  const id = t.started();
  const before = t.read(id);
  t.transcript(before.sessionId);
  t.kill(id);
  const r = t.orka(["resume", id]);
  assert.equal(r.status, 0, r.stderr);
  const calls = t.calls();
  // The old pane is gone and no worker pane is alive: a new workspace.
  assert.match(calls, /herdr workspace create/);
  assert.match(calls, new RegExp(`herdr agent start ${before.agent} --kind claude --pane p-ws2 .*-- --model \\S+ --resume ${before.sessionId}`));
  assert.doesNotMatch(calls, /--session-id/);
  assert.doesNotMatch(calls, /pane close/);
  assert.match(calls, /orka resume: your pane was gone/);
  assert.match(calls, /Status running: continue the flow/);
  const job = t.read(id);
  assert.equal(job.pane, "p-ws2");
  assert.equal(job.agent, before.agent);
  assert.equal(job.sessionId, before.sessionId);
  assert.equal(job.status, "running");
  assert.equal(job.leadDelivery, "ok");
  assert.deepEqual(
    job.resumes.map((x) => [x.mode, x.from.pane, x.pane]),
    [["resume", before.pane, "p-ws2"]],
  );
  assert.match(t.decisions(id), /resume\torchestrator reattached \(session reopened\)/);
  assert.match(r.stdout, /resumed \(session \S+ reopened\) pane=p-ws2/);
});

test("resume splits next to a pane of the job that is still alive, and never touches workers", () => {
  const t = scratch();
  const id = t.started();
  t.patch(id, { workers: [{ name: "builder", pane: "p-worker", sessionId: "s-w" }] });
  t.transcript(t.read(id).sessionId);
  t.kill(id);
  t.alivePane("p-worker");
  const r = t.orka(["resume", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.calls(), /herdr pane split --pane p-worker /);
  assert.doesNotMatch(t.calls(), /workspace create/);
  assert.doesNotMatch(t.calls(), /agent (prompt|send-keys) builder/);
  assert.equal(t.read(id).pane, "p-new");
});

test("with no transcript, resume starts a fresh orchestrator on the first prompt plus the digest", () => {
  const t = scratch();
  const id = t.started();
  const before = t.read(id);
  t.kill(id);
  const r = t.orka(["resume", id]);
  assert.equal(r.status, 0, r.stderr);
  const job = t.read(id);
  assert.notEqual(job.sessionId, before.sessionId);
  const calls = t.calls();
  assert.match(calls, new RegExp(`--session-id ${job.sessionId}`));
  assert.doesNotMatch(calls, /--resume/);
  assert.match(calls, /orka resume: you replace an orchestrator whose pane and session are gone \(no transcript was found\)/);
  assert.match(calls, new RegExp(`Current state \\(orka digest ${id}\\)`));
  // The first prompt again: the fresh orchestrator needs the flow.
  assert.match(calls, /Write every worker --task as this brief/);
  assert.equal(job.resumes[0].mode, "fresh");
  assert.match(t.decisions(id), /orchestrator reattached \(fresh, from the digest\)/);
});

test("a job in review is reopened but not prompted; it waits on Olaf", () => {
  const t = scratch();
  const id = t.started();
  t.patch(id, { status: "review" });
  t.transcript(t.read(id).sessionId);
  t.kill(id);
  const r = t.orka(["resume", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.calls(), /--resume/);
  assert.doesNotMatch(t.calls(), /herdr agent prompt/);
  assert.match(r.stdout, /review: waiting on Olaf/);
  assert.equal(t.read(id).status, "review");
});

test("resume refuses a live orchestrator and a finished job", () => {
  const t = scratch();
  const id = t.started();
  const live = t.orka(["resume", id]);
  assert.equal(live.status, 1);
  assert.match(live.stderr, /is still alive .*nothing to resume/);
  assert.doesNotMatch(t.calls(), /herdr agent start .*--resume/);
  t.patch(id, { status: "done" });
  t.kill(id);
  const done = t.orka(["resume", id]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /is done; orka resume only reattaches a running, awaiting-direction or review job/);
  assert.doesNotMatch(t.calls(), /agent start/);
  t.patch(id, { status: "stopped" });
  assert.match(t.orka(["resume", id]).stderr, /is stopped; orka resume only/);
});

test("--dry-run says what resume would do and starts nothing", () => {
  const t = scratch();
  const id = t.started();
  t.transcript(t.read(id).sessionId);
  t.kill(id);
  const r = t.orka(["resume", id, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run resume .* reopen session/);
  assert.match(r.stdout, /pane: a new workspace/);
  assert.doesNotMatch(t.calls(), /agent start|workspace create|pane split/);
});

test("a pi job resumes with the same --session-id", () => {
  const t = scratch();
  const id = t.started("--kind", "pi");
  const before = t.read(id);
  const dir = join(t.base, "home", ".pi", "agent", "sessions", "-x-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026_${before.sessionId}.jsonl`), "{}\n");
  t.kill(id);
  const r = t.orka(["resume", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.calls(), new RegExp(`agent start ${before.agent} --kind pi .*--session-id ${before.sessionId}`));
  assert.doesNotMatch(t.calls(), /--resume/);
});

test("approve and steer on a job whose orchestrator pane is gone point to orka resume", () => {
  const t = scratch();
  const id = t.started();
  t.kill(id);
  const steerRunning = t.orka(["steer", id, "use a loop"]);
  assert.equal(steerRunning.status, 1);
  assert.match(steerRunning.stderr, new RegExp(`the orchestrator pane is gone .*not steered\\. Run orka resume ${id} to reattach it`));
  t.patch(id, { status: "awaiting-direction", gate: { on: true, state: "proposed" } });
  const approve = t.orka(["approve", id]);
  assert.equal(approve.status, 1);
  assert.match(approve.stderr, new RegExp(`the job stays awaiting-direction\\. Run orka resume ${id}`));
  assert.doesNotMatch(approve.stderr, /cannot resume/);
  const steerGate = t.orka(["steer", id, "smaller"]);
  assert.match(steerGate.stderr, new RegExp(`Run orka resume ${id}`));
  t.patch(id, { status: "review" });
  const signoff = t.orka(["approve", id]);
  assert.equal(signoff.status, 1);
  assert.match(signoff.stderr, new RegExp(`orka resume ${id} reattaches it`));
  assert.doesNotMatch(t.calls(), /agent prompt/);
});
