import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// herdr and claude are stubs on PATH. herdr logs its arguments and reports a working agent.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-vmodel-"));
  process.on("exit", () => rmScratch(base, { recursive: true, force: true }));
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
      # The first get is the free-name check (not found); once the agent exists it is idle and ready.
      if [ ! -e "${base}/seen-$3" ]; then touch "${base}/seen-$3"; echo '{"error":{"code":"agent_not_found","message":"no"}}'; exit 1; fi
      echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true,"pane_id":"p-split"}}}'; exit 0
    fi
    echo '{"result":{"agent":{"agent_status":"working","pane_id":"p-split"}}}';;
  "agent prompt") touch "${base}/prompted"; echo '{"result":{}}';;
  *) echo '{"result":{}}';;
esac
`,
  );
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
echo "Options:"
echo "  --model <model>   Model alias (e.g. 'sonnet' or 'opus') or full name."
echo "  -h, --help        help"
`,
  );
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off" };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  const config = (patch) => {
    const path = join(repo, ".orka", "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
  };
  const jobFile = (id) => join(repo, ".orka", "jobs", `${id}.json`);
  const read = (id) => JSON.parse(readFileSync(jobFile(id), "utf8"));
  const mk = (...extra) => orka(["new", "--kind", "claude", "--title", "vm", "--goal", "g", "--no-gate", ...extra]);
  return { repo, log, orka, config, read, jobFile, mk, calls: () => readFileSync(log, "utf8") };
}

function running(t, id) {
  const job = t.read(id);
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") });
  writeFileSync(t.jobFile(id), JSON.stringify(job));
}

test("default verifier model is the job-type default (haiku for cli), not the worker model", () => {
  const t = scratch();
  const id = t.mk("--worker-model", "opus").stdout.trim();
  assert.equal(t.read(id).verifierModel, "haiku");
  const dry = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"]);
  assert.match(dry.stdout, /model=haiku role=verifier/);
  assert.match(dry.stdout, /pane: claude --model haiku/);
});

test("--verifier-model is stored; verifier pane uses it, builders keep workerModel", () => {
  const t = scratch();
  const id = t.mk("--verifier-model", "claude-haiku-5-5").stdout.trim();
  assert.equal(t.read(id).verifierModel, "claude-haiku-5-5");
  assert.equal(t.read(id).workerModel, "sonnet");
  const v = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", "t", "--dry-run"]);
  assert.match(v.stdout, /pane: claude --model claude-haiku-5-5/);
  const b = t.orka(["worker", "--job", id, "--name", "api", "--task", "t", "--dry-run"]);
  assert.match(b.stdout, /pane: claude --model sonnet/);
  const o = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--model", "opus", "--task", "t", "--dry-run"]);
  assert.match(o.stdout, /pane: claude --model opus/, "explicit worker --model wins");
});

