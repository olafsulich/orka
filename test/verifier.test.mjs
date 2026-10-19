import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// herdr and agent-browser are stubs on PATH; they only append to a log.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-verifier-"));
  process.on("exit", () => rmScratch(base, { recursive: true, force: true }));
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: run, AGENT_BROWSER_SOCKET_DIR: "", ORCA_NO_WATCH: "1" };
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

const workerArgs = (id) => ["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"];

test("there is no round cap by default: a 4th and 10th verifier round are allowed", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 3, verdict: "fail", history: [] } });
  const r = t.orca(workerArgs(j.id));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /round=4/);
  const ten = makeJob(t, { verifier: { rounds: 9, verdict: "fail", history: [] } });
  assert.match(t.orca(workerArgs(ten.id)).stdout, /round=10/);
});

test("--max-rounds is an opt-in ceiling that refuses a round beyond it", () => {
  const t = scratch();
  const id = t.orca(["new", "--kind", "pi", "--title", "cap", "--goal", "g", "--max-rounds", "2"]).stdout.trim();
  const path = join(t.repo, ".orca", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(job.maxRounds, 2);
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt"), verifier: { rounds: 1, verdict: "fail", history: [] } });
  writeFileSync(path, JSON.stringify(job));
  assert.match(t.orca(workerArgs(id)).stdout, /round=2/);
  job.verifier.rounds = 2;
  writeFileSync(path, JSON.stringify(job));
  const r = t.orca(workerArgs(id));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--max-rounds 2 reached, refusing round 3/);
});

test("--max-rounds needs a positive integer and is accepted by run", () => {
  const t = scratch();
  for (const bad of ["0", "-1", "x", "1.5"]) {
    const r = t.orca(["new", "--kind", "pi", "--title", "bad", "--goal", "g", "--max-rounds", bad]);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /--max-rounds needs a positive integer/);
  }
  const id = t.orca(["new", "--kind", "pi", "--title", "r", "--goal", "g"]).stdout.trim();
  assert.equal(JSON.parse(readFileSync(join(t.repo, ".orca", "jobs", `${id}.json`), "utf8")).maxRounds, undefined);
  assert.equal(t.orca(["run", id, "--dry-run", "--max-rounds", "5"]).status, 0);
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
  assert.match(r.stdout, /verifier failed after 3 rounds: x/);
  assert.match(r.stdout, /verifier: fail, round 3/);
  const job = j.read();
  assert.equal(job.status, "failed");
  assert.equal(job.stopReason, "verifier failed after 3 rounds: x");
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
  assert.deepEqual(payloadOf(plain), { job: none.id, status: "done", branch: `orca/${none.id}`, playbook: "feature" });

  const pass = makeJob(t, { verifier: { rounds: 2, verdict: null, history: [] } });
  writeFileSync(join(pass.results, "verifier.json"), verdict(2, "pass"));
  assert.deepEqual(payloadOf(t.orca(["done", pass.id, "--dry-run", "--keep"]).stdout), {
    job: pass.id,
    status: "done",
    branch: `orca/${pass.id}`,
    playbook: "feature",
    verifier: "verified by verifier: pass, round 2",
    verification: { verdict: "pass", rounds: 2, strategyChanges: [], blocking: [], warnings: [] },
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

const result = (round, failures, warnings = []) =>
  JSON.stringify({ name: "verifier", role: "verifier", round, verdict: failures.length ? "fail" : "pass", failures, warnings, checks: [], summary: "s" });

test("stall detection: the same failing check in two consecutive rounds is recorded and shown", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 1, verdict: null, history: [] } });
  writeFileSync(join(j.results, "verifier.json"), result(1, [{ check: "scrub", evidence: "missing #scrub" }, { check: "lint", evidence: "e" }]));
  // starting round 2 records round 1 first
  assert.equal(t.orca(["worker", "--job", j.id, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"]).status, 0);
  t.orca(["status", j.id]);
  let v = j.read().verifier;
  assert.deepEqual(v.history.map((h) => [h.round, h.verdict, h.failing]), [[1, "fail", ["scrub", "lint"]]]);
  assert.equal(v.stall, null);

  // round 2 starts for real state: simulate by bumping rounds
  const job = j.read();
  job.verifier.rounds = 2;
  writeFileSync(j.path, JSON.stringify(job));
  writeFileSync(join(j.results, "verifier.json"), result(2, [{ check: "scrub", evidence: "still missing" }]));
  const out = t.orca(["status", j.id]).stdout;
  v = j.read().verifier;
  assert.deepEqual(v.stall, { checks: ["scrub"], rounds: [1, 2] });
  assert.match(out, /stall: scrub failed in rounds 1 and 2/);
  assert.match(out, /last failing: scrub/);
  assert.match(out, /verifier rounds: 2/);

  // a different failing set clears the stall
  const third = j.read();
  third.verifier.rounds = 3;
  writeFileSync(j.path, JSON.stringify(third));
  writeFileSync(join(j.results, "verifier.json"), result(3, [{ check: "other", evidence: "x" }]));
  t.orca(["status", j.id]);
  assert.equal(j.read().verifier.stall, null);
});

test("orca strategy appends to strategyChanges and status lists them", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 2, verdict: "fail", history: [] } });
  const r = t.orca(["strategy", j.id, "split", "the", "work", "differently"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /strategy change 1 recorded/);
  assert.match(t.orca(["strategy", j.id, "fresh worker"]).stdout, /strategy change 2 recorded/);
  const v = j.read().verifier;
  assert.deepEqual(v.strategyChanges.map((c) => [c.round, c.change]), [[2, "split the work differently"], [2, "fresh worker"]]);
  assert.equal(v.rounds, 2);
  assert.match(t.orca(["status", j.id]).stdout, /strategy change \(round 2\): fresh worker/);
  assert.notEqual(t.orca(["strategy", j.id]).status, 0);
});

