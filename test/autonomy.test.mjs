import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allows, pushActions } from "../lib/autonomy.mjs";

const execFileAsync = promisify(execFile);
const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// A real git repo with a bare origin, a fake herdr (logs its arguments, agents start working once
// prompted) and an orka config dir inside the scratch, so no test touches ~/.config.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-autonomy-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const remote = join(base, "remote.git");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "${log}"
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
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet', 'haiku' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const env = { ...process.env, ...gitEnv, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), XDG_CONFIG_HOME: join(base, "config"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_READY_WAIT_MS: "3000", ORKA_PROMPT_WAIT_MS: "3000" };
  delete env.ORKA_JOB;
  delete env.ORCA_JOB;
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: opts.cwd || repo, encoding: "utf8", env: { ...env, ...(opts.env || {}) }, input: opts.input });
  const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "init");
  g("remote", "add", "origin", remote);
  const orka = (args, opts = {}) => run(process.execPath, [ORKA, ...args, "--cwd", opts.cwd || repo], opts);
  orka(["init"]);
  g("add", ".gitignore");
  g("commit", "-q", "-m", "ignore .orka");
  g("push", "-q", "origin", "main");
  const jobFile = (id) => join(repo, ".orka", "jobs", `${id}.json`);
  const read = (id) => JSON.parse(readFileSync(jobFile(id), "utf8"));
  const write = (id, job) => writeFileSync(jobFile(id), JSON.stringify(job));
  const decisions = (id) => {
    const path = join(repo, ".orka", "jobs", id, "decisions.tsv");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  const fresh = () => {
    writeFileSync(log, "");
    for (const f of readdirSync(base)) if (f === "prompted" || f.startsWith("seen-")) rmSync(join(base, f));
  };
  // git as a job pane runs it: core.hooksPath from the env orka gives every pane.
  const paneGit = (id, cwd, ...args) => {
    const hooks = join(repo, ".orka", "hooks");
    return run("git", args, { cwd, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks, ORKA_JOB: id } });
  };
  const setLevel = (level) => assert.equal(orka(["autonomy", "set", level]).status, 0);
  // A running job with a real worktree and one commit on its branch.
  const runningJob = () => {
    const id = orka(["new", "--title", "aut", "--goal", "add a file", "--no-gate"]).stdout.trim();
    const r = orka(["run", id]);
    assert.equal(r.status, 0, r.stderr);
    const job = read(id);
    writeFileSync(join(job.worktree, "feature.txt"), "new\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: job.worktree, env });
    execFileSync("git", ["commit", "-q", "-m", "feature"], { cwd: job.worktree, env });
    return { id, job };
  };
  const markDone = (id) => {
    const job = read(id);
    Object.assign(job, { status: "done", finished: new Date().toISOString(), verifier: { rounds: 1, verdict: "pass", history: [{ round: 1, verdict: "pass", failing: [] }], stale: false } });
    write(id, job);
  };
  return { base, repo, remote, env, g, orka, run, read, write, decisions, fresh, paneGit, setLevel, runningJob, markDone, calls: () => readFileSync(log, "utf8") };
}

