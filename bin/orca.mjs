#!/usr/bin/env node
// orca v0 — job file in <repo>/.orca/jobs, linked worktree at
// <repo>/.orca/worktrees/<id> on branch orca/<id>. Workers share that worktree.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORCA = fileURLToPath(import.meta.url);
const ORCHESTRATOR_MODEL = "opus";
const WORKER_MODEL = "sonnet";
const IDLE_RETRY_MS = 8000;
const VALUE_FLAGS = new Set(["title", "goal", "cwd", "kind", "job", "name", "task", "pane"]);
const BOOL_FLAGS = new Set(["dry-run", "help"]);

function fail(msg) {
  const err = new Error(msg);
  err.orca = true;
  throw err;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!VALUE_FLAGS.has(key) && !BOOL_FLAGS.has(key)) fail(`unknown flag --${key}`);
      if (BOOL_FLAGS.has(key) || !next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

function pathPrefix() {
  const extra = [join(homedir(), ".local", "bin"), join(homedir(), "bin"), dirname(ORCA)];
  return [...extra, process.env.PATH || ""].filter(Boolean).join(":");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") fail("git is not on PATH");
  return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function gitMeta(start) {
  const cwd = resolve(start);
  const top = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (top.code !== 0) fail(`not a git repository: ${cwd}`);
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) fail(common.err || "git common-dir failed");
  const primary = dirname(common.out);
  return { top: top.out, primary, linked: resolve(top.out) !== resolve(primary) };
}

function configPath(repo) {
  return join(repo, ".orca", "config.json");
}

function requireRepo(start) {
  const { primary } = gitMeta(start);
  if (!existsSync(configPath(primary))) fail(`not an orca repo: ${primary}\nrun: orca init`);
  return primary;
}

function ensureGitignore(repo) {
  const path = join(repo, ".gitignore");
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.split("\n").some((line) => line.trim() === ".orca/" || line.trim() === ".orca")) return false;
  const block = "# orca: job state, worktrees, and secrets\n.orca/\n";
  const next = cur && !cur.endsWith("\n") ? `${cur}\n\n${block}` : `${cur}${cur ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return true;
}

function cmdInit(args) {
  const start = args.cwd || process.cwd();
  const { primary, linked } = gitMeta(start);
  if (linked) fail("orca init must run in the primary checkout, not a linked worktree");
  const dir = join(primary, ".orca");
  const secrets = join(dir, "secrets");
  mkdirSync(join(dir, "jobs"), { recursive: true });
  mkdirSync(join(dir, "worktrees"), { recursive: true });
  mkdirSync(secrets, { recursive: true });
  chmodSync(secrets, 0o700);
  const cfg = configPath(primary);
  const fresh = !existsSync(cfg);
  if (fresh) {
    writeFileSync(
      cfg,
      JSON.stringify(
        {
          version: 1,
          repo: primary,
          jobs: ".orca/jobs",
          worktrees: ".orca/worktrees",
          secrets: ".orca/secrets",
          created: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  }
  const ignored = ensureGitignore(primary);
  console.log(`${fresh ? "initialized" : "already initialized"} ${primary}`);
  if (ignored) console.log("gitignored .orca/ — commit that .gitignore line if you share the repo; do not commit .orca/");
}

function slug(title) {
  const words = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  return `${stamp}-${words || "job"}`;
}

function jobsDir(repo) {
  return join(repo, ".orca", "jobs");
}

function jobPath(repo, id) {
  return join(jobsDir(repo), `${id}.json`);
}

function jobDir(repo, id) {
  return join(jobsDir(repo), id);
}

function worktreePath(repo, id) {
  return join(repo, ".orca", "worktrees", id);
}

function load(repo, id) {
  const path = jobPath(repo, id);
  if (!existsSync(path)) fail(`no job ${id} in ${repo}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`corrupt job file ${path}`);
  }
}

