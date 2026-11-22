import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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


const promptOf = (t, id) => {
  const log = t.calls();
  return log.slice(log.indexOf("herdr agent prompt"));
};
const ctxDir = (t, id) => join(t.repo, ".orka", "jobs", id, "context");

function runJob(...flags) {
  const t = scratch();
  const id = t.mk(...flags).stdout.trim();
  const r = t.orka(["run", id]);
  assert.equal(r.status, 0, r.stderr);
  return { t, id, prompt: promptOf(t, id) };
}

for (const playbook of ["feature", "bug-fix", "investigation", "hillclimb"]) {
  test(`orchestrator prompt (${playbook}) has the allowlist, the never Edit/Write rule, workers and no solo path`, () => {
    const { prompt } = runJob("--playbook", playbook);
    assert.match(prompt, /thin orchestrator: you only communicate, delegate and track/);
    assert.match(prompt, /Allowed: orka worker, steer, status, digest, strategy, log, propose, review, done, reap and approve-wait/);
    assert.match(prompt, /never Edit\/Write\/MultiEdit\/NotebookEdit/);
    assert.match(prompt, /including fixing a failing gate, goes to a worker/);
    assert.match(prompt, /guard hook.*decisions\.tsv/);
    assert.match(prompt, /orka worker --job/);
    assert.doesNotMatch(prompt, /Do not implement the goal yourself/);
    if (playbook !== "investigation") assert.match(prompt, /--role verifier/);
  });
}

test("the lead claude pane gets a separate settings file with the PreToolUse write guard", () => {
  const { t, id } = runJob();
  const job = t.read(id);
  const settings = JSON.parse(readFileSync(join(ctxDir(t, id), "claude-settings-lead.json"), "utf8"));
  const pre = settings.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
  const cmd = pre[0].hooks[0].command;
  assert.match(cmd, /orchestrator-guard\.mjs/);
  assert.ok(cmd.includes(join(t.repo, ".orka", "jobs", id)), cmd);
  assert.ok(cmd.includes(job.worktree), cmd);
  assert.match(settings.statusLine.command, /statusline\.mjs/);
  assert.equal(settings.hooks.PostToolUse[0].matcher, "*");
  assert.match(t.calls(), /claude-settings-lead\.json/);
});

test("worker panes keep today's settings: no PreToolUse, a different file", () => {
  const t = scratch();
  const id = t.mk().stdout.trim();
  const dry = t.orka(["run", id]);
  assert.equal(dry.status, 0, dry.stderr);
  const job = t.read(id);
  Object.assign(job, { status: "running", signoff: { round: 1, at: "2026-10-23T00:00:00Z" } });
  writeFileSync(t.jobFile(id), JSON.stringify(job));
  rmSync(join(t.repo, "..", "prompted"), { force: true }); // the stub herdr then reports a free name once
  const w = t.orka(["worker", "--job", id, "--name", "builder", "--task", "GOAL: x. SCOPE: a. ACCEPTANCE: b."]);
  assert.equal(w.status, 0, w.stderr);
  const settings = JSON.parse(readFileSync(join(ctxDir(t, id), "claude-settings.json"), "utf8"));
  assert.equal(settings.hooks.PreToolUse, undefined);
  assert.ok(settings.hooks.PostToolUse);
});

test("the lead pi pane gets pi-lead.mjs importing piGuardExtension next to the handoff hook", () => {
  const { t, id } = runJob("--kind", "pi");
  const ext = readFileSync(join(ctxDir(t, id), "pi-lead.mjs"), "utf8");
  assert.match(ext, /import \{ piGuardExtension \} from "file:\/\/.*\/lib\/orchestrator-guard\.mjs"/);
  assert.match(ext, /piExtension\(/);
  assert.match(ext, /piGuardExtension\(\{"jobDir":".*","worktree":".*"\}\)/);
  assert.match(t.calls(), /pi-lead\.mjs/);
});
