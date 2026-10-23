import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatKb, removableWorktree } from "../lib/lifecycle.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// A real git repo with one commit; herdr and agent-browser are stubs that only log.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-wtclean-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run", "agent-browser")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  for (const name of ["herdr", "agent-browser"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\necho '{}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const g = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  g(["init", "-q", "-b", "main"]);
  g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1" };
  // orka cleanup is wrapped in timeout, so a hang fails the test instead of stalling the suite.
  const orka = (args) => spawnSync("timeout", ["60", process.execPath, ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  return { repo, orka, g };
}

// A job record (orka new). orka new also runs the cleanup, so create every
// record first, then give each its worktree and status with setup().
function newJob(t, title = "w") {
  const id = t.orka(["new", "--kind", "pi", "--title", title, "--goal", "g"]).stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const wt = join(t.repo, ".orka", "worktrees", id);
  return { id, path, wt, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

// A real linked worktree on orka/<id> with one commit, the way orka run makes it.
function setup(t, j, status, patch = {}) {
  t.g(["worktree", "add", "-q", "-b", `orka/${j.id}`, j.wt, "HEAD"]);
  writeFileSync(join(j.wt, "file.txt"), "x".repeat(4096));
  t.g(["add", "file.txt"], j.wt);
  t.g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work"], j.wt);
  const rec = JSON.parse(readFileSync(j.path, "utf8"));
  Object.assign(rec, { status, worktree: j.wt }, patch);
  writeFileSync(j.path, JSON.stringify(rec));
  return j;
}

const job = (t, status, extra = {}) => setup(t, newJob(t, extra.title), status, extra.patch);

const branchExists = (t, id) => spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/orka/${id}`], { cwd: t.repo }).status === 0;

test("removableWorktree: only a done, not kept job with a live worktree", () => {
  assert.equal(removableWorktree({ status: "done", worktree: "/x" }), true);
  for (const status of ["failed", "stopped", "running", "queued"]) assert.equal(removableWorktree({ status, worktree: "/x" }), false);
  assert.equal(removableWorktree({ status: "done", worktree: "/x", keep: true }), false);
  assert.equal(removableWorktree({ status: "done", worktree: "/x", worktreeRemoved: "t" }), false);
  assert.equal(removableWorktree({ status: "done", worktree: "" }), false);
  assert.equal(formatKb(2048), "2M");
});

test("done removes the worktree and keeps the branch", () => {
  const t = scratch();
  const j = job(t, "running");
  const r = t.orka(["done", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`cleanup: removed worktree ${j.wt} \\(.*branch orka/${j.id} kept\\)`));
  assert.ok(!existsSync(j.wt));
  assert.ok(branchExists(t, j.id));
  assert.ok(j.read().worktreeRemoved);
  assert.equal(j.read().cleanup.worktree, j.wt);
  assert.match(t.orka(["status", j.id]).stdout, /worktree: .*\(removed .*; branch kept\)/);
});

test("done keeps a worktree with uncommitted changes", () => {
  const t = scratch();
  const j = job(t, "running");
  writeFileSync(join(j.wt, "wip.txt"), "unsaved");
  const r = t.orka(["done", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cleanup: kept worktree .*1 uncommitted change/);
  assert.ok(existsSync(join(j.wt, "wip.txt")));
  assert.equal(j.read().worktreeRemoved, undefined);
});

test("a failed or stopped job keeps its worktree", () => {
  const t = scratch();
  const j = job(t, "running");
  const r = t.orka(["done", j.id, "--give-up", "cannot"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /worktree/);
  assert.ok(existsSync(j.wt));
  const s = job(t, "running", { title: "s" });
  t.orka(["stop", s.id]);
  assert.ok(existsSync(s.wt));
});

test("orka cleanup sweeps past done worktrees, dry-run first; running, failed, stopped and kept stay", () => {
  const t = scratch();
  const [done, kept, ...others] = ["d", "k", "running", "failed", "stopped"].map((title) => newJob(t, title));
  setup(t, done, "done");
  setup(t, kept, "done", { keep: true });
  for (const o of others) setup(t, o, o.id.replace(/^[0-9]+-/, ""));
  const dry = t.orka(["cleanup", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`cleanup: would remove worktree ${done.wt} \\([0-9.]+[KMG], branch orka/${done.id} kept\\)`));
  assert.match(dry.stdout, /cleanup: would free [0-9.]+[KMG] of done-job worktrees/);
  assert.ok(existsSync(done.wt));
  const r = t.orka(["cleanup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cleanup: removed worktree/);
  assert.ok(!existsSync(done.wt));
  assert.ok(branchExists(t, done.id));
  for (const o of [...others, kept]) assert.ok(existsSync(o.wt), o.wt);
  assert.match(t.orka(["cleanup"]).stdout, /nothing to close/);
});

test("orka new runs the cleanup on stderr only", () => {
  const t = scratch();
  const done = job(t, "done");
  const r = t.orka(["new", "--kind", "pi", "--title", "n", "--goal", "g"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^[0-9]{17}-n$/);
  assert.match(r.stderr, /cleanup: removed worktree/);
  assert.ok(!existsSync(done.wt));
});
