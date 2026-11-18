import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { piGuardExtension } from "../lib/orchestrator-guard.mjs";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "orchestrator-guard.mjs");

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orka-guard-")));
  const worktree = join(root, "wt");
  const jobDir = join(root, "job");
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(jobDir, { recursive: true });
  return { root, worktree, jobDir, log: join(jobDir, "decisions.tsv") };
}

function run(s, stdin, args) {
  return spawnSync(process.execPath, [GUARD, ...(args || ["claude", s.jobDir, s.worktree])], { input: stdin, encoding: "utf8" });
}

const call = (tool_name, tool_input, cwd) => JSON.stringify({ tool_name, tool_input, cwd });

test("Edit inside the worktree is refused, with a reason and one log row", () => {
  const s = setup();
  const r = run(s, call("Edit", { file_path: join(s.worktree, "src", "a.mjs") }, s.worktree));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /orka worker/);
  assert.match(r.stderr, /orka steer/);
  const lines = readFileSync(s.log, "utf8").split("\n").filter(Boolean);
  assert.equal(lines[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
  assert.equal(lines.length, 2);
  const cells = lines[1].split("\t");
  assert.equal(cells[1], "guard");
  assert.equal(cells[2], "refused Edit");
  assert.equal(cells[4], join(s.worktree, "src", "a.mjs"));
  assert.equal(cells[5], "refused");
});

test("Write outside the worktree is allowed and logs nothing", () => {
  const s = setup();
  const r = run(s, call("Write", { file_path: join(s.jobDir, "summary.txt") }, s.worktree));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.equal(existsSync(s.log), false);
});

test("a relative file_path resolves against cwd", () => {
  const s = setup();
  assert.equal(run(s, call("Write", { file_path: "src/new.mjs" }, s.worktree)).status, 2);
  assert.equal(run(s, call("Write", { file_path: "summary.txt" }, s.jobDir)).status, 0);
  assert.equal(run(s, call("Write", { file_path: "../wt/x.txt" }, s.jobDir)).status, 2);
});

test("NotebookEdit is refused through notebook_path", () => {
  const s = setup();
  const r = run(s, call("NotebookEdit", { notebook_path: join(s.worktree, "n.ipynb") }, s.worktree));
  assert.equal(r.status, 2);
  assert.match(readFileSync(s.log, "utf8"), /refused NotebookEdit/);
});

test("MultiEdit in the worktree is refused", () => {
  const s = setup();
  assert.equal(run(s, call("MultiEdit", { file_path: join(s.worktree, "b.mjs") }, s.worktree)).status, 2);
});

test("other tools pass", () => {
  const s = setup();
  assert.equal(run(s, call("Read", { file_path: join(s.worktree, "a.mjs") }, s.worktree)).status, 0);
  assert.equal(run(s, call("Bash", { command: "echo hi > a" }, s.worktree)).status, 0);
  assert.equal(existsSync(s.log), false);
});

test("garbage stdin and missing args pass", () => {
  const s = setup();
  assert.equal(run(s, "not json {").status, 0);
  assert.equal(run(s, "").status, 0);
  assert.equal(run(s, call("Edit", { file_path: join(s.worktree, "a") }, s.worktree), ["claude"]).status, 0);
});

test("a sibling directory sharing the worktree name prefix is outside", () => {
  const s = setup();
  const sibling = `${s.worktree}-other`;
  assert.equal(run(s, call("Write", { file_path: join(sibling, "a.txt") }, s.root)).status, 0);
});

test("tabs and newlines in a path stay in one row", () => {
  const s = setup();
  run(s, call("Write", { file_path: join(s.worktree, "a\tb\nc") }, s.worktree));
  const lines = readFileSync(s.log, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].split("\t").length, 6);
});

test("piGuardExtension blocks a write on a worktree path and logs it, ignores a read", () => {
  const s = setup();
  let handler;
  piGuardExtension({ jobDir: s.jobDir, worktree: s.worktree })({ on: (name, fn) => { if (name === "tool_call") handler = fn; } });
  assert.equal(handler({ toolName: "read", input: { path: join(s.worktree, "a") } }, { cwd: s.worktree }), undefined);
  assert.equal(handler({ toolName: "write", input: { path: join(s.jobDir, "summary.txt") } }, { cwd: s.worktree }), undefined);
  assert.equal(existsSync(s.log), false);
  const got = handler({ toolName: "write", input: { path: "src/x.mjs" } }, { cwd: s.worktree });
  assert.equal(got.block, true);
  assert.match(got.reason, /orka worker/);
  const handled = handler({ toolName: "edit", input: { path: join(s.worktree, "y.mjs") } }, {});
  assert.equal(handled.block, true);
  const lines = readFileSync(s.log, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /\tguard\trefused write\t/);
});
