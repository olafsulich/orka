import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanBrowsers, selectGone, selectOrphans, selectRecorded, selectReap, stateSessions } from "../lib/browsers.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// The "browsers" are idle node processes made by these tests. orka sees them
// through a fake /proc (ORKA_PROC_ROOT) whose entries describe an agent-browser
// daemon -> Chrome root -> renderer tree, so no real agent-browser or Chrome
// starts and only pids this file created can be killed.
const procs = [];
process.on("exit", () => {
  for (const pid of procs) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

// Started through sh and backgrounded, so init reaps it when orka kills it
// (a killed child of this process would stay a zombie that still looks alive).
function idle() {
  const out = spawnSync("sh", ["-c", `"${process.execPath}" -e "setInterval(() => {}, 1000)" orka-hygiene-fake >/dev/null 2>&1 </dev/null & echo $!`], { encoding: "utf8" });
  const pid = Number(out.stdout.trim());
  procs.push(pid);
  return pid;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function waitDead(pid) {
  for (let i = 0; i < 200 && alive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  return !alive(pid);
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-hygiene-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const run = join(base, "run");
  const proc = join(base, "proc");
  for (const d of [repo, bin, join(base, "home"), join(run, "agent-browser"), proc]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  for (const name of ["herdr", "agent-browser"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\necho '{}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(proc, "stat"), "btime 1000000000\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: run, AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_PROC_ROOT: proc };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const state = join(run, "agent-browser");
  // Describes a pid in the fake /proc. startSecAgo: how long ago it started.
  const entry = (pid, { cmd, env: penv = {}, ppid = 1, ageH = 0 }) => {
    const d = join(proc, String(pid));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "cmdline"), cmd.split(" ").join("\0") + "\0");
    writeFileSync(join(d, "environ"), Object.entries(penv).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
    const now = Math.floor(Date.now() / 1000);
    const start = (now - 1000000000 - Math.round(ageH * 3600)) * 100;
    writeFileSync(join(d, "stat"), `${pid} (x) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`);
  };
  // daemon -> chrome root -> renderer. Only the daemon carries the session
  // (as the real daemon does); Chrome is untagged. daemonParent 1: daemon gone,
  // root reparented to init (orphan).
  const tree = ({ session = null, jobTag = null, ageH = 0, orphan = false, uuid = Math.random().toString(16).slice(2) }) => {
    const daemon = idle();
    const root = idle();
    const renderer = idle();
    if (!orphan) {
      entry(daemon, { cmd: `/x/agent-browser-linux-x64 --session ${session || "default"}`, env: session ? { AGENT_BROWSER_SESSION: session } : {}, ppid: 1, ageH });
    }
    const chromeEnv = jobTag ? { ORKA_JOB: jobTag } : {};
    entry(root, { cmd: `/c/chrome --headless --user-data-dir=/tmp/agent-browser-chrome-${uuid}`, env: chromeEnv, ppid: orphan ? 1 : daemon, ageH });
    entry(renderer, { cmd: `/c/chrome --type=renderer --user-data-dir=/tmp/agent-browser-chrome-${uuid}`, env: chromeEnv, ppid: root, ageH });
    return { daemon: orphan ? null : daemon, root, renderer, all: [orphan ? null : daemon, root, renderer].filter(Boolean) };
  };
  return { repo, orka, calls, state, tree, entry, proc };
}

function makeJob(t, status = "running", extra = {}) {
  const id = t.orka(["new", "--kind", "pi", "--title", "h", "--goal", "g"]).stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status, pane: "p-1", agent: "orch", workspace: "w-1", worktree: join(t.repo, "wt") }, extra);
  writeFileSync(path, JSON.stringify(job));
  mkdirSync(join(t.repo, ".orka", "jobs", id, "results"), { recursive: true });
  return { id, path, read: () => JSON.parse(readFileSync(path, "utf8")), prefix: `orka-${createHash("sha1").update(id).digest("hex").slice(0, 8)}` };
}

test("a session name maps to its daemon and untagged Chrome tree", () => {
  const t = scratch();
  const a = t.tree({ session: "orka-aaaaaaaa-verifier" });
  const b = t.tree({ session: "orka-bbbbbbbb-w1" });
  const found = scanBrowsers({ procRoot: t.proc, selfPid: 1 });
  const bySession = (s) => found.filter((p) => p.session === s).map((p) => p.pid).sort();
  assert.deepEqual(bySession("orka-aaaaaaaa-verifier"), a.all.sort());
  assert.deepEqual(selectReap(found, { prefix: "orka-aaaaaaaa" }).map((p) => p.pid).sort(), a.all.sort());
  assert.deepEqual(selectReap(found, { prefix: "orka-aaaaaaaa", workers: ["w1"] }).map((p) => p.pid), []);
  assert.deepEqual(selectReap(found, { prefix: "orka-bbbbbbbb", worker: "w1" }).map((p) => p.pid).sort(), b.all.sort());
  assert.deepEqual(stateSessions(join(t.state, "nope")), []);
});

test("done kills a job's untagged Chrome by session name and leaves a running job's browser alone", () => {
  const t = scratch();
  const finishing = makeJob(t);
  const running = makeJob(t);
  const mine = t.tree({ session: `${finishing.prefix}-verifier` });
  const mineTagged = t.tree({ session: `${finishing.prefix}-w1`, jobTag: finishing.id });
  const other = t.tree({ session: `${running.prefix}-verifier` });
  const otherTagged = t.tree({ session: `${running.prefix}-w1`, jobTag: running.id });
  writeFileSync(join(t.state, `${finishing.prefix}-verifier.config`), "{}");
  const r = t.orka(["done", finishing.id, "--give-up", "test"]);
  assert.equal(r.status, 0, r.stderr);
  for (const pid of [...mine.all, ...mineTagged.all]) assert.ok(waitDead(pid), `pid ${pid} should be gone`);
  for (const pid of [...other.all, ...otherTagged.all]) assert.ok(alive(pid), `running job pid ${pid} must live`);
  assert.ok(!existsSync(join(t.state, `${finishing.prefix}-verifier.config`)));
  // the live session was closed through agent-browser, the dead ones were not launched
  assert.ok(!t.calls().some((c) => c.includes(running.prefix)));
});

test("stop and fail reap the job's browsers too", () => {
  const t = scratch();
  const stopped = makeJob(t);
  const failed = makeJob(t);
  const a = t.tree({ session: `${stopped.prefix}-w1` });
  const b = t.tree({ session: `${failed.prefix}-verifier` });
  const keep = t.tree({ session: "orka-ffffffff-w1" });
  assert.equal(t.orka(["stop", stopped.id, "why"]).status, 0);
  assert.equal(t.orka(["done", failed.id, "--give-up", "no"]).status, 0);
  for (const pid of [...a.all, ...b.all]) assert.ok(waitDead(pid));
  for (const pid of keep.all) assert.ok(alive(pid));
});

test("a new verifier round reaps the previous verifier's Chrome, not other workers'", () => {
  const t = scratch();
  const j = makeJob(t, "running", { workers: [{ name: "verifier", role: "verifier", pane: "p-v" }, { name: "api", role: "builder", pane: "p-a" }] });
  const prevVerifier = t.tree({ session: `${j.prefix}-verifier` });
  const prevVerify = t.tree({ session: `${j.prefix}-verify`, jobTag: j.id });
  const builder = t.tree({ session: `${j.prefix}-api` });
  // The worker start itself fails against the stub herdr; the reap runs before it.
  t.orka(["worker", "--job", j.id, "--name", "verifier", "--role", "verifier", "--task", "t"]);
  for (const pid of [...prevVerifier.all, ...prevVerify.all]) assert.ok(waitDead(pid), `verifier pid ${pid} should be gone`);
  for (const pid of builder.all) assert.ok(alive(pid), "a builder's browser stays");
});

test("closing a stale session never launches agent-browser; a live one is closed once", () => {
  const t = scratch();
  const j = makeJob(t, "done", { finished: new Date().toISOString() });
  for (const ext of [".config", ".target", ".pid"]) writeFileSync(join(t.state, `${j.prefix}-w1${ext}`), ext === ".pid" ? "999999999" : "{}");
  const live = t.tree({ session: `${j.prefix}-w2` });
  writeFileSync(join(t.state, `${j.prefix}-w2.config`), "{}");
  const r = t.orka(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(t.state, `${j.prefix}-w1.config`)));
  const closes = t.calls().filter((c) => c.startsWith("agent-browser"));
  assert.ok(!closes.some((c) => c.includes("-w1")), `stale session must not be closed through agent-browser: ${closes}`);
  for (const pid of live.all) assert.ok(waitDead(pid));
});

test("cleanup lists and kills orphan agent-browser Chrome roots; live jobs and young roots are untouched", () => {
  const t = scratch();
  const j = makeJob(t, "running");
  const old = t.tree({ orphan: true, ageH: 30 });
  const oldMapped = t.tree({ orphan: true, ageH: 30 });
  t.entry(oldMapped.root, { cmd: `/c/chrome --headless --user-data-dir=/tmp/agent-browser-chrome-live`, env: { AGENT_BROWSER_SESSION: `${j.prefix}-verifier` }, ppid: 1, ageH: 30 });
  const young = t.tree({ orphan: true, ageH: 0.1 });
  const withDaemon = t.tree({ session: "default", ageH: 30 });
  const otherJobTag = t.tree({ orphan: true, ageH: 30, jobTag: "20260101000000000-elsewhere" });
  const dry = t.orka(["cleanup", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`would kill browser pid ${old.root} `));
  assert.match(dry.stdout, /1 orphan agent-browser Chrome root/);
  for (const pid of [...old.all, ...young.all]) assert.ok(alive(pid), "dry-run kills nothing");
  const r = t.orka(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  for (const pid of old.all) assert.ok(waitDead(pid), `orphan ${pid} should be gone`);
  for (const pid of [...oldMapped.all, ...young.all, ...withDaemon.all, ...otherJobTag.all]) assert.ok(alive(pid), `pid ${pid} must live`);
  const hours = t.orka(["cleanup", "--orphan-hours", "0.01"]);
  assert.equal(hours.status, 0, hours.stderr);
  for (const pid of young.all) assert.ok(waitDead(pid));
  for (const pid of [...oldMapped.all, ...withDaemon.all]) assert.ok(alive(pid));
  assert.notEqual(t.orka(["cleanup", "--orphan-hours", "soon"]).status, 0);
});

test("selectOrphans needs ppid init, age and no live owner", () => {
  const mk = (o) => ({ pid: 10, ppid: 1, cmdline: "chrome --user-data-dir=/tmp/agent-browser-chrome-x", job: "", worker: "", session: "", ageMs: 5e7, chromeRoot: true, ...o });
  const opts = { minAgeMs: 3.6e6, liveJobIds: ["live"], livePrefixes: ["orka-aaaaaaaa"] };
  assert.equal(selectOrphans([mk({})], opts).length, 1);
  assert.equal(selectOrphans([mk({ ageMs: 1000 })], opts).length, 0);
  assert.equal(selectOrphans([mk({ ppid: 77 })], opts).length, 0);
  assert.equal(selectOrphans([mk({ session: "orka-aaaaaaaa-verifier" })], opts).length, 0);
  assert.equal(selectOrphans([mk({ job: "live" })], opts).length, 0);
  assert.equal(selectOrphans([mk({ pid: 11, ppid: 10, chromeRoot: false }), mk({ job: "", session: "" })], opts).length, 2);
});

test("every agent-browser launch in orka.mjs carries ORKA_JOB (and ORCA_JOB)", () => {
  const src = readFileSync(ORKA, "utf8");
  const launches = src.match(/spawnSync\("agent-browser"[\s\S]*?\}\);/g) || [];
  assert.ok(launches.length >= 2);
  for (const l of launches) assert.match(l, /browserEnv\(/, l.slice(0, 80));
  assert.match(src, /brand\.envPair\("JOB", String\(job\)\)/);
  assert.doesNotMatch(src, /"session", "list"/);
});

test("the verifier's round-end reap records its Chrome pids and kills them", () => {
  const t = scratch();
  const j = makeJob(t, "running", { workers: [{ name: "verifier", role: "verifier", pane: "p-v" }] });
  const chrome = t.tree({ session: `${j.prefix}-verifier` });
  const r = t.orka(["reap", j.id, "--worker", "verifier"]);
  assert.equal(r.status, 0, r.stderr);
  for (const pid of chrome.all) assert.ok(waitDead(pid), `verifier pid ${pid} should be gone`);
  const recorded = JSON.parse(readFileSync(join(t.repo, ".orka", "jobs", j.id, "browser-pids.json"), "utf8")).pids;
  assert.deepEqual(recorded.map((p) => p.pid).sort(), chrome.all.sort());
  assert.ok(recorded.every((p) => p.worker === "verifier" && p.startMs > 0));
});

test("the verifier prompt ends the round with orka reap and a bracketed pgrep", () => {
  const src = readFileSync(ORKA, "utf8");
  assert.match(src, /Your round ends with one last command: orka reap \$\{job\.id\} --worker \$\{name\}/);
  assert.match(src, /pgrep -af '\[a\]gent-browser-chrome'/);
});

test("cleanup kills Chrome whose worker pane is gone; a live pane's Chrome stays", () => {
  const t = scratch();
  const j = makeJob(t, "running", { workers: [{ name: "api", pane: "p-a", closed: new Date().toISOString() }, { name: "web", pane: "p-w" }] });
  const api = t.tree({ session: `${j.prefix}-api` });
  const web = t.tree({ session: `${j.prefix}-web`, jobTag: j.id });
  const dry = t.orka(["cleanup", "--dry-run"]);
  assert.match(dry.stdout, new RegExp(`browser pid ${api.daemon} has no owner left \\(pane p-a of api is gone\\)`));
  const r = t.orka(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  for (const pid of api.all) assert.ok(waitDead(pid), `api pid ${pid} should be gone`);
  for (const pid of web.all) assert.ok(alive(pid), `web pid ${pid} must live`);
});

test("cleanup kills Chrome tagged for a job that no longer exists, only inside this repo's worktrees", () => {
  const t = scratch();
  makeJob(t, "running");
  const here = t.tree({ session: "default", jobTag: "20260101000000000-gone" });
  const elsewhere = t.tree({ session: "default", jobTag: "20260101000000000-other-repo" });
  const wt = join(t.repo, ".orka", "worktrees", "20260101000000000-gone");
  mkdirSync(wt, { recursive: true });
  for (const pid of here.all) symlinkSync(wt, join(t.proc, String(pid), "cwd"));
  for (const pid of elsewhere.all) symlinkSync(tmpdir(), join(t.proc, String(pid), "cwd"));
  const r = t.orka(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /job 20260101000000000-gone no longer exists/);
  for (const pid of [here.root, here.renderer]) assert.ok(waitDead(pid), `pid ${pid} should be gone`);
  for (const pid of elsewhere.all) assert.ok(alive(pid), `another repo's pid ${pid} must live`);
});

test("a recorded pid that lost its tag and session is killed once its pane is closed", () => {
  const t = scratch();
  const j = makeJob(t, "running", { workers: [{ name: "verifier", role: "verifier", pane: "p-v" }] });
  const chrome = t.tree({ session: `${j.prefix}-verifier` });
  assert.equal(t.orka(["status", j.id]).status, 0);
  assert.ok(existsSync(join(t.repo, ".orka", "jobs", j.id, "browser-pids.json")));
  // The daemon goes, Chrome is reparented and carries nothing that names the job.
  rmSync(join(t.proc, String(chrome.daemon)), { recursive: true });
  for (const pid of [chrome.root, chrome.renderer]) t.entry(pid, { cmd: `/c/chrome --type=x --user-data-dir=/tmp/agent-browser-chrome-z`, ppid: 1 });
  const before = t.orka(["cleanup"]);
  for (const pid of [chrome.root, chrome.renderer]) assert.ok(alive(pid), "pane still open: kept");
  assert.doesNotMatch(before.stdout, /no owner left/);
  const job = j.read();
  job.workers[0].closed = new Date().toISOString();
  writeFileSync(j.path, JSON.stringify(job));
  const r = t.orka(["cleanup"]);
  assert.match(r.stdout, /recorded pid of verifier/);
  for (const pid of [chrome.root, chrome.renderer]) assert.ok(waitDead(pid), `pid ${pid} should be gone`);
});

test("selectRecorded never matches a recycled pid; selectGone ignores unattributed and live-pane processes", () => {
  const proc = (o) => ({ pid: 50, ppid: 1, cmdline: "chrome", job: "", worker: "", session: "", startMs: 1000000, cwd: "", ...o });
  assert.equal(selectRecorded([proc({})], [{ pid: 50, startMs: 1000000 }]).length, 1);
  assert.equal(selectRecorded([proc({})], [{ pid: 50, startMs: 9000000 }]).length, 0);
  assert.equal(selectRecorded([proc({})], [{ pid: 51, startMs: 1000000 }]).length, 0);
  const job = { id: "j1", status: "running", pane: "p-o", workers: [{ name: "w1", pane: "p-1" }] };
  const opts = { jobs: [job], prefixOf: () => "orka-12345678", worktreesRoot: "/r/.orka/worktrees", livePanes: new Set(["p-o", "p-1"]) };
  assert.equal(selectGone([proc({})], opts).length, 0);
  assert.equal(selectGone([proc({ job: "j1", worker: "w1" })], opts).length, 0);
  assert.equal(selectGone([proc({ job: "j1", worker: "w1" })], { ...opts, livePanes: new Set(["p-o"]) }).length, 1);
  assert.equal(selectGone([proc({ session: "orka-12345678-orchestrator" })], { ...opts, livePanes: new Set() }).length, 1);
  assert.equal(selectGone([proc({ job: "j1", worker: "w1" })], { ...opts, livePanes: null }).length, 0);
  assert.equal(selectGone([proc({ job: "nope", cwd: "/r/.orka/worktrees/nope" })], opts).length, 1);
  assert.equal(selectGone([proc({ job: "nope", cwd: "/r/.orka/worktrees2/nope" })], opts).length, 0);
});
