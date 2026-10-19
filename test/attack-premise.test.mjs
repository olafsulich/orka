import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// No herdr is needed: strategy and status never talk to it.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-premise-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  for (const d of [repo, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), ORCA_NO_WATCH: "1" };
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orca(["init"]);
  const id = orca(["new", "--kind", "claude", "--title", "pm", "--goal", "attack the premise"]).stdout.trim();
  const jobFile = join(repo, ".orca", "jobs", `${id}.json`);
  // status prints verifier detail only once a verifier round exists.
  const job = JSON.parse(readFileSync(jobFile, "utf8"));
  job.verifier = { rounds: 2, verdict: "fail", history: [] };
  writeFileSync(jobFile, JSON.stringify(job));
  const rows = () => readFileSync(join(repo, ".orca", "jobs", id, "decisions.tsv"), "utf8").split("\n").filter(Boolean);
  return { orca, id, rows };
}

test("stall paragraph asks for the shared premise, a census and the strategy that drops it", () => {
  const src = readFileSync(ORCA, "utf8");
  assert.match(src, /attack the premise: write in one sentence the premise the failed fixes share, list what else could explain the failure \(a census\), and pick the strategy that drops that premise/);
  assert.match(src, /orca strategy \$\{job\.id\} --premise "/);
});

test("orca strategy --premise is shown by status and logged as a decision row", () => {
  const t = scratch();
  const r = t.orca(["strategy", t.id, "--premise", "the selector exists", "render the page first"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.orca(["status", t.id]).stdout, /strategy change \(round 2\): premise: the selector exists \| change: render the page first/);
  const cells = t.rows()[1].split("\t");
  assert.equal(cells[1], "strategy");
  assert.equal(cells[2], "premise: the selector exists | change: render the page first");
});

test("orca strategy without --premise behaves as before", () => {
  const t = scratch();
  assert.equal(t.orca(["strategy", t.id, "fresh worker"]).status, 0);
  assert.match(t.orca(["status", t.id]).stdout, /strategy change \(round 2\): fresh worker/);
  assert.doesNotMatch(t.orca(["status", t.id]).stdout, /premise:/);
  assert.equal(t.rows()[1].split("\t")[2], "fresh worker");
});
