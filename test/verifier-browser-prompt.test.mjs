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
  const base = mkdtempSync(join(tmpdir(), "orca-vbrowser-"));
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

function running(t, id, extra = {}) {
  const job = t.read(id);
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") }, extra);
  writeFileSync(t.jobFile(id), JSON.stringify(job));
}

// The verifier prompt herdr received, with the per-run ids masked so two jobs compare.
function verifierPromptOf(...flags) {
  const t = scratch();
  const id = t.mk(...flags).stdout.trim();
  running(t, id);
  const r = t.orca(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", "t"]);
  assert.equal(r.status, 0, r.stderr);
  const log = t.calls();
  return log.slice(log.indexOf("herdr agent prompt")).replaceAll(t.repo, "REPO").replaceAll(id, "JOB").replace(/\bj\d+rf\b/g, "AGENT").replace(/\b[0-9a-f]{40}\b/g, "SHA").replace(/--model (sonnet|haiku)/, "--model M").replace(/orca-[0-9a-f]{8}-/g, "orca-BROWSER-").replace(/\b[2-6]\d{4}\b/g, "PORT");
}

const BROWSER_BLOCK = /^Browser checks \(agent-browser\)\..*\n(- .*\n?){5}/m;

test("a UI job verifier prompt carries the agent-browser practices", () => {
  const prompt = verifierPromptOf("--ui");
  assert.match(prompt, BROWSER_BLOCK);
  assert.match(prompt, /agent-browser skills get core/);
  assert.match(prompt, /Session: use only --session orca-BROWSER-verifier, and close it/);
  assert.match(prompt, /snapshot -i\), then act on the @eN refs/);
  assert.match(prompt, /Do not guess selectors/);
  assert.match(prompt, /wait @ref, wait --text .*wait --url .*wait --load networkidle\. No sleeps/);
  assert.match(prompt, /save screenshots under REPO\/\.orca\/jobs\/JOB\/results\//);
  assert.match(prompt, /console and network requests/);
  assert.ok(prompt.split("\n").filter((l) => /^- /.test(l) && /agent-browser --session|wait|Console/.test(l)).length >= 4);
});

test("a CLI job verifier prompt lacks the browser text and is the UI prompt minus that block", () => {
  const cli = verifierPromptOf();
  const ui = verifierPromptOf("--ui");
  assert.doesNotMatch(cli, /Browser checks \(agent-browser\)/);
  assert.doesNotMatch(cli, /skills get core/);
  assert.doesNotMatch(cli, /@eN refs/);
  assert.doesNotMatch(cli, /networkidle/);
  assert.equal(ui.replace(BROWSER_BLOCK, ""), cli, "the only difference is the browser block");
  // The generic session line the CLI prompt always had is still there, byte for byte.
  assert.match(cli, /Use exactly one agent-browser session, named orca-BROWSER-verifier \(agent-browser --session orca-BROWSER-verifier\)\. Reuse it for every check\. Never spawn a fresh session per check\. When done, close it: agent-browser --session orca-BROWSER-verifier close\n\nWhen finished, write /);
});
