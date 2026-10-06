#!/usr/bin/env node
// orca v0 — job file in <repo>/.orca/jobs, linked worktree at
// <repo>/.orca/worktrees/<id> on branch orca/<id>. Workers share that worktree.
// Finish wake: when the CLI marks done|failed|stopped, POST {job, status, branch}
// if <repo>/.orca/secrets/finish-webhook.env exists. Never a home path.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ORCA = fileURLToPath(import.meta.url);
// Defaults only. A claude job stores the aliases it will actually run.
// opus is Opus 5.5 and sonnet is Sonnet 5.5 on current Claude Code; the alias
// tracks the latest model of that family, so these are not pinned ids.
const DEFAULT_ORCHESTRATOR_MODEL = "opus";
const DEFAULT_WORKER_MODEL = "sonnet";
const IDLE_RETRY_MS = 8000;
const VERIFY_STEP_TIMEOUT_MS = 90000;
const VERIFY_SCRIPT_TIMEOUT_MS = 600000;
const VERIFY_FILE = "orca.verify.json";
const STEP_ACTIONS = new Set([
  "open",
  "click",
  "fill",
  "press",
  "wait",
  "waitText",
  "visible",
  "text",
  "title",
  "titleIncludes",
  "urlIncludes",
  "count",
  "get",
]);
const GET_FIELDS = { text: "text", title: "title", url: "url", count: "count", value: "value", attr: "value" };
const VALUE_FLAGS = new Set([
  "title",
  "goal",
  "cwd",
  "kind",
  "job",
  "name",
  "task",
  "pane",
  "orchestrator-model",
  "worker-model",
  "model",
]);
const BOOL_FLAGS = new Set(["dry-run", "help", "force"]);
const FINISH_STATUSES = new Set(["done", "failed", "stopped"]);
const FINISH_TIMEOUT_MS = 8000;

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

function allowFlags(args, names) {
  const allowed = new Set(names);
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help" || allowed.has(key)) continue;
    fail(`--${key} is not used by this command`);
  }
}

function flagValue(args, key) {
  if (!(key in args)) return "";
  const value = args[key];
  if (value === true || String(value).trim() === "") fail(`--${key} needs a value`);
  return String(value).trim();
}

let modelSpec;

function claudeHelpText() {
  const r = spawnSync("claude", ["--help"], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, PATH: pathPrefix() },
  });
  if (r.error && r.error.code === "ENOENT") fail("claude is not on PATH; cannot validate model aliases");
  const text = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (!text.includes("--model")) {
    const detail = (r.stderr || r.stdout || r.error?.message || "claude --help failed").trim();
    fail(`could not read model aliases from claude --help\n${detail.slice(0, 400)}`);
  }
  return text;
}

function modelHelpBlob(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s+--model\s+<model>/.test(line));
  if (start < 0) return "";
  const blob = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:-\w|--\w)/.test(line) || /^Commands:/.test(line)) break;
    blob.push(line);
  }
  return blob.join(" ");
}

function claudeModelSpec() {
  if (modelSpec) return modelSpec;
  const blob = modelHelpBlob(claudeHelpText());
  const aliases = [];
  for (const match of blob.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9._:-]*)['"]/g)) aliases.push(match[1].toLowerCase());
  modelSpec = {
    aliases: [...new Set(aliases)],
    acceptsFullName: /full name/i.test(blob),
  };
  if (!modelSpec.aliases.length) fail("could not read model aliases from claude --help");
  return modelSpec;
}

