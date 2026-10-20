import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// herdr and claude are stubs on PATH; ORKA_NO_WATCH keeps the run from spawning a watcher.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-vdefault-"));
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
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1" };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  const config = (patch) => {
    const path = join(repo, ".orka", "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
  };
  const read = (id) => JSON.parse(readFileSync(join(repo, ".orka", "jobs", `${id}.json`), "utf8"));
  const mk = (goal, ...extra) => orka(["new", "--kind", "claude", "--title", "vd", "--goal", goal, ...extra]);
  const write = (name, data) => writeFileSync(join(repo, name), typeof data === "string" ? data : JSON.stringify(data));
  return { repo, orka, config, read, mk, write, calls: () => readFileSync(log, "utf8") };
}

test("a CLI job with no flags or config gets haiku and says why", () => {
  const t = scratch();
  const id = t.mk("add a flag").stdout.trim();
  const job = t.read(id);
  assert.equal(job.verifierModel, "haiku");
  assert.equal(job.jobType, "cli");
  assert.equal(job.verifierSource, "default: cli job");
});

test("--ui gives a ui job with sonnet", () => {
  const t = scratch();
  const job = t.read(t.mk("add a flag", "--ui").stdout.trim());
  assert.equal(job.verifierModel, "sonnet");
  assert.equal(job.jobType, "ui");
  assert.equal(job.jobTypeReason, "--ui flag");
  assert.equal(job.verifierSource, "default: ui job, --ui flag");
});

test("browser steps in orka.verify.json make a ui job; non-browser checks do not", () => {
  const t = scratch();
  t.write("orka.verify.json", { steps: [["open", "http://127.0.0.1:${ORKA_PORT}/"], { visible: "h1" }] });
  const ui = t.read(t.mk("g").stdout.trim());
  assert.equal(ui.jobType, "ui");
  assert.equal(ui.verifierModel, "sonnet");
  assert.equal(ui.verifierSource, "default: ui job, orka.verify.json has browser steps");
  t.write("orka.verify.json", { steps: [] });
  assert.equal(t.read(t.mk("g").stdout.trim()).jobType, "cli");
  t.write("orka.verify.json", "#!/bin/sh\nopen http://x\n");
  assert.equal(t.read(t.mk("g").stdout.trim()).jobType, "cli", "a script checks file is not browser steps");
});

test("the config verify path with browser steps makes a ui job", () => {
  const t = scratch();
  mkdirSync(join(t.repo, "checks"));
  t.write("checks/ui.json", { steps: [{ open: "http://127.0.0.1:1/" }] });
  t.config({ verify: "checks/ui.json" });
  const job = t.read(t.mk("g").stdout.trim());
  assert.equal(job.jobType, "ui");
  assert.equal(job.jobTypeReason, "checks/ui.json has browser steps");
});

test("a goal that asks for agent-browser or UI verification makes a ui job", () => {
  const t = scratch();
  assert.equal(t.read(t.mk("Fix it and verify with agent-browser").stdout.trim()).jobType, "ui");
  const job = t.read(t.mk("ACCEPTANCE: UI verification of the login page").stdout.trim());
  assert.equal(job.jobType, "ui");
  assert.equal(job.jobTypeReason, "goal asks for browser/UI verification");
  assert.equal(t.read(t.mk("rename the build step").stdout.trim()).jobType, "cli");
});

test("precedence: config beats the type default, the flag beats config, worker --model beats both", () => {
  const t = scratch();
  t.config({ verifierModel: "opus" });
  const a = t.mk("g").stdout.trim();
  assert.equal(t.read(a).verifierModel, "opus");
  assert.equal(t.read(a).verifierSource, "config verifierModel");
  const b = t.mk("g", "--verifier-model", "claude-haiku-5-5").stdout.trim();
  assert.equal(t.read(b).verifierModel, "claude-haiku-5-5");
  assert.equal(t.read(b).verifierSource, "--verifier-model");
  const dry = t.orka(["worker", "--job", b, "--name", "verifier", "--role", "verifier", "--model", "sonnet", "--task", "t", "--dry-run"]);
  assert.match(dry.stdout, /pane: claude --model sonnet/);
  const plain = t.orka(["worker", "--job", b, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"]);
  assert.match(plain.stdout, /pane: claude --model claude-haiku-5-5/);
  t.config({ verifierModel: "haiku" });
  assert.equal(t.read(t.mk("g", "--ui").stdout.trim()).verifierModel, "haiku", "config beats the ui default");
});

test("haiku alias validation is kept", () => {
  const t = scratch();
  const bad = t.mk("g", "--verifier-model", "nope");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown model alias "nope" for verifier/);
});

test("run --ui flips a queued cli job to ui; a stored default is not changed by run otherwise", () => {
  const t = scratch();
  const id = t.mk("g").stdout.trim();
  assert.equal(t.read(id).verifierModel, "haiku");
  assert.equal(t.orka(["run", id, "--worker-model", "opus", "--dry-run"]).status, 0);
  const r = t.orka(["run", id, "--ui"]);
  assert.equal(r.status, 0, r.stderr);
  const job = t.read(id);
  assert.equal(job.jobType, "ui");
  assert.equal(job.verifierModel, "sonnet");
});

test("status, dry-run and the orchestrator prompt show model and source", () => {
  const t = scratch();
  const cli = t.mk("g").stdout.trim();
  assert.match(t.orka(["status", cli]).stdout, /verifier=haiku \(default: cli job\)/);
  assert.match(t.orka(["run", cli, "--dry-run"]).stdout, /models: orchestrator=opus worker=sonnet verifier=haiku \(default: cli job\)/);
  t.write("orka.verify.json", { steps: [["open", "http://x/"]] });
  const ui = t.mk("g").stdout.trim();
  assert.match(t.orka(["status", ui]).stdout, /verifier=sonnet \(default: ui job, orka.verify.json has browser steps\)/);
  assert.match(t.orka(["run", ui, "--dry-run"]).stdout, /verifier=sonnet \(default: ui job, orka.verify.json has browser steps\)/);
  const ov = t.mk("g", "--verifier-model", "opus").stdout.trim();
  assert.match(t.orka(["status", ov]).stdout, /verifier=opus \(--verifier-model\)/);
  const r = t.orka(["run", ov]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.calls(), /verifier model, verifier=opus \(--verifier-model\)/);
});

test("run keeps an explicit --verifier-model from new, even with --ui; a new flag on run overrides", () => {
  const t = scratch();
  const id = t.mk("add a flag", "--verifier-model", "opus").stdout.trim();
  const plain = t.orka(["run", id, "--dry-run"]).stdout;
  assert.match(plain, /verifier=opus \(--verifier-model\)/);
  const ui = t.orka(["run", id, "--ui", "--dry-run"]).stdout;
  assert.match(ui, /verifier=opus \(--verifier-model\)/);
  const over = t.orka(["run", id, "--verifier-model", "haiku", "--dry-run"]).stdout;
  assert.match(over, /verifier=haiku \(--verifier-model\)/);
});

test("run re-detects the job type from orka.verify.json at the repo root", () => {
  const t = scratch();
  const id = t.mk("add a flag").stdout.trim();
  assert.equal(t.read(id).jobType, "cli");
  t.write("orka.verify.json", { steps: [["open", "http://localhost:38892/"]] });
  const out = t.orka(["run", id, "--dry-run"]).stdout;
  assert.match(out, /verifier=sonnet \(default: ui job, orka\.verify\.json has browser steps\)/);
});
