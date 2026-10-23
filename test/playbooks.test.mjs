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
  const base = mkdtempSync(join(tmpdir(), "orka-playbooks-"));
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
  const mk = (...extra) => orka(["new", "--kind", "claude", "--title", "rf", "--goal", "g", "--no-gate", ...extra]);
  return { repo, log, orka, config, read, jobFile, mk, calls: () => readFileSync(log, "utf8") };
}

function running(t, id) {
  const job = t.read(id);
  Object.assign(job, { status: "running", signoff: { round: 1, at: "2026-10-23T00:00:00Z" }, pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") });
  writeFileSync(t.jobFile(id), JSON.stringify(job));
}



// The prompt text a run call sent to herdr, ids masked so two jobs compare.
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

const lines = (name) => orchestratorLog(...(name ? ["--playbook", name] : [])).prompt.split("\n");

// Lines of the playbook prompt that are not in the feature prompt, and the other way round, as multisets.
function diffLines(name) {
  const plain = lines();
  const other = lines(name);
  const minus = (a, b) => {
    const rest = [...b];
    return a.filter((l) => {
      const i = rest.indexOf(l);
      if (i < 0) return true;
      rest.splice(i, 1);
      return false;
    });
  };
  return { added: minus(other, plain), removed: minus(plain, other) };
}

const added = (name) => {
  const { added: extra, removed } = diffLines(name);
  assert.deepEqual(removed, [], `${name} prompt dropped or changed a feature line`);
  return extra;
};

test("all four playbooks are accepted and stored; default is feature", () => {
  for (const name of ["feature", "bug-fix", "investigation", "hillclimb"]) {
    const t = scratch();
    const id = t.mk("--playbook", name).stdout.trim();
    assert.equal(t.read(id).playbook, name);
  }
  const t = scratch();
  assert.equal(t.read(t.mk().stdout.trim()).playbook, "feature");
});

test("an invalid --playbook lists all four valid values, in new and run", () => {
  const t = scratch();
  const bad = t.mk("--playbook", "nope");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--playbook must be one of: feature, bug-fix, investigation, hillclimb/);
  const id = t.mk().stdout.trim();
  const run = t.orka(["run", id, "--playbook", "nope"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /feature, bug-fix, investigation, hillclimb/);
});

test("--playbook feature matches the default prompt byte for byte", () => {
  assert.equal(orchestratorLog("--playbook", "feature").prompt, orchestratorLog().prompt);
  assert.deepEqual(added("feature"), []);
});

test("each non-default playbook adds only its own block to the feature prompt", () => {
  const bug = added("bug-fix");
  assert.equal(bug.length, 2);
  assert.match(bug.join("\n"), /Playbook bug-fix \(repro first\)/);
  const hill = added("hillclimb");
  assert.equal(hill.length, 2);
  assert.match(hill.join("\n"), /Playbook hillclimb/);
  assert.match(hill.join("\n"), /metric/);
  assert.match(hill.join("\n"), /baseline/);
  assert.match(hill.join("\n"), /only when the metric improves/);
  for (const block of [bug, hill]) assert.doesNotMatch(block.join("\n"), /Playbook feature/);
});

test("playbook blocks do not leak into other playbooks", () => {
  assert.doesNotMatch(added("hillclimb").join("\n"), /repro|citation/);
  assert.doesNotMatch(diffLines("investigation").added.join("\n"), /repro|baseline/);
  assert.doesNotMatch(added("bug-fix").join("\n"), /baseline|citation/);
});

test("the investigation prompt has no verifier flow: no verifier worker, no rounds, no verdict", () => {
  const prompt = lines("investigation").join("\n");
  assert.match(prompt, /Playbook investigation/);
  assert.match(prompt, /RESEARCH REPORT FORMAT/);
  assert.match(prompt, /check the research summaries yourself/);
  assert.match(prompt, /re-run each cited command/);
  assert.match(prompt, /orka done /);
  assert.doesNotMatch(prompt, /--role verifier/);
  assert.doesNotMatch(prompt, /verifier|verdict|verifier round|round ceiling|stall/i);
  assert.doesNotMatch(prompt, /start ONE verifier|orka strategy/);
});

test("a non-feature prompt differs from the feature prompt only in its playbook section", () => {
  const plain = lines();
  const verifyStart = plain.findIndex((l) => l.startsWith("When every builder has reported"));
  const stop = plain.findIndex((l) => l.startsWith("Then stop working."));
  for (const name of ["bug-fix", "hillclimb"]) assert.deepEqual(diffLines(name).removed, [], name);
  // investigation swaps only the verifier-and-finish section: every removed line sits between the
  // worker setup and "Then stop working", and the lines around it are unchanged
  const inv = lines("investigation");
  const head = plain.findIndex((l) => l.startsWith("Worker names must match"));
  assert.deepEqual(inv.slice(0, 1), plain.slice(0, 1));
  assert.deepEqual(inv.slice(-(plain.length - stop)), plain.slice(stop));
  const removed = diffLines("investigation").removed;
  assert.ok(removed.length > 0);
  for (const l of removed) {
    const at = plain.indexOf(l);
    assert.ok(at > head - 1 || /^Start each worker|^Write every|^When orka.features/.test(l) === false, `unexpected removal: ${l}`);
    assert.ok(at >= head && at < stop, `removed line outside the verifier/finish section: ${l}`);
  }
  assert.ok(verifyStart > head && verifyStart < stop);
});

test("orka done on an investigation job with no verifier round marks it done", () => {
  const t = scratch();
  const id = t.mk("--playbook", "investigation").stdout.trim();
  running(t, id);
  const r = t.orka(["done", id, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /running -> done/);
});

test("a real orka done on an investigation job with no verifier.json marks it done, not failed", () => {
  const t = scratch();
  const id = t.mk("--playbook", "investigation").stdout.trim();
  running(t, id);
  const r = t.orka(["done", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^done /);
  const job = t.read(id);
  assert.equal(job.status, "done");
  assert.ok(!job.verifier || job.verifier.verdict == null);
});

test("a feature job with a failing verifier.json still ends failed", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  running(t, id);
  const job = t.read(id);
  job.verifier = { rounds: 1, verdict: null, history: [] };
  writeFileSync(t.jobFile(id), JSON.stringify(job));
  const dir = join(t.repo, ".orka", "jobs", id, "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "verifier.json"), JSON.stringify({ name: "verifier", role: "verifier", round: 1, verdict: "fail", checks: [], failures: [{ check: "x", evidence: "boom" }], summary: "no" }));
  const r = t.orka(["done", id]);
  assert.match(r.stdout, /^failed /);
  assert.equal(t.read(id).status, "failed");
});

test("status and the finish payload show the playbook", () => {
  for (const name of ["feature", "hillclimb"]) {
    const t = scratch();
    const id = t.mk("--playbook", name).stdout.trim();
    running(t, id);
    assert.match(t.orka(["status", id]).stdout, new RegExp(`playbook: ${name}`));
    const done = t.orka(["done", id, "--dry-run"]);
    assert.match(done.stdout, new RegExp(`payload: .*"playbook":"${name}"`));
  }
});

test("orka run --playbook investigation sets the playbook on a queued job", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  assert.equal(t.orka(["run", id, "--playbook", "investigation"]).status, 0);
  assert.equal(t.read(id).playbook, "investigation");
  assert.match(promptOf(t, id), /Playbook investigation/);
});