function isFullModelName(alias) {
  return /^claude-[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(alias);
}

function assertClaudeModel(raw, role) {
  const alias = String(raw ?? "").trim();
  if (!alias) fail(`need a ${role} model alias`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(alias)) fail(`invalid model alias "${alias}"`);
  const spec = claudeModelSpec();
  const known = spec.aliases.find((item) => item === alias.toLowerCase());
  if (known) return known;
  if (spec.acceptsFullName && isFullModelName(alias)) return alias.toLowerCase();
  const extra = spec.acceptsFullName ? "\na full model name (claude-…) is also accepted" : "";
  fail(`unknown model alias "${alias}" for ${role}\nknown aliases from claude --help: ${spec.aliases.join(", ")}${extra}`);
}

function claudeModels(job, args) {
  return {
    orchestratorModel: assertClaudeModel(
      flagValue(args, "orchestrator-model") || job.orchestratorModel || job.model || DEFAULT_ORCHESTRATOR_MODEL,
      "orchestrator",
    ),
    workerModel: assertClaudeModel(
      flagValue(args, "worker-model") || job.workerModel || DEFAULT_WORKER_MODEL,
      "worker",
    ),
  };
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
  allowFlags(args, ["cwd"]);
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

function finishEnvPath(repo) {
  return join(repo, ".orca", "secrets", "finish-webhook.env");
}

function finishRecordPath(repo, id) {
  return join(jobsDir(repo), `${id}.finish.json`);
}

function insideOrca(repo, path) {
  try {
    const primary = realpathSync(repo);
    const root = realpathSync(join(repo, ".orca"));
    const real = realpathSync(path);
    const orcaRoot = join(primary, ".orca");
    if (root !== orcaRoot && !root.startsWith(orcaRoot + sep)) return false;
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

function readFinishConfig(repo) {
  const path = finishEnvPath(repo);
  if (!existsSync(path)) return { off: true, path };
  if (!insideOrca(repo, path)) return { error: "finish-webhook.env must stay inside .orca (no home path, no escaped symlink)" };
  let st;
  try {
    st = statSync(path);
  } catch {
    return { error: "cannot stat finish-webhook.env" };
  }
  if (!st.isFile()) return { error: "finish-webhook.env is not a file" };
  if ((st.mode & 0o077) !== 0) return { error: "finish-webhook.env must be mode 600" };
  let env;
  try {
    env = parseEnv(readFileSync(path, "utf8"));
  } catch {
    return { error: "cannot read finish-webhook.env" };
  }
  const urlText = env.WEBHOOK_URL ?? "";
  const key = env.WEBHOOK_KEY ?? "";
  if (!urlText || !key) return { error: "finish-webhook.env needs WEBHOOK_URL and WEBHOOK_KEY" };
  if (key !== key.trim() || /[\r\n]/.test(key)) return { error: "WEBHOOK_KEY is empty or invalid" };
  let url;
  try {
    url = new URL(urlText);
  } catch {
    return { error: "WEBHOOK_URL is not a URL" };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    return { error: "WEBHOOK_URL must be https with no userinfo or fragment" };
  }
  return { url: url.href, origin: url.origin, key, path };
}

function readFinishRecord(repo, id) {
  const path = finishRecordPath(repo, id);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || data.v !== 1 || !Array.isArray(data.attempts)) return { corrupt: true };
    return data;
  } catch {
    return { corrupt: true };
  }
}

function lastAttempt(record) {
  if (!record || record.corrupt || !record.attempts?.length) return null;
  return record.attempts[record.attempts.length - 1];
}

function writeFinishRecord(repo, record) {
  const path = finishRecordPath(repo, record.job);
  mkdirSync(jobsDir(repo), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function appendAttempt(repo, job, payload, attempt, prior) {
  const record = prior
    ? { ...prior, status: payload.status, branch: payload.branch, attempts: [...prior.attempts, attempt] }
    : { v: 1, job: job.id, status: payload.status, branch: payload.branch, attempts: [attempt] };
  if (!prior) {
    const path = finishRecordPath(repo, job.id);
    mkdirSync(jobsDir(repo), { recursive: true });
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if (err.code === "EEXIST") return null;
      throw err;
    }
    writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
    closeSync(fd);
    chmodSync(path, 0o600);
    return record;
  }
  writeFinishRecord(repo, record);
  return record;
}

function settleAttempt(repo, id, sent) {
  const record = readFinishRecord(repo, id);
  if (!record || record.corrupt || !record.attempts.length) return record;
  const attempts = record.attempts.slice();
  const last = { ...attempts[attempts.length - 1], outcome: sent.outcome, http: sent.http, detail: sent.detail, settled: new Date().toISOString() };
  attempts[attempts.length - 1] = last;
  const next = { ...record, attempts };
  writeFinishRecord(repo, next);
  return next;
}

function payloadOf(job, status = job.status) {
  return { job: job.id, status, branch: job.branch || `orca/${job.id}` };
}

function dryRunPlan(repo, job, status) {
  const payload = payloadOf(job, status);
  const config = readFinishConfig(repo);
  const record = readFinishRecord(repo, job.id);
  const last = lastAttempt(record);
  let send = "would POST";
  if (!FINISH_STATUSES.has(status)) send = "no (not terminal)";
  else if (config.off) send = "no (off)";
  else if (config.error) send = "no (invalid config)";
  else if (record?.corrupt) send = "no (corrupt record)";
  else if (last && last.outcome !== "failed") send = `no (last attempt ${last.outcome})`;
  const configLine = config.off ? "off" : config.error ? `invalid: ${config.error}` : config.origin;
  return {
    payload,
    lines: [`payload: ${JSON.stringify(payload)}`, `config: ${configLine}`, `send: ${send}`],
  };
}

async function postFinish(config, payload) {
  let response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(FINISH_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`,
        "X-Automation-Key": config.key,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const name = err?.name || "";
    if (name === "TimeoutError" || name === "AbortError") return { outcome: "unknown", http: null, detail: "timed out; acceptance unknown" };
    return { outcome: "unknown", http: null, detail: "request failed; acceptance unknown" };
  }
  const http = response.status;
  try {
    await response.body?.cancel();
  } catch {
    // never read or print a response body
  }
  if (http >= 200 && http < 300) return { outcome: "accepted", http, detail: `accepted (HTTP ${http})` };
  return { outcome: "failed", http, detail: `HTTP ${http}` };
}

async function deliverFinish(repo, job, opts = {}) {
  const manual = !!opts.manual;
  const force = !!opts.force;
  const status = opts.status || job.status;
  const payload = payloadOf(job, status);
  if (opts.dryRun) return { action: "dry-run", ...dryRunPlan(repo, job, status) };
  if (!FINISH_STATUSES.has(status)) fail(`job ${job.id} is ${status}; finish webhook sends only for done, failed, or stopped`);
  const config = readFinishConfig(repo);
  if (config.off) {
    if (manual) fail(`no finish webhook configured\nmissing ${config.path}`);
    return { action: "off" };
  }
  const record = readFinishRecord(repo, job.id);
  if (record?.corrupt) return { action: "failed", detail: "finish record is corrupt; not sent" };
  if (config.error) {
    if (!manual && record) return { action: "already", detail: lastAttempt(record)?.detail || "already recorded" };
    const attempt = { at: new Date().toISOString(), outcome: "failed", http: null, detail: config.error, settled: new Date().toISOString() };
    if (!appendAttempt(repo, job, payload, attempt, record)) return { action: "already", detail: "attempt already recorded" };
    return { action: "failed", detail: config.error };
  }
  const last = lastAttempt(record);
  if (!manual && last) return { action: "already", detail: `${last.outcome}${last.detail ? `: ${last.detail}` : ""}` };
  if (manual && last && last.outcome !== "failed" && !force) {
    const extra = last.outcome === "accepted" ? "" : "; pass --force to record another attempt";
    return { action: "refuse", detail: `last attempt is ${last.outcome}${extra}` };
  }
  const claimed = appendAttempt(repo, job, payload, { at: new Date().toISOString(), outcome: "attempting", http: null, detail: "acceptance unknown" }, record);
  if (!claimed) return { action: "already", detail: "attempt already recorded" };
  const sent = await postFinish(config, payload);
  try {
    settleAttempt(repo, job.id, sent);
  } catch {
    return { action: sent.outcome, detail: `${sent.detail}; could not record result`, http: sent.http };
  }
  return { action: sent.outcome, detail: sent.detail, http: sent.http };
}

function finishLine(result) {
  if (!result) return "";
  if (result.action === "off") return "finish webhook: off";
  if (result.action === "dry-run") return result.lines.map((line) => `finish webhook: ${line}`).join("\n");
  if (result.action === "accepted") return `finish webhook: ${result.detail}`;
  if (result.action === "already") return `finish webhook: already recorded (${result.detail}); not sent again`;
  if (result.action === "refuse") return `finish webhook: ${result.detail}`;
  if (result.action === "failed" || result.action === "unknown") return `finish webhook: ${result.action}: ${result.detail}`;
  return `finish webhook: ${result.action}${result.detail ? `: ${result.detail}` : ""}`;
}

function finishStatusLine(repo, job) {
  const record = readFinishRecord(repo, job.id);
  if (record?.corrupt) return "finish webhook: record corrupt";
  const last = lastAttempt(record);
  if (last) {
    const http = last.http ? ` HTTP ${last.http}` : "";
    return `finish webhook: ${last.outcome}${http} attempt ${record.attempts.length} (${last.detail})`;
  }
  const config = readFinishConfig(repo);
  if (config.off) return "finish webhook: off";
  if (config.error) return `finish webhook: ${config.error}`;
  return "finish webhook: configured, not sent";
}

// Saves the terminal status first. A sender failure cannot flip it back.
async function markTerminal(repo, job, status, reason) {
  if (!FINISH_STATUSES.has(status)) fail(`not a terminal status: ${status}`);
  job.status = status;
  job.finished = new Date().toISOString();
  if (reason) job.stopReason = reason;
  save(repo, job);
  try {
    return await deliverFinish(repo, job);
  } catch (err) {
    return { action: "failed", detail: err?.orca ? err.message : "sender error" };
  }
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
  return alias ? `claude --model ${alias}` : "pi";
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

function workerPrompt(job, name, task, alias) {
  const dir = jobDir(job.repo, job.id);
  const result = join(dir, "results", `${name}.json`);
  const note = join(dir, "notes", `${name}.txt`);
  return [
    `You are a worker for orca job ${job.id} (${paneCommand(alias)}). Do this task and stop.`,
    `Work only in this shared checkout: ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Other workers share this worktree. Do not revert their files. Do not create a branch, worktree, or push.`,
    `Browser checks, if this task needs them, go in ${VERIFY_FILE} at the worktree root, or the path in ${join(job.repo, ".orca", "config.json")} "verify".`,
    `Shape: {"steps":[["open","http://HOST:PORT/"],{"visible":"SELECTOR"},{"text":"SELECTOR","includes":"EXPECTED"}]}`,
    `Use this project's URL. Do not copy a host or port from another repo. Do not run orca verify unless the task says so.`,
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
    `Finish wake is automatic from the orca CLI when it marks the job done, failed, or stopped. That is not your job. Do not run herdr-finish-watch. Do not run orca stop or orca webhook. Do not start another agent.`,
  ].join("\n");
}

function orchestratorPrompt(job) {
  const dir = jobDir(job.repo, job.id);
  const pi = job.kind === "pi";
  return [
    `You are the orchestrator for orca job ${job.id}, not the implementer.`,
    `Do not implement the goal yourself. Do not edit the repo to satisfy the goal.`,
    `Split the goal into the smallest set of worker tasks, then start one worker per task.`,
    `When tasks are independent, start several workers in parallel (several orca worker calls, one per task) instead of one after another.`,
    `Workers share one worktree, so never give two workers the same files. Split by file or area so edits cannot clash.`,
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
    ...(pi
      ? [`Workers are Pi agents (kind pi). Do not pass --model; pi workers have no model flag.`, `Pane command: ${paneCommand("")}`]
      : [
          `That uses this job's worker model (${job.workerModel}). Pass --model <alias> only to override one worker.`,
          `Pane command: ${paneCommand(job.workerModel)}`,
        ]),
    ``,
    `Each worker writes ${dir}/results/<name>.json and a one-line note at ${dir}/notes/<name>.txt,`,
    `then prompts you with that note. Read those files. Do not trust a worker that skipped them.`,
    `Finish wake is automatic from the orca CLI when it marks the job done, failed, or stopped. That is not your job. Do not run herdr-finish-watch. Do not run orca stop or orca webhook.`,
    ``,
    `When every worker has reported, run project checks before the summary:`,
    `  orca verify ${job.id}`,
    `If orca is not on PATH, run ${ORCA} verify ${job.id}.`,
    `That drives agent-browser from checks in this worktree. It does not assume a host, port, or app.`,
    `Default file: ${VERIFY_FILE} here. Or "verify" in ${join(job.repo, ".orca", "config.json")} (relative to this worktree, or false to disable).`,
    `No checks file skips and exits 0. That is not a failure. If verify fails, the goal is not done: say so in the summary and stop.`,
    `Do not invent a URL or a checks file unless the goal asked for checks.`,
    ``,
    `Then read ${jobPath(job.repo, job.id)} again, write a short summary to ${dir}/summary.txt`,
    `and set the "summary" field to that same text. Keep every other field, including verify.`,
    `Do not change verify; orca verify writes that. Then stop working.`,
  ].join("\n");
}

function leadPrompt(job) {
  return orchestratorPrompt(job);
}

function printDryRun(repo, job) {
  const wt = job.worktree || worktreePath(repo, job.id);
  const branch = job.branch || `orca/${job.id}`;
  const name = job.agent || agentName(job.id);
  const kind = job.kind === "pi" ? "pi" : "claude";
  const orchestratorModel = kind === "claude" ? job.orchestratorModel || job.model : "";
  const workerModel = kind === "claude" ? job.workerModel : "";
  if (kind === "claude" && (!orchestratorModel || !workerModel)) fail("claude job is missing orchestratorModel or workerModel");
  console.log(`dry-run ${job.id} kind=${kind} status=${job.status}`);
  console.log(`repo: ${repo}`);
  console.log(`branch: ${branch}`);
  console.log(`worktree: ${wt}`);
  console.log(`layout: shared worktree (workers do not get sibling checkouts)`);
  console.log(`git: git -C ${q(repo)} worktree add -b ${q(branch)} ${q(wt)} HEAD`);
  console.log(`workspace: herdr workspace create --cwd ${q(wt)} --label ${q(`orca-${job.id}`.slice(0, 40))} --no-focus --env PATH=<orca-bins>:$PATH`);
  console.log(`lead: herdr ${sh(startArgs(name, "<pane>", kind, orchestratorModel))}`);
  if (kind === "claude") {
    console.log(`models: orchestrator=${orchestratorModel} worker=${workerModel}`);
    console.log(`pane: ${paneCommand(orchestratorModel)}`);
    console.log(`worker: orca worker --job ${job.id} --name <worker> --task "<task>"`);
    console.log(`worker-pane: ${paneCommand(workerModel)}`);
    console.log(`worker-lead: herdr ${sh(startArgs("<worker>", "<pane>", "claude", workerModel))}`);
  } else {
    console.log("role: orchestrator (pi)");
    console.log(`pane: ${paneCommand("")}`);
    console.log(`worker: orca worker --job ${job.id} --name <worker> --task "<task>"`);
    console.log(`worker-pane: ${paneCommand("")}`);
    console.log(`worker-lead: herdr ${sh(startArgs("<worker>", "<pane>", "pi", ""))}`);
  }
  console.log("finish webhook: posts {job, status, branch} when the CLI marks done, failed, or stopped");
  console.log(`verify: orca verify ${job.id} (skips when the worktree has no checks file)`);
}

function assignClaudeModels(job, args) {
  if (job.kind !== "claude") {
    if (args["orchestrator-model"] || args["worker-model"]) fail("--orchestrator-model and --worker-model are only for kind claude");
    return;
  }
  const models = claudeModels(job, args);
  job.orchestratorModel = models.orchestratorModel;
  job.workerModel = models.workerModel;
  job.model = models.orchestratorModel;
}

function cmdNew(args) {
  if ("model" in args) fail("use --worker-model on orca new, not --model");
  allowFlags(args, ["cwd", "title", "goal", "kind", "orchestrator-model", "worker-model"]);
  const title = args.title;
  const goal = args.goal;
  const kind = args.kind || "claude";
  if (!title || !goal) fail("need --title and --goal");
  if (kind !== "pi" && kind !== "claude") fail("kind must be pi or claude");
  if (kind === "pi" && (args["orchestrator-model"] || args["worker-model"])) {
    fail("--orchestrator-model and --worker-model are only for kind claude");
  }
  const orchestratorModel = kind === "claude" ? assertClaudeModel(flagValue(args, "orchestrator-model") || DEFAULT_ORCHESTRATOR_MODEL, "orchestrator") : "";
  const workerModel = kind === "claude" ? assertClaudeModel(flagValue(args, "worker-model") || DEFAULT_WORKER_MODEL, "worker") : "";
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
    model: orchestratorModel,
    orchestratorModel,
    workerModel,
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
  const alias = kind === "claude" ? job.orchestratorModel || job.model : "";
  if (kind === "claude" && !alias) fail("job has no orchestratorModel");
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

async function cmdRun(args) {
  if ("model" in args) fail("use --orchestrator-model and --worker-model on orca run, not --model");
  allowFlags(args, ["cwd", "dry-run", "orchestrator-model", "worker-model"]);
  const id = args._[1];
  if (!id) fail("need id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status !== "queued") fail(`job ${id} is ${job.status}, not queued`);
  assignClaudeModels(job, args);
  if (args["dry-run"]) {
    printDryRun(repo, job);
    return;
  }
  if (job.kind === "claude") save(repo, job);
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
      try {
        const wake = await markTerminal(repo, job, "failed", err.message);
        console.error(finishLine(wake));
      } catch (markErr) {
        console.error(markErr?.message || markErr);
      }
    }
    throw err;
  }
  const extra = job.kind === "claude" ? ` role=orchestrator model=${job.orchestratorModel} worker=${job.workerModel}` : " role=orchestrator kind=pi";
  console.log(`${id} running pane=${job.pane} agent=${job.agent} branch=${job.branch} worktree=${job.worktree}${extra}`);
}

function splitPane(fromPane, cwd) {
  const split = herdr(["pane", "split", "--pane", fromPane, "--direction", "right", "--cwd", cwd, "--no-focus", "--env", `PATH=${pathPrefix()}`]);
  const pane = split.json?.result?.pane?.pane_id;
  if (!pane) herdrFail(split, "pane split");
  return pane;
}

function workerAlias(job, args) {
  if (job.kind === "pi") {
    if ("model" in args) fail("--model is only for kind claude; pi workers have no model flag");
    return "";
  }
  return assertClaudeModel(flagValue(args, "model") || job.workerModel || DEFAULT_WORKER_MODEL, "worker");
}

function cmdWorker(args) {
  if ("orchestrator-model" in args || "worker-model" in args) {
    fail("use --model to override a worker; the job default is workerModel");
  }
  allowFlags(args, ["cwd", "dry-run", "job", "name", "task", "pane", "model"]);
  const id = args.job;
  const name = args.name;
  const task = args.task || args._.slice(1).join(" ");
  if (!id || !name || !task) fail("need --job --name --task");
  assertAgentName(String(name));
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, String(id));
  const alias = workerAlias(job, args);
  const kind = job.kind === "pi" ? "pi" : "claude";
  if (args["dry-run"]) {
    const wt = job.worktree || worktreePath(repo, job.id);
    console.log(`dry-run worker ${name} job=${job.id} kind=${kind}${alias ? ` model=${alias}` : ""}`);
    console.log(`worktree: ${wt}`);
    console.log("layout: shared worktree");
    console.log(`split: herdr pane split --pane ${q(job.pane || "<orchestrator-pane>")} --direction right --cwd ${q(wt)} --no-focus`);
    console.log(`spawn: herdr ${sh(startArgs(String(name), args.pane || "<pane>", kind, alias))}`);
    console.log(`pane: ${paneCommand(alias)}`);
    return;
  }
  if (!job.pane || !job.agent || !job.worktree) fail("orchestrator is not running");
  if (job.status !== "running") fail(`job ${id} is ${job.status}, not running`);
  ensureJobDir(repo, job.id);
  const pane = args.pane ? String(args.pane) : splitPane(job.pane, job.worktree);
  const started = herdr(startArgs(String(name), pane, kind, alias), 90000);
  if (started.code !== 0 || started.json?.error) herdrFail(started, "worker start");
  promptWithRetry(String(name), workerPrompt(job, String(name), String(task), alias));
  job.workers = job.workers || [];
  job.workers.push({
    name: String(name),
    pane,
    kind,
    model: alias,
    task: String(task),
    result: join(jobDir(repo, job.id), "results", `${name}.json`),
    note: join(jobDir(repo, job.id), "notes", `${name}.txt`),
  });
  save(repo, job);
  console.log(`${id} worker ${name} pane=${pane} kind=${kind}${alias ? ` model=${alias}` : ""} worktree=${job.worktree}`);
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
  allowFlags(args, ["cwd"]);
  const id = args._[1];
  const repo = requireRepo(args.cwd || process.cwd());
  if (id) {
    const job = load(repo, id);
    line(job);
    console.log(`  repo: ${repo}`);
    console.log(`  branch: ${job.branch || `orca/${job.id}`}`);
    console.log(`  worktree: ${job.worktree || "(not created)"}`);
    console.log(`  layout: ${job.workerLayout || "shared-worktree"}`);
    if (job.kind === "claude") console.log(`  models: orchestrator=${job.orchestratorModel || job.model || "-"} worker=${job.workerModel || "-"}`);
    if (job.agent || job.pane) console.log(`  agent: ${job.agent || "-"} pane=${job.pane || "-"} workspace=${job.workspace || "-"} model=${job.orchestratorModel || job.model || "-"}`);
    for (const worker of job.workers || []) console.log(`  worker: ${worker.name} pane=${worker.pane} ${worker.model ? `model=${worker.model}` : "kind=pi"}`);
    const summary = summaryOf(repo, job);
    if (summary) console.log(`  summary: ${summary}`);
    if (job.stopReason) console.log(`  stop: ${job.stopReason}`);
    console.log(`  ${finishStatusLine(repo, job)}`);
    printVerifyStatus(repo, job);
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
  allowFlags(args, ["cwd"]);
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

async function cmdStop(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need id");
  const reason = args._.slice(2).join(" ").trim() || "stopped by request";
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (args["dry-run"]) {
    if (job.status !== "running" && job.status !== "queued") {
      console.log(`dry-run stop ${id}: already ${job.status}; no status change; no finish webhook`);
      return;
    }
    console.log(`dry-run stop ${id}: ${job.status} -> stopped`);
    console.log(`reason: ${reason}`);
    const preview = await deliverFinish(repo, { ...job, status: "stopped" }, { dryRun: true });
    for (const line of preview.lines) console.log(`finish webhook: ${line}`);
    return;
  }
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
  const wake = await markTerminal(repo, job, "stopped", reason);
  console.log(`stopped ${id} (${how}): ${reason}`);
  console.log(finishLine(wake));
}

function webhookExit(result) {
  if (result.action === "accepted" || result.action === "dry-run" || result.action === "already") return 0;
  if (result.action === "refuse" && result.detail.includes("accepted")) return 0;
  return 1;
}

async function cmdWebhook(args) {
  allowFlags(args, ["cwd", "dry-run", "force"]);
  const id = args._[1];
  if (!id) fail("need id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (args["dry-run"]) {
    console.log(`dry-run webhook ${job.id}`);
    const preview = await deliverFinish(repo, job, { dryRun: true });
    for (const line of preview.lines) console.log(line);
    return;
  }
  const result = await deliverFinish(repo, job, { manual: true, force: !!args.force });
  console.log(finishLine(result));
  if (webhookExit(result) !== 0) process.exitCode = 1;
}

function readConfig(repo) {
  const path = configPath(repo);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`corrupt config ${path}`);
  }
}

function assertChecksFile(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    fail(`checks file not found: ${path}`);
  }
  if (!st.isFile()) fail(`checks path is not a file: ${path}`);
}

function resolveChecks(repo, worktree) {
  const cfg = readConfig(repo);
  if (cfg.verify === false) return { skip: true, reason: "disabled in .orca/config.json" };
  if (cfg.verify != null && cfg.verify !== "") {
    if (typeof cfg.verify !== "string") fail('config "verify" must be a path or false');
    const path = resolve(worktree, cfg.verify);
    if (!existsSync(path)) fail(`checks file not found: ${path}\nconfig verify is ${cfg.verify}`);
    assertChecksFile(path);
    return { path };
  }
  const path = join(worktree, VERIFY_FILE);
  if (!existsSync(path)) return { skip: true, reason: `no ${VERIFY_FILE}` };
  assertChecksFile(path);
  return { path };
}

function relTo(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..")) return path;
  return rel;
}

function verifySession(id) {
  const clean = String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `orca-verify-${clean || "job"}`;
}

function classifyChecks(path) {
  if (path.endsWith(".json")) return "json";
  const head = readFileSync(path, "utf8").replace(/^\uFEFF/, "").slice(0, 200).trimStart();
  if (!head) fail(`checks file is empty: ${path}`);
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  return "script";
}

function loadSteps(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    fail(`checks file is not JSON: ${path}\n${err.message}`);
  }
  let steps;
  if (Array.isArray(parsed)) steps = parsed;
  else if (parsed && typeof parsed === "object") {
    const extra = Object.keys(parsed).filter((key) => key !== "steps" && key !== "note");
    if (extra.length) fail(`unknown checks field: ${extra.join(", ")}`);
    if (!Array.isArray(parsed.steps)) fail("checks file needs a steps array");
    steps = parsed.steps;
  } else {
    fail("checks file must be a steps array or { steps: [...] }");
  }
  if (!steps.length) fail("checks file has no steps");
  if (steps.length > 100) fail("checks file has more than 100 steps");
  return steps;
}