function save(repo, job) {
  mkdirSync(jobsDir(repo), { recursive: true });
  const path = jobPath(repo, job.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n");
  renameSync(tmp, path);
}

function herdr(args, timeoutMs = 30000) {
  const r = spawnSync("herdr", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, PATH: pathPrefix() },
  });
  const text = `${r.stdout || ""}${r.stderr || ""}${r.error ? `\n${r.error.message}` : ""}`;
  let json = null;
  const trimmed = text.trim();
  try {
    json = JSON.parse(trimmed);
  } catch {
    const i = trimmed.indexOf("{");
    const j = trimmed.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        json = JSON.parse(trimmed.slice(i, j + 1));
      } catch {
        json = null;
      }
    }
  }
  return { code: r.status ?? 1, text, json };
}

function herdrFail(got, what) {
  const detail = got.json?.error?.message || got.json?.error || got.text;
  const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
  fail(`${what} failed:\n${msg.slice(0, 800)}`);
}

function agentName(id) {
  return `j${String(id).replace(/[^a-z0-9]/g, "")}`.slice(0, 32);
}

function assertAgentName(name) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) fail(`agent name must match [a-z][a-z0-9_-]{0,31}, got ${name}`);
}

function startArgs(name, pane, kind, alias) {
  const args = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000"];
  if (kind === "claude") args.push("--", "--model", alias);
  return args;
}

function paneCommand(alias) {
  return `claude --model ${alias}`;
}

function agentStatus(name) {
  const got = herdr(["agent", "get", name]);
  return got.json?.result?.agent?.agent_status || "unknown";
}

function promptWithRetry(name, text) {
  const prompted = herdr(["agent", "prompt", name, text], 60000);
  if (prompted.code !== 0 || prompted.json?.error) herdrFail(prompted, "prompt");
  const deadline = Date.now() + IDLE_RETRY_MS;
  let status = agentStatus(name);
  while (status === "idle" && Date.now() < deadline) {
    sleep(500);
    status = agentStatus(name);
  }
  if (status === "idle") {
    const again = herdr(["agent", "prompt", name, text], 60000);
    if (again.code !== 0 || again.json?.error) herdrFail(again, "prompt retry");
  }
}

function ensureJobDir(repo, id) {
  const dir = jobDir(repo, id);
  mkdirSync(join(dir, "results"), { recursive: true });
  mkdirSync(join(dir, "notes"), { recursive: true });
  return dir;
}

