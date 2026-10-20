import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_STALE_MS,
  findWorktreeProcesses,
  findWorktreeServers,
  isServerProcess,
  isStale,
  killProcesses,
  lastActivity,
  parseDuration,
} from "../lib/lifecycle.mjs";

const H = 3600 * 1000;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const base = (over = {}) => ({ status: "done", workspace: "w1", finished: iso(13 * H), ...over });

test("parseDuration accepts units and rejects bare numbers", () => {
  assert.equal(parseDuration("12h"), 12 * H);
  assert.equal(parseDuration("30m"), 30 * 60000);
  assert.equal(parseDuration("45s"), 45000);
  assert.equal(parseDuration("2d"), 48 * H);
  assert.equal(parseDuration("1.5h"), 1.5 * H);
  assert.throws(() => parseDuration("90"), /needs a unit/);
  assert.throws(() => parseDuration("abc"), /bad duration/);
  assert.throws(() => parseDuration(""), /bad duration/);
  assert.equal(DEFAULT_STALE_MS, 12 * H);
});

test("lastActivity takes the latest known timestamp", () => {
  assert.equal(lastActivity({}), 0);
  const job = base({
    updated: iso(5 * H),
    steers: [{ at: iso(2 * H), message: "x" }],
    verifier: { history: [{ at: iso(1 * H) }] },
    finishRounds: [iso(20 * H)],
  });
  assert.equal(lastActivity(job), NOW - 1 * H);
  assert.equal(lastActivity({ lastSteer: iso(3 * H), finishRounds: [{ at: iso(1 * H) }] }), NOW - 1 * H);
});

test("isStale threshold boundary", () => {
  const at = (ago) => base({ finished: iso(ago) });
  assert.equal(isStale(at(12 * H), NOW, DEFAULT_STALE_MS), false);
  assert.equal(isStale(at(12 * H + 1), NOW, DEFAULT_STALE_MS), true);
  assert.equal(isStale(at(1 * H), NOW, DEFAULT_STALE_MS), false);
});

test("isStale respects status, keep, workspace and extra activity", () => {
  assert.equal(isStale(base({ status: "running" }), NOW, H), false);
  assert.equal(isStale(base({ status: "new" }), NOW, H), false);
  for (const status of ["done", "failed", "stopped"]) assert.equal(isStale(base({ status }), NOW, H), true);
  assert.equal(isStale(base({ keep: true }), NOW, H), false);
  assert.equal(isStale(base({ workspace: "" }), NOW, H), false);
  assert.equal(isStale(base({ workspaceClosed: iso(H) }), NOW, H), false);
  assert.equal(isStale(base(), NOW, H, NOW - 10 * 60000), false);
  assert.equal(isStale(base(), NOW, H, NOW - 2 * H), true);
});

function fakeProc() {
  const root = mkdtempSync(join(tmpdir(), "orka-lifecycle-"));
  const procRoot = join(root, "proc");
  const wt = join(root, "wt");
  const wt2 = join(root, "wt2");
  for (const d of [procRoot, wt, join(wt, "sub"), wt2]) mkdirSync(d, { recursive: true });
  const add = (pid, cwd, argv, ppid = 1) => {
    const dir = join(procRoot, String(pid));
    mkdirSync(dir);
    symlinkSync(cwd, join(dir, "cwd"));
    writeFileSync(join(dir, "cmdline"), argv.join("\0") + "\0");
    writeFileSync(join(dir, "status"), `Name:\tx\nPPid:\t${ppid}\n`);
  };
  return { root, procRoot, wt, wt2, add };
}

test("findWorktreeProcesses matches cwd on a path boundary and skips self and ancestors", () => {
  const f = fakeProc();
  f.add(100, f.wt, ["node", "tools/server.mjs", "--port", "5199"]);
  f.add(101, join(f.wt, "sub"), ["vite"]);
  f.add(102, f.wt2, ["node", "other.mjs"]);
  f.add(103, f.root, ["node", "x.mjs"]);
  f.add(200, f.wt, ["bash"], 1); // ancestor of self
  f.add(201, f.wt, ["node", "me.mjs"], 200); // self
  mkdirSync(join(f.procRoot, "self"));
  const got = findWorktreeProcesses(f.wt, { procRoot: f.procRoot, selfPid: 201 });
  assert.deepEqual(got.map((p) => p.pid).sort(), [100, 101]);
  assert.equal(got.find((p) => p.pid === 100).cmdline, "node tools/server.mjs --port 5199");
  assert.equal(got.find((p) => p.pid === 101).cwd, join(f.wt, "sub"));
});

test("isServerProcess heuristics", () => {
  for (const c of [
    "node tools/server.mjs --port 5199",
    "node app.js",
    "bun run index.ts",
    "deno run main.ts",
    "python3 -m http.server 8000",
    "vite",
    "npm run dev",
    "/usr/bin/foo -p 3000",
    "ruby web-server.rb",
  ]) assert.equal(isServerProcess(c), true, c);
  for (const c of [
    "",
    "claude --model sonnet",
    "node /usr/lib/node_modules/claude/claude",
    "herdr pane",
    "agent-browser --session x open",
    "pi",
    "bash",
    "-bash",
    "zsh -l",
    "fish",
    "git status",
    "node /x/bin/orka.mjs done abc",
    "ls -la",
  ]) assert.equal(isServerProcess(c), false, c);
});

test("findWorktreeServers drops claude and herdr panes", () => {
  const f = fakeProc();
  f.add(100, f.wt, ["node", "tools/server.mjs", "--port", "5199"]);
  f.add(101, f.wt, ["claude", "--model", "sonnet"]);
  f.add(102, f.wt, ["herdr", "pane"]);
  f.add(103, f.wt, ["bash"]);
  f.add(104, f.wt2, ["node", "server.mjs"]);
  const got = findWorktreeServers(f.wt, { procRoot: f.procRoot, selfPid: 999999 });
  assert.deepEqual(got.map((p) => p.pid), [100]);
});

test("killProcesses signals live pids and ignores ESRCH", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 100));
  const killed = killProcesses([child.pid, 2 ** 22 + 12345], { signal: "SIGTERM" });
  assert.deepEqual(killed, [child.pid]);
  await exited;
  assert.deepEqual(killProcesses([child.pid]), []);
});