test("warnings never block a pass; only failures do", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 1, verdict: null, history: [] } });
  const warning = { check: "editor-scrub", evidence: "#scrub missing on /clips/flowchart/", base: "abc", proof: "fails on base via orca verify --base" };
  writeFileSync(join(j.results, "verifier.json"), result(1, [], [warning]));
  const r = t.orca(["done", j.id, "--keep"]);
  assert.equal(r.status, 0, r.stderr);
  const job = j.read();
  assert.equal(job.status, "done");
  assert.equal(job.verifier.verdict, "pass");
  assert.deepEqual(job.verifier.history[0].warnings, ["editor-scrub"]);
  assert.deepEqual(job.verifier.history[0].failing, []);

  // a verdict "fail" with only warnings in the failures-shaped result is a pass too
  const k = makeJob(t, { verifier: { rounds: 1, verdict: null, history: [] } });
  writeFileSync(join(k.results, "verifier.json"), JSON.stringify({ round: 1, verdict: "fail", failures: [], warnings: [warning] }));
  t.orca(["done", k.id, "--keep"]);
  assert.equal(k.read().status, "done");
});

test("plain string failures stay accepted and are normalised to check+evidence", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 1, verdict: null, history: [] } });
  writeFileSync(join(j.results, "verifier.json"), JSON.stringify({ round: 1, verdict: "fail", failures: ["npm test red"] }));
  const payload = payloadOf(t.orca(["done", j.id, "--dry-run", "--keep"]).stdout);
  assert.deepEqual(payload.verification.blocking, [{ check: "npm test red", evidence: "npm test red" }]);
});