function q(s) {
  const text = String(s);
  return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

function sh(args) {
  return args.map(q).join(" ");
}

function workerPrompt(job, name, task) {
  const dir = jobDir(job.repo, job.id);
  const result = join(dir, "results", `${name}.json`);
  const note = join(dir, "notes", `${name}.txt`);
  return [
    `You are a Sonnet worker for orca job ${job.id}. Do this task and stop.`,
    `Work only in this shared checkout: ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Other workers share this worktree. Do not revert their files. Do not create a branch, worktree, or push.`,
    ``,
    String(task).trim(),
    ``,
    `When finished, write ${result} as JSON:`,
    `{"worker":"${name}","ok":true,"result":"<what you did, a few sentences>"}`,
    `Also write one line at ${note}.`,
    `Then send that line to the orchestrator:`,
    `herdr agent prompt ${job.agent} "<the one-line note>"`,
    `If that prompt is rejected because the orchestrator is busy, the files are enough.`,
    ``,
    `Do not POST a finish webhook. Do not run herdr-finish-watch. Do not start another agent.`,
  ].join("\n");
}

function orchestratorPrompt(job) {
  const dir = jobDir(job.repo, job.id);
  return [
    `You are the orchestrator for orca job ${job.id}, not the implementer.`,
    `Do not implement the goal yourself. Do not edit the repo to satisfy the goal.`,
    `Split the goal into the smallest set of worker tasks, then start one Sonnet worker per task.`,
    ``,
    `Worktree (shared by every worker): ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Do not create branches or worktrees. Do not push. Workers share this checkout in v0.`,
    ``,
    `Goal:`,
    job.goal.trim(),
    ``,
    `Start each worker with orca, which opens a Herdr pane in this same worktree:`,
    `  orca worker --job ${job.id} --name <worker> --task "<task>"`,
    `If orca is not on PATH, run ${ORCA} instead. The binary is the same file.`,
    `Worker names must match [a-z][a-z0-9_-]{0,31}.`,
    `Pane command: ${paneCommand(WORKER_MODEL)}`,
    ``,
    `Each worker writes ${dir}/results/<name>.json and a one-line note at ${dir}/notes/<name>.txt,`,
    `then prompts you with that note. Read those files. Do not trust a worker that skipped them.`,
    `Do not POST a finish webhook. Finish wake is not wired. Do not run herdr-finish-watch.`,
    ``,
    `When every worker has reported, write a short summary to ${dir}/summary.txt`,
    `and set the "summary" field of ${jobPath(job.repo, job.id)} to that same text. Keep every other field.`,
    `Then stop.`,
  ].join("\n");
}

function piPrompt(job) {
  return [
    `You are the worker for orca job ${job.id}.`,
    `Work only in this checkout: ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Do not push. Do not create another worktree or branch.`,
    `Do not POST a finish webhook. Do not run herdr-finish-watch.`,
    ``,
    job.goal.trim(),
  ].join("\n");
}

function leadPrompt(job) {
  return job.kind === "claude" ? orchestratorPrompt(job) : piPrompt(job);
}

function printDryRun(repo, job) {
  const wt = job.worktree || worktreePath(repo, job.id);
  const branch = job.branch || `orca/${job.id}`;
  const name = job.agent || agentName(job.id);
  const kind = job.kind === "pi" ? "pi" : "claude";
  const alias = kind === "claude" ? ORCHESTRATOR_MODEL : "";
  console.log(`dry-run ${job.id} kind=${kind} status=${job.status}`);
  console.log(`repo: ${repo}`);
  console.log(`branch: ${branch}`);
  console.log(`worktree: ${wt}`);
  console.log(`layout: shared worktree (workers do not get sibling checkouts)`);
  console.log(`git: git -C ${q(repo)} worktree add -b ${q(branch)} ${q(wt)} HEAD`);
  console.log(`workspace: herdr workspace create --cwd ${q(wt)} --label ${q(`orca-${job.id}`.slice(0, 40))} --no-focus --env PATH=<orca-bins>:$PATH`);
  console.log(`lead: herdr ${sh(startArgs(name, "<pane>", kind, alias))}`);
  if (kind === "claude") {
    console.log(`pane: ${paneCommand(ORCHESTRATOR_MODEL)}`);
    console.log(`worker: orca worker --job ${job.id} --name <worker> --task "<task>"`);
    console.log(`worker-pane: ${paneCommand(WORKER_MODEL)}`);
    console.log(`worker-lead: herdr ${sh(startArgs("<worker>", "<pane>", "claude", WORKER_MODEL))}`);
  } else {
    console.log("workers: none (pi is a single worker)");
  }
}

function cmdNew(args) {
  const title = args.title;
  const goal = args.goal;
  const kind = args.kind || "claude";
  if (!title || !goal) fail("need --title and --goal");
  if (kind !== "pi" && kind !== "claude") fail("kind must be pi or claude");
  const repo = requireRepo(args.cwd || process.cwd());
  const id = slug(title);
  const branch = `orca/${id}`;
  const check = git(repo, ["check-ref-format", "--branch", branch]);
  if (check.code !== 0) fail(`refused branch name ${branch}`);
  if (existsSync(jobPath(repo, id))) fail(`job ${id} already exists`);
  const job = {
    v: 1,
    id,
    title: String(title),
    goal: String(goal),
    kind,
    status: "queued",
    repo,
    branch,
    worktree: "",
    workerLayout: "shared-worktree",
    pane: "",
    agent: "",
    workspace: "",
    role: kind === "claude" ? "orchestrator" : "worker",
    model: kind === "claude" ? ORCHESTRATOR_MODEL : "",
    workerModel: kind === "claude" ? WORKER_MODEL : "",
    workers: [],
    steers: [],
    started: null,
    finished: null,
    summary: "",
    stopReason: "",
    created: new Date().toISOString(),
  };
  save(repo, job);
  console.log(id);
}

function hasHead(repo) {
  return git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).code === 0;
}