function needString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} needs a non-empty string`);
  return value;
}

function rejectAssert(step, action) {
  if ("equals" in step || "includes" in step) fail(`${action} does not take equals or includes`);
}

function stepAction(step) {
  const actions = Object.keys(step).filter((key) => STEP_ACTIONS.has(key));
  if (actions.length !== 1) fail(`step needs one action (${[...STEP_ACTIONS].join(", ")}), got ${actions.join(", ") || "none"}`);
  const unknown = Object.keys(step).filter((key) => key !== actions[0] && key !== "equals" && key !== "includes");
  if (unknown.length) fail(`unknown step field ${unknown.join(", ")}`);
  return actions[0];
}

function assertSpec(label, step, mode) {
  const hasEq = "equals" in step;
  const hasIn = "includes" in step;
  if (mode === "equals") {
    if (!hasEq || hasIn) fail(`${label} needs equals`);
    return { equals: step.equals };
  }
  if (hasEq === hasIn) fail(`${label} needs exactly one of equals or includes`);
  if (hasEq) return { equals: step.equals };
  return { includes: step.includes };
}

function fillPair(value) {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !value[0].trim() || typeof value[1] !== "string") {
    fail("fill needs [selector, text]");
  }
  return value;
}

function planArgv(args) {
  if (!args.length || args.some((item) => typeof item !== "string" || item.trim() === "")) fail("argv step needs non-empty strings");
  if (args.some((item) => item === "--session" || item.startsWith("--session=") || item === "--json")) {
    fail("argv step must not set --session or --json; orca sets those");
  }
  const plan = { argv: args };
  if (args[0] === "is" && (args[1] === "visible" || args[1] === "enabled" || args[1] === "checked")) {
    if (!args[2]) fail(`is ${args[1]} needs a selector`);
    plan.assert = { flag: args[1] };
  }
  return plan;
}

function planStep(step) {
  if (Array.isArray(step)) return planArgv(step);
  if (!step || typeof step !== "object") fail("step must be an array or object");
  const action = stepAction(step);
  if (action === "open") {
    rejectAssert(step, action);
    return { argv: ["open", needString(step.open, "open")] };
  }
  if (action === "click") {
    rejectAssert(step, action);
    return { argv: ["click", needString(step.click, "click")] };
  }
  if (action === "press") {
    rejectAssert(step, action);
    return { argv: ["press", needString(step.press, "press")] };
  }
  if (action === "fill") {
    rejectAssert(step, action);
    const [sel, text] = fillPair(step.fill);
    return { argv: ["fill", sel, text] };
  }
  if (action === "waitText") {
    rejectAssert(step, action);
    return { argv: ["wait", "--text", needString(step.waitText, "waitText")] };
  }
  if (action === "wait") {
    rejectAssert(step, action);
    if (typeof step.wait === "number") {
      if (!Number.isFinite(step.wait) || step.wait < 0 || step.wait > 60000) fail("wait milliseconds must be between 0 and 60000");
      return { argv: ["wait", String(Math.trunc(step.wait))] };
    }
    return { argv: ["wait", needString(step.wait, "wait")] };
  }
  if (action === "visible") {
    rejectAssert(step, action);
    return { argv: ["is", "visible", needString(step.visible, "visible")], assert: { flag: "visible" } };
  }
  if (action === "title") {
    rejectAssert(step, action);
    return { argv: ["get", "title"], assert: { field: "title", equals: needString(step.title, "title") } };
  }
  if (action === "titleIncludes") {
    rejectAssert(step, action);
    return { argv: ["get", "title"], assert: { field: "title", includes: needString(step.titleIncludes, "titleIncludes") } };
  }
  if (action === "urlIncludes") {
    rejectAssert(step, action);
    return { argv: ["get", "url"], assert: { field: "url", includes: needString(step.urlIncludes, "urlIncludes") } };
  }
  if (action === "text") {
    const sel = needString(step.text, "text");
    return { argv: ["get", "text", sel], assert: { field: "text", ...assertSpec(`text ${sel}`, step, "either") } };
  }
  if (action === "count") {
    const sel = needString(step.count, "count");
    if ("includes" in step) fail("count needs equals, not includes");
    const spec = assertSpec(`count ${sel}`, step, "equals");
    if (typeof spec.equals !== "number") fail("count equals needs a number");
    return { argv: ["get", "count", sel], assert: { field: "count", ...spec } };
  }
  if (action === "get") {
    if (!Array.isArray(step.get) || !step.get.length || step.get.some((item) => typeof item !== "string" || !item.trim())) {
      fail("get needs a non-empty string array");
    }
    const field = GET_FIELDS[step.get[0]];
    if (!field) fail(`get ${step.get[0]} is not an assertion; use an argv step`);
    const spec = assertSpec(`get ${step.get.join(" ")}`, step, "either");
    if (field === "count" && ("includes" in spec || typeof spec.equals !== "number")) fail("count equals needs a number");
    return { argv: ["get", ...step.get], assert: { field, ...spec } };
  }
  fail(`unknown action ${action}`);
}

function isAssertion(plan) {
  if (plan.assert) return true;
  return plan.argv[0] === "wait" && plan.argv.some((arg) => arg === "--text" || arg === "--url" || arg === "--fn");
}

function loadPlans(path) {
  const steps = loadSteps(path);
  const plans = steps.map((step, index) => {
    try {
      return planStep(step);
    } catch (err) {
      fail(`step ${index + 1}: ${err?.orca ? err.message : err?.message || err}`);
    }
  });
  if (!plans.some(isAssertion)) fail("checks file does not assert anything (need visible, text, title, url, count, get, is, or wait --text)");
  return plans;
}

function describePlan(plan) {
  const base = plan.argv.join(" ");
  const assert = plan.assert;
  if (!assert) return base;
  if (assert.flag) return `${base} == true`;
  if ("equals" in assert) return `${base} equals ${JSON.stringify(assert.equals)}`;
  return `${base} includes ${JSON.stringify(assert.includes)}`;
}

function browser(session, args, cwd) {
  const r = spawnSync("agent-browser", ["--session", session, "--json", ...args], {
    cwd,
    encoding: "utf8",
    timeout: VERIFY_STEP_TIMEOUT_MS,
    env: { ...process.env, PATH: pathPrefix(), AGENT_BROWSER_SESSION: session },
  });
  if (r.error && r.error.code === "ENOENT") fail("agent-browser is not on PATH");
  if (r.error && r.error.code === "ETIMEDOUT") fail(`timed out after ${VERIFY_STEP_TIMEOUT_MS}ms: agent-browser ${args.join(" ")}`);
  const stdout = (r.stdout || "").trim();
  let json = null;
  if (stdout) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }
  return {
    code: r.status ?? 1,
    json,
    text: `${stdout}\n${r.stderr || ""}`.trim().slice(0, 2000),
    error: r.error,
  };
}

function requireOk(got, label) {
  if (got.code === 0 && got.json?.success === true && !got.json.error) return got.json.data || {};
  const detail = got.json?.error || got.text || got.error?.message || "agent-browser failed";
  fail(`${label}: ${String(detail).slice(0, 400)}`);
}

function compare(label, value, spec) {
  if (value === undefined) fail(`${label}: agent-browser returned no value`);
  if ("includes" in spec) {
    const expected = spec.includes;
    if (typeof expected !== "string" && typeof expected !== "number") fail(`${label}: includes needs a string`);
    if (value === null || (typeof value !== "string" && typeof value !== "number")) fail(`${label}: cannot search ${JSON.stringify(value)}`);
    if (!String(value).includes(String(expected))) fail(`${label}: ${JSON.stringify(value)} does not include ${JSON.stringify(expected)}`);
    return;
  }
  const expected = spec.equals;
  if (typeof expected === "number" || typeof value === "number") {
    if (typeof expected !== "number" || typeof value !== "number" || value !== expected) {
      fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
    }
    return;
  }
  if (typeof expected === "string" || typeof value === "string") {
    const got = typeof value === "string" ? value.trim() : value;
    const want = typeof expected === "string" ? expected.trim() : expected;
    if (got !== want) fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    return;
  }
  if (value !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
}

function execPlan(session, plan, cwd) {
  const data = requireOk(browser(session, plan.argv, cwd), plan.argv.join(" "));
  const assert = plan.assert;
  if (!assert) return;
  if (assert.flag) {
    if (!data || data[assert.flag] !== true) fail(`${assert.flag} is not true`);
    return;
  }
  if (!data || !(assert.field in data)) fail(`response has no ${assert.field}`);
  compare(plan.argv.join(" "), data[assert.field], assert);
}

function runPlans(session, plans, cwd, logPath) {
  plans.forEach((plan, index) => {
    const label = `${index + 1}/${plans.length} ${describePlan(plan)}`;
    appendFileSync(logPath, `step ${label}\n`);
    try {
      execPlan(session, plan, cwd);
      appendFileSync(logPath, `ok ${label}\n`);
    } catch (err) {
      const msg = err?.orca ? err.message : err?.message || String(err);
      appendFileSync(logPath, `fail ${label}: ${msg}\n`);
      fail(`step ${index + 1}/${plans.length} (${describePlan(plan)}): ${msg}`);
    }
  });
}

function closeSession(session, cwd) {
  try {
    spawnSync("agent-browser", ["--session", session, "close"], {
      cwd,
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, PATH: pathPrefix(), AGENT_BROWSER_SESSION: session },
    });
  } catch {
    // a missing browser should not hide the verify result
  }
}

function runScript(path, cwd, session, logPath, job) {
  const text = readFileSync(path, "utf8");
  const executable = (statSync(path).mode & 0o111) !== 0;
  let cmd;
  let args;
  if (executable) {
    cmd = path;
    args = [];
  } else {
    const shebang = text.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
    if (shebang && shebang[1] === "/usr/bin/env" && shebang[2]) {
      cmd = shebang[2];
      args = [path];
    } else if (shebang) {
      cmd = shebang[1];
      args = [path];
    } else {
      cmd = "bash";
      args = [path];
    }
  }
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: VERIFY_SCRIPT_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: pathPrefix(),
      AGENT_BROWSER_SESSION: session,
      ORCA_JOB: job.id,
      ORCA_REPO: job.repo,
      ORCA_WORKTREE: job.worktree,
      ORCA_BRANCH: job.branch || "",
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim().slice(-4000);
  if (out) appendFileSync(logPath, `${out}\n`);
  if (r.error && r.error.code === "ETIMEDOUT") fail("checks script timed out after 600s");
  if (r.error && r.error.code === "ENOENT") fail(`cannot run checks script: ${cmd} is not on PATH`);
  if ((r.status ?? 1) !== 0) fail(`checks script exited ${r.status ?? 1}${out ? `\n${out.slice(-800)}` : ""}`);
}

function recordFailed(repo, job, err, file) {
  const msg = err?.orca ? err.message : err?.message || String(err);
  try {
    recordVerify(repo, job, { status: "failed", summary: msg, file: file || "" });
  } catch {
    // keep the verify error
  }
}

function recordVerify(repo, job, result) {
  job.verify = {
    status: result.status,
    at: new Date().toISOString(),
    file: result.file || "",
    summary: String(result.summary || "").slice(0, 500),
  };
  if (result.log) job.verify.log = result.log;
  if (result.steps != null) job.verify.steps = result.steps;
  save(repo, job);
}

function printVerifyStatus(repo, job) {
  if (job.verify?.status) {
    const file = job.verify.file ? ` ${job.verify.file}` : "";
    const summary = String(job.verify.summary || "").replace(/\s+/g, " ").slice(0, 240);
    console.log(`  verify: ${job.verify.status}${file}${summary ? ` - ${summary}` : ""}`);
    if (job.verify.log && job.verify.status === "failed") console.log(`  verify-log: ${job.verify.log}`);
    return;
  }
  if (!job.worktree || !existsSync(job.worktree)) return;
  let checks;
  try {
    checks = resolveChecks(repo, job.worktree);
  } catch {
    return;
  }
  if (checks.skip) return;
  console.log(`  verify: not run (${relTo(job.worktree, checks.path)})`);
}

function printVerifyDryRun(id, job, path, kind) {
  console.log(`dry-run verify ${id}`);
  console.log(`worktree: ${job.worktree}`);
  console.log(`checks: ${path}`);
  console.log(`kind: ${kind}`);
  console.log(`session: ${verifySession(id)}`);
  if (kind === "script") {
    console.log("would run the script with AGENT_BROWSER_SESSION set, then close that session");
    return;
  }
  const plans = loadPlans(path);
  console.log(`steps: ${plans.length}`);
  plans.forEach((plan, index) => console.log(`  ${index + 1}. ${describePlan(plan)}`));
}

function cmdVerify(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need id");
  if (args._.length > 2) fail("verify takes one job id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (!job.worktree) fail(`job ${id} has no worktree; run it before verify`);
  if (!existsSync(job.worktree)) fail(`worktree missing: ${job.worktree}`);
  let checks;
  try {
    checks = resolveChecks(repo, job.worktree);
  } catch (err) {
    if (!args["dry-run"]) recordFailed(repo, job, err, "");
    throw err;
  }
  if (checks.skip) {
    if (!args["dry-run"]) recordVerify(repo, job, { status: "skipped", summary: checks.reason, file: "" });
    console.log(`verify skipped ${id}: ${checks.reason}`);
    return;
  }
  let kind;
  try {
    kind = classifyChecks(checks.path);
  } catch (err) {
    if (!args["dry-run"]) recordFailed(repo, job, err, relTo(job.worktree, checks.path));
    throw err;
  }
  if (args["dry-run"]) {
    printVerifyDryRun(id, job, checks.path, kind);
    return;
  }
  const session = verifySession(id);
  const logPath = join(ensureJobDir(repo, id), "verify.log");
  const file = relTo(job.worktree, checks.path);
  writeFileSync(logPath, `verify ${id}\nat ${new Date().toISOString()}\nfile ${checks.path}\nsession ${session}\nkind ${kind}\n`);
  let started = false;
  try {
    if (kind === "json") {
      const plans = loadPlans(checks.path);
      started = true;
      closeSession(session, job.worktree);
      runPlans(session, plans, job.worktree, logPath);
      recordVerify(repo, job, {
        status: "passed",
        summary: `passed ${plans.length} steps`,
        file,
        steps: plans.length,
        log: logPath,
      });
      console.log(`verify passed ${id} (${plans.length} steps) ${file}`);
      return;
    }
    started = true;
    closeSession(session, job.worktree);
    runScript(checks.path, job.worktree, session, logPath, job);
    recordVerify(repo, job, { status: "passed", summary: "script passed", file, log: logPath });
    console.log(`verify passed ${id} (script) ${file}`);
  } catch (err) {
    const msg = err?.orca ? err.message : err?.message || String(err);
    try {
      recordVerify(repo, job, { status: "failed", summary: msg, file, log: logPath });
    } catch {
      // keep the verify error
    }
    const withLog = msg.includes(logPath) ? msg : `${msg}\nlog: ${logPath}`;
    if (err?.orca) {
      err.message = `verify failed ${id}: ${withLog}`;
      throw err;
    }
    fail(`verify failed ${id}: ${withLog}`);
  } finally {
    if (started) closeSession(session, job.worktree);
  }
}

function help() {
  console.log(`orca — one job in a linked worktree

  orca init [--cwd <repo>]
  orca new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi]
           [--orchestrator-model <alias>] [--worker-model <alias>]
  orca run <id> [--dry-run] [--cwd <repo>]
           [--orchestrator-model <alias>] [--worker-model <alias>]
  orca worker --job <id> --name <agent> --task "..." [--model <alias>] [--dry-run]
           (--model is claude only; pi workers have no model flag)
  orca status [id] [--cwd <repo>]
  orca steer <id> "message"
  orca stop <id> [reason] [--dry-run]
  orca webhook <id> [--dry-run] [--force] [--cwd <repo>]
  orca verify <id> [--dry-run] [--cwd <repo>]
  orca help