test("finish payload verification carries verdict, rounds, strategy changes, blocking, warnings", () => {
  const t = scratch();
  const strategyChanges = [{ round: 1, change: "fresh worker", at: "2026-01-01T00:00:00.000Z" }];
  const j = makeJob(t, { verifier: { rounds: 2, verdict: null, history: [], strategyChanges } });
  const warning = { check: "editor-scrub", evidence: "w-ev", base: "abc", proof: "p" };
  writeFileSync(join(j.results, "verifier.json"), result(2, [{ check: "api", evidence: "500 on /x" }], [warning]));
  const payload = payloadOf(t.orca(["done", j.id, "--dry-run", "--keep"]).stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.verifier, "verifier: fail, round 2");
  assert.deepEqual(payload.verification, {
    verdict: "fail",
    rounds: 2,
    strategyChanges: ["fresh worker"],
    blocking: [{ check: "api", evidence: "500 on /x" }],
    warnings: [{ check: "editor-scrub", evidence: "w-ev" }],
  });
  const done = t.orca(["done", j.id, "--keep"]);
  assert.match(done.stdout, /verifier failed after 2 rounds: api/);
  assert.equal(j.read().stopReason, "verifier failed after 2 rounds: api");
});

test("done --give-up fails the job, stores stopReason and puts it in the payload", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 4, verdict: null, history: [] } });
  writeFileSync(join(j.results, "verifier.json"), result(4, [{ check: "api", evidence: "e" }]));
  const dry = payloadOf(t.orca(["done", j.id, "--give-up", "needs an API key", "--dry-run", "--keep"]).stdout);
  assert.equal(dry.status, "failed");
  assert.equal(dry.verification.stopReason, "needs an API key");
  const r = t.orca(["done", j.id, "--give-up", "needs an API key", "--keep"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /failed .*: needs an API key/);
  const job = j.read();
  assert.equal(job.status, "failed");
  assert.equal(job.stopReason, "needs an API key");
  assert.equal(job.verifier.stopReason, "needs an API key");
  assert.notEqual(t.orca(["done", makeJob(t).id, "--give-up"]).status, 0);
});

test("job.baseCommit is recorded at run time and verify --base needs a checks file", () => {
  const t = scratch();
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "init"], { cwd: t.repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: t.repo, encoding: "utf8" }).trim();
  const id = t.orca(["new", "--kind", "pi", "--title", "b", "--goal", "g"]).stdout.trim();
  assert.equal(JSON.parse(readFileSync(join(t.repo, ".orca", "jobs", `${id}.json`), "utf8")).baseCommit, head);
  const wt = join(t.repo, "wt");
  mkdirSync(wt, { recursive: true });
  const path = join(t.repo, ".orca", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  job.worktree = wt;
  writeFileSync(path, JSON.stringify(job));
  const r = t.orca(["verify", id, "--base"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /verify --base needs a checks file/);
  writeFileSync(join(wt, "orca.verify.json"), JSON.stringify({ steps: [["open", "http://127.0.0.1:1/"], { visible: "h1" }] }));
  const dry = t.orca(["verify", id, "--base", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`base: ${head}`));
});

