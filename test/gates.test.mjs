import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectGates, gateLimits, runGate, singleCommand } from "../lib/gates.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

function dir(files = {}) {
  const d = mkdtempSync(join(tmpdir(), "orka-gates-"));
  process.on("exit", () => rmSync(d, { recursive: true, force: true }));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), typeof body === "string" ? body : JSON.stringify(body));
  return d;
}

test("detectGates: package.json scripts in a fixed order, oxlint/oxfmt names included, the npm placeholder skipped", () => {
  const d = dir({ "package.json": { scripts: { test: "node --test", lint: "oxlint", "format:check": "oxfmt --check", check: "oxlint && oxfmt --check", typecheck: "tsc --noEmit", build: "vite build" } } });
  assert.deepEqual(detectGates(d).gates.map((g) => g.command), ["npm run typecheck", "npm run lint", "npm run format:check", "npm run check", "npm test"]);
  const p = dir({ "package.json": { scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }, "pnpm-lock.yaml": "" });
  assert.deepEqual(detectGates(p).gates, [{ name: "lint", command: "pnpm run lint" }]);
  assert.equal(detectGates(dir()).source, "none");
  assert.match(detectGates(dir({ "package.json": { scripts: { build: "x" } } })).reason, /has none of: typecheck/);
});

test("detectGates: \"gates\" in .orka/config.json overrides detection; false turns gates off", () => {
  const d = dir({ "package.json": { scripts: { test: "node --test" } } });
  assert.deepEqual(detectGates(d, { gates: ["npm run lint -- --max-warnings 0", "make check"] }).gates, [
    { name: "npm-run-lint-max-warnings-0", command: "npm run lint -- --max-warnings 0" },
    { name: "make-check", command: "make check" },
  ]);
  assert.deepEqual(detectGates(d, { gates: false }), { gates: [], source: "off", reason: '"gates": false in .orka/config.json' });
  assert.deepEqual(gateLimits({}), { timeoutMs: 600000, budgetMs: 1200000 });
  assert.deepEqual(gateLimits({ gateTimeout: "30s", gateBudget: "2m" }), { timeoutMs: 30000, budgetMs: 120000 });
});

test("singleCommand: one backticked command is the whole acceptance; anything else is not", () => {
  assert.equal(singleCommand("GOAL: x\nACCEPTANCE: `npm test -- dark` passes\nREPORT: y"), "npm test -- dark");
  assert.equal(singleCommand("ACCEPTANCE:\n- `node check.mjs`\n"), "node check.mjs");
  assert.equal(singleCommand("ACCEPTANCE: `a` and `b`"), null);
  assert.equal(singleCommand("ACCEPTANCE: the toggle works\n- `npm test`"), null);
  assert.equal(singleCommand("ACCEPTANCE: the toggle works"), null);
  assert.equal(singleCommand("no sections"), null);
});

const alive = (marker) => spawnSync("pgrep", ["-f", marker]).status === 0;

test("runGate: exit code and output tail; a timeout and stray children leave no process behind", () => {
  const d = dir();
  const ok = runGate("echo one; echo two", d, { logPath: join(d, "ok.log") });
  assert.deepEqual([ok.exit, ok.timedOut, ok.tail], [0, false, "one\ntwo"]);
  const bad = runGate("echo boom >&2; exit 3", d, { logPath: join(d, "bad.log") });
  assert.deepEqual([bad.exit, bad.tail], [3, "boom"]);
  const slow = runGate("sleep 31.7", d, { timeoutMs: 1000, logPath: join(d, "slow.log") });
  assert.equal(slow.timedOut, true);
  assert.ok(slow.ms < 10000);
  assert.equal(alive("sleep 31.7"), false);
  const stray = runGate("(sleep 31.8 &) ; exit 0", d, { logPath: join(d, "stray.log") });
  assert.equal(stray.exit, 0);
  assert.equal(alive("sleep 31.8"), false, "a child the gate left running is killed with its group");
});

// A real repo (base commit + linked worktree on the job branch) with a herdr stub that starts agents.
function scratch({ pkg = { scripts: { test: "node -e \"process.exit(require('fs').existsSync('broken') ? 1 : 0)\"" } }, baseFiles = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "orka-gates-cli-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
echo "herdr $*" >> "${log}"
case "$1 $2" in
  "agent start") echo "$3" >> "${base}/agents"; echo '{"result":{}}';;
  "agent get") if ! grep -qx "$3" "${base}/agents" 2>/dev/null; then echo '{"error":{"message":"not found"}}'; exit 1; fi
    if [ -e "${base}/prompted-$3" ]; then echo '{"result":{"agent":{"agent_status":"working","interactive_ready":true}}}'; else echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true}}}'; fi;;
  "agent prompt") touch "${base}/prompted-$3"; echo '{"result":{}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  *) echo '{}';;
