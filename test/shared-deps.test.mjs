import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyDeps, isLinkStatusLine, linkState, planDeps } from "../lib/deps.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

function dirs() {
  const base = mkdtempSync(join(tmpdir(), "orka-deps-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const main = join(base, "main");
  const wt = join(base, "wt");
  for (const d of [main, wt]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), '{"name":"x"}');
    writeFileSync(join(d, "package-lock.json"), '{"lockfileVersion":3}');
  }
  mkdirSync(join(main, "node_modules", "left-pad"), { recursive: true });
  return { base, main, wt };
}

const actions = (plan) => plan.map((p) => p.action);

test("planDeps: same lockfile links, different lockfile installs, a real dir is left alone", () => {
  const d = dirs();
  assert.deepEqual(actions(planDeps(d.main, d.wt)), ["link"]);
  writeFileSync(join(d.wt, "package-lock.json"), '{"lockfileVersion":3,"x":1}');
  const plan = planDeps(d.main, d.wt);
  assert.deepEqual(actions(plan), ["install"]);
  assert.deepEqual(plan[0].install, ["npm", "ci"]);
  mkdirSync(join(d.wt, "node_modules"));
  assert.deepEqual(planDeps(d.main, d.wt), []);
});

test("planDeps: no manifest or no main node_modules means nothing to do", () => {
  const d = dirs();
  rmSync(join(d.wt, "package.json"));
  assert.deepEqual(planDeps(d.main, d.wt), []);
  const e = dirs();
  rmSync(join(e.main, "node_modules"), { recursive: true });
  assert.deepEqual(planDeps(e.main, e.wt), []);
});

test("applyDeps links, then a broken link is relinked or reinstalled", () => {
  const d = dirs();
  const log = [];
  const run = (cmd, cwd) => {
    mkdirSync(join(cwd, "node_modules"));
    log.push(cmd.join(" "));
    return { ok: true };
  };
  applyDeps(d.main, d.wt, planDeps(d.main, d.wt), { run, log: (m) => log.push(m) });
  assert.equal(readlinkSync(join(d.wt, "node_modules")), join(d.main, "node_modules"));
  assert.equal(linkState(join(d.wt, "node_modules"), join(d.main, "node_modules")), "link");
  assert.deepEqual(actions(planDeps(d.main, d.wt)), ["ok"]);
  // A link to somewhere else is broken: relinked to main.
  rmSync(join(d.wt, "node_modules"));
  symlinkSync(join(d.base, "nowhere"), join(d.wt, "node_modules"));
  assert.deepEqual(actions(planDeps(d.main, d.wt)), ["relink"]);
  applyDeps(d.main, d.wt, planDeps(d.main, d.wt), { run, log: () => {} });
  assert.equal(linkState(join(d.wt, "node_modules"), join(d.main, "node_modules")), "link");
  // main lost its node_modules: the link points at nothing, so the worktree installs its own.
  rmSync(join(d.main, "node_modules"), { recursive: true });
  assert.deepEqual(actions(planDeps(d.main, d.wt)), ["install"]);
  applyDeps(d.main, d.wt, planDeps(d.main, d.wt), { run, log: () => {} });
  assert.ok(lstatSync(join(d.wt, "node_modules")).isDirectory());
  assert.ok(log.includes("npm ci"));
});

test("isLinkStatusLine only matches orka's own link", () => {
  const d = dirs();
  symlinkSync(join(d.main, "node_modules"), join(d.wt, "node_modules"));
  assert.equal(isLinkStatusLine(d.wt, "?? node_modules"), true);
  assert.equal(isLinkStatusLine(d.wt, "?? other"), false);
  assert.equal(isLinkStatusLine(d.wt, " M node_modules"), false);
});

// orka worker on a running job with a real linked worktree; herdr and npm are stubs.
function repoWithJob() {
  const base = mkdtempSync(join(tmpdir(), "orka-deps-cli-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "agent start") echo "$3" >> "${base}/agents"; echo '{"result":{}}';;
  "agent get") if ! grep -qx "$3" "${base}/agents" 2>/dev/null; then echo '{"error":{"message":"not found"}}'; exit 1; fi
    if [ -e "${base}/prompted-$3" ]; then echo '{"result":{"agent":{"agent_status":"working","interactive_ready":true}}}'; else echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true}}}'; fi;;
  "agent prompt") touch "${base}/prompted-$3"; echo '{"result":{}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  *) echo '{}';;
esac
`);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "${log}"\nmkdir -p node_modules\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "npm", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  const g = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  g(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "package.json"), '{"name":"x"}');
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}');
  g(["add", "."]);
  g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_PROMPT_POLL_MS: "50" };
  const orka = (args) => spawnSync("timeout", ["60", process.execPath, ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "d", "--goal", "g"]).stdout.trim();
  const wt = join(repo, ".orka", "worktrees", id);
  g(["worktree", "add", "-q", "-b", `orka/${id}`, wt, "HEAD"]);
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: wt });
  writeFileSync(path, JSON.stringify(job));
  const calls = () => readFileSync(log, "utf8");
  return { repo, wt, id, orka, g, calls, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

test("orka worker links node_modules to main, keeps it out of git, and tells the worker", () => {
  const t = repoWithJob();
  const r = t.orka(["worker", "--job", t.id, "--name", "w1", "--task", "SCOPE: a ACCEPTANCE: b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /deps: linked node_modules -> .*\/repo\/node_modules/);
  assert.equal(readlinkSync(join(t.wt, "node_modules")), join(t.repo, "node_modules"));
  assert.equal(t.g(["status", "--porcelain"], t.wt), "");
  assert.match(t.calls(), /node_modules in this worktree is a symlink to the main checkout's/);
  assert.equal(t.read().deps[0].action, "link");
  // The job is done: the worktree goes, the link with it, main's node_modules stays.
  const done = t.orka(["done", t.id]);
  assert.match(done.stdout, /cleanup: removed worktree/);
  assert.ok(!existsSync(t.wt));
  assert.ok(existsSync(join(t.repo, "node_modules", "left-pad")));
});

test("orka worker installs for real when the worktree lockfile differs from main", () => {
  const t = repoWithJob();
  writeFileSync(join(t.wt, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
  const r = t.orka(["worker", "--job", t.id, "--name", "w1", "--task", "SCOPE: a ACCEPTANCE: b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /deps: lockfile differs from main; running npm ci in the worktree/);
  assert.match(t.calls(), /^npm ci$/m);
  assert.ok(lstatSync(join(t.wt, "node_modules")).isDirectory());
});