test("verify --base runs the checks on a temporary base worktree and writes verify-base.json", () => {
  const t = scratch();
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "init"], { cwd: t.repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: t.repo, encoding: "utf8" }).trim();
  const j = makeJob(t, { baseCommit: head });
  const wt = join(t.repo, "wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "orca.verify.json"), JSON.stringify({ steps: [["open", "http://127.0.0.1:1/"], { visible: "h1" }] }));
  const r = t.orca(["verify", j.id, "--base"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(readFileSync(join(j.results, "verify-base.json"), "utf8"));
  assert.equal(out.base, head);
  assert.deepEqual(out.steps.map((s) => [s.index, s.outcome]), [[1, "fail"], [2, "fail"]]); // the agent-browser stub never reports success
  assert.equal(out.failed, 2);
  assert.equal(existsSync(join(t.repo, ".orca", "worktrees")) ? readdirSync(join(t.repo, ".orca", "worktrees")).length : 0, 0);
  assert.equal(j.read().verify, undefined);
});

test("help drops the 3-round cap and documents max-rounds, strategy, give-up and --base", () => {
  const out = spawnSync(process.execPath, [ORCA, "help"], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(out, /Max 3 rounds|at most 3 rounds/);
  assert.match(out, /--max-rounds/);
  assert.match(out, /orca strategy <id>/);
  assert.match(out, /--give-up/);
  assert.match(out, /verify <id> \[--base\]/);
  assert.match(out, /"verification"/);
});

// Patch-id guard: a real worktree repo with a base commit, so orca can fingerprint the code.
function guardJob(t) {
  const wt = join(t.repo, "wt");
  mkdirSync(wt, { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: wt, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q");
  writeFileSync(join(wt, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").trim();
  const j = makeJob(t, { worktree: wt, baseCommit: base, verifier: { rounds: 1, verdict: null, history: [] } });
  writeFileSync(join(wt, "a.txt"), "two\n");
  writeFileSync(join(j.results, "verifier.json"), verdict(1, "pass"));
  return { ...j, wt };
}

test("a pass with no later edit is not stale and done reports verified", () => {
  const t = scratch();
  const j = guardJob(t);
  assert.match(t.orca(["status", j.id]).stdout, /verified by verifier: pass, round 1/);
  const v = j.read().verifier;
  assert.ok(v.patchId && v.head);
  assert.equal(v.stale, false);
  const r = t.orca(["done", j.id, "--keep"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified by verifier: pass, round 1/);
  assert.equal(j.read().status, "done");
});

for (const [label, edit] of [
  ["tracked dirty-tree edit", (wt) => writeFileSync(join(wt, "a.txt"), "three\n")],
  ["untracked file", (wt) => writeFileSync(join(wt, "new.txt"), "x\n")],
  ["commit", (wt) => { writeFileSync(join(wt, "a.txt"), "four\n"); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "c"], { cwd: wt }); }],
]) {
  test(`pass then ${label} is stale in status and done refuses`, () => {
    const t = scratch();
    const j = guardJob(t);
    t.orca(["status", j.id]);
    edit(j.wt);
    const st = t.orca(["status", j.id]);
    assert.match(st.stdout, /verifier: pass \(STALE, code changed since round 1\)/);
    assert.doesNotMatch(st.stdout, /verified by verifier/);
    const r = t.orca(["done", j.id, "--keep"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Re-run the verifier/);
    assert.doesNotMatch(r.stdout + r.stderr, /verified by verifier: pass/);
    assert.equal(j.read().status, "running");
  });
}

test("a stale pass can still be given up, and reverting the edit clears stale", () => {
  const t = scratch();
  const j = guardJob(t);
  t.orca(["status", j.id]);
  writeFileSync(join(j.wt, "new.txt"), "x\n");
  assert.match(t.orca(["status", j.id]).stdout, /STALE/);
  rmSync(join(j.wt, "new.txt"));
  assert.doesNotMatch(t.orca(["status", j.id]).stdout, /STALE/);
  writeFileSync(join(j.wt, "new.txt"), "x\n");
  const r = t.orca(["done", j.id, "--give-up", "out of time", "--keep"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(j.read().status, "failed");
});

test("an agent-supplied patchId is ignored and old results without one are not stale", () => {
  const t = scratch();
  const j = guardJob(t);
  writeFileSync(join(j.results, "verifier.json"), JSON.stringify({ round: 1, verdict: "pass", failures: [], patchId: "fake" }));
  t.orca(["status", j.id]);
  assert.notEqual(j.read().verifier.patchId, "fake");
  const t2 = scratch();
  const j2 = makeJob(t2, { verifier: { rounds: 1, verdict: null, history: [] } });
  writeFileSync(join(j2.results, "verifier.json"), verdict(1, "pass"));
  assert.match(t2.orca(["status", j2.id]).stdout, /verified by verifier: pass/);
});
