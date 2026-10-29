import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as doctor from "../lib/doctor.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

test("doctor checks: required CLIs fail with a fix and no install, optional ones warn; node version", () => {
  const have = new Set(["git", "herdr", "claude", "jq", "file", "identify"]);
  const got = doctor.cliChecks({ which: (c) => (have.has(c) ? `/usr/bin/${c}` : "") });
  const by = Object.fromEntries(got.map((c) => [c.name, c]));
  assert.equal(by.rg.status, "fail");
  assert.match(by.rg.fix, /^sudo apt install ripgrep\. orka does not install it$/);
  assert.equal(by.ImageMagick.status, "ok", "identify is enough");
  assert.equal(by["agent-browser"].status, "warn");
  assert.equal(doctor.nodeCheck({ nodeVersion: () => "v24.1.0" }).status, "ok");
  assert.match(doctor.nodeCheck({ nodeVersion: () => "v20.9.0" }).fix, /nvm install 22/);
  assert.equal(doctor.nodeCheck({ nodeVersion: () => "" }).status, "fail");
});

test("doctor checks: node_modules, ports, disk, memory, trust, chrome, summary and render", () => {
  const repo = mkdtempSync(join(tmpdir(), "orka-doc-"));
  assert.equal(doctor.depsCheck({ repo }).detail, "no package.json");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  assert.equal(doctor.depsCheck({ repo }).detail, "no dependencies in package.json");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { a: "1" } }));
  assert.equal(doctor.depsCheck({ repo }).status, "warn");
  const linked = doctor.depsCheck({ repo, worktree: "/wt", jobId: "j1", plan: [{ dir: "node_modules", action: "relink", reason: "link was broken" }] });
  assert.deepEqual([linked.status, linked.fix], ["fail", "orka doctor --job j1 --fix (relinks to the main checkout)"]);
  assert.equal(doctor.depsCheck({ repo, worktree: "/wt", plan: [{ dir: "node_modules", action: "ok" }] }).status, "ok");
  assert.deepEqual(doctor.portChecks([{ port: 3000, user: "node pid 12" }, { port: 3001, user: "" }]).map((c) => c.status), ["warn", "ok"]);
  assert.equal(doctor.diskCheck({ freeBytes: 1024 * 1048576, totalBytes: 100 * 1024 * 1048576 }).status, "fail");
  assert.equal(doctor.diskCheck({ freeBytes: 5 * 1024 * 1048576, totalBytes: 60 * 1024 * 1048576 }).status, "warn");
  assert.equal(doctor.memoryCheck(500, 1024).status, "warn");
  assert.equal(doctor.swapCheck(2048).status, "ok");
  assert.equal(doctor.swapCheck(null).status, "ok");
  const noSwap = doctor.swapCheck(0);
  assert.equal(noSwap.status, "warn");
  assert.match(noSwap.detail, /OOM killer/);
  assert.match(noSwap.fix, /needs sudo; orka never does it/);
  assert.deepEqual([doctor.tmpfsCheck(null).status, doctor.tmpfsCheck({ path: "/tmp", fstype: "ext4", usedBytes: 9e9 }).status], ["ok", "ok"]);
  assert.equal(doctor.tmpfsCheck({ path: "/tmp", fstype: "tmpfs", usedBytes: 500 * 1048576 }).status, "ok");
  const tmpfs = doctor.tmpfsCheck({ path: "/tmp", fstype: "tmpfs", usedBytes: 1300 * 1048576 });
  assert.deepEqual([tmpfs.status, tmpfs.detail], ["warn", "/tmp is a tmpfs (RAM) with 1300 MB in use"]);
  assert.match(tmpfs.fix, /orka cleanup --dry-run lists the Claude scratch folders/);
  const home = join(repo, "home.json");
  writeFileSync(home, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true }, "/other": {} } }));
  assert.equal(doctor.trustCheck({ repo, claudeJson: home }).status, "ok");
  const untrusted = doctor.trustCheck({ repo: "/other", claudeJson: home });
  assert.equal(untrusted.status, "fail");
  assert.match(untrusted.fix, /^once, by hand: cd \/other && claude, choose "Yes, I trust this folder", then \/exit\. orka never accepts the dialog for you$/);
  assert.equal(doctor.chromeCheck([41, 42]).status, "warn");
  const checks = [doctor.chromeCheck([]), untrusted, doctor.memoryCheck(500, 1024)];
  assert.deepEqual(doctor.summary(checks), { ok: false, failed: ["claude trust"], warnings: ["memory"] });
  assert.match(doctor.render(checks), /  ok    chrome: no orphan agent-browser Chrome\n  FAIL  claude trust: .*\n          fix: once, by hand/);
  assert.match(doctor.render(checks), /doctor: 1 failed: claude trust; warnings: memory$/);
  rmSync(repo, { recursive: true, force: true });
});

