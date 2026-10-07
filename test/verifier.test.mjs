import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// herdr and agent-browser are stubs on PATH; they only append to a log.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-verifier-"));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const run = join(base, "run");
  for (const d of [repo, bin, home, run]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  for (const name of ["herdr", "agent-browser"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\necho '{}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: run, AGENT_BROWSER_SOCKET_DIR: "" };
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orca(["init"]);
  return { repo, orca };
}

function makeJob(t, extra = {}) {
  const id = t.orca(["new", "--kind", "pi", "--title", "v", "--goal", "g"]).stdout.trim();
  const path = join(t.repo, ".orca", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") }, extra);
  writeFileSync(path, JSON.stringify(job));
  const results = join(t.repo, ".orca", "jobs", id, "results");
  mkdirSync(results, { recursive: true });
  return { id, path, results, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

const verdict = (round, v) => JSON.stringify({ name: "verifier", role: "verifier", round, verdict: v, checks: [], failures: v === "fail" ? ["x"] : [], summary: "s" });

test("--role accepts builder and verifier, rejects anything else", () => {
  const t = scratch();
  const j = makeJob(t);
  const base = ["worker", "--job", j.id, "--task", "t", "--dry-run"];
  assert.match(t.orca([...base, "--name", "verifier", "--role", "verifier"]).stdout, /role=verifier round=1/);
  assert.match(t.orca([...base, "--name", "api", "--role", "builder"]).stdout, /role=builder/);
  assert.match(t.orca([...base, "--name", "api"]).stdout, /role=builder/);
  const bad = t.orca([...base, "--name", "api", "--role", "judge"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--role must be builder or verifier/);
});

test("a verifier must be named verifier, and builders cannot take that name", () => {
  const t = scratch();
  const j = makeJob(t);
  const base = ["worker", "--job", j.id, "--task", "t", "--dry-run"];
  const a = t.orca([...base, "--name", "checker", "--role", "verifier"]);
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /must be named "verifier"/);
  const b = t.orca([...base, "--name", "verifier"]);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /reserved/);
});

test("a 4th verifier round is refused", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 3, verdict: "fail", history: [] } });
  const r = t.orca(["worker", "--job", j.id, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already ran 3 rounds/);
  const two = makeJob(t, { verifier: { rounds: 2, verdict: "fail", history: [] } });
  const ok = t.orca(["worker", "--job", two.id, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /round=3/);
});

test("done records a passing verdict and history, job is done", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 2, verdict: null, history: [{ round: 1, verdict: "fail", at: "2026-01-01T00:00:00.000Z" }] } });
  writeFileSync(join(j.results, "verifier.json"), verdict(2, "pass"));
  const r = t.orca(["done", j.id, "--keep"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified by verifier: pass, round 2/);
  const job = j.read();
  assert.equal(job.status, "done");
  assert.equal(job.verifier.rounds, 2);
  assert.equal(job.verifier.verdict, "pass");
  assert.deepEqual(job.verifier.history.map((h) => [h.round, h.verdict]), [[1, "fail"], [2, "pass"]]);
});

test("done marks the job failed on a final verifier fail", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 3, verdict: null, history: [] } });
  writeFileSync(join(j.results, "verifier.json"), verdict(3, "fail"));
  const r = t.orca(["done", j.id, "--keep"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verifier failed after 3 rounds/);
  assert.match(r.stdout, /verifier: fail, round 3/);
  const job = j.read();
  assert.equal(job.status, "failed");
  assert.equal(job.stopReason, "verifier failed after 3 rounds");
  assert.equal(job.verifier.verdict, "fail");
});

test("done ignores a stale verifier result from an earlier round", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 2, verdict: null, history: [] } });
  writeFileSync(join(j.results, "verifier.json"), verdict(1, "fail"));
  const r = t.orca(["done", j.id, "--keep"]);
  assert.equal(j.read().status, "done");
  assert.doesNotMatch(r.stdout, /verifier:/);
});

test("without a verifier, done and status behave as before", () => {
  const t = scratch();
  const j = makeJob(t);
  const r = t.orca(["done", j.id, "--keep"]);
  assert.match(r.stdout, new RegExp(`done ${j.id}: completed`));
  assert.doesNotMatch(r.stdout, /verif/);
  assert.equal(j.read().status, "done");
  assert.equal(j.read().verifier, undefined);
  assert.doesNotMatch(t.orca(["status", j.id]).stdout, /verified by|verifier: /);
});

test("status reports the verifier verdict", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 2, verdict: "pass", history: [] } });
  assert.match(t.orca(["status", j.id]).stdout, /verified by verifier: pass, round 2/);
  const f = makeJob(t, { verifier: { rounds: 3, verdict: "fail", history: [] } });
  assert.match(t.orca(["status", f.id]).stdout, /verifier: fail, round 3/);
});

test("done --dry-run previews failed on a verifier fail without changing the job", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 3, verdict: null, history: [] } });
  writeFileSync(join(j.results, "verifier.json"), verdict(3, "fail"));
  const r = t.orca(["done", j.id, "--dry-run", "--keep"]);
  assert.match(r.stdout, /running -> failed/);
  assert.equal(j.read().status, "running");
});

test("help documents --role and the verifier", () => {
  const out = spawnSync(process.execPath, [ORCA, "help"], { encoding: "utf8" }).stdout;
  assert.match(out, /--role builder\|verifier/);
  assert.match(out, /verified by verifier: pass, round N/);
});

function payloadOf(out) {
  return JSON.parse(out.match(/payload: (\{.*\})/)[1]);
}

test("finish payload adds verifier only when a verifier has a verdict", () => {
  const t = scratch();
  const none = makeJob(t);
  const plain = t.orca(["done", none.id, "--dry-run", "--keep"]).stdout;
  assert.deepEqual(payloadOf(plain), { job: none.id, status: "done", branch: `orca/${none.id}` });

  const pass = makeJob(t, { verifier: { rounds: 2, verdict: null, history: [] } });
  writeFileSync(join(pass.results, "verifier.json"), verdict(2, "pass"));
  assert.deepEqual(payloadOf(t.orca(["done", pass.id, "--dry-run", "--keep"]).stdout), {
    job: pass.id,
    status: "done",
    branch: `orca/${pass.id}`,
    verifier: "verified by verifier: pass, round 2",
  });

  const bad = makeJob(t, { verifier: { rounds: 3, verdict: null, history: [] } });
  writeFileSync(join(bad.results, "verifier.json"), verdict(3, "fail"));
  const payload = payloadOf(t.orca(["done", bad.id, "--dry-run", "--keep"]).stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.verifier, "verifier: fail, round 3");
});

test("help documents the verifier payload field", () => {
  const out = spawnSync(process.execPath, [ORCA, "help"], { encoding: "utf8" }).stdout;
  assert.match(out, /"verifier": "verified by verifier: pass, round N"/);
});
