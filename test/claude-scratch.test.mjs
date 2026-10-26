import { execFileSync, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeScratchDir } from "../lib/lifecycle.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

test("claudeScratchDir turns every non-alphanumeric character of the path into a dash", () => {
  assert.equal(
    claudeScratchDir("/home/olaf/projects/motion-lab/.orca/worktrees/20261025120710491-film2-s4", "/tmp/claude-1000"),
    "/tmp/claude-1000/-home-olaf-projects-motion-lab--orca-worktrees-20261025120710491-film2-s4",
  );
  assert.equal(claudeScratchDir(`/${"a".repeat(220)}`, "/tmp/claude-1000"), null);
  assert.equal(claudeScratchDir("", "/tmp/claude-1000"), null);
});

// herdr is a stub on PATH; the Claude scratch root is a folder in the sandbox.
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "orka-scratch-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const claudeTmp = join(base, "claude-tmp");
  for (const d of [repo, bin, claudeTmp, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  for (const name of ["herdr", "agent-browser"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\necho '{}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_CLAUDE_TMP: claudeTmp };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const calls = () => readFileSync(log, "utf8");
  return { repo, claudeTmp, orka, calls };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// A finished job record with a worktree under the state dir and a filled Claude scratch folder.
function jobWithScratch(t, patch) {
  const id = t.orka(["new", "--kind", "pi", "--title", "s", "--goal", "g"]).stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  const worktree = join(t.repo, ".orka", "worktrees", id);
  Object.assign(job, { worktree, workspace: `w-${id}`, finished: hoursAgo(13) }, patch);
  writeFileSync(path, JSON.stringify(job));
  const dir = claudeScratchDir(job.worktree, t.claudeTmp);
  mkdirSync(join(dir, "session-1", "scratchpad"), { recursive: true });
  writeFileSync(join(dir, "session-1", "scratchpad", "big.bin"), Buffer.alloc(64 * 1024));
  return { id, path, dir, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

test("cleanup removes the Claude scratch folder of a job whose workspace it closes, dry-run only lists it", () => {
  const t = sandbox();
  const j = jobWithScratch(t, { status: "stopped" });
  const dry = t.orka(["cleanup", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`would remove Claude scratch ${j.dir} \\(\\d+[KM], ${j.id}\\)`));
  assert.ok(existsSync(j.dir), "dry-run deletes nothing");
  const real = t.orka(["cleanup"]);
  assert.equal(real.status, 0, real.stderr);
  assert.match(t.calls(), new RegExp(`herdr workspace close w-${j.id}`));
  assert.match(real.stdout, new RegExp(`removed Claude scratch ${j.dir} `));
  assert.ok(!existsSync(j.dir));
  assert.ok(existsSync(t.claudeTmp), "only the job's own folder goes, not the root");
  assert.ok(j.read().scratchRemoved);
  assert.match(t.orka(["cleanup"]).stdout, /nothing to close/);
});

test("cleanup clears the scratch of a job whose workspace was closed earlier", () => {
  const t = sandbox();
  const j = jobWithScratch(t, { status: "done", workspaceClosed: hoursAgo(1), worktreeRemoved: hoursAgo(1) });
  const r = t.orka(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed Claude scratch/);
  assert.ok(!existsSync(j.dir));
});

test("cleanup keeps the scratch of open workspaces, kept jobs, live jobs and other folders", () => {
  const t = sandbox();
  const open = jobWithScratch(t, { status: "done", finished: new Date().toISOString() });
  const kept = jobWithScratch(t, { status: "stopped", keep: true });
  const live = jobWithScratch(t, { status: "running", workspaceClosed: hoursAgo(1) });
  const outside = jobWithScratch(t, { status: "stopped", worktree: join(t.repo, "elsewhere") });
  const other = join(t.claudeTmp, "-home-olaf-projects-orca");
  mkdirSync(other, { recursive: true });
  const r = t.orka(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  // The outside job's stale workspace closes, but its worktree is not under the state dir.
  for (const j of [open, kept, live, outside]) assert.ok(existsSync(j.dir), `${j.id} kept`);
  assert.ok(existsSync(other));
  assert.doesNotMatch(r.stdout, /Claude scratch/);
});

test("cleanup keeps a scratch folder a process still works in", async () => {
  const t = sandbox();
  const j = jobWithScratch(t, { status: "stopped", workspaceClosed: hoursAgo(1) });
  const holder = spawn("sleep", ["30"], { cwd: j.dir, stdio: "ignore" });
  try {
    await new Promise((r) => holder.once("spawn", r));
    const r = t.orka(["cleanup"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`kept Claude scratch ${j.dir} \\(pid ${holder.pid} still works in it`));
    assert.ok(existsSync(j.dir));
  } finally {
    holder.kill();
  }
});
