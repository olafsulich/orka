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
  const base = mkdtempSync(join(tmpdir(), "orka-rfirst-"));
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_BACKEND: "herdr", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off" };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  const config = (patch) => {
    const path = join(repo, ".orka", "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
  };
  const jobFile = (id) => join(repo, ".orka", "jobs", `${id}.json`);
  const read = (id) => JSON.parse(readFileSync(jobFile(id), "utf8"));
  const mk = (...extra) => orka(["new", "--kind", "claude", "--title", "rf", "--goal", "g", "--no-gate", ...extra]);
  return { repo, log, orka, config, read, jobFile, mk, calls: () => readFileSync(log, "utf8") };
}

function running(t, id) {
  const job = t.read(id);
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") });
  writeFileSync(t.jobFile(id), JSON.stringify(job));
}


const REPRO = /results\/repro\.json/;
const REPRO_TEXT = /Playbook bug-fix|repro worker|repro\.json|the repro\b/i;

// The prompt text a run or worker call sent to herdr, ids masked so two jobs compare.
function promptOf(t, id) {
  const log = t.calls();
  return log.slice(log.indexOf("herdr agent prompt")).replaceAll(t.repo, "REPO").replaceAll(id, "JOB").replace(/\bj\d+rf\b/g, "AGENT").replace(/\b[0-9a-f]{40}\b/g, "SHA").replace(/orka-[0-9a-f]{8}-/g, "orka-BROWSER-").replace(/\b[2-6]\d{4}\b/g, "PORT");
}

function orchestratorLog(...flags) {
  const t = scratch();
  const id = t.mk(...flags).stdout.trim();
  const r = t.orka(["run", id]);
  assert.equal(r.status, 0, r.stderr);
  return { t, id, prompt: promptOf(t, id) };
}

function verifierLog(...flags) {
  const t = scratch();
  const id = t.mk(...flags).stdout.trim();
  running(t, id);
  const r = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--pane", "p-9", "--task", "check it"]);
  assert.equal(r.status, 0, r.stderr);
  return { t, id, prompt: promptOf(t, id) };
}

test("bug-fix orchestrator prompt requires a repro worker first and no fix before repro.json", () => {
  const { prompt, t, id } = orchestratorLog("--playbook", "bug-fix");
  assert.equal(t.read(id).playbook, "bug-fix");
  assert.match(prompt, /Playbook bug-fix \(repro first\): the FIRST worker must be a repro worker/);
  assert.match(prompt, /saves the failing evidence to .*results\/repro\.json/);
  assert.match(prompt, /the command or steps, plus the real failing output/);
  assert.match(prompt, /adds a failing test and commits it before the fix/);
  assert.match(prompt, /No fix worker starts before results\/repro\.json exists/);
});

test("bug-fix verifier prompt re-runs the repro and treats a missing or irreproducible one as blocking", () => {
  const { prompt } = verifierLog("--playbook", "bug-fix");
  assert.match(prompt, /re-run the repro from .*results\/repro\.json; it must now pass/);
  assert.match(prompt, /missing results\/repro\.json, or a repro you cannot reproduce or re-run, is a blocking failure/);
  assert.match(prompt, /Never pass it silently/);
});

test("without the flag or with --playbook feature, prompts carry no repro text and match byte for byte", () => {
  const none = orchestratorLog();
  const feature = orchestratorLog("--playbook", "feature");
  assert.doesNotMatch(none.prompt, REPRO);
  assert.deepEqual(none.prompt.split("\n").filter((l) => REPRO_TEXT.test(l)), []);
  assert.equal(none.t.read(none.id).playbook, "feature");
  assert.equal(feature.prompt, none.prompt);
  const vnone = verifierLog();
  const vfeature = verifierLog("--playbook", "feature");
  assert.doesNotMatch(vnone.prompt, REPRO_TEXT);
  assert.equal(vfeature.prompt, vnone.prompt);
});

test("the bug-fix prompt differs from the default only by the repro lines", () => {
  const plain = orchestratorLog().prompt.split("\n");
  const bug = orchestratorLog("--playbook", "bug-fix").prompt.split("\n");
  assert.deepEqual(bug.filter((l) => !REPRO_TEXT.test(l)), plain);
  const vplain = verifierLog().prompt.split("\n");
  const vbug = verifierLog("--playbook", "bug-fix").prompt.split("\n");
  assert.deepEqual(vbug.filter((l) => !REPRO_TEXT.test(l)).filter((l, i, a) => !(l === "" && a[i - 1] === "")), vplain.filter((l, i, a) => !(l === "" && a[i - 1] === "")));
});

test("an invalid --playbook exits non-zero and lists the valid values, in new and run", () => {
  const t = scratch();
  const bad = t.mk("--playbook", "nope");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--playbook must be one of: feature, bug-fix/);
  const id = t.mk().stdout.trim();
  const run = t.orka(["run", id, "--playbook", "nope"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /feature, bug-fix/);
  assert.equal(t.read(id).status, "queued");
});

test("orka run --playbook bug-fix sets the playbook on a queued job", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  const r = t.orka(["run", id, "--playbook", "bug-fix"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.read(id).playbook, "bug-fix");
  assert.match(promptOf(t, id), REPRO);
});
