import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// herdr and agent-browser are stubs on PATH; they only append to a log.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-cleanup-"));
  process.on("exit", () => rmScratch(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const run = join(base, "run");
  for (const d of [repo, bin, home, run, join(run, "agent-browser")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("herdr", "echo '{}'");
  stub("agent-browser", `case "$*" in *"session list"*) echo '{"success":true,"data":{"sessions":["$LIVE"]}}';; esac`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: run, AGENT_BROWSER_SOCKET_DIR: "", ORCA_NO_WATCH: "1" };
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orca(["init"]);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { repo, run, orca, calls, log, bin };
}

// Creates the record with orca new. Patch it afterwards: a later orca new sweeps
// stale finished jobs, so create every job before patching any of them stale.
function newJob(t, extra = {}) {
  const id = t.orca(["new", "--kind", "pi", "--title", "c", "--goal", "g", ...(extra.keep ? ["--keep"] : [])]).stdout.trim();
  return { id, path: join(t.repo, ".orca", "jobs", `${id}.json`), prefix: `orca-${createHash("sha1").update(id).digest("hex").slice(0, 8)}` };
}

function patchJob(j, status, extra = {}) {
  const job = JSON.parse(readFileSync(j.path, "utf8"));
  Object.assign(job, { status, workspace: "w-1", browserSessions: [`${j.prefix}-w1`] }, extra);
  writeFileSync(j.path, JSON.stringify(job));
  return j;
}

function makeJob(t, status, extra = {}) {
  return patchJob(newJob(t, extra), status, extra.patch);
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const read = (j) => JSON.parse(readFileSync(j.path, "utf8"));

test("done closes browsers and worker panes, keeps the workspace and orchestrator pane", () => {
  const t = scratch();
  const j = makeJob(t, "running", {
    patch: {
      pane: "p-lead",
      workers: [
        { name: "w1", pane: "p-w1", role: "builder" },
        { name: "verifier", pane: "p-v", role: "verifier" },
      ],
    },
  });
  const r = t.orca(["done", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`cleanup: closed browser ${j.prefix}-w1`));
  assert.match(r.stdout, /cleanup: closed worker pane p-w1 \(w1\)/);
  assert.match(r.stdout, /cleanup: closed worker pane p-v \(verifier\)/);
  assert.doesNotMatch(r.stdout, /closed workspace/);
  const calls = t.calls();
  assert.ok(calls.includes("herdr pane close p-w1"));
  assert.ok(calls.includes("herdr pane close p-v"));
  // The session has no live daemon or Chrome: its state is deleted, agent-browser is not run.
  assert.ok(!calls.some((c) => c.startsWith("agent-browser")));
  assert.ok(!calls.some((c) => c.startsWith("herdr workspace close")));
  assert.ok(!calls.includes("herdr pane close p-lead"));
  const job = read(j);
  assert.equal(job.status, "done");
  assert.equal(job.workspaceClosed, undefined);
  assert.deepEqual(job.cleanup.browsers, [`${j.prefix}-w1`]);
  assert.deepEqual(job.cleanup.panes.map((p) => p.name), ["w1", "verifier"]);
  assert.ok(job.workers.every((w) => w.closed));
});

test("done stops a dev server running inside the job worktree", () => {
  const t = scratch();
  const wt = join(t.repo, ".orca", "worktrees", "srv");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "dev.mjs"), "import { createServer } from 'node:http';\ncreateServer().listen(0);\nsetInterval(() => {}, 1000);\n");
  const server = spawn(process.execPath, ["dev.mjs"], { cwd: wt, stdio: "ignore" });
  try {
    for (let i = 0; i < 200; i++) {
      try {
        if (readlinkSync(`/proc/${server.pid}/cwd`) === wt) break;
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    const j = makeJob(t, "running", { patch: { worktree: wt } });
    const r = t.orca(["done", j.id]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`cleanup: stopped server pid ${server.pid}`));
    assert.equal(read(j).cleanup.servers[0].pid, server.pid);
  } finally {
    server.kill("SIGKILL");
  }
});

test("--keep and job.keep skip cleanup", () => {
  const t = scratch();
  const a = makeJob(t, "running");
  assert.match(t.orca(["done", a.id, "--keep"]).stdout, /cleanup: kept/);
  const b = makeJob(t, "running", { keep: true });
  assert.match(t.orca(["done", b.id]).stdout, /cleanup: kept/);
  assert.ok(!t.calls().some((c) => c.includes("close")));
});

test("done --dry-run lists without closing", () => {
  const t = scratch();
  const j = makeJob(t, "running", { patch: { workers: [{ name: "w1", pane: "p-w1" }] } });
  const r = t.orca(["done", j.id, "--dry-run"]);
  assert.match(r.stdout, /cleanup: would close browser/);
  assert.match(r.stdout, /cleanup: would close worker pane p-w1/);
  assert.doesNotMatch(r.stdout, /workspace/);
  assert.ok(!t.calls().some((c) => c.includes("close")));
});

test("orca cleanup --older-than closes only stale finished workspaces", () => {
  const t = scratch();
  const old = newJob(t);
  const fresh = newJob(t);
  const live = newJob(t);
  const kept = newJob(t);
  patchJob(old, "stopped", { finished: hoursAgo(30), workspace: "w-old" });
  patchJob(fresh, "done", { finished: hoursAgo(1), workspace: "w-fresh" });
  patchJob(live, "running", { workspace: "w-live" });
  patchJob(kept, "done", { finished: hoursAgo(50), workspace: "w-kept", keep: true });
  writeFileSync(join(t.run, "agent-browser", "ghost.pid"), "999999999");
  const dry = t.orca(["cleanup", "--dry-run"]);
  assert.match(dry.stdout, /would close workspace w-old/);
  assert.ok(!t.calls().some((c) => c.includes("close")));
  const r = t.orca(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /closed workspace w-old/);
  assert.match(r.stdout, /closed browser ghost/);
  assert.match(r.stdout, new RegExp(`closed browser ${old.prefix}-w1`));
  assert.ok(!r.stdout.includes(`${live.prefix}-w1`));
  assert.deepEqual(t.calls().filter((c) => c.startsWith("herdr workspace close")), ["herdr workspace close w-old"]);
  assert.ok(read(old).workspaceClosed);
  // A shorter threshold now takes the 1h-old job too; kept and running stay.
  const short = t.orca(["cleanup", "--older-than", "30m"]);
  assert.match(short.stdout, /closed workspace w-fresh/);
  assert.deepEqual(t.calls().filter((c) => c.startsWith("herdr workspace close")), ["herdr workspace close w-old", "herdr workspace close w-fresh"]);
  assert.notEqual(t.orca(["cleanup", "--older-than", "30"]).status, 0);
});

test("staleAfter in the orca config sets the default threshold", () => {
  const t = scratch();
  const j = newJob(t);
  patchJob(j, "done", { finished: hoursAgo(2) });
  assert.doesNotMatch(t.orca(["cleanup"]).stdout, /workspace/);
  const cfgPath = join(t.repo, ".orca", "config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), staleAfter: "1h" }));
  assert.match(t.orca(["cleanup"]).stdout, /closed workspace w-1/);
});

test("orca new sweeps stale workspaces quietly, on stderr only", () => {
  const t = scratch();
  const old = newJob(t);
  patchJob(old, "done", { finished: hoursAgo(40), workspace: "w-old" });
  const r = t.orca(["new", "--kind", "pi", "--title", "n", "--goal", "g"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^[0-9]{17}-n$/);
  assert.match(r.stderr, /closed 1 stale workspace/);
  assert.ok(t.calls().includes("herdr workspace close w-old"));
  assert.ok(read(old).workspaceClosed);
  const again = t.orca(["new", "--kind", "pi", "--title", "n2", "--goal", "g"]);
  assert.equal(again.stderr, "");
});

test("cleanup with nothing prints nothing to close", () => {
  const t = scratch();
  assert.match(t.orca(["cleanup"]).stdout, /cleanup: nothing to close/);
});

test("worker prompt names one reused browser session", () => {
  const src = readFileSync(ORCA, "utf8");
  assert.match(src, /Use exactly one agent-browser session/);
  assert.match(src, /Never spawn a fresh session per check/);
});

test("a closed workspace is recorded and a second cleanup leaves it alone", () => {
  const t = scratch();
  const j = makeJob(t, "stopped");
  assert.match(t.orca(["cleanup"]).stdout, /closed workspace w-1/);
  assert.ok(read(j).workspaceClosed);
  const before = t.calls().length;
  const again = t.orca(["cleanup"]);
  assert.doesNotMatch(again.stdout, /workspace/);
  assert.ok(!t.calls().slice(before).some((c) => c.startsWith("herdr workspace close")));
});

test("cleanup closes a legacy orca-verify session of a finished job", () => {
  const t = scratch();
  const j = makeJob(t, "done");
  const state = join(t.run, "agent-browser", `orca-verify-${j.id}.config`);
  writeFileSync(state, "{}");
  assert.match(t.orca(["cleanup"]).stdout, new RegExp(`closed browser orca-verify-${j.id}`));
  assert.ok(!existsSync(state));
  assert.ok(!t.calls().some((c) => c.startsWith("agent-browser")));
});

// Fake process lists: nothing is really killed (ORCA_FAKE_WATCHERS makes cleanup only report).
function fakeWatchers(t, list) {
  const file = join(t.repo, "..", "watchers.json");
  writeFileSync(file, JSON.stringify(list));
  return file;
}

test("cleanup kills orphan watchers (terminal, missing, unrecorded pid) and spares the live recorded one", () => {
  const t = scratch();
  const live = makeJob(t, "running", { patch: { watcherPid: 4001 } });
  const done = makeJob(t, "running");
  const stale = makeJob(t, "running", { patch: { watcherPid: 4003 } });
  patchJob(done, "done", { watcherPid: 4002 });
  const list = [
    { pid: 4001, jobId: live.id, cwd: t.repo },
    { pid: 4002, jobId: done.id, cwd: t.repo },
    { pid: 4004, jobId: "no-such-job", cwd: t.repo },
    { pid: 4005, jobId: stale.id, cwd: t.repo },
    { pid: 4006, jobId: "x", cwd: join(t.repo, "..", "home") },
    { pid: 4007, jobId: "y", cwd: join(t.repo, "..", "deleted-repo") },
  ];
  const file = fakeWatchers(t, list);
  const env = { ORCA_FAKE_WATCHERS: file };
  const run = (extra) => spawnSync(process.execPath, [ORCA, "cleanup", ...extra, "--cwd", t.repo], { encoding: "utf8", env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: t.run, ORCA_NO_WATCH: "1", ...env } });
  const dry = run(["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  for (const pid of [4002, 4004, 4005, 4007]) assert.match(dry.stdout, new RegExp(`would kill orphan watcher pid ${pid} `));
  assert.match(dry.stdout, /pid 4002 .*job done/);
  assert.match(dry.stdout, /pid 4004 .*job missing/);
  assert.match(dry.stdout, /pid 4005 .*not the recorded watcher/);
  for (const pid of [4001, 4006]) assert.doesNotMatch(dry.stdout, new RegExp(`pid ${pid} `));
  const real = run([]);
  assert.match(real.stdout, /killed orphan watcher pid 4002 /);
  assert.doesNotMatch(real.stdout, /pid 4001 /);
});
