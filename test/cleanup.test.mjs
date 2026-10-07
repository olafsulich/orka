import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// herdr and agent-browser are stubs on PATH; they only append to a log.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-cleanup-"));
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: run, AGENT_BROWSER_SOCKET_DIR: "" };
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orca(["init"]);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { repo, run, orca, calls, log, bin };
}

function makeJob(t, status, extra = {}) {
  const id = t.orca(["new", "--kind", "pi", "--title", "c", "--goal", "g", ...(extra.keep ? ["--keep"] : [])]).stdout.trim();
  const path = join(t.repo, ".orca", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  const prefix = `orca-${createHash("sha1").update(id).digest("hex").slice(0, 8)}`;
  Object.assign(job, { status, workspace: "w-1", browserSessions: [`${prefix}-w1`] });
  writeFileSync(path, JSON.stringify(job));
  return { id, prefix, path };
}

test("done closes job browsers then the workspace", () => {
  const t = scratch();
  const j = makeJob(t, "running");
  const r = t.orca(["done", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`cleanup: closed browser ${j.prefix}-w1`));
  assert.match(r.stdout, /cleanup: closed workspace w-1/);
  assert.ok(t.calls().includes(`herdr workspace close w-1`));
  assert.ok(t.calls().includes(`agent-browser --session ${j.prefix}-w1 close`));
  assert.equal(JSON.parse(readFileSync(j.path, "utf8")).status, "done");
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
  const j = makeJob(t, "running");
  const r = t.orca(["done", j.id, "--dry-run"]);
  assert.match(r.stdout, /cleanup: would close workspace w-1/);
  assert.ok(!t.calls().some((c) => c.includes("close")));
});

test("orca cleanup sweeps finished jobs and dead-pid sessions, spares running jobs", () => {
  const t = scratch();
  const fin = makeJob(t, "stopped");
  const live = makeJob(t, "running");
  writeFileSync(join(t.run, "agent-browser", "ghost.pid"), "999999999");
  const dry = t.orca(["cleanup", "--dry-run"]);
  assert.match(dry.stdout, /would close workspace w-1/);
  assert.ok(!t.calls().some((c) => c.includes("close")));
  const r = t.orca(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`closed browser ${fin.prefix}-w1`));
  assert.match(r.stdout, /closed browser ghost/);
  assert.ok(!r.stdout.includes(`${live.prefix}-w1`));
  assert.equal(t.calls().filter((c) => c === "herdr workspace close w-1").length, 1);
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