Jobs: <repo>/.orca/jobs/<id>.json
Worktree: <repo>/.orca/worktrees/<id> on branch orca/<id>
Workers share that worktree. Sibling worktrees are not in v0.

kind claude (default)
  Defaults: orchestrator ${DEFAULT_ORCHESTRATOR_MODEL} (Opus 5.5), worker ${DEFAULT_WORKER_MODEL} (Sonnet 5.5).
  The job stores orchestratorModel and workerModel. new sets them. run may replace them.
  orca worker --model overrides one worker; the job default stays workerModel.
  Aliases are checked against claude --help. Unknown aliases fail. The error lists the aliases named there.
  A full model name (claude-…) is accepted when help says so.
  run starts the orchestrator (claude --model <orchestratorModel>) in a Herdr pane.
  It does not implement the goal. It starts workers with orca worker
  (claude --model <workerModel>) in extra panes, same worktree.
  Herdr has no --model flag. The alias is an agent argument.

kind pi
  run starts a Pi orchestrator (pi) in a Herdr pane. It does not implement the goal.
  It starts Pi workers with orca worker (pi, no model flag) in extra panes, same worktree.
  No Opus or Sonnet. --orchestrator-model, --worker-model and worker --model are refused.

Multi-worker (both kinds)
  The orchestrator splits the goal and starts one worker per task. Independent tasks
  start in parallel (several orca worker calls). All workers share one worktree, so no
  two workers get the same files.

