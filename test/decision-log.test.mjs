import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DECISION_ROWS, DIGEST_MAX, renderDigest } from "../lib/digest.mjs";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// No herdr is needed: log, strategy, status and digest never talk to it.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-dlog-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  for (const d of [repo, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), ORCA_NO_WATCH: "1" };
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orca(["init"]);
  const id = orca(["new", "--kind", "claude", "--title", "dl", "--goal", "log decisions"]).stdout.trim();
  const rows = () => readFileSync(join(repo, ".orca", "jobs", id, "decisions.tsv"), "utf8").split("\n").filter(Boolean);
  return { orca, id, rows };
}

test("orca log appends a timestamped TSV row and escapes tabs and newlines", () => {
  const t = scratch();
  const r = t.orca(["log", t.id, "split", "two workers", "files\tdiffer", "line1\nline2", "ok"]);
  assert.equal(r.status, 0, r.stderr);
  const rows = t.rows();
  assert.equal(rows[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
  assert.equal(rows.length, 2);
  const cells = rows[1].split("\t");
  assert.equal(cells.length, 6);
  assert.match(cells[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.deepEqual(cells.slice(1), ["split", "two workers", "files\\tdiffer", "line1\\nline2", "ok"]);
});

test("orca log rejects a wrong argument count", () => {
  const t = scratch();
  const r = t.orca(["log", t.id, "split", "only two"]);
  assert.notEqual(r.status, 0);
});

test("orca strategy appends a strategy row", () => {
  const t = scratch();
  assert.equal(t.orca(["strategy", t.id, "fresh worker"]).status, 0);
  const cells = t.rows()[1].split("\t");
  assert.equal(cells[1], "strategy");
  assert.equal(cells[2], "fresh worker");
});

test("orca status shows the decision count", () => {
  const t = scratch();
  assert.match(t.orca(["status", t.id]).stdout, /decisions: 0/);
  t.orca(["log", t.id, "routing", "a", "b", "c", "d"]);
  t.orca(["log", t.id, "routing", "a2", "b", "c", "d"]);
  assert.match(t.orca(["status", t.id]).stdout, /decisions: 2/);
});

test("digest shows the last rows and stays within DIGEST_MAX", () => {
  const t = scratch();
  for (let i = 1; i <= 6; i++) t.orca(["log", t.id, "split", `decision-${i}`, "why", "ev", "res"]);
  const out = t.orca(["digest", t.id]).stdout;
  assert.match(out, /decisions: 6/);
  assert.match(out, /decision-6/);
  assert.match(out, new RegExp(`decision-${6 - DECISION_ROWS + 1}`));
  assert.doesNotMatch(out, /decision-1\b/);
  assert.ok(out.length <= DIGEST_MAX + 1);
  const long = Array.from({ length: 50 }, (_, i) => `2026-01-01T00:00:00Z\tsplit\t${"x".repeat(500)}${i}\t\t\t${"y".repeat(500)}`);
  const text = renderDigest({ id: "j", status: "running" }, { decisions: { count: 50, rows: long } });
  assert.ok(text.length <= DIGEST_MAX);
});

test("orchestrator prompt tells the lead to log decisions", () => {
  const src = readFileSync(ORCA, "utf8");
  assert.match(src, /Log every split, routing and strategy decision[^`]*orca log \$\{job\.id\}/);
});
