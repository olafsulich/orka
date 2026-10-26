import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isBrowserProcess } from "../lib/browsers.mjs";
import { findJobLeftovers } from "../lib/lifecycle.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// A fake /proc: { pid: { ppid, cmd, env, state } }.
function fakeProc(entries) {
  const root = mkdtempSync(join(tmpdir(), "orka-leftover-proc-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  for (const [pid, e] of Object.entries(entries)) {
    const dir = join(root, pid);
    mkdirSync(dir);
    writeFileSync(join(dir, "cmdline"), `${e.cmd.split(" ").join("\0")}\0`);
    writeFileSync(join(dir, "environ"), Object.entries(e.env || {}).map(([k, v]) => `${k}=${v}`).join("\0"));
    writeFileSync(join(dir, "status"), `State:\t${e.state || "S (sleeping)"}\nPPid:\t${e.ppid}\n`);
  }
  return root;
}

test("findJobLeftovers picks detached tagged processes of the given jobs only", () => {
  const procRoot = fakeProc({
    100: { ppid: 1, cmd: "/usr/bin/herdr server" },
    101: { ppid: 100, cmd: "bash", env: { ORKA_JOB: "j1", ORKA_WORKER: "w1" } },
    102: { ppid: 101, cmd: "node vite.mjs", env: { ORKA_JOB: "j1", ORKA_WORKER: "w1" } },
    200: { ppid: 1, cmd: "node server.mjs --port 4100", env: { ORKA_JOB: "j1", ORKA_WORKER: "w1" } },
    201: { ppid: 200, cmd: "esbuild --service", env: { ORKA_JOB: "j1", ORKA_WORKER: "w1" } },
    202: { ppid: 1, cmd: "tail -f log.txt", env: { ORCA_JOB: "j1" } },
    203: { ppid: 1, cmd: "node watch.mjs", env: { ORKA_JOB: "j2" } },
    204: { ppid: 1, cmd: "/opt/chrome/chrome --headless", env: { ORKA_JOB: "j1" } },
    205: { ppid: 1, cmd: "node /x/bin/orka.mjs watch j1", env: { ORKA_JOB: "j1" } },
    206: { ppid: 1, cmd: "node zombie.mjs", env: { ORKA_JOB: "j1" }, state: "Z (zombie)" },
    207: { ppid: 1, cmd: "node untagged.mjs" },
  });
  const got = findJobLeftovers(["j1"], { procRoot, selfPid: 999999, isBrowser: isBrowserProcess });
  assert.deepEqual(got.map((p) => p.pid).sort(), [200, 201, 202]);
  assert.deepEqual(got.find((p) => p.pid === 200), { pid: 200, ppid: 1, job: "j1", worker: "w1", cmdline: "node server.mjs --port 4100" });
  assert.equal(got.find((p) => p.pid === 202).job, "j1", "ORCA_JOB is still read");
  assert.deepEqual(findJobLeftovers([], { procRoot }), []);
});

// Real idle processes made by this file, tagged like a job pane's children. Started through sh
// and backgrounded, so they are detached (reparented) like a daemon a pane left behind.
const made = [];
process.on("exit", () => {
  for (const pid of made) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function idle(jobId) {
  const out = spawnSync("sh", ["-c", `"${process.execPath}" -e "setInterval(() => {}, 1000)" orka-leftover-fake >/dev/null 2>&1 </dev/null & echo $!`], { encoding: "utf8", env: { ...process.env, ORKA_JOB: jobId, ORKA_WORKER: "w1" } });
  const pid = Number(out.stdout.trim());
  made.push(pid);
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

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "orka-leftover-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run"), join(base, "claude-tmp")]) mkdirSync(d, { recursive: true });
  for (const name of ["herdr", "agent-browser"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho '{}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_CLAUDE_TMP: join(base, "claude-tmp") };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const job = (patch) => {
    const id = orka(["new", "--kind", "pi", "--title", "l", "--goal", "g"]).stdout.trim();
    const path = join(repo, ".orka", "jobs", `${id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), workspace: `w-${id}`, ...patch }));
    return id;
  };
  return { orka, job };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

test("cleanup kills tagged leftovers of done and stopped jobs whose workspace is closed, and nothing else", () => {
  const t = sandbox();
  const closed = t.job({ status: "stopped", workspaceClosed: hoursAgo(1), finished: hoursAgo(13) });
  const closing = t.job({ status: "done", finished: hoursAgo(13), worktreeRemoved: hoursAgo(13) });
  const open = t.job({ status: "done", finished: new Date().toISOString(), worktreeRemoved: hoursAgo(1) });
  const kept = t.job({ status: "stopped", keep: true, workspaceClosed: hoursAgo(1) });
  const failed = t.job({ status: "failed", workspaceClosed: hoursAgo(1) });
  const running = t.job({ status: "running", workspaceClosed: hoursAgo(1) });
  const doomed = [idle(closed), idle(closing)];
  const spared = [idle(open), idle(kept), idle(failed), idle(running)];
  const dry = t.orka(["cleanup", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  for (const pid of doomed) assert.match(dry.stdout, new RegExp(`would kill leftover pid ${pid} \\(\\S+ w1: .*-e setInterval`));
  for (const pid of spared) assert.doesNotMatch(dry.stdout, new RegExp(`pid ${pid} `));
  assert.ok([...doomed, ...spared].every(alive), "dry-run kills nothing");
  const real = t.orka(["cleanup"]);
  assert.equal(real.status, 0, real.stderr);
  for (const pid of doomed) {
    assert.match(real.stdout, new RegExp(`killed leftover pid ${pid} `));
    assert.ok(waitDead(pid), `${pid} gone`);
  }
  assert.ok(spared.every(alive), "open, kept, failed and running jobs keep their processes");
});