A prompt that is still idle after ~8s is sent once more.
status reads the job file. It does not poll Herdr. One job also prints the finish-wake record and verify.
stop closes the job workspace, or interrupts the lead if there is no workspace, then marks stopped.
A failed run marks failed after the worktree or pane exists. Idle is not terminal.

Finish wake is automatic from this CLI when it marks a job done, failed, or stopped.
It POSTs {"job","status","branch"} once, using <repo>/.orca/secrets/finish-webhook.env (mode 600).
Keys are WEBHOOK_URL and WEBHOOK_KEY, the same pair as herdr-finish-wake.env. Off if that file is missing.
This CLI does not read a home path and does not run herdr-finish-watch. Agents must not either.
A failed POST does not change job status. The attempt is <repo>/.orca/jobs/<id>.finish.json.
orca webhook retries a failed attempt and records it. --dry-run prints the payload and does not send.
Example (not a secret): examples/finish-webhook.env

verify
  Runs project checks in the job worktree through agent-browser.
  Default file: orca.verify.json at the worktree root. Commit it. It is not under .orca/.
  Override: "verify" in <repo>/.orca/config.json, a path relative to the worktree, or false to disable.
  No checks file skips (exit 0, verify.status skipped). That is not a pass.
  Invalid or failing checks fail closed (exit 1, verify.status failed).
  The checks file names the URL. This command does not assume a host, port, or app.
  agent-browser must be on PATH. This CLI does not install it.
  Example: {"steps":[["open","http://127.0.0.1:3000/"],{"visible":"h1"},{"text":"h1","includes":"Ready"}]}
  See README. examples/orca.verify.json is an example only; orca does not run it.

claude must be on PATH in the pane, and on PATH here so aliases can be checked.
This CLI does not install it.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "help";
  if (args.help || cmd === "help") {
    help();
    return;
  }
  if (cmd === "init") cmdInit(args);
  else if (cmd === "new") cmdNew(args);
  else if (cmd === "run") await cmdRun(args);
  else if (cmd === "worker") cmdWorker(args);
  else if (cmd === "status") cmdStatus(args);
  else if (cmd === "steer") cmdSteer(args);
  else if (cmd === "stop") await cmdStop(args);
  else if (cmd === "webhook") await cmdWebhook(args);
  else if (cmd === "verify") cmdVerify(args);
  else fail(`unknown command ${cmd}\nrun: orca help`);
}

try {
  await main();
} catch (err) {
  console.error(err && err.orca ? err.message : err?.message || err);
  process.exit(1);
}