function addWorktree(repo, job) {
  if (!hasHead(repo)) fail("target repo has no commits; commit once before orca run");
  const path = worktreePath(repo, job.id);
  const branch = job.branch || `orca/${job.id}`;
  if (existsSync(path)) fail(`worktree path already exists: ${path}`);
  const exists = git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.code === 0) fail(`branch ${branch} already exists`);
  mkdirSync(join(repo, ".orca", "worktrees"), { recursive: true });
  const added = git(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (added.code !== 0) fail(added.err || added.out || "git worktree add failed");
  return path;
}

function createWorkspace(job) {
  const label = `orca-${job.id}`.slice(0, 40);
  const got = herdr([
    "workspace",
    "create",
    "--cwd",
    job.worktree,
    "--label",
    label,
    "--no-focus",
    "--env",
    `PATH=${pathPrefix()}`,
  ]);
  const pane = got.json?.result?.root_pane?.pane_id;
  const workspace = got.json?.result?.workspace?.workspace_id;
  if (!pane) herdrFail(got, "workspace create");
  return { pane, workspace: workspace || "" };
}

function startLead(job) {
  const name = agentName(job.id);
  assertAgentName(name);
  const kind = job.kind === "pi" ? "pi" : "claude";
  const alias = kind === "claude" ? ORCHESTRATOR_MODEL : "";
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = herdr(startArgs(name, job.pane, kind, alias), 90000);
    if (last.code === 0 && !last.json?.error) return name;
    if (attempt === 1 && /not an available shell|agent_not_ready/i.test(last.text)) {
      sleep(1000);
      continue;
    }
    break;
  }
  herdrFail(last, "agent start");
}

function cmdRun(args) {
  const id = args._[1];
  if (!id) fail("need id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (args["dry-run"]) {
    if (job.status !== "queued") fail(`job ${id} is ${job.status}, not queued`);
    printDryRun(repo, job);
    return;
  }
  if (job.status !== "queued") fail(`job ${id} is ${job.status}, not queued`);
  try {
    job.worktree = addWorktree(repo, job);
    save(repo, job);
    ensureJobDir(repo, id);
    const place = createWorkspace(job);
    job.pane = place.pane;
    job.workspace = place.workspace;
    save(repo, job);
    job.agent = startLead(job);
    save(repo, job);
    promptWithRetry(job.agent, leadPrompt(job));
    job.status = "running";
    job.started = new Date().toISOString();
    save(repo, job);
  } catch (err) {
    if (job.worktree || job.pane || job.agent) {
      job.status = "failed";
      job.finished = new Date().toISOString();
      job.stopReason = err.message;
      save(repo, job);
    }
    throw err;
  }
  const extra = job.kind === "claude" ? ` role=orchestrator model=${ORCHESTRATOR_MODEL}` : " role=worker";
  console.log(`${id} running pane=${job.pane} agent=${job.agent} branch=${job.branch} worktree=${job.worktree}${extra}`);
}

function splitPane(fromPane, cwd) {
  const split = herdr(["pane", "split", "--pane", fromPane, "--direction", "right", "--cwd", cwd, "--no-focus", "--env", `PATH=${pathPrefix()}`]);
  const pane = split.json?.result?.pane?.pane_id;
  if (!pane) herdrFail(split, "pane split");
  return pane;
}