test("levels: L1 by default, set writes orka's own config keyed by repo path, never the target repo", () => {
  const t = scratch();
  let r = t.orka(["autonomy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /autonomy: L1 \(branch and commit \(default\)\)/);
  assert.match(r.stdout, /source: default/);
  t.setLevel("L2");
  const cfg = JSON.parse(readFileSync(join(t.base, "config", "orka", "config.json"), "utf8"));
  assert.equal(cfg.repos[t.repo].autonomy, "L2");
  assert.match(t.orka(["autonomy"]).stdout, /autonomy: L2/);
  assert.equal(t.g("status", "--porcelain"), "");
  r = t.orka(["autonomy", "set", "L3"], { env: { ORKA_JOB: "some-job" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused inside a job pane/);
  assert.notEqual(t.orka(["autonomy", "set", "L9"]).status, 0);
});

test("allows and pushActions map actions to levels", () => {
  assert.equal(allows("L1", "commit").ok, true);
  assert.equal(allows("L0", "commit").ok, false);
  assert.deepEqual(allows("L1", "push"), { ok: false, need: "L2" });
  assert.equal(allows("L2", "push-main").ok, false);
  assert.equal(allows("L3", "merge").ok, true);
  assert.deepEqual(pushActions("refs/heads/a 1 refs/heads/orka/x 0\nrefs/heads/main 1 refs/heads/main 0\n"), ["push", "push-main"]);
});

test("orka run gives every pane the guard hooks (core.hooksPath env) and tells agents the level", () => {
  const t = scratch();
  const { id } = t.runningJob();
  const hooks = join(t.repo, ".orka", "hooks");
  for (const h of ["pre-commit", "pre-push", "pre-merge-commit"]) assert.ok(existsSync(join(hooks, h)), h);
  assert.match(t.calls(), new RegExp(`herdr workspace create .*--env GIT_CONFIG_COUNT=1 --env GIT_CONFIG_KEY_0=core.hooksPath --env GIT_CONFIG_VALUE_0=${hooks}`));
  assert.match(t.calls(), /Autonomy: this repo is at L1 \(branch and commit \(default\)\)/);
  t.fresh();
  assert.equal(t.orka(["worker", "--job", id, "--name", "builder", "--task", "GOAL: x\nSCOPE: a\nACCEPTANCE: b"]).status, 0);
  assert.match(t.calls(), /herdr pane split .*--env GIT_CONFIG_VALUE_0=/);
});

test("L1: the pane's git may commit on the job branch but a push is refused, with a clear error, and logged", () => {
  const t = scratch();
  const { id, job } = t.runningJob();
  writeFileSync(join(job.worktree, "b.txt"), "b\n");
  t.paneGit(id, job.worktree, "add", "b.txt");
  const commit = t.paneGit(id, job.worktree, "commit", "-q", "-m", "b");
  assert.equal(commit.status, 0, commit.stderr);
  const push = t.paneGit(id, job.worktree, "push", "origin", job.branch);
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /orka: refused push: .* is at autonomy L1 \(default\); push needs L2/);
  assert.equal(spawnSync("git", ["--git-dir", t.remote, "show-ref", "--verify", "--quiet", `refs/heads/${job.branch}`]).status, 1, "nothing reached origin");
  assert.match(t.decisions(id), /\tautonomy\trefused push\trepo at L1; push needs L2\tpre-push on orka\//);
  const main = t.paneGit(id, t.repo, "commit", "-q", "--allow-empty", "-m", "on main");
  assert.notEqual(main.status, 0);
  assert.match(main.stderr, /refused commit-main: .*commit-main needs L3/);
});

test("the guard runs the repo's own hook too", () => {
  const t = scratch();
  const { id, job } = t.runningJob();
  const own = join(t.repo, ".git", "hooks", "pre-commit");
  writeFileSync(own, `#!/bin/sh\necho own-hook-ran >> "${join(t.base, "own.log")}"\n`);
  chmodSync(own, 0o755);
  assert.equal(t.paneGit(id, job.worktree, "commit", "-q", "--allow-empty", "-m", "c").status, 0);
  assert.equal(readFileSync(join(t.base, "own.log"), "utf8"), "own-hook-ran\n");
});

test("L0 refuses even a branch commit; L2 pushes a branch but not main; L3 pushes main", () => {
  const t = scratch();
  const { id, job } = t.runningJob();
  t.setLevel("L0");
  const c = t.paneGit(id, job.worktree, "commit", "-q", "--allow-empty", "-m", "c");
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /refused commit: .*at autonomy L0; commit needs L1/);
  t.setLevel("L2");
  assert.equal(t.paneGit(id, job.worktree, "push", "-q", "origin", job.branch).status, 0);
  const m = t.paneGit(id, job.worktree, "push", "origin", `${job.branch}:main`);
  assert.notEqual(m.status, 0);
  assert.match(m.stderr, /refused push-main: .*push-main needs L3/);
  t.setLevel("L3");
  assert.equal(t.paneGit(id, job.worktree, "push", "-q", "origin", `${job.branch}:main`).status, 0);
});

test("orka push: refused at L1 with a decisions row; at L2 it pushes the job branch", () => {
  const t = scratch();
  const { id, job } = t.runningJob();
  let r = t.orka(["push", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /orka: refused push: .*L1 \(default\); push needs L2/);
  assert.match(t.decisions(id), /\tautonomy\trefused push\t.*\torka push /);
  assert.match(t.orka(["push", id, "--pr"]).stderr, /refused pr/);
  t.setLevel("L2");
  r = t.orka(["push", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(spawnSync("git", ["--git-dir", t.remote, "rev-parse", job.branch], { encoding: "utf8" }).stdout.trim(), execFileSync("git", ["rev-parse", "HEAD"], { cwd: job.worktree, encoding: "utf8" }).trim());
});

test("orka land: refused below L3; at L3 merges --no-ff into main and --push pushes it", () => {
  const t = scratch();
  const { id, job } = t.runningJob();
  t.markDone(id);
  t.setLevel("L2");
  let r = t.orka(["land", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refused merge: .*merge needs L3/);
  t.setLevel("L3");
  r = t.orka(["land", id, "--push"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.g("log", "-1", "--format=%s %p", "main"), new RegExp(`^Merge ${job.branch}: aut [0-9a-f]+ [0-9a-f]+$`));
  assert.equal(t.g("show", "main:feature.txt"), "new");
  assert.equal(spawnSync("git", ["--git-dir", t.remote, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim(), t.g("rev-parse", "main"));
  assert.match(t.decisions(id), /\tautonomy\tlanded orka\/.* on main\t/);
});

test("orka land aborts a conflicting merge and leaves main as it was", () => {
  const t = scratch();
  const { id } = t.runningJob();
  t.markDone(id);
  t.setLevel("L3");
  writeFileSync(join(t.repo, "feature.txt"), "other\n");
  t.g("add", "feature.txt");
  t.g("commit", "-q", "-m", "conflicting");
  const before = t.g("rev-parse", "main");
  const r = t.orka(["land", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /merge conflict .*merge aborted/);
  assert.equal(t.g("rev-parse", "main"), before);
  assert.equal(t.g("status", "--porcelain"), "");
});

test("orka chain --dry-run names what a pass would do at the repo's level", () => {
  const t = scratch();
  mkdirSync(join(t.repo, "tasks"));
  writeFileSync(join(t.repo, "tasks", "01-thing.md"), "# 01 thing\n");
  writeFileSync(join(t.repo, ".orka", "chain-queue"), "# queue\n01 haiku\n");
  let r = t.orka(["chain", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /autonomy L1: on a verifier pass keep the branch for review/);
  assert.match(r.stderr, /dry-run: orka new --title 'task 01 thing' --verifier-model haiku/);
  assert.equal(readFileSync(join(t.repo, ".orka", "chain-queue"), "utf8"), "# queue\n01 haiku\n", "dry-run pops nothing");
  t.setLevel("L3");
  assert.match(t.orka(["chain", "--dry-run"]).stderr, /autonomy L3: on a verifier pass merge into main, test, push main/);
});

// Runs orka chain in the background; when the job it starts appears, a commit lands on its branch and it is marked done + pass.
async function chainOnce(t) {
  mkdirSync(join(t.repo, "tasks"), { recursive: true });
  writeFileSync(join(t.repo, "tasks", "01-thing.md"), "# 01 thing\n");
  writeFileSync(join(t.repo, ".orka", "chain-queue"), "01\n");
  const env = { ...t.env, ORKA_CHAIN_POLL_MS: "100", ORKA_CHAIN_MIN_MEM_MB: "0", ORKA_CHAIN_MAX_LOAD: "100000" };
  const child = spawn(process.execPath, [ORKA, "chain", "--cwd", t.repo], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const current = join(t.repo, ".orka", "chain-current");
    const deadline = Date.now() + 20000;
    let id = "";
    while (!id && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const candidate = (existsSync(current) ? readFileSync(current, "utf8") : "").trim().split(/\s+/)[1];
      // Wait for orka run to finish (status running), or it would save over the done status below.
      if (candidate && existsSync(join(t.repo, ".orka", "jobs", `${candidate}.json`)) && t.read(candidate).status === "running") id = candidate;
    }
    assert.ok(id, `chain never started a job:\n${err}`);
    const wt = t.read(id).worktree;
    writeFileSync(join(wt, "feature.txt"), "new\n");
    // Async git: the chain child keeps running meanwhile.
    await execFileAsync("git", ["add", "feature.txt"], { cwd: wt, env: t.env });
    await execFileAsync("git", ["commit", "-q", "-m", "feature"], { cwd: wt, env: t.env });
    t.markDone(id);
    const job = t.read(id);
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 20000))]);
    return { id, code, err, job };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

test("orka chain at L1 runs the queue and keeps a passing branch for review: no merge, no push", async () => {
  const t = scratch();
  const before = t.g("rev-parse", "main");
  const { id, code, err } = await chainOnce(t);
  assert.equal(code, 0, err);
  assert.match(err, /verifier pass; kept on orka\/.* for review \(autonomy L1: no push, no merge\)/);
  assert.match(err, /queue empty, chain done/);
  assert.equal(t.g("rev-parse", "main"), before);
  assert.match(t.decisions(id), /\tautonomy\tchain kept orka\//);
  assert.match(readFileSync(join(t.repo, ".orka", "chain.log"), "utf8"), /orka chain start .*autonomy L1/);
  assert.ok(!existsSync(join(t.repo, ".orka", "chain.lock")), "lock released");
});

test("orka chain at L3 merges, and pushes main after a pass", async () => {
  const t = scratch();
  t.setLevel("L3");
  const { code, err, job } = await chainOnce(t);
  assert.equal(code, 0, err);
  assert.match(t.g("log", "-1", "--format=%s", "main"), new RegExp(`^Merge ${job.branch}: task 01 thing$`));
  assert.equal(spawnSync("git", ["--git-dir", t.remote, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim(), t.g("rev-parse", "main"));
});