test("haiku alias is accepted; an unknown alias is still rejected", () => {
  const t = scratch();
  const id = t.mk("--verifier-model", "haiku").stdout.trim();
  assert.equal(t.read(id).verifierModel, "haiku");
  assert.equal(t.mk("--worker-model", "haiku").status, 0);
  const bad = t.orka(["new", "--kind", "claude", "--title", "bad", "--goal", "g", "--no-gate", "--verifier-model", "nope"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown model alias "nope" for verifier/);
  assert.match(bad.stderr, /haiku/);
  const pi = t.orka(["new", "--kind", "pi", "--title", "p", "--goal", "g", "--no-gate", "--verifier-model", "haiku"]);
  assert.notEqual(pi.status, 0);
});

test("repo config verifierModel is the default; the flag beats it", () => {
  const t = scratch();
  t.config({ verifierModel: "haiku" });
  const a = t.mk().stdout.trim();
  assert.equal(t.read(a).verifierModel, "haiku");
  assert.equal(t.read(a).workerModel, "sonnet");
  const b = t.orka(["new", "--kind", "claude", "--title", "vm2", "--goal", "g", "--no-gate", "--verifier-model", "opus"]).stdout.trim();
  assert.equal(t.read(b).verifierModel, "opus");
  t.config({ verifierModel: "nope" });
  assert.notEqual(t.mk().status, 0, "an invalid configured alias is rejected");
});

test("status and run --dry-run show the verifier model", () => {
  const t = scratch();
  const id = t.mk("--verifier-model", "haiku").stdout.trim();
  assert.match(t.orka(["status", id]).stdout, /worker=sonnet verifier=haiku/);
  const dry = t.orka(["run", id, "--dry-run"]).stdout;
  assert.match(dry, /models: orchestrator=opus worker=sonnet verifier=haiku/);
  assert.match(dry, /verifier-pane: claude --model haiku/);
});

test("run --verifier-model replaces it; a stored default does not follow a new worker model", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  assert.equal(t.read(id).verifierModel, "haiku");
  const r = t.orka(["run", id, "--worker-model", "opus"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.read(id).verifierModel, "haiku");
  const id2 = t.orka(["new", "--kind", "claude", "--title", "vm3", "--goal", "g", "--no-gate"]).stdout.trim();
  assert.equal(t.orka(["run", id2, "--verifier-model", "opus"]).status, 0);
  assert.equal(t.read(id2).verifierModel, "opus");
});

test("orchestrator prompt names the verifier model", () => {
  const t = scratch();
  const id = t.mk("--verifier-model", "haiku").stdout.trim();
  const r = t.orka(["run", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.calls(), /verifier \(--role verifier\) uses the job's verifier model, verifier=haiku \(--verifier-model\)/);
});

test("verifier prompt carries the evidence standard", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  running(t, id);
  const r = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--pane", "p-9", "--task", "check it"]);
  assert.equal(r.status, 0, r.stderr);
  const log = t.calls();
  assert.match(log, /Test the real user path/);
  assert.match(log, /Check side effects \(files written, network calls, state changed\), not just the exit code/);
  assert.match(log, /Suspect the observation method first/);
  assert.match(log, /Save proof under .*results\/ \(screenshots, command output\)/);
  assert.match(log, /"Inconclusive" or "could not test" is a fail, not a pass/);
});

test("orchestrator prompt requires the structured worker brief", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  const r = t.orka(["run", id]);
  assert.equal(r.status, 0, r.stderr);
  const log = t.calls();
  assert.match(log, /GOAL \/ SCOPE \(files it owns\) \/ CONTEXT \(file pointers, not pasted text\) \/ ACCEPTANCE \/ VERIFY \/ TIMEBOX \/ FORBIDDEN \/ REPORT/);
  assert.match(log, /collapses to GOAL \+ ACCEPTANCE/);
  assert.match(log, /Build the verifier --task from the builders' ACCEPTANCE lines/);
});

test("worker prompt footer covers a missing SCOPE or ACCEPTANCE", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  running(t, id);
  const r = t.orka(["worker", "--job", id, "--name", "w1", "--pane", "p-9", "--task", "do it"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.calls(), /If SCOPE or ACCEPTANCE is missing from the task above, do the narrowest reading of it and say so in the result/);
});

test("cmdWorker warns, without failing, when a builder task lacks SCOPE: or ACCEPTANCE:", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  running(t, id);
  const bare = t.orka(["worker", "--job", id, "--name", "w1", "--task", "do it", "--dry-run"]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stderr, /warning: worker task has no SCOPE: or ACCEPTANCE:/);
  const partial = t.orka(["worker", "--job", id, "--name", "w2", "--task", "GOAL: x\nSCOPE: a.js", "--dry-run"]);
  assert.match(partial.stderr, /no ACCEPTANCE:/);
  const full = t.orka(["worker", "--job", id, "--name", "w3", "--task", "GOAL: x\nSCOPE: a.js\nACCEPTANCE: y", "--dry-run"]);
  assert.equal(full.stderr, "");
  const verifier = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", "check", "--dry-run"]);
  assert.equal(verifier.stderr, "");
});