function cmdWorker(args) {
  const id = args.job;
  const name = args.name;
  const task = args.task || args._.slice(1).join(" ");
  if (!id || !name || !task) fail("need --job --name --task");
  assertAgentName(String(name));
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, String(id));
  if (job.kind !== "claude") fail("workers are only for kind claude");
  if (args["dry-run"]) {
    const wt = job.worktree || worktreePath(repo, job.id);
    console.log(`dry-run worker ${name} job=${job.id} model=${WORKER_MODEL}`);
    console.log(`worktree: ${wt}`);
    console.log("layout: shared worktree");
    console.log(`split: herdr pane split --pane ${q(job.pane || "<orchestrator-pane>")} --direction right --cwd ${q(wt)} --no-focus`);
    console.log(`spawn: herdr ${sh(startArgs(String(name), args.pane || "<pane>", "claude", WORKER_MODEL))}`);
    console.log(`pane: ${paneCommand(WORKER_MODEL)}`);
    return;
  }
  if (!job.pane || !job.agent || !job.worktree) fail("orchestrator is not running");
  if (job.status !== "running") fail(`job ${id} is ${job.status}, not running`);
  ensureJobDir(repo, job.id);
  const pane = args.pane ? String(args.pane) : splitPane(job.pane, job.worktree);
  const started = herdr(startArgs(String(name), pane, "claude", WORKER_MODEL), 90000);
  if (started.code !== 0 || started.json?.error) herdrFail(started, "worker start");
  promptWithRetry(String(name), workerPrompt(job, String(name), String(task)));
  job.workers = job.workers || [];
  job.workers.push({
    name: String(name),
    pane,
    model: WORKER_MODEL,
    task: String(task),
    result: join(jobDir(repo, job.id), "results", `${name}.json`),
    note: join(jobDir(repo, job.id), "notes", `${name}.txt`),
  });
  save(repo, job);
  console.log(`${id} worker ${name} pane=${pane} model=${WORKER_MODEL} worktree=${job.worktree}`);
}

function summaryOf(repo, job) {
  const path = join(jobDir(repo, job.id), "summary.txt");
  if (existsSync(path)) return readFileSync(path, "utf8").trim().slice(0, 2000);
  return job.summary || "";
}

function line(job) {
  console.log(`${job.id}  ${String(job.status).padEnd(8)}  ${String(job.kind).padEnd(6)}  ${job.title}`);
}

function cmdStatus(args) {
  const id = args._[1];
  const repo = requireRepo(args.cwd || process.cwd());
  if (id) {
    const job = load(repo, id);
    line(job);
    console.log(`  repo: ${repo}`);
    console.log(`  branch: ${job.branch || `orca/${job.id}`}`);
    console.log(`  worktree: ${job.worktree || "(not created)"}`);
    console.log(`  layout: ${job.workerLayout || "shared-worktree"}`);
    if (job.agent || job.pane) console.log(`  agent: ${job.agent || "-"} pane=${job.pane || "-"} workspace=${job.workspace || "-"} model=${job.model || "-"}`);
    for (const worker of job.workers || []) console.log(`  worker: ${worker.name} pane=${worker.pane} model=${worker.model}`);
    const summary = summaryOf(repo, job);
    if (summary) console.log(`  summary: ${summary}`);
    if (job.stopReason) console.log(`  stop: ${job.stopReason}`);
    return;
  }
  mkdirSync(jobsDir(repo), { recursive: true });
  const files = readdirSync(jobsDir(repo)).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) {
    console.log("no jobs");
    return;
  }
  for (const file of files) line(JSON.parse(readFileSync(join(jobsDir(repo), file), "utf8")));
}

