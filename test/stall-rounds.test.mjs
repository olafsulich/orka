import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// herdr and claude are stubs on PATH; herdr logs its arguments, so the verifier prompt can be read back.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-stall-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
echo "herdr $*" >> "${log}"
case "$1 $2" in
  "workspace create") rm -f "${base}/prompted" "${base}"/seen-*; echo '{"result":{"root_pane":{"pane_id":"p-root"}}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  "agent list") echo '{"result":{"agents":[]}}';;
  "agent get")
    if [ ! -e "${base}/prompted" ]; then
      if [ ! -e "${base}/seen-$3" ]; then touch "${base}/seen-$3"; echo '{"error":{"code":"agent_not_found","message":"no"}}'; exit 1; fi
      echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true,"pane_id":"p-split"}}}'; exit 0
    fi
    echo '{"result":{"agent":{"agent_status":"working","pane_id":"p-split"}}}';;
  "agent prompt") touch "${base}/prompted"; echo '{"result":{}}';;
  *) echo '{"result":{}}';;
esac
`,
  );
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet' or 'opus') or full name."\necho "  -h, --help        help"\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off" };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  return { repo, log, orka };
}

// A running claude job. orka status folds results/verifier.json into job.verifier.
function makeJob(t, ...flags) {
  const r = t.orka(["new", "--kind", "claude", "--title", "st", "--goal", "g", "--no-gate", ...flags]);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const results = join(t.repo, ".orka", "jobs", id, "results");
  mkdirSync(results, { recursive: true });
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const write = (patch) => writeFileSync(path, JSON.stringify({ ...read(), ...patch }));
  write({ status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") });
  return { id, read, write, results };
}

const result = (round, verdict, checks) =>
  JSON.stringify({ name: "verifier", role: "verifier", round, verdict, checks: [], failures: checks.map((check) => ({ check, evidence: "e" })), summary: "s" });

// Fixture in the shape of a diagram-framework verifier.history (round, verdict, failing, warnings, at):
// five fail rounds whose failing check names never repeat.
const FIVE_FAILS = [
  ["check-all-sound-rules"],
  ["scene-diagram-correctness"],
  ["review-fix-2-scene5-return-path-accent"],
  ["v3-framing-punch-ins", "v3-dot-stills"],
  ["review-fix-1-centring-and-slicing"],
].map((failing, i) => ({ round: i + 1, verdict: "fail", failing, warnings: ["orca-verify"], at: `2026-10-17T10:${10 + i}:00.000Z` }));

// Feeds rounds 1..n through orka status (one round at a time) and returns the stall seen after each round.
function stallsPerRound(t, job, rounds) {
  const out = [];
  for (const h of rounds) {
    const state = job.read().verifier || { history: [] };
    job.write({ verifier: { ...state, rounds: h.round, verdict: null, history: state.history.filter((x) => x.round < h.round) } });
    writeFileSync(join(job.results, "verifier.json"), result(h.round, h.verdict, h.failing));
    t.orka(["status", job.id]);
    out.push(job.read().verifier.stall);
  }
  return out;
}

test("fixture: five fail rounds share no check name, so the shared-check rule alone never fires", () => {
  for (let i = 1; i < FIVE_FAILS.length; i++) {
    const prev = new Set(FIVE_FAILS[i - 1].failing);
    assert.deepEqual(FIVE_FAILS[i].failing.filter((c) => prev.has(c)), [], `rounds ${i} and ${i + 1}`);
  }
});

test("default: consecutive fail rounds with disjoint checks stall by round 3 (kind rounds) and stay stalled through round 5", () => {
  const t = scratch();
  const job = makeJob(t);
  const s = stallsPerRound(t, job, FIVE_FAILS);
  assert.equal(s[0], null);
  assert.equal(s[1], null, "two rounds with no shared check is no stall");
  assert.deepEqual(s[2], { kind: "rounds", checks: ["check-all-sound-rules", "scene-diagram-correctness", "review-fix-2-scene5-return-path-accent"], rounds: [1, 2, 3] });
  assert.deepEqual(s[3], { kind: "rounds", checks: ["scene-diagram-correctness", "review-fix-2-scene5-return-path-accent", "v3-framing-punch-ins", "v3-dot-stills"], rounds: [2, 3, 4] });
  assert.equal(s[4].kind, "rounds");
  assert.deepEqual(s[4].rounds, [3, 4, 5]);
  assert.deepEqual(s[4].checks, ["review-fix-2-scene5-return-path-accent", "v3-framing-punch-ins", "v3-dot-stills", "review-fix-1-centring-and-slicing"]);
  const out = t.orka(["status", job.id]).stdout;
  assert.match(out, /stall: rounds 3-5 all failed \(.*v3-dot-stills.*\).*class sweep/);
  assert.match(out, /orka strategy /);
});

test("a shared check still stalls at round 2 with kind checks and the old checks/rounds fields", () => {
  const t = scratch();
  const job = makeJob(t);
  const s = stallsPerRound(t, job, [
    { round: 1, verdict: "fail", failing: ["scrub", "lint"] },
    { round: 2, verdict: "fail", failing: ["scrub"] },
  ]);
  assert.equal(s[0], null);
  assert.deepEqual(s[1], { kind: "checks", checks: ["scrub"], rounds: [1, 2] });
  assert.match(t.orka(["status", job.id]).stdout, /stall: scrub failed in rounds 1 and 2; change strategy/);
});

test("kind checks wins when the shared check also spans K fail rounds", () => {
  const t = scratch();
  const job = makeJob(t);
  const s = stallsPerRound(t, job, [1, 2, 3].map((round) => ({ round, verdict: "fail", failing: ["scrub"] })));
  assert.deepEqual(s[2], { kind: "checks", checks: ["scrub"], rounds: [2, 3] });
});

test("--stall-after 4 is stored on the job and delays the rounds stall to round 4", () => {
  const t = scratch();
  const job = makeJob(t, "--stall-after", "4");
  assert.equal(job.read().stallAfter, 4);
  const s = stallsPerRound(t, job, FIVE_FAILS);
  assert.deepEqual(s.slice(0, 3), [null, null, null]);
  assert.equal(s[3].kind, "rounds");
  assert.deepEqual(s[3].rounds, [1, 2, 3, 4]);
  assert.deepEqual(s[4].rounds, [2, 3, 4, 5]);
});

test("a pass round resets the consecutive-fail count", () => {
  const t = scratch();
  const job = makeJob(t);
  const f = (round, check) => ({ round, verdict: "fail", failing: [check] });
  const s = stallsPerRound(t, job, [f(1, "a"), f(2, "b"), { round: 3, verdict: "pass", failing: [] }, f(4, "c"), f(5, "d"), f(6, "e")]);
  assert.deepEqual(s.slice(0, 5), [null, null, null, null, null]);
  assert.deepEqual(s[5].rounds, [4, 5, 6], "the count restarts after the pass");
});

test("--stall-after needs an integer >= 2", () => {
  const t = scratch();
  for (const bad of ["1", "0", "-3", "x", "2.5"]) {
    const r = t.orka(["new", "--kind", "claude", "--title", "bad", "--goal", "g", "--stall-after", bad]);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /--stall-after needs an integer >= 2/);
  }
  assert.notEqual(t.orka(["new", "--kind", "claude", "--title", "bad", "--goal", "g", "--stall-after"]).status, 0);
  assert.equal(t.orka(["new", "--kind", "claude", "--title", "ok", "--goal", "g", "--stall-after", "2"]).status, 0);
});

// The verifier prompt herdr received when round 4 starts, after rounds 1-3 are recorded from history and the result file.
function verifierPrompt(thirdVerdict, thirdChecks) {
  const t = scratch();
  const job = makeJob(t);
  const history = FIVE_FAILS.slice(0, 2).map(({ round, verdict, failing, warnings, at }) => ({ round, verdict, failing, warnings, at }));
  job.write({ verifier: { rounds: 3, verdict: null, history } });
  writeFileSync(join(job.results, "verifier.json"), result(3, thirdVerdict, thirdChecks));
  const r = t.orka(["worker", "--job", job.id, "--name", "verifier", "--role", "verifier", "--task", "t"]);
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(t.log, "utf8");
  return log.slice(log.indexOf("herdr agent prompt"));
}

test("the verifier prompt asks for a class sweep only when stall.kind is rounds", () => {
  const stalled = verifierPrompt("fail", ["review-fix-2-scene5-return-path-accent"]);
  assert.match(stalled, /Class sweep/);
  assert.match(stalled, /List every instance of the failing class/);
  const clear = verifierPrompt("pass", []);
  assert.match(clear, /Evidence standard/, "the prompt was captured");
  assert.doesNotMatch(clear, /Class sweep|every instance of the failing class/);
});

test("the verifier prompt has no class sweep for a kind checks stall", () => {
  const t = scratch();
  const job = makeJob(t);
  job.write({ verifier: { rounds: 2, verdict: null, history: [{ round: 1, verdict: "fail", failing: ["scrub"], warnings: [] }] } });
  writeFileSync(join(job.results, "verifier.json"), result(2, "fail", ["scrub"]));
  assert.equal(t.orka(["worker", "--job", job.id, "--name", "verifier", "--role", "verifier", "--task", "t"]).status, 0);
  const log = readFileSync(t.log, "utf8");
  const prompt = log.slice(log.indexOf("herdr agent prompt"));
  assert.match(prompt, /Evidence standard/, "the prompt was captured");
  assert.doesNotMatch(prompt, /Class sweep/);
});

test("FEATURE_FLOW tells the orchestrator how to react to both stall kinds", () => {
  const src = readFileSync(ORKA, "utf8");
  const line = src.split("\n").find((l) => l.includes("after each verifier round. If it reports a stall"));
  assert.ok(line, "stall line present");
  assert.match(line, /kind "checks" \(the same check failing two rounds in a row\)/);
  assert.match(line, /kind "rounds" \(.*consecutive fail rounds, --stall-after/);
  assert.match(line, /class sweep/);
  assert.match(src, /orka strategy \$\{job\.id\} --premise "/, "change-strategy instruction still follows");
});