// A repo with a running job, a fake HOME (Claude trust file) and a herdr stub.
function scratch({ startFails = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "orka-doctor-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const home = join(base, "home");
  for (const d of [repo, bin, home, join(base, "run")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
case "$1 $2" in
  "agent start") ${startFails ? `echo '{"error":{"message":"agent start failed: status=Blocked"}}'; exit 1;;` : `echo '{"result":{}}';;`}
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  *) echo '{}';;
esac
`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: {} }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off" };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "d", "--goal", "g", "--no-gate"]).stdout.trim();
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const patch = (extra) => writeFileSync(path, JSON.stringify({ ...read(), ...extra }));
  patch({ status: "running", pane: "p-1", agent: "orch", worktree: join(repo, "wt") });
  const results = join(repo, ".orka", "jobs", id, "results");
  mkdirSync(results, { recursive: true });
  const decisions = () => readFileSync(join(repo, ".orka", "jobs", id, "decisions.tsv"), "utf8");
  return { repo, id, orka, read, patch, results, decisions };
}

test("orka doctor prints every check with its fix, exits 1 on a failure, and reports Claude trust for the repo", () => {
  const t = scratch();
  const r = t.orka(["doctor"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`^orka doctor ${t.repo}\\n`));
  assert.match(r.stdout, /  FAIL  claude trust: .* is not trusted by Claude Code/);
  assert.match(r.stdout, /  ok    herdr: /);
  // This host's own swap and temp folder: either verdict is fine, the lines must be there.
  assert.match(r.stdout, /  (ok  |warn)  swap: /);
  assert.match(r.stdout, /  (ok  |warn)  tmp: /);
  assert.match(r.stdout, /doctor: \d+ failed: .*claude trust/);
  const j = t.orka(["doctor", "--job", t.id]);
  assert.doesNotMatch(j.stdout, /claude trust/, "a pi job needs no Claude trust");
  assert.match(t.decisions(), /\tdoctor\torka doctor --job\t/);
  assert.ok(t.read().doctor.at);
  assert.match(t.orka(["doctor", "--fix"]).stderr, /--fix needs --job/);
});

const blocked = (round) => JSON.stringify({ name: "verifier", role: "verifier", round, verdict: "blocked", blocked: { reason: "agent-browser cannot start Chrome", evidence: "Error: spawn chrome ENOENT" }, checks: [], failures: [], warnings: [] });

test("a blocked verdict runs the doctor once, is not a code failure, and does not count as a round", () => {
  const t = scratch();
  t.patch({ maxRounds: 1, verifier: { rounds: 1, verdict: null, history: [] } });
  writeFileSync(join(t.results, "verifier.json"), blocked(1));
  const status = t.orka(["status", t.id]);
  assert.match(status.stdout, /verifier: blocked by the environment, round 1 \(not a code failure; see orka doctor\)/);
  const job = t.read();
  assert.deepEqual([job.verifier.verdict, job.doctor.verifierRound], ["blocked", 1]);
  assert.match(t.decisions(), /\tdoctor\tverifier round 1 blocked: agent-browser cannot start Chrome\t/);
  t.orka(["status", t.id]);
  assert.equal(t.decisions().match(/\tdoctor\t/g).length, 1, "once per blocked round");
  const digest = t.orka(["digest", t.id]).stdout;
  assert.match(digest, /verifier blocked \(environment, not code; do not route to builders\): agent-browser cannot start Chrome: Error: spawn chrome ENOENT/);
  assert.match(digest, /doctor \(verifier round 1 blocked: .*\): (ok|failed: )/);
  const done = t.orka(["done", t.id]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /not marked done\. verifier: blocked by the environment/);
  // --max-rounds 1 is not used up by a blocked round.
  const next = t.orka(["worker", "--job", t.id, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"]);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /role=verifier round=2/);
  assert.equal(t.orka(["done", t.id, "--give-up", "browser broken"]).status, 0);
});

test("a pane that does not start runs the doctor and says what it found", () => {
  const t = scratch({ startFails: true });
  const r = t.orka(["worker", "--job", t.id, "--name", "builder", "--task", "SCOPE: a ACCEPTANCE: b"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /orka doctor(: .* failed| found nothing wrong)/);
  assert.match(r.stderr, /worker start failed/);
  assert.match(t.decisions(), /\tdoctor\tworker builder did not start\t/);
});

test("doctor: hc and the deprecated herdr only warn when missing; herdr-core serve is checked without hc", () => {
  const by = Object.fromEntries(doctor.cliChecks({ which: () => "" }).map((c) => [c.name, c]));
  assert.equal(by.hc.status, "warn");
  assert.equal(by.herdr.status, "warn");
  assert.match(by.herdr.fix, /deprecated ORKA_BACKEND=herdr/);
  assert.equal(doctor.hcServeCheck({ socket: "/run/s.sock", socketExists: true, serving: true }).status, "ok");
  const down = doctor.hcServeCheck({ socket: "/run/s.sock", socketExists: false, serving: true });
  assert.equal(down.status, "warn");
  assert.match(down.detail, /no socket at \/run\/s\.sock/);
  assert.match(down.fix, /hc server start; orka never starts it/);
  assert.match(doctor.hcServeCheck({ socket: "/run/s.sock", socketExists: true, serving: false }).detail, /no herdr-core serve process/);
});