function cmdSteer(args) {
  const id = args._[1];
  const message = args._.slice(2).join(" ").trim();
  if (!id || !message) fail('need: orca steer <id> "message"');
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status !== "running" || !job.agent) fail(`${id} is ${job.status}; not steered`);
  promptWithRetry(job.agent, message);
  job.steers = job.steers || [];
  job.steers.push({ at: new Date().toISOString(), message });
  save(repo, job);
  console.log(`steered ${id}`);
}

function interrupt(name) {
  const first = herdr(["agent", "send-keys", name, "ctrl+c"]);
  sleep(200);
  const second = herdr(["agent", "send-keys", name, "ctrl+c"]);
  return first.code === 0 && second.code === 0 && !first.json?.error && !second.json?.error;
}

function cmdStop(args) {
  const id = args._[1];
  if (!id) fail("need id");
  const reason = args._.slice(2).join(" ").trim() || "stopped by request";
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status !== "running" && job.status !== "queued") {
    console.log(`${id} is already ${job.status}`);
    return;
  }
  let how = "recorded";
  if (job.status === "running") {
    let ok = false;
    if (job.workspace) {
      const closed = herdr(["workspace", "close", job.workspace]);
      ok = closed.code === 0 && !closed.json?.error;
      how = ok ? "workspace closed" : "workspace close failed";
    }
    if (!ok && job.agent) {
      const lead = interrupt(job.agent);
      for (const worker of job.workers || []) interrupt(worker.name);
      if (lead) {
        ok = true;
        how = job.workspace ? "interrupted; workspace still open" : "interrupted";
      }
    }
    if (!ok && (job.workspace || job.agent)) fail(`could not stop ${id}; job left running (${how})`);
    if (!job.workspace && !job.agent) how = "no pane recorded";
  } else {
    how = "was queued";
  }
  job.status = "stopped";
  job.finished = new Date().toISOString();
  job.stopReason = reason;
  save(repo, job);
  console.log(`stopped ${id} (${how}): ${reason}`);
}

function help() {
  console.log(`orca — one job in a linked worktree

  orca init [--cwd <repo>]
  orca new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi]
  orca run <id> [--dry-run] [--cwd <repo>]
  orca worker --job <id> --name <agent> --task "..." [--dry-run]
  orca status [id] [--cwd <repo>]
  orca steer <id> "message"
  orca stop <id> [reason]
  orca help

Jobs: <repo>/.orca/jobs/<id>.json
Worktree: <repo>/.orca/worktrees/<id> on branch orca/<id>
Workers share that worktree. Sibling worktrees are not in v0.

kind claude (default)
  run starts an Opus orchestrator (claude --model ${ORCHESTRATOR_MODEL}) in a Herdr pane.
  It does not implement the goal. It starts Sonnet workers with orca worker
  (claude --model ${WORKER_MODEL}) in extra panes, same worktree.
  Herdr has no --model flag. The alias is an agent argument.

kind pi
  One Pi worker in the worktree. No Opus or Sonnet.

A prompt that is still idle after ~8s is sent once more.
status reads the job file. It does not poll Herdr.
stop closes the job workspace, or interrupts the lead if there is no workspace.
Finish webhooks are not wired. Next: POST {job, status, branch} using <repo>/.orca/secrets/finish-webhook.env

claude must be on PATH in the pane. This CLI does not install it.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "help";
  if (args.help || cmd === "help") {
    help();
    return;
  }
  if (cmd === "init") cmdInit(args);
  else if (cmd === "new") cmdNew(args);
  else if (cmd === "run") cmdRun(args);
  else if (cmd === "worker") cmdWorker(args);
  else if (cmd === "status") cmdStatus(args);
  else if (cmd === "steer") cmdSteer(args);
  else if (cmd === "stop") cmdStop(args);
  else fail(`unknown command ${cmd}\nrun: orca help`);
}

try {
  main();
} catch (err) {
  console.error(err && err.orca ? err.message : err?.message || err);
  process.exit(1);
}
