import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// herdr and claude are stubs on PATH. herdr logs its arguments and reports a working agent.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-playbooks-"));
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
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORCA_NO_WATCH: "1" };
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orca(["init"]);
  const config = (patch) => {
    const path = join(repo, ".orca", "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
  };
  const jobFile = (id) => join(repo, ".orca", "jobs", `${id}.json`);
  const read = (id) => JSON.parse(readFileSync(jobFile(id), "utf8"));
  const mk = (...extra) => orca(["new", "--kind", "claude", "--title", "rf", "--goal", "g", ...extra]);
  return { repo, log, orca, config, read, jobFile, mk, calls: () => readFileSync(log, "utf8") };
}

function running(t, id) {
  const job = t.read(id);
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") });
  writeFileSync(t.jobFile(id), JSON.stringify(job));
}



// The prompt text a run call sent to herdr, ids masked so two jobs compare.
function promptOf(t, id) {
  const log = t.calls();
  return log.slice(log.indexOf("herdr agent prompt")).replaceAll(t.repo, "REPO").replaceAll(id, "JOB").replace(/\bj\d+rf\b/g, "AGENT").replace(/\b[0-9a-f]{40}\b/g, "SHA").replace(/orca-[0-9a-f]{8}-/g, "orca-BROWSER-").replace(/\b[2-6]\d{4}\b/g, "PORT");
}

function orchestratorLog(...flags) {
  const t = scratch();
  const id = t.mk(...flags).stdout.trim();
  const r = t.orca(["run", id]);
  assert.equal(r.status, 0, r.stderr);
  return { t, id, prompt: promptOf(t, id) };
}

const added = (name) => {
  const plain = orchestratorLog().prompt.split("\n");
  const other = orchestratorLog("--playbook", name).prompt.split("\n");
  // every line of the feature prompt survives, in order; the rest is the playbook block
  let i = 0;
  const extra = [];
  for (const l of other) {
    if (i < plain.length && l === plain[i]) i++;
    else extra.push(l);
  }
  assert.equal(i, plain.length, `${name} prompt dropped or changed a feature line`);
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
  const run = t.orca(["run", id, "--playbook", "nope"]);
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
  const inv = added("investigation");
  assert.equal(inv.length, 3);
  assert.match(inv.join("\n"), /Playbook investigation/);
  assert.match(inv.join("\n"), /Do NOT start a verifier/);
  assert.match(inv.join("\n"), /RESEARCH REPORT FORMAT/);
  assert.match(inv.join("\n"), /citation/);
  assert.match(inv.join("\n"), /check the citations yourself/);
  const hill = added("hillclimb");
  assert.equal(hill.length, 2);
  assert.match(hill.join("\n"), /Playbook hillclimb/);
  assert.match(hill.join("\n"), /metric/);
  assert.match(hill.join("\n"), /baseline/);
  assert.match(hill.join("\n"), /only when the metric improves/);
  for (const block of [bug, inv, hill]) assert.doesNotMatch(block.join("\n"), /Playbook feature/);
});

test("playbook blocks do not leak into other playbooks", () => {
  assert.doesNotMatch(added("hillclimb").join("\n"), /repro|Do NOT start a verifier/);
  assert.doesNotMatch(added("investigation").join("\n"), /repro|baseline/);
  assert.doesNotMatch(added("bug-fix").join("\n"), /baseline|Do NOT start a verifier/);
});

test("orca done on an investigation job with no verifier round marks it done", () => {
  const t = scratch();
  const id = t.mk("--playbook", "investigation").stdout.trim();
  running(t, id);
  const r = t.orca(["done", id, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /running -> done/);
});

test("status and the finish payload show the playbook", () => {
  for (const name of ["feature", "hillclimb"]) {
    const t = scratch();
    const id = t.mk("--playbook", name).stdout.trim();
    running(t, id);
    assert.match(t.orca(["status", id]).stdout, new RegExp(`playbook: ${name}`));
    const done = t.orca(["done", id, "--dry-run"]);
    assert.match(done.stdout, new RegExp(`payload: .*"playbook":"${name}"`));
  }
});

test("orca run --playbook investigation sets the playbook on a queued job", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  assert.equal(t.orca(["run", id, "--playbook", "investigation"]).status, 0);
  assert.equal(t.read(id).playbook, "investigation");
  assert.match(promptOf(t, id), /Playbook investigation/);
});