esac
`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  const g = (args, cwd = repo) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  g(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
  for (const [f, body] of Object.entries(baseFiles)) writeFileSync(join(repo, f), body);
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_PROMPT_POLL_MS: "50" };
  const orka = (args) => spawnSync("timeout", ["120", process.execPath, ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "g", "--goal", "g", "--no-gate"]).stdout.trim();
  const wt = join(repo, ".orka", "worktrees", id);
  g(["worktree", "add", "-q", "-b", `orka/${id}`, wt, "HEAD"]);
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const patch = (extra) => writeFileSync(path, JSON.stringify({ ...read(), ...extra }));
  patch({ status: "running", pane: "p-1", agent: "orch", worktree: wt, baseCommit: g(["rev-parse", "HEAD"]) });
  const starts = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("herdr agent start verifier")).length;
  const verifier = (task = "GOAL: check it\nACCEPTANCE: the toggle works") => orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", task]);
  const decisions = () => readFileSync(join(repo, ".orka", "jobs", id, "decisions.tsv"), "utf8");
  return { repo, wt, id, orka, read, patch, starts, verifier, decisions };
}

test("a red gate starts no verifier; after the fix the gates pass and the verifier starts", () => {
  const t = scratch();
  writeFileSync(join(t.wt, "broken"), "x");
  const r = t.verifier();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate test: fail \(exit 1/);
  assert.match(r.stderr, /gates round 1: FAIL; no verifier started\.\n--- test: `npm test` exit 1; log .*round-1\/test\.log/);
  assert.match(r.stderr, /Route each failing gate with this output to the builder/);
  assert.equal(t.starts(), 0, "no verifier pane");
  let job = t.read();
  assert.deepEqual([job.gates.rounds, job.gates.verdict, job.gates.history[0].failing], [1, "fail", ["test"]]);
  assert.equal(job.verifier?.rounds || 0, 0, "gate rounds are not verifier rounds");
  assert.match(t.decisions(), /\tgate\tgate round 1: fail\tblocking: test exit 1\t.*\tno verifier started/);
  const digest = t.orka(["digest", t.id]).stdout;
  assert.match(digest, /gates: round 1 fail blocking=test; no verifier started, route to the owning builder/);
  assert.match(digest, /gate test: `npm test` exit 1: /);
  assert.ok(existsSync(join(t.repo, ".orka", "jobs", t.id, "results", "gates", "round-1.json")));
  rmSync(join(t.wt, "broken"));
  const ok = t.verifier();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /gate test: pass/);
  assert.equal(t.starts(), 1);
  job = t.read();
  assert.deepEqual([job.gates.rounds, job.gates.verdict, job.verifier.rounds], [2, "pass", 1]);
  assert.match(t.orka(["status", t.id]).stdout, /gates: round 2 pass/);
});

test("a gate that also fails on the base commit is a warning, proved once per (base, command)", () => {
  const t = scratch({ baseFiles: { broken: "x" } });
  const r = t.verifier();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /gate test: preexisting \(exit 1.*\); fails on base [0-9a-f]{8} too \(warning\)/);
  assert.equal(t.starts(), 1);
  assert.deepEqual(t.read().gates.history[0].warnings, ["test"]);
  const cache = JSON.parse(readFileSync(join(t.repo, ".orka", "gates-base.json"), "utf8"));
  assert.equal(Object.values(cache)[0].exit, 1);
  const summary = JSON.parse(readFileSync(join(t.repo, ".orka", "jobs", t.id, "results", "gates", "round-1.json"), "utf8"));
  assert.equal(summary.results[0].base.cached, undefined);
  assert.equal(spawnSync("git", ["worktree", "list"], { cwd: t.repo, encoding: "utf8" }).stdout.includes("gate-base"), false, "the base worktree is removed");
});

test("single-command acceptance that passes after green gates records a pass by gate and starts no verifier", () => {
  const t = scratch();
  const r = t.verifier("GOAL: x\nACCEPTANCE: `node -e \"process.exit(0)\"` passes");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verifier round 1: pass by gate \(acceptance `node -e "process\.exit\(0\)"`\); no verifier pane started/);
  assert.equal(t.starts(), 0);
  const job = t.read();
  assert.deepEqual([job.verifier.rounds, job.verifier.verdict, job.verifier.history[0].by], [1, "pass", "gate"]);
  const result = JSON.parse(readFileSync(join(t.repo, ".orka", "jobs", t.id, "results", "verifier.json"), "utf8"));
  assert.deepEqual([result.by, result.verdict, result.round], ["gate", "pass", 1]);
  assert.match(t.orka(["status", t.id]).stdout, /verified by gate: pass, round 1/);
  assert.match(t.decisions(), /\tgate\tverifier round 1: pass by gate\t/);
  const fail = t.orka(["worker", "--job", t.id, "--name", "verifier", "--role", "verifier", "--task", "x", "--accept", "exit 4"]);
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /acceptance `exit 4`: fail \(exit 4\)/);
  assert.equal(t.starts(), 0);
});

test("a UI job always gets the verifier, even with a single acceptance command", () => {
  const t = scratch();
  t.patch({ jobType: "ui" });
  const dry = t.orka(["worker", "--job", t.id, "--name", "verifier", "--role", "verifier", "--task", "ACCEPTANCE: `npm test`", "--dry-run"]);
  assert.match(dry.stdout, /gates: npm test \(package\.json scripts: test\)\nacceptance by gate: no \(UI job: always verified\)/);
  const r = t.verifier("ACCEPTANCE: `npm test`");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.starts(), 1);
});

test("\"gates\": false starts the verifier with no gate round", () => {
  const t = scratch();
  writeFileSync(join(t.wt, "broken"), "x");
  const cfg = join(t.repo, ".orka", "config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), gates: false }));
  const r = t.verifier();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /gates: none \("gates": false/);
  assert.equal(t.starts(), 1);
  assert.equal(t.read().gates, undefined);
});
