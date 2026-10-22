#!/usr/bin/env node
// orka v0 (formerly orca) — job file in <repo>/.orka/jobs, linked worktree at
// <repo>/.orka/worktrees/<id> on branch orka/<id>. Workers share that worktree.
// Repos and jobs from orca keep .orca/ and orca/<id>; lib/brand.mjs holds the fallbacks.
// Finish wake: when the CLI marks done|failed|stopped, POST {job, status, branch}
// if <repo>/.orka/secrets/finish-webhook.env exists. Never a home path.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DECISION_ROWS, DIGEST_MAX, FILE_READ_MAX, SUMMARY_MAX, VERIFIER_JSON_MAX, renderDigest, steerText } from "../lib/digest.mjs";
import * as brand from "../lib/brand.mjs";
import * as browsers from "../lib/browsers.mjs";
import * as context from "../lib/context.mjs";
import * as lifecycle from "../lib/lifecycle.mjs";
import * as ports from "../lib/ports.mjs";
import * as watch from "../lib/watch.mjs";

const ORKA = fileURLToPath(import.meta.url);
// Defaults only. A claude job stores the aliases it will actually run.
// opus is Opus 5.5 and sonnet is Sonnet 5.5 on current Claude Code; the alias
// tracks the latest model of that family, so these are not pinned ids.
const DEFAULT_ORCHESTRATOR_MODEL = "opus";
const DEFAULT_WORKER_MODEL = "sonnet";
const VERIFY_STEP_TIMEOUT_MS = 90000;
const VERIFY_SCRIPT_TIMEOUT_MS = 600000;
// Default checks file name; a worktree that already has orca.verify.json keeps using it.
const VERIFY_FILE = "orka.verify.json";
const verifyFile = (dir) => brand.fileName(dir, "verify.json");
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
  "verifier-model",
  "model",
  "role",
  "max-rounds",
  "playbook",
  "give-up",
  "premise",
  "older-than",
  "orphan-hours",
  "worker",
]);
const BOOL_FLAGS = new Set(["dry-run", "help", "force", "keep", "base", "ui"]);
const FINISH_STATUSES = new Set(["done", "failed", "stopped"]);
const VERIFIER_NAME = "verifier";
const FINISH_TIMEOUT_MS = 8000;

function fail(msg) {
  const err = new Error(msg);
  err.orka = true;
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
  const extra = [join(homedir(), ".local", "bin"), join(homedir(), "bin"), dirname(ORKA)];
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

const CLAUDE_HELP_TIMEOUT_MS = 120000;
const MODEL_CACHE_MAX_AGE_MS = 24 * 3600 * 1000;

// claude --help takes a minute under heavy load, so the parsed aliases are cached on disk.
// Kept under the repo's state dir (.orka/, or .orca/ in an older repo; gitignored), never in a home directory.
let activeRepo = null;

function modelCachePath() {
  return activeRepo ? join(brand.stateDir(activeRepo), "cache", "claude-models.json") : null;
}

function readModelCache() {
  try {
    const data = JSON.parse(readFileSync(modelCachePath(), "utf8"));
    if (!Array.isArray(data.aliases) || !data.aliases.length || Date.now() - Date.parse(data.at) > MODEL_CACHE_MAX_AGE_MS) return null;
    return { aliases: data.aliases.map(String), acceptsFullName: Boolean(data.acceptsFullName) };
  } catch {
    return null;
  }
}

function writeModelCache(spec) {
  try {
    const path = modelCachePath();
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...spec }));
  } catch {
    // the cache is only an optimisation
  }
}

function claudeHelpText() {
  const r = spawnSync("claude", ["--help"], {
    encoding: "utf8",
    timeout: CLAUDE_HELP_TIMEOUT_MS,
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

function claudeModelSpec(refresh = false) {
  if (modelSpec && !refresh) return modelSpec;
  if (!refresh) {
    const cached = readModelCache();
    if (cached) {
      modelSpec = { ...cached, cached: true };
      return modelSpec;
    }
  }
  const blob = modelHelpBlob(claudeHelpText());
  const aliases = [];
  for (const match of blob.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9._:-]*)['"]/g)) aliases.push(match[1].toLowerCase());
  modelSpec = {
    aliases: [...new Set(aliases)],
    acceptsFullName: /full name/i.test(blob),
  };
  if (!modelSpec.aliases.length) fail("could not read model aliases from claude --help");
  writeModelCache(modelSpec);
  return modelSpec;
}

function isFullModelName(alias) {
  return /^claude-[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(alias);
}

// Aliases the installed claude accepts but its --help text does not list.
const EXTRA_MODEL_ALIASES = ["haiku"];

function assertClaudeModel(raw, role) {
  const alias = String(raw ?? "").trim();
  if (!alias) fail(`need a ${role} model alias`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(alias)) fail(`invalid model alias "${alias}"`);
  let spec = claudeModelSpec();
  const lookup = () => [...spec.aliases, ...EXTRA_MODEL_ALIASES].find((item) => item === alias.toLowerCase());
  if (!lookup() && spec.cached) spec = claudeModelSpec(true); // an alias the cache lacks may be new
  const known = lookup();
  if (known) return known;
  if (spec.acceptsFullName && isFullModelName(alias)) return alias.toLowerCase();
  const extra = spec.acceptsFullName ? "\na full model name (claude-…) is also accepted" : "";
  fail(`unknown model alias "${alias}" for ${role}\nknown aliases from claude --help: ${[...new Set([...spec.aliases, ...EXTRA_MODEL_ALIASES])].join(", ")}${extra}`);
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

// Task 10 playbooks are not built yet; this is the hook where a playbook that implies UI will return a reason.
function playbookImpliesUi() {
  return "";
}

function browserStepAction(step) {
  if (Array.isArray(step)) return String(step[0] || "");
  if (step && typeof step === "object") return Object.keys(step).find((key) => STEP_ACTIONS.has(key)) || "";
  return "";
}

function hasBrowserSteps(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const steps = Array.isArray(data) ? data : data?.steps;
    return Array.isArray(steps) && steps.some((step) => STEP_ACTIONS.has(browserStepAction(step)));
  } catch {
    return false;
  }
}

const BROWSER_CLOSE_TIMEOUT_MS = 20000;
const CLEANUP_BUDGET_MS = 120000;
const ORPHAN_BROWSER_HOURS = 2;
const UI_GOAL_RE = /agent-browser|\b(ui|browser|visual)\s+(verification|check|checks|test|tests|testing)\b|\b(verify|check|test)\s+(the\s+)?(ui|user interface|user flows?)\b/i;

// A job is ui when --ui is set, a playbook implies it, the checks file has browser steps, or the goal asks for browser/UI verification.
function detectJobType(repo, goal, ui, worktree) {
  if (ui) return { jobType: "ui", reason: "--ui flag" };
  if (playbookImpliesUi()) return { jobType: "ui", reason: playbookImpliesUi() };
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(repo), "utf8"));
  } catch {}
  const custom = typeof cfg.verify === "string" && cfg.verify ? cfg.verify : "";
  if (cfg.verify !== false) {
    const roots = [worktree, repo].filter(Boolean);
    const found = roots.map((root) => resolve(root, custom || verifyFile(root))).find((path) => existsSync(path) && hasBrowserSteps(path));
    if (found) return { jobType: "ui", reason: `${custom || relative(dirname(found), found)} has browser steps` };
  }
  if (UI_GOAL_RE.test(String(goal || ""))) return { jobType: "ui", reason: "goal asks for browser/UI verification" };
  return { jobType: "cli", reason: "" };
}

function verifierDefaultLabel(jobType, reason) {
  return jobType === "ui" ? `default: ui job, ${reason}` : "default: cli job";
}

// Precedence: --verifier-model flag > repo .orka/config.json "verifierModel" > the job-type default (ui sonnet, cli haiku).
// Returns the model and a short label of where it came from.
function resolveVerifierModel(repo, args, jobType, reason) {
  const flag = flagValue(args, "verifier-model");
  if (flag) return { model: assertClaudeModel(flag, "verifier"), source: "--verifier-model" };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath(repo), "utf8")).verifierModel;
  } catch {}
  if (cfg) return { model: assertClaudeModel(String(cfg), "verifier"), source: "config verifierModel" };
  return { model: assertClaudeModel(jobType === "ui" ? "sonnet" : "haiku", "verifier"), source: verifierDefaultLabel(jobType, reason) };
}

function verifierLabel(job) {
  return `verifier=${job.verifierModel || job.workerModel} (${job.verifierSource || "job file"})`;
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
  return join(brand.stateDir(repo), "config.json");
}

function requireRepo(start) {
  const { primary } = gitMeta(start);
  if (!existsSync(configPath(primary))) fail(`not an orka repo: ${primary}\nrun: orka init`);
  activeRepo = primary;
  return primary;
}

function ensureGitignore(repo, dirName) {
  const path = join(repo, ".gitignore");
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.split("\n").some((line) => line.trim() === `${dirName}/` || line.trim() === dirName)) return false;
  const block = `# orka: job state, worktrees, and secrets\n${dirName}/\n`;
  const next = cur && !cur.endsWith("\n") ? `${cur}\n\n${block}` : `${cur}${cur ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return true;
}

function cmdInit(args) {
  allowFlags(args, ["cwd"]);
  const start = args.cwd || process.cwd();
  const { primary, linked } = gitMeta(start);
  if (linked) fail("orka init must run in the primary checkout, not a linked worktree");
  // An existing .orca/ stays the state dir; nothing is moved.
  const dirName = brand.stateDirName(primary);
  const dir = join(primary, dirName);
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
          jobs: `${dirName}/jobs`,
          worktrees: `${dirName}/worktrees`,
          secrets: `${dirName}/secrets`,
          created: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  }
  const ignored = ensureGitignore(primary, dirName);
  console.log(`${fresh ? "initialized" : "already initialized"} ${primary}`);
  if (ignored) console.log(`gitignored ${dirName}/ — commit that .gitignore line if you share the repo; do not commit ${dirName}/`);
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
  return join(brand.stateDir(repo), "jobs");
}

function jobPath(repo, id) {
  return join(jobsDir(repo), `${id}.json`);
}

function jobDir(repo, id) {
  return join(jobsDir(repo), id);
}

function worktreePath(repo, id) {
  return join(brand.stateDir(repo), "worktrees", id);
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

function loadAllJobs(repo) {
  if (!existsSync(jobsDir(repo))) return [];
  const out = [];
  for (const f of readdirSync(jobsDir(repo)).filter((f) => f.endsWith(".json") && !f.endsWith(".finish.json")).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(jobsDir(repo), f), "utf8")));
    } catch {
      // a corrupt record is not ours to sweep
    }
  }
  return out;
}

function save(repo, job) {
  mkdirSync(jobsDir(repo), { recursive: true });
  const path = jobPath(repo, job.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n");
  renameSync(tmp, path);
}

function finishEnvPath(repo) {
  return join(brand.stateDir(repo), "secrets", "finish-webhook.env");
}

function finishRecordPath(repo, id) {
  return join(jobsDir(repo), `${id}.finish.json`);
}

function insideStateDir(repo, path) {
  try {
    const primary = realpathSync(repo);
    const root = realpathSync(brand.stateDir(repo));
    const real = realpathSync(path);
    const stateRoot = join(primary, brand.stateDirName(repo));
    if (root !== stateRoot && !root.startsWith(stateRoot + sep)) return false;
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

function readFinishConfig(repo) {
  const path = finishEnvPath(repo);
  if (!existsSync(path)) return { off: true, path };
  if (!insideStateDir(repo, path)) return { error: `finish-webhook.env must stay inside ${brand.stateDirName(repo)} (no home path, no escaped symlink)` };
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

function roundOf(job) {
  const n = Number(job?.round);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

// The last attempt, or with a round the last attempt of that round (attempts
// written before follow-up rounds existed have no round and count as round 1).
function lastAttempt(record, round) {
  if (!record || record.corrupt || !record.attempts?.length) return null;
  const list = round ? record.attempts.filter((a) => (a.round || 1) === round) : record.attempts;
  return list.length ? list[list.length - 1] : null;
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
  const round = roundOf(job);
  attempt = { ...attempt, round };
  const entry = { round, status: payload.status, at: attempt.at, followUp: round > 1 };
  const record = prior
    ? {
        ...prior,
        status: payload.status,
        branch: payload.branch,
        rounds: [...(prior.rounds || []).filter((r) => r.round !== round), entry],
        attempts: [...prior.attempts, attempt],
      }
    : { v: 1, job: job.id, status: payload.status, branch: payload.branch, rounds: [entry], attempts: [attempt] };
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
  // Shape and field names are fixed. A job record without a branch predates orka, so its value stays orca/<id>.
  const payload = { job: job.id, status, branch: brand.jobBranch(job) };
  if (roundOf(job) > 1) {
    payload.round = roundOf(job);
    payload.followUp = true;
  }
  if (job.playbook) payload.playbook = job.playbook;
  const verifier = verifierLine(job);
  if (verifier) payload.verifier = verifier;
  const verification = verificationOf(job.repo, job);
  if (verification) payload.verification = verification;
  return payload;
}

function dryRunPlan(repo, job, status) {
  const payload = payloadOf(job, status);
  const config = readFinishConfig(repo);
  const record = readFinishRecord(repo, job.id);
  const last = lastAttempt(record, roundOf(job));
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
    if (!manual && lastAttempt(record, roundOf(job))) return { action: "already", detail: lastAttempt(record, roundOf(job)).detail || "already recorded" };
    const attempt = { at: new Date().toISOString(), outcome: "failed", http: null, detail: config.error, settled: new Date().toISOString() };
    if (!appendAttempt(repo, job, payload, attempt, record)) return { action: "already", detail: "attempt already recorded" };
    return { action: "failed", detail: config.error };
  }
  const last = lastAttempt(record, roundOf(job));
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

// orka-<sha8> for new jobs; jobs created by orca keep orca-<sha8>.
function browserPrefix(job) {
  return brand.sessionPrefix(job);
}

function noteSession(repo, job, session) {
  job.browserSessions = job.browserSessions || [];
  if (job.browserSessions.includes(session)) return;
  job.browserSessions.push(session);
  save(repo, job);
}

// Old verify sessions were orca-verify-<slug of the job id>.
function legacyVerifySession(job) {
  const clean = String(job.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `orca-verify-${clean || "job"}`;
}

// Session names agent-browser keeps state for. Read from its state dir: asking
// the CLI could start a daemon.
function browserList() {
  return browsers.stateSessions(browserStateDir());
}

// Job id of the verify run in this process, so every agent-browser it starts carries ORKA_JOB (and ORCA_JOB).
let verifyJobId = null;

// Env for any agent-browser orka launches: the daemon passes it on to Chrome, so
// the process is findable by ORKA_JOB / ORKA_WORKER (and the ORCA_* twins) even when it is orphaned.
function browserEnv(session, jobId = null) {
  const prefix = brand.SESSION_RE.exec(session);
  const env = { ...process.env, PATH: pathPrefix(), AGENT_BROWSER_SESSION: session };
  const job = jobId || verifyJobId || brand.env("JOB");
  if (job) Object.assign(env, brand.envPair("JOB", String(job)));
  const worker = brand.env("WORKER") || prefix?.[2];
  if (worker) Object.assign(env, brand.envPair("WORKER", worker));
  return env;
}

// Sessions agent-browser still lists, plus the ones this job recorded.
function jobSessions(job) {
  const prefix = `${browserPrefix(job)}-`;
  const names = new Set((job.browserSessions || []).filter((n) => n.startsWith(prefix)));
  for (const name of browserList()) if (name.startsWith(prefix)) names.add(name);
  return [...names];
}

function browserStateDir() {
  if (process.env.AGENT_BROWSER_SOCKET_DIR) return process.env.AGENT_BROWSER_SOCKET_DIR;
  if (process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, "agent-browser");
  return join(homedir(), ".agent-browser");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Sessions whose <name>.pid names a dead process. Empty if the dir is unreadable.
function orphanSessions() {
  let files;
  try {
    files = readdirSync(browserStateDir()).filter((f) => f.endsWith(".pid"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const pid = Number.parseInt(readFileSync(join(browserStateDir(), f), "utf8"), 10);
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) out.push(f.slice(0, -4));
  }
  return out;
}

// True when something of this session still runs (daemon or Chrome, found by
// session name in env/cmdline/process tree), or its pid file names a live process.
function sessionLive(session, procs = browsers.scanBrowsers()) {
  return procs.some((p) => p.session === session) || browsers.sessionPidAlive(browserStateDir(), session, pidAlive);
}

// Closes a session without ever starting a browser: a session with no live
// daemon or Chrome only has its state files deleted (agent-browser close would
// launch a fresh daemon + Chrome for it). A live one is closed, then anything of
// it that survives is killed. force: the caller just used the session, so close
// it for real even when it cannot be attributed.
function closeBrowser(session, { jobId = null, force = false, dry = false } = {}) {
  const procs = browsers.scanBrowsers();
  const live = force || sessionLive(session, procs);
  if (dry) return true;
  let ok = true;
  if (live) {
    const r = spawnSync("agent-browser", ["--session", session, "close"], {
      encoding: "utf8",
      timeout: BROWSER_CLOSE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: browserEnv(session, jobId),
    });
    ok = !r.error && (r.status ?? 1) === 0;
    killBrowserProcs(browsers.scanBrowsers().filter((p) => p.session === session), false);
  }
  browsers.deleteSessionState(browserStateDir(), session);
  return ok || !live;
}

// Frees what a finished job no longer needs, right away: its agent-browser
// sessions, dev/preview servers running inside its worktree, and the panes of
// its finished workers and verifier. The orchestrator pane and the Herdr
// workspace stay open so Olaf can still steer; orka cleanup closes the
// workspace once the job has been idle long enough.
function releaseJob(repo, job, opts = {}) {
  if (opts.keep || job.keep) {
    console.log(`cleanup: kept ${job.id} (--keep)`);
    return;
  }
  const dry = Boolean(opts.dryRun);
  const closed = { at: new Date().toISOString(), round: roundOf(job), browsers: [], servers: [], panes: [] };
  for (const s of jobSessions(job)) {
    if (dry) console.log(`cleanup: would close browser ${s}`);
    else if (closeBrowser(s, { jobId: job.id })) {
      console.log(`cleanup: closed browser ${s}`);
      closed.browsers.push(s);
    } else console.log(`cleanup: browser ${s} not closed`);
  }
  closed.browserPids = reapBrowsers(job, { dry });
  if (job.worktree && existsSync(job.worktree)) {
    const servers = lifecycle.findWorktreeServers(job.worktree);
    for (const p of servers) {
      const what = `server pid ${p.pid} (${String(p.cmdline).slice(0, 80)})`;
      console.log(`cleanup: ${dry ? "would stop" : "stopped"} ${what}`);
    }
    if (!dry && servers.length) {
      try {
        lifecycle.killProcesses(servers.map((p) => p.pid), { graceMs: 2000 });
      } catch (err) {
        console.log(`cleanup: could not stop a server: ${err.message}`);
      }
      closed.servers = servers.map((p) => ({ pid: p.pid, cmdline: String(p.cmdline).slice(0, 200) }));
    }
  }
  for (const w of job.workers || []) {
    if (!w.pane || w.closed || w.pane === job.pane) continue;
    if (dry) {
      console.log(`cleanup: would close worker pane ${w.pane} (${w.name})`);
      continue;
    }
    const got = herdr(["pane", "close", w.pane]);
    if (got.code === 0 && !got.json?.error) {
      console.log(`cleanup: closed worker pane ${w.pane} (${w.name})`);
      w.closed = closed.at;
      closed.panes.push({ name: w.name, pane: w.pane });
    } else console.log(`cleanup: worker pane ${w.pane} (${w.name}) not closed`);
  }
  if (dry) return;
  job.cleanup = closed;
  save(repo, job);
}

function killWatcher(job) {
  const pid = Number(job.watcherPid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    // Only a process that still looks like our watcher, never a recycled pid.
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!cmd.includes("watch") || !cmd.includes(String(job.id))) return;
    process.kill(pid, "SIGTERM");
  } catch {
    // gone already, or no /proc
  }
}

// Saves the terminal status first. A sender failure cannot flip it back.
async function markTerminal(repo, job, status, reason) {
  if (!FINISH_STATUSES.has(status)) fail(`not a terminal status: ${status}`);
  job.status = status;
  job.finished = new Date().toISOString();
  job.updated = job.finished;
  job.finishRounds = [...(Array.isArray(job.finishRounds) ? job.finishRounds : []), { round: roundOf(job), status, at: job.finished }];
  if (reason) job.stopReason = reason;
  save(repo, job);
  killWatcher(job);
  try {
    return await deliverFinish(repo, job);
  } catch (err) {
    return { action: "failed", detail: err?.orka ? err.message : "sender error" };
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

// sessionId names the agent's transcript (claude and pi both take --session-id), so orka reads
// the right file when it measures context; every pane of a job shares one transcript folder.
function startArgs(name, pane, kind, alias, sessionId) {
  const args = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000"];
  const extra = [...(kind === "claude" ? ["--model", alias] : []), ...(sessionId ? ["--session-id", sessionId] : [])];
  if (extra.length) args.push("--", ...extra);
  return args;
}

function paneCommand(alias) {
  return alias ? `claude --model ${alias}` : "pi";
}

function agentStatus(name) {
  const got = herdr(["agent", "get", name]);
  return got.json?.result?.agent?.agent_status || "unknown";
}

const PROMPT_WAIT_MS = Number(brand.env("PROMPT_WAIT_MS")) || 60000;
const PROMPT_POLL_MS = Number(brand.env("PROMPT_POLL_MS")) || 1000;

function agentPane(name) {
  const got = herdr(["agent", "get", name]);
  return got.json?.result?.agent?.pane_id || "";
}

// What the pane shows: the text still sitting in the input box (after the last prompt line), if any.
function unsubmittedInput(paneText) {
  const lines = String(paneText || "").split(/\r?\n/);
  const tail = lines.slice(-25).join("\n");
  if (/\[(?:Pasted text|\.\.\.Truncated text)[^\]]*\]/i.test(tail)) return true;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[│|]?\s*[❯>]\s?(.*?)\s*[│|]?\s*$/.exec(lines[i]);
    if (m) return m[1].trim().length > 0;
  }
  return false;
}

function promptSeenInPane(paneText, text) {
  const probe = String(text).split(/\r?\n/).find((l) => l.trim().length >= 20)?.trim().slice(0, 40);
  return Boolean(probe) && String(paneText).includes(probe);
}

const READY_WAIT_MS = Number(brand.env("READY_WAIT_MS")) || 120000;
const PROMPT_ATTEMPTS = Number(brand.env("PROMPT_ATTEMPTS")) || 3;
const PROMPT_BACKOFF_MS = Number(brand.env("PROMPT_BACKOFF_MS")) || 5000;

function agentInfo(name) {
  const got = herdr(["agent", "get", name]);
  return got.json?.result?.agent || {};
}

// The prompt gate: interactive_ready must be exactly true AND the status exactly idle. A missing
// key or status, an error, blocked, working or done all mean "not ready".
function isAgentReady(info) {
  return Boolean(info) && info.interactive_ready === true && info.agent_status === "idle";
}

// After the prompt was sent: working means it took. Blocked also counts: the agent received the
// prompt and waits on a permission dialog, and prompting again into that dialog is harmful.
// Called only once the prompt is out, so blocked before the prompt is never ready (isAgentReady).
function isDelivered(status, sawWorking) {
  return status === "working" || (status === "blocked" && sawWorking !== false);
}

// Blocks until isAgentReady(info), polling until READY_WAIT_MS; anything else keeps polling.
function waitAgentReady(name) {
  const deadline = Date.now() + READY_WAIT_MS;
  let info = agentInfo(name);
  for (;;) {
    if (isAgentReady(info)) return { ready: true };
    if (Date.now() >= deadline) return { ready: false, status: info.agent_status, interactiveReady: info.interactive_ready };
    sleep(PROMPT_POLL_MS);
    info = agentInfo(name);
  }
}

// One attempt: send the prompt (or press Enter when a pasted prompt sits unsubmitted in the input
// box), then wait for the agent to start working. Enter is nudged with backoff while it does not.
function sendAndWatch(name, text, attempt) {
  let pane = agentPane(name);
  const readPane = () => (pane ? herdr(["pane", "read", pane, "--source", "recent"]).text : "");
  if (attempt > 1 && unsubmittedInput(readPane())) herdr(["agent", "send-keys", name, "Enter"]);
  else {
    const prompted = herdr(["agent", "prompt", name, text], 60000);
    if (prompted.code !== 0 || prompted.json?.error) herdrFail(prompted, "prompt");
    pane = pane || prompted.json?.result?.agent?.pane_id || "";
  }
  const deadline = Date.now() + PROMPT_WAIT_MS;
  let nextCheck = Date.now() + 3 * PROMPT_POLL_MS;
  let backoff = 2 * PROMPT_POLL_MS;
  while (Date.now() < deadline) {
    const status = agentStatus(name);
    if (isDelivered(status, true)) return true;
    if (Date.now() >= nextCheck) {
      if (unsubmittedInput(readPane())) {
        herdr(["agent", "send-keys", name, "Enter"]);
        backoff = Math.min(backoff * 2, 15000);
      }
      nextCheck = Date.now() + backoff;
    }
    sleep(PROMPT_POLL_MS);
  }
  return isDelivered(agentStatus(name), true);
}

// Delivers a prompt and confirms it took: waits for interactive_ready + idle, sends, and only counts
// agent_status working as delivered (the text showing up in the pane is not enough). Up to
// ORKA_PROMPT_ATTEMPTS attempts with backoff. Returns { ok, attempts, reason }; never throws on a
// missed start, so callers can record delivery: failed before exiting.
function promptWithRetry(name, text) {
  const ready = waitAgentReady(name);
  if (!ready.ready) {
    return { ok: false, attempts: 0, reason: `delivery failed: agent ${name} not ready after ${Math.round(READY_WAIT_MS / 1000)}s (last status ${ready.status}, interactive_ready ${ready.interactiveReady})` };
  }
  for (let attempt = 1; attempt <= PROMPT_ATTEMPTS; attempt++) {
    if (sendAndWatch(name, text, attempt)) return { ok: true, attempts: attempt };
    if (attempt < PROMPT_ATTEMPTS) sleep(PROMPT_BACKOFF_MS * attempt);
  }
  return { ok: false, attempts: PROMPT_ATTEMPTS, reason: `agent ${name} never started working after ${PROMPT_ATTEMPTS} prompt attempts` };
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

// Ports held by other jobs that might still run something: not finished, or kept.
function takenPorts(repo, job) {
  const taken = [];
  for (const other of loadAllJobs(repo)) {
    if (other.id === job.id) continue;
    if (FINISH_STATUSES.has(other.status) && !other.keep) continue;
    if (Array.isArray(other.ports)) taken.push(...other.ports);
    else if (other.port != null) taken.push(other.port);
  }
  return taken;
}

async function assignPorts(repo, job) {
  if (job.port != null) return;
  const got = await ports.allocatePorts(job.id, { taken: takenPorts(repo, job) });
  job.port = got.port;
  job.ports = got.ports;
}

// Shared prompt rules: each literal lives here once and is interpolated into the prompts that use it.
const REVERSIBLE_RULE = `Reversible work never waits on a human. Irreversible actions (push, delete outside the worktree, external sends, purchases) stop and ask.`;
const NEVER_CLOSE_PANES = `Never close panes (yours or anyone's, no herdr pane close): finished panes stay open, and orka frees them when the job is done or stopped.`;
const SUMMARY_FROM_DIFF = (job) => `Before orka done, run git diff ${job.baseCommit || `$(git merge-base ${brand.jobBranch(job)} main)`} (--stat plus a skim) and write summary.txt from the diff, not from the workers' claims.`;

function portPromptLines(job) {
  const list = Array.isArray(job.ports) && job.ports.length ? job.ports : job.port != null ? [job.port] : [];
  const lines = [];
  if (list.length) {
    lines.push(`Your job port${list.length > 1 ? "s" : ""}: ${list.join(", ")} (env ORKA_PORT=${job.port ?? list[0]}${list.length > 1 ? `, ORKA_PORTS=${list.join(",")}` : ""}).`);
    lines.push(`Use your job port(s) ($ORKA_PORT / the ports listed above) for any dev or preview server, never a fixed default like 3000 or 5173, so concurrent orka jobs never collide.`);
  }
  lines.push(
    `Decide operational questions yourself by choosing the safe recommended option instead of asking. Examples: stop a stale server left by a finished orka job, or pick your own job port when one is busy.`,
    `Only ask when a genuine human decision or a secret is required. A question nobody sees leaves the job stuck.`,
    REVERSIBLE_RULE,
  );
  return lines;
}

// ORKA_JOB / ORKA_WORKER (plus the ORCA_* twins) tag every process a pane starts, browsers included.
function jobEnvArgs(job, worker) {
  const env = { ...brand.envPair("JOB", job.id), ...(worker ? brand.envPair("WORKER", worker) : {}) };
  return Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

// Kills the browser processes of one job (or of some of its workers): those
// tagged ORKA_JOB / ORCA_JOB, and untagged ones whose agent-browser session is
// <browserPrefix>-<worker>.
function reapBrowsers(job, { worker = null, workers = null, dry = false } = {}) {
  const procs = browsers.selectReap(browsers.scanBrowsers(), { jobId: job.id, worker, workers, prefix: browserPrefix(job) });
  return killBrowserProcs(procs, dry);
}

function killBrowserProcs(procs, dry) {
  const pids = new Set(procs.map((p) => p.pid));
  for (const p of procs) {
    if (pids.has(p.ppid)) continue; // listed under its parent
    const kids = procs.filter((c) => c.ppid === p.pid).length;
    const who = [p.job, p.worker].filter(Boolean).join(" ");
    console.log(`cleanup: ${dry ? "would kill" : "killed"} browser pid ${p.pid} (${who || p.session || "untagged"}: ${p.cmdline.slice(0, 80)})${kids ? ` and ${procs.length - 1} child process(es)` : ""}`);
  }
  if (!dry && procs.length) {
    try {
      lifecycle.killProcesses(procs.map((p) => p.pid), { graceMs: 3000 });
    } catch (err) {
      console.log(`cleanup: could not kill a browser: ${err.message}`);
    }
  }
  return procs.map((p) => p.pid);
}

function portEnvArgs(job) {
  return Object.entries(ports.portEnv(job)).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

function startWatcher(repo, job) {
  if (brand.env("NO_WATCH") === "1") return;
  if (job.status !== "running" || !job.agent || !job.pane) return;
  try {
    const dir = ensureJobDir(repo, job.id);
    job.watcherPid = watch.spawnWatcher({ bin: ORKA, jobId: job.id, repo, logPath: join(dir, "watcher.log") });
    save(repo, job);
  } catch (err) {
    console.error(`watcher not started: ${err?.message || err}`);
  }
}

// Appended by the orchestrator to the brief of a research or investigation worker. Deliberately no line or character cap.
const RESEARCH_REPORT = [
  `RESEARCH REPORT FORMAT (for your result and note):`,
  `- Lead with the answer.`,
  `- Label each claim Observed or Guessed.`,
  `- For each Observed claim give "Verified: <cmd> -> <real output line>", or "Verified: none".`,
  `- Cut narration. Stay compact.`,
].join("\n");

function workerPrompt(job, name, task, alias) {
  const dir = jobDir(job.repo, job.id);
  const result = join(dir, "results", `${name}.json`);
  const note = join(dir, "notes", `${name}.txt`);
  return [
    `You are a worker for orka job ${job.id} (${paneCommand(alias)}). Do this task and stop.`,
    `Work only in this shared checkout: ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Other workers share this worktree. Do not revert their files. Do not create a branch, worktree, or push.`,
    `Browser checks, if this task needs them, go in ${verifyFile(job.worktree)} at the worktree root, or the path in ${configPath(job.repo)} "verify".`,
    `Shape: {"steps":[["open","http://HOST:PORT/"],{"visible":"SELECTOR"},{"text":"SELECTOR","includes":"EXPECTED"}]}`,
    `Use this project's URL. Do not copy a host or port from another repo. Do not run orka verify unless the task says so.`,
    ...portPromptLines(job),
    `Use exactly one agent-browser session, named ${browserPrefix(job)}-${name} (agent-browser --session ${browserPrefix(job)}-${name}). Reuse it for every check. Never spawn a fresh session per check. When the task is done, close it: agent-browser --session ${browserPrefix(job)}-${name} close`,
    ``,
    String(task).trim(),
    ``,
    `When finished, write ${result} as JSON:`,
    `{"worker":"${name}","ok":true,"result":"<what you did, a few sentences>"}`,
    `Also write one line at ${note}.`,
    `Then send that line to the orchestrator:`,
    `herdr agent prompt ${job.agent} "<the one-line note>"`,
    `If that prompt is rejected because the orchestrator is busy, the files are enough.`,
    `The note and the herdr prompt are one line, at most 200 characters. Do not paste logs, diffs, or the job file. The orchestrator will run orka digest.`,
    ``,
    `If SCOPE or ACCEPTANCE is missing from the task above, do the narrowest reading of it and say so in the result.`,
    ``,
    NEVER_CLOSE_PANES,
    `Finish wake is automatic from the orka CLI when it marks the job done, failed, or stopped. That is not your job. Do not run herdr-finish-watch. Do not run orka stop or orka webhook. Do not start another agent.`,
  ].join("\n");
}

function verifierState(job) {
  const v = job.verifier || {};
  return { rounds: Number(v.rounds) || 0, verdict: v.verdict ?? null, history: Array.isArray(v.history) ? v.history : [] };
}

function parseMaxRounds(args) {
  if (!("max-rounds" in args)) return null;
  const raw = args["max-rounds"];
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) fail(`--max-rounds needs a positive integer, got ${raw === true ? "nothing" : raw}`);
  return Number(raw);
}

function verifierLine(job) {
  const v = job.verifier;
  if (!v || !v.verdict) return "";
  const round = Number(v.rounds) || 0;
  if (v.verdict === "pass" && v.stale) return `verifier: pass (STALE, code changed since round ${round})`;
  return v.verdict === "pass" ? `verified by verifier: pass, round ${round}` : `verifier: ${v.verdict}, round ${round}`;
}

function parseRole(args) {
  if (!("role" in args)) return "builder";
  const role = flagValue(args, "role");
  if (role !== "builder" && role !== "verifier") fail(`--role must be builder or verifier, got ${role}`);
  return role;
}

const isVerifierName = (name) => name === VERIFIER_NAME || /^verifier-[0-9]+$/.test(name);

// Names are never reused: a finished pane keeps its name until orka frees it on done/stop.
// herdr agent names are global across workspaces and jobs, so ask for every agent, not just ours.
function herdrAgentNames() {
  const got = herdr(["agent", "list"]);
  const agents = got.json?.result?.agents;
  return new Set(Array.isArray(agents) ? agents.map((a) => a?.name).filter(Boolean) : []);
}

function herdrAgentExists(name, names) {
  if (names.has(name)) return true;
  const got = herdr(["agent", "get", name]);
  return got.code === 0 && !got.json?.error && Boolean(got.json?.result?.agent);
}

// First of base, base-2, base-3... that no worker of this job and no herdr agent holds.
function freeWorkerName(job, base, taken = []) {
  const used = new Set([...(job.workers || []).map((w) => w.name), ...taken]);
  const names = herdrAgentNames();
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (candidate.length > 32 || used.has(candidate)) continue;
    if (!herdrAgentExists(candidate, names)) return candidate;
  }
  fail(`no free worker name for "${base}"`);
}

function checkRole(role, name, job) {
  if (role === "verifier" && name !== VERIFIER_NAME) fail(`a verifier worker must be named "${VERIFIER_NAME}", got "${name}"`);
  if (role === "builder" && isVerifierName(name)) fail(`the name "${VERIFIER_NAME}" is reserved; start it with --role verifier`);
  const max = Number(job.maxRounds) || 0;
  const rounds = verifierState(job).rounds;
  if (role === "verifier" && max && rounds >= max) {
    fail(`verifier already ran ${rounds} rounds for job ${job.id}; --max-rounds ${max} reached, refusing round ${rounds + 1}`);
  }
}

// Every verifier round writes the same results/verifier.json. Starting the next round moves
// the old one to verifier.round-N.json, so a stale round is never read as the current verdict.
function verifierResultPath(repo, id) {
  return join(jobDir(repo, id), "results", `${VERIFIER_NAME}.json`);
}

function archiveVerifierResult(repo, job, round) {
  const path = verifierResultPath(repo, job.id);
  if (!existsSync(path)) return;
  renameSync(path, join(dirname(path), `${VERIFIER_NAME}.round-${round}.json`));
}

function readVerifierResult(repo, id) {
  const path = verifierResultPath(repo, id);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data?.verdict !== "pass" && data?.verdict !== "fail") return null;
    return data;
  } catch {
    return null;
  }
}

function entryList(list, withExtra) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ check: item.trim(), evidence: item.trim() });
    } else if (item && typeof item === "object") {
      const check = String(item.check ?? item.name ?? "").trim() || String(item.evidence ?? "").trim().slice(0, 80);
      if (!check) continue;
      const entry = { check, evidence: String(item.evidence ?? item.notes ?? "") };
      if (withExtra) {
        if (item.base) entry.base = String(item.base);
        if (item.proof) entry.proof = String(item.proof);
      }
      out.push(entry);
    }
  }
  return out;
}

// failures block the job; warnings (pre-existing, shown on the base commit) never do.
function normaliseResult(result) {
  const failures = entryList(result.failures, false);
  const warnings = entryList(result.warnings, true);
  let verdict = result.verdict;
  if (Array.isArray(result.failures)) {
    if (failures.length) verdict = "fail";
    else if (warnings.length || verdict === "pass") verdict = "pass";
  }
  return { verdict, failures, warnings };
}

function stallOf(history, round) {
  const now = history.find((h) => h.round === round);
  const before = history.find((h) => h.round === round - 1);
  if (!now || !before) return null;
  const prev = new Set(before.failing || []);
  const checks = (now.failing || []).filter((c) => prev.has(c));
  return checks.length ? { checks, rounds: [round - 1, round] } : null;
}

// Head SHA and patch id of the job's code as it is right now: the diff against baseCommit with the
// dirty tree and untracked files folded in (via a throwaway index), so no real index is touched.
// orka computes this itself; a value the agent wrote is never used. Null when it cannot be computed.
function codeSnapshot(job) {
  const wt = job.worktree;
  if (!wt || !job.baseCommit || !existsSync(wt)) return null;
  const head = git(wt, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.code !== 0) return null;
  const tmp = mkdtempSync(join(tmpdir(), "orka-patch-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    const run = (args, input) => spawnSync("git", args, { cwd: wt, env, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
    if (run(["read-tree", job.baseCommit]).status !== 0) return null;
    // Both checks file names: excluding an absent path leaves the patch id of older jobs unchanged.
    const exclude = brand.fileNames("verify.json").map((f) => `:(exclude)${f}`);
    if (run(["add", "-A", "--", ".", ...exclude]).status !== 0) return null;
    const diff = run(["diff", "--cached", "--binary", job.baseCommit, "--", ".", ...exclude]);
    if (diff.status !== 0) return null;
    const pid = run(["patch-id", "--stable"], diff.stdout);
    if (pid.status !== 0) return null;
    return { head: head.out, patchId: pid.stdout.trim().split(/\s+/)[0] || "empty" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Computes the verifier state with the latest results/verifier.json folded in. Does not save.
function computeVerifier(repo, job) {
  const state = verifierState(job);
  if (!state.rounds) return null;
  const result = readVerifierResult(repo, job.id);
  if (!result) return null;
  const round = state.rounds;
  if (result.round !== undefined && Number(result.round) !== round) return null;
  const norm = normaliseResult(result);
  const history = state.history.filter((h) => h.round !== round);
  history.push({
    round,
    verdict: norm.verdict,
    failing: norm.failures.map((f) => f.check),
    warnings: norm.warnings.map((w) => w.check),
    at: new Date().toISOString(),
  });
  history.sort((a, b) => a.round - b.round);
  const next = { ...job.verifier, rounds: round, verdict: norm.verdict, history, stall: stallOf(history, round) };
  if (!Array.isArray(next.strategyChanges)) next.strategyChanges = [];
  // The first time orka reads this round's result it records the code snapshot; later reads compare.
  const snap = codeSnapshot(job);
  if (snap) {
    if (next.patchRound === round && next.patchId) next.stale = snap.patchId !== next.patchId;
    else Object.assign(next, { head: snap.head, patchId: snap.patchId, patchRound: round, stale: false });
  }
  return next;
}

// Records the latest verifier verdict on the job. Returns the verifier state, or null if none ran.
function recordVerifier(repo, job) {
  const next = computeVerifier(repo, job);
  if (!next) return null;
  job.verifier = next;
  save(repo, job);
  return job.verifier;
}

// The blocking failures and warnings of the verifier's latest result, with evidence.
function verificationDetail(repo, job) {
  const result = readVerifierResult(repo, job.id);
  if (!result) return { blocking: [], warnings: [] };
  const round = Number(job.verifier?.rounds) || 0;
  if (result.round !== undefined && Number(result.round) !== round) return { blocking: [], warnings: [] };
  const norm = normaliseResult(result);
  const slim = ({ check, evidence }) => ({ check, evidence });
  return { blocking: norm.failures.map(slim), warnings: norm.warnings.map(slim) };
}

function verificationOf(repo, job) {
  const v = job.verifier;
  if (!v || (!v.verdict && !(Number(v.rounds) > 0))) return null;
  const detail = verificationDetail(repo, job);
  const out = {
    verdict: v.verdict ?? null,
    rounds: Number(v.rounds) || 0,
    strategyChanges: (v.strategyChanges || []).map((c) => c.change),
    blocking: detail.blocking,
    warnings: detail.warnings,
  };
  if (v.stopReason) out.stopReason = v.stopReason;
  return out;
}

// orka.features.md, or an existing orca.features.md in that worktree.
const featureMapFile = (dir) => brand.fileName(dir, "features.md");

const PLAYBOOKS = ["feature", "bug-fix", "investigation", "hillclimb"];
const REPRO_FILE = "results/repro.json";

function parsePlaybook(args) {
  if (!("playbook" in args)) return "";
  const value = flagValue(args, "playbook");
  if (!PLAYBOOKS.includes(value)) fail(`--playbook must be one of: ${PLAYBOOKS.join(", ")}`);
  return value;
}

// Bug-fix jobs only: the bug is reproduced and recorded failing before any fix starts.
const REPRO_ORCHESTRATOR_LINES = (dir) => [
  `Playbook bug-fix (repro first): the FIRST worker must be a repro worker. It reproduces the bug and saves the failing evidence to ${dir}/${REPRO_FILE} as JSON: the command or steps, plus the real failing output. Ideally it also adds a failing test and commits it before the fix.`,
  `No fix worker starts before ${REPRO_FILE} exists. Include the repro command in the fix worker task and in the verifier --task.`,
];
const REPRO_VERIFIER_LINES = (dir) => [
  `Playbook bug-fix (repro first): re-run the repro from ${dir}/${REPRO_FILE}; it must now pass.`,
  `A missing ${REPRO_FILE}, or a repro you cannot reproduce or re-run, is a blocking failure (check name "repro"). Never pass it silently.`,
];

// Per-playbook orchestrator blocks, all in one place. feature adds nothing; bug-fix is the repro-first lines above.
const INVESTIGATION_ORCHESTRATOR_LINES = () => [
  `Playbook investigation: this job needs findings, not a browser check. Nothing is built, so you check the research yourself; no separate checker runs.`,
  `Workers write research summaries in the RESEARCH REPORT FORMAT, with a citation (file:line, URL or command output) for every Observed claim.`,
];
const HILLCLIMB_ORCHESTRATOR_LINES = (dir) => [
  `Playbook hillclimb: first fix ONE metric, the command that prints it, and whether higher or lower is better. A worker records the baseline value in ${dir}/results/baseline.json before any change.`,
  `Then iterate: each worker iteration changes one thing, re-measures, and keeps the change only when the metric improves on the best value so far; otherwise it reverts the change. Log every iteration (change, metric, kept or reverted).`,
];
const PLAYBOOK_ORCHESTRATOR_LINES = {
  feature: () => [],
  "bug-fix": REPRO_ORCHESTRATOR_LINES,
  investigation: INVESTIGATION_ORCHESTRATOR_LINES,
  hillclimb: HILLCLIMB_ORCHESTRATOR_LINES,
};

// UI jobs only. The skill itself is linked, not copied: `agent-browser skills get core` serves the text for the installed version, so it follows upgrades.
const browserVerifierLines = (session, dir) => [
  `Browser checks (agent-browser). Load its guide first: agent-browser skills get core (served by the installed version).`,
  `- Session: use only --session ${session}, and close it as your last browser command.`,
  `- Snapshot (agent-browser --session ${session} snapshot -i), then act on the @eN refs it returns. Do not guess selectors.`,
  `- Wait explicitly after any page-changing action: wait @ref, wait --text "...", wait --url "...", or wait --load networkidle. No sleeps and no bare wait <ms>.`,
  `- Evidence: save screenshots under ${join(dir, "results")}/ (agent-browser --session ${session} screenshot <path>) and name them in the check notes.`,
  `- Console and network: run console and network requests before the verdict; an error caused by this job is a failure.`,
];

function verifierPrompt(job, name, task, alias, round) {
  const dir = jobDir(job.repo, job.id);
  const result = verifierResultPath(job.repo, job.id);
  const note = join(dir, "notes", `${name}.txt`);
  const session = `${browserPrefix(job)}-${name}`;
  return [
    `You are the verifier for orka job ${job.id} (${paneCommand(alias)}), round ${round}${job.maxRounds ? ` of ${job.maxRounds}` : ""}. Do this task and stop.`,
    `You start with fresh context. You did not build this. Judge it against the goal, not against what the builders say.`,
    `Work only in this shared checkout: ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Do not edit product code. Do not revert anyone's files. Do not create a branch, worktree, or push.`,
    ``,
    `Goal:`,
    job.goal.trim(),
    ``,
    `What was built and the acceptance criteria:`,
    String(task).trim(),
    ``,
    ...(job.playbook === "bug-fix" ? [...REPRO_VERIFIER_LINES(dir), ``] : []),
    `Evidence standard (a pass needs proof, not a claim):`,
    `- Test the real user path: run the feature the way a user would (the real command, page or API), not only unit tests or a private helper.`,
    `- Check side effects (files written, network calls, state changed), not just the exit code.`,
    `- Suspect the observation method first: when a check fails or looks odd, ask whether the check itself is wrong (wrong URL, stale server, wrong directory, cached output) before blaming or clearing the code.`,
    `- Save proof under ${join(dir, "results")}/ (screenshots, command output) and name the file in the check notes or failure evidence.`,
    `- "Inconclusive" or "could not test" is a fail, not a pass. If you cannot show it works, the verdict is fail.`,
    ``,
    `Feature map: before running checks, read ${featureMapFile(job.worktree)} at the worktree root. Per feature it records how to reach it (URL or command), how to drive it, how to prove it works, and when it was last verified (date + commit). Use it to start faster and check consistently.`,
    `Staleness guard: each entry carries the commit it was last proven at. Every entry whose commit is older than HEAD (git rev-parse HEAD) must be re-proved by you before you rely on it or mark it verified, never trusted, whether or not this job touched the feature.`,
    `If ${featureMapFile(job.worktree)} is missing, that is fine: create it with one entry per feature you check. On a pass, update the entries you touched (reach, drive, prove, last-verified date and HEAD commit). Editing ${featureMapFile(job.worktree)} is allowed even though you do not edit product code. On a fail, do not mark entries as proven.`,
    ``,
    `Run these checks:`,
    `1. orka verify ${job.id} (if orka is not on PATH, run ${ORKA} verify ${job.id}).`,
    `2. The project's own checks: npm test and npm run check, each only when package.json has that script.`,
    `3. Targeted agent-browser checks against the acceptance criteria above, when the goal has a UI.`,
    `For every check that fails, test mechanically whether it is pre-existing: run orka verify ${job.id} --base (runs the same checks file on the base commit and writes results/verify-base.json), or re-run the same project command at the base commit (${job.baseCommit || "git merge-base <branch> main"}).`,
    `A failure that also fails on the base commit is a warning (non-blocking), with the proof. Anything else, including anything you could not test on the base, is a blocking failure. Never edit product code. Never weaken or remove a check.`,
    `You may author or extend ${verifyFile(job.worktree)} (at the worktree root, or the path in ${configPath(job.repo)} "verify") only to cover the acceptance criteria.`,
    `Never weaken, loosen or delete a check to make it pass. Never skip a failing check.`,
    `Shape: {"steps":[["open","http://HOST:PORT/"],{"visible":"SELECTOR"},{"text":"SELECTOR","includes":"EXPECTED"}]}`,
    `Use this project's URL. Do not copy a host or port from another repo.`,
    ...portPromptLines(job),
    `Use exactly one agent-browser session, named ${session} (agent-browser --session ${session}). Reuse it for every check. Never spawn a fresh session per check. When done, close it: agent-browser --session ${session} close`,
    ...(job.jobType === "ui" ? browserVerifierLines(session, dir) : []),
    ``,
    `When finished, write ${result} as JSON:`,
    `{"name":"${name}","role":"verifier","round":${round},"verdict":"pass"|"fail","checks":[{"name":"...","outcome":"pass"|"fail"|"skipped","scope":"job"|"preexisting","notes":"..."}],"failures":[{"check":"<stable check name>","evidence":"<exact error, step, url, command output>"}],"warnings":[{"check":"...","evidence":"...","base":"<sha>","proof":"<how it was shown pre-existing, e.g. fails on base via orka verify --base>"}],"summary":"..."}`,
    `verdict is "pass" when failures is empty, even if warnings are present. failures are blocking and cover what this job changed; warnings are pre-existing or unrelated failures proven on the base commit. Use the same check name for the same check every round. Evidence must be concrete: the exact error, step, url or command output.`,
    `Also write one line at ${note}.`,
    `Then send that line to the orchestrator:`,
    `herdr agent prompt ${job.agent} "<the one-line note>"`,
    `If that prompt is rejected because the orchestrator is busy, the files are enough.`,
    ``,
    NEVER_CLOSE_PANES,
    `Finish wake is automatic from the orka CLI when it marks the job done, failed, or stopped. That is not your job. Do not run herdr-finish-watch. Do not run orka stop, orka done or orka webhook. Do not start another agent.`,
  ].join("\n");
}

// The verifier and finish section of the orchestrator prompt. Every playbook but investigation uses this one.
const FEATURE_FLOW = (job, dir) => ({
  reap: `When a worker or the verifier has finished, run orka reap ${job.id} --worker <name> to close its browsers (its pane stays open).`,
  modelNote: [`The verifier (--role verifier) uses the job's verifier model, ${verifierLabel(job)}, not the worker model, unless you pass --model.`],
  digest: `When a worker note arrives, run orka digest ${job.id} and trust it over memory after compaction. Do not read the job JSON, verify.log, or a pane transcript. Open results/<name>.json only if the digest says the note is missing or ok is not true. When routing a verifier failure, use the evidence already in the digest. Do not paste a longer excerpt into the next worker task.`,
  digestUse: "test counts and status",
  summaryFrom: "from the git diff",
  verify: [
    `When every builder has reported, start ONE verifier. It has fresh context and checks the work against the goal. Every round uses the same command; orka names the panes verifier, verifier-2, verifier-3... and each round overwrites ${dir}/results/${VERIFIER_NAME}.json (the previous one is kept as verifier.round-N.json):`,
    `  orka worker --job ${job.id} --name ${VERIFIER_NAME} --role verifier --task "<what was built and the acceptance criteria>"`,
    `Build the verifier --task from the builders' ACCEPTANCE lines (copy them in, one per builder), plus the job goal.`,
    `The verifier runs orka verify, the project's own checks and targeted agent-browser checks, and may extend ${verifyFile(job.worktree)} only to cover the acceptance criteria.`,
    `It writes ${dir}/results/${VERIFIER_NAME}.json: "verdict" pass or fail, "failures" (blocking: what this job changed, each with its evidence) and "warnings" (pre-existing failures the verifier showed also fail on the base commit; they never block a pass).`,
    `If the verdict is fail, read ${dir}/results/${VERIFIER_NAME}.json and route each blocking failure WITH its evidence to the builder that owns those files (a new or resumed builder worker). Ignore warnings for routing. Wait for their reports, then start the verifier again.`,
    `Run orka status ${job.id} after each verifier round. If it reports a stall (the same check failing two rounds in a row), do NOT repeat the same instruction.`,
    `Before changing strategy, attack the premise: write in one sentence the premise the failed fixes share, list what else could explain the failure (a census), and pick the strategy that drops that premise.`,
    `Change strategy instead: rewrite the worker prompt using the verifier's evidence verbatim, split the work differently, start a fresh worker instead of resuming one, or take a different approach.`,
    `Record the change with: orka strategy ${job.id} --premise "<the shared premise you dropped>" "<what you changed>", then re-verify.`,
    `Log every split, routing and strategy decision so it survives compaction: orka log ${job.id} <phase> "<decision>" "<why>" "<evidence>" "<result>" (phase: split, routing or strategy). orka strategy logs its own row.`,
    job.maxRounds
      ? `There is a round ceiling of ${job.maxRounds} verifier rounds (--max-rounds). orka refuses a round beyond it; say so in the summary and run orka done.`
      : `There is no round limit. Keep going until the verdict is pass.`,
    `Stop only when you genuinely cannot progress: the same failure survived 3 different strategy changes, or the fix needs a human decision or a secret. Then run: orka done ${job.id} --give-up "<plain reason>".`,
    `You never run orka verify yourself and never edit ${verifyFile(job.worktree)} or any check. You may only run trivial read-only commands to read results.`,
    `Do not invent a URL or a checks file unless the goal asked for checks.`,
  ],
  done: [
    `Keep every other field, including verify.`,
    `Do not change verify or verifier; the verifier and orka done write those.`,
    `Then mark the job done, which sends the finish wake and records the verifier verdict (a fail verdict marks the job failed):`,
    `  orka done ${job.id}`,
    `If orka is not on PATH, run ${ORKA} done ${job.id}.`,
  ],
});
// Investigation swaps the verifier and finish section for a citation check by the orchestrator: no verifier runs, no verdict is waited for.
const INVESTIGATION_FLOW = (job, dir) => ({
  reap: `When a worker has finished, run orka reap ${job.id} --worker <name> to close its browsers (its pane stays open).`,
  modelNote: [],
  digest: `When a worker note arrives, run orka digest ${job.id} and trust it over memory after compaction. Do not read the job JSON, verify.log, or a pane transcript. Open results/<name>.json only if the digest says the note is missing or ok is not true.`,
  digestUse: "status",
  summaryFrom: "only from the claims whose citations held",
  verify: [
    `When every worker has reported, check the research summaries yourself. Open each cited file or re-run each cited command and confirm it says what the summary claims. Send a worker back for any claim that fails, then check again.`,
    `You may only run trivial read-only commands to read results and check citations.`,
    `Log every split and routing decision so it survives compaction: orka log ${job.id} <phase> "<decision>" "<why>" "<evidence>" "<result>" (phase: split or routing).`,
    `Stop only when you genuinely cannot progress: the question needs a human decision or a secret. Then run: orka done ${job.id} --give-up "<plain reason>".`,
  ],
  done: [
    `Keep every other field.`,
    `Then mark the job done, which sends the finish wake:`,
    `  orka done ${job.id}`,
    `If orka is not on PATH, run ${ORKA} done ${job.id}.`,
  ],
});
const PLAYBOOK_FLOW = { investigation: INVESTIGATION_FLOW };

function orchestratorPrompt(job) {
  const dir = jobDir(job.repo, job.id);
  const pi = job.kind === "pi";
  const flow = (PLAYBOOK_FLOW[job.playbook] || FEATURE_FLOW)(job, dir);
  return [
    `You are the orchestrator for orka job ${job.id}, not the implementer.`,
    `Do not implement the goal yourself. Do not edit the repo to satisfy the goal.`,
    `Split the goal into the smallest set of worker tasks, then start one worker per task.`,
    `When tasks are independent, start several workers in parallel (several orka worker calls, one per task) instead of one after another.`,
    `Workers share one worktree, so never give two workers the same files. Split by file or area so edits cannot clash.`,
    ``,
    `Worktree (shared by every worker): ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Do not create branches or worktrees. Do not push. Workers share this checkout in v0.`,
    ...portPromptLines(job),
    ``,
    `Goal:`,
    job.goal.trim(),
    ``,
    `Start each worker with orka, which opens a Herdr pane in this same worktree:`,
    `  orka worker --job ${job.id} --name <worker> --task "<task>"`,
    `If orka is not on PATH, run ${ORKA} instead. The binary is the same file.`,
    `Write every worker --task as this brief, one labelled section per line: GOAL / SCOPE (files it owns) / CONTEXT (file pointers, not pasted text) / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT. Workers cannot ask questions, so a vague task fails quietly.`,
    `When ${featureMapFile(job.worktree)} exists at the repo root, point workers at it in CONTEXT.`,
    ...(PLAYBOOK_ORCHESTRATOR_LINES[job.playbook] || PLAYBOOK_ORCHESTRATOR_LINES.feature)(dir),
    `For a one-command task the brief collapses to GOAL + ACCEPTANCE. orka warns when a builder task has no SCOPE: or ACCEPTANCE:.`,
    `When a worker's task is research or investigation, append this block verbatim to its --task (after REPORT):\n${RESEARCH_REPORT}`,
    `Worker names must match [a-z][a-z0-9_-]{0,31}. If a name is already taken (by an earlier worker, even a finished one) orka appends -2, -3... and prints the real name.`,
    NEVER_CLOSE_PANES,
    flow.reap,
    ...(pi
      ? [`Workers are Pi agents (kind pi). Do not pass --model; pi workers have no model flag.`, `Pane command: ${paneCommand("")}`]
      : [
          `That uses this job's worker model (${job.workerModel}). Pass --model <alias> only to override one worker.`,
          `Pane command: ${paneCommand(job.workerModel)}`,
          ...flow.modelNote,
        ]),
    ``,
    `Each worker writes ${dir}/results/<name>.json and a one-line note at ${dir}/notes/<name>.txt,`,
    `then prompts you with that note. Do not trust a worker that skipped them.`,
    flow.digest,
    `The finish wake is sent by the orka CLI when orka done marks the job done (or when the job goes failed or stopped). Do not run herdr-finish-watch. Do not run orka stop or orka webhook.`,
    ``,
    ...flow.verify,
    ``,
    SUMMARY_FROM_DIFF(job),
    `Before orka done, run orka digest ${job.id}, use it only for ${flow.digestUse}; write ${dir}/summary.txt ${flow.summaryFrom} (per the rule above), and set the summary field. Do not load the job JSON into the turn to copy fields.`,
    ...flow.done,
    `Then stop working. Your pane stays open after orka done, so Olaf can still give feedback with orka steer; a follow-up message starts a new round, and you run orka done ${job.id} again when that round is finished (the finish wake is sent again, marked followUp).`,
    `If you stop and wait on a question, orka's watcher tells Olaf you need input, so ask only the genuine human questions described above.`,
  ].join("\n");
}

function leadPrompt(job) {
  return orchestratorPrompt(job);
}

function printDryRun(repo, job) {
  const wt = job.worktree || worktreePath(repo, job.id);
  const branch = brand.jobBranch(job);
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
  console.log(`workspace: herdr workspace create --cwd ${q(wt)} --label ${q(brand.workspaceLabel(job.id))} --no-focus --env PATH=<orka-bins>:$PATH${job.port != null ? ` ${portEnvArgs(job).map(q).join(" ")}` : " (+ ORKA_PORT/ORCA_PORT env, allocated at run)"}`);
  console.log(`port: ${job.port != null ? (job.ports || [job.port]).join(",") : "allocated at run"} (ORKA_PORT in the panes and orka verify scripts; urls and commands in ${verifyFile(job.worktree)} expand \${ORKA_PORT})`);
  console.log(`lead: herdr ${sh(startArgs(name, "<pane>", kind, orchestratorModel, "<session-id>"))}`);
  if (kind === "claude") {
    const verifierModel = job.verifierModel || workerModel;
    console.log(`models: orchestrator=${orchestratorModel} worker=${workerModel} ${verifierLabel(job)}`);
    console.log(`pane: ${paneCommand(orchestratorModel)}`);
    console.log(`worker: orka worker --job ${job.id} --name <worker> --task "<task>"`);
    console.log(`worker-pane: ${paneCommand(workerModel)}`);
    console.log(`worker-lead: herdr ${sh(startArgs("<worker>", "<pane>", "claude", workerModel, "<session-id>"))}`);
    console.log(`verifier-pane: ${paneCommand(verifierModel)}`);
  } else {
    console.log("role: orchestrator (pi)");
    console.log(`pane: ${paneCommand("")}`);
    console.log(`worker: orka worker --job ${job.id} --name <worker> --task "<task>"`);
    console.log(`worker-pane: ${paneCommand("")}`);
    console.log(`worker-lead: herdr ${sh(startArgs("<worker>", "<pane>", "pi", "", "<session-id>"))}`);
  }
  console.log("finish webhook: posts {job, status, branch} when the CLI marks done, failed, or stopped");
  console.log("watcher: orka watch <id> (detached) posts {kind:needs-input, job, title, status, question, pane} when the orchestrator waits on a question");
  console.log("cleanup on finish: browsers, worktree servers and worker panes close at once; the orchestrator pane and workspace stay until orka cleanup finds them idle");
  console.log(`verify: orka verify ${job.id} (skips when the worktree has no checks file)`);
}

function assignClaudeModels(job, args) {
  if (job.kind !== "claude") {
    if (args["orchestrator-model"] || args["worker-model"] || args["verifier-model"]) fail("--orchestrator-model, --worker-model and --verifier-model are only for kind claude");
    return;
  }
  const models = claudeModels(job, args);
  const sticky = job.jobType === "ui" && job.jobTypeReason === "--ui flag";
  const detected = detectJobType(job.repo, job.goal, args.ui || sticky, job.worktree);
  job.jobType = detected.jobType;
  if (detected.reason) job.jobTypeReason = detected.reason;
  else delete job.jobTypeReason;
  const storedDefault = !job.verifierModel || String(job.verifierSource || "").startsWith("default:");
  if (args["verifier-model"] || storedDefault) {
    const v = resolveVerifierModel(job.repo, args, job.jobType, job.jobTypeReason);
    job.verifierModel = v.model;
    job.verifierSource = v.source;
  }
  job.orchestratorModel = models.orchestratorModel;
  job.workerModel = models.workerModel;
  job.model = models.orchestratorModel;
}

async function cmdNew(args) {
  if ("model" in args) fail("use --worker-model on orka new, not --model");
  allowFlags(args, ["cwd", "title", "goal", "kind", "orchestrator-model", "worker-model", "verifier-model", "keep", "max-rounds", "ui", "playbook"]);
  const title = args.title;
  const goal = args.goal;
  const kind = args.kind || "claude";
  if (!title || !goal) fail("need --title and --goal");
  if (kind !== "pi" && kind !== "claude") fail("kind must be pi or claude");
  if (kind === "pi" && (args["orchestrator-model"] || args["worker-model"] || args["verifier-model"])) {
    fail("--orchestrator-model, --worker-model and --verifier-model are only for kind claude");
  }
  const repo = requireRepo(args.cwd || process.cwd());
  const orchestratorModel = kind === "claude" ? assertClaudeModel(flagValue(args, "orchestrator-model") || DEFAULT_ORCHESTRATOR_MODEL, "orchestrator") : "";
  const workerModel = kind === "claude" ? assertClaudeModel(flagValue(args, "worker-model") || DEFAULT_WORKER_MODEL, "worker") : "";
  if (kind === "pi" && args.ui) fail("--ui is only for kind claude");
  const detected = detectJobType(repo, goal, args.ui);
  const verifier = kind === "claude" ? resolveVerifierModel(repo, args, detected.jobType, detected.reason) : null;
  const verifierModel = verifier ? verifier.model : "";
  const id = slug(title);
  const branch = brand.branchFor(id);
  const check = git(repo, ["check-ref-format", "--branch", branch]);
  if (check.code !== 0) fail(`refused branch name ${branch}`);
  if (existsSync(jobPath(repo, id))) fail(`job ${id} already exists`);
  const maxRounds = parseMaxRounds(args);
  const playbook = parsePlaybook(args) || "feature";
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
    ...(verifierModel ? { verifierModel, verifierSource: verifier.source } : {}),
    playbook,
    jobType: detected.jobType,
    ...(detected.reason ? { jobTypeReason: detected.reason } : {}),
    workers: [],
    browserSessions: [],
    keep: Boolean(args.keep),
    steers: [],
    started: null,
    finished: null,
    summary: "",
    stopReason: "",
    created: new Date().toISOString(),
  };
  if (maxRounds) job.maxRounds = maxRounds;
  sweepQuietly(repo);
  await assignPorts(repo, job);
  const head = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.code === 0 && head.out.trim()) job.baseCommit = head.out.trim();
  save(repo, job);
  console.log(id);
}

function hasHead(repo) {
  return git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).code === 0;
}

function addWorktree(repo, job) {
  if (!hasHead(repo)) fail("target repo has no commits; commit once before orka run");
  const path = worktreePath(repo, job.id);
  const branch = brand.jobBranch(job);
  if (existsSync(path)) fail(`worktree path already exists: ${path}`);
  const exists = git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.code === 0) fail(`branch ${branch} already exists`);
  mkdirSync(join(brand.stateDir(repo), "worktrees"), { recursive: true });
  const base = git(repo, ["rev-parse", "HEAD"]).out.trim();
  const added = git(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (added.code !== 0) fail(added.err || added.out || "git worktree add failed");
  if (base) job.baseCommit = base;
  return path;
}

function createWorkspace(job) {
  const label = brand.workspaceLabel(job.id);
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
    ...portEnvArgs(job),
    ...jobEnvArgs(job, "orchestrator"),
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
  job.sessionId = randomUUID();
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = herdr(startArgs(name, job.pane, kind, alias, job.sessionId), 90000);
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
  if ("model" in args) fail("use --orchestrator-model and --worker-model on orka run, not --model");
  allowFlags(args, ["cwd", "dry-run", "orchestrator-model", "worker-model", "verifier-model", "keep", "max-rounds", "ui", "playbook"]);
  const id = args._[1];
  if (!id) fail("need id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status !== "queued") fail(`job ${id} is ${job.status}, not queued`);
  assignClaudeModels(job, args);
  const playbook = parsePlaybook(args);
  if (playbook) job.playbook = playbook;
  if (!args["dry-run"]) sweepQuietly(repo);
  if (!args["dry-run"] || job.port == null) await assignPorts(repo, job);
  if (args.keep) job.keep = true;
  const maxRounds = parseMaxRounds(args);
  if (maxRounds) job.maxRounds = maxRounds;
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
    const lead = promptWithRetry(job.agent, leadPrompt(job));
    job.leadDelivery = lead.ok ? "ok" : "failed";
    if (!lead.ok) fail(`orchestrator prompt not delivered: ${lead.reason}`);
    job.status = "running";
    job.started = new Date().toISOString();
    save(repo, job);
    startWatcher(repo, job);
  } catch (err) {
    if (job.worktree || job.pane || job.agent) {
      try {
        const wake = await markTerminal(repo, job, "failed", err.message);
        console.error(finishLine(wake));
        releaseJob(repo, job);
      } catch (markErr) {
        console.error(markErr?.message || markErr);
      }
    }
    throw err;
  }
  const portNote = job.port != null ? ` port=${job.port}` : "";
  const extra = (job.kind === "claude" ? ` role=orchestrator model=${job.orchestratorModel} worker=${job.workerModel} verifier=${job.verifierModel || job.workerModel}` : " role=orchestrator kind=pi") + portNote;
  console.log(`${id} running pane=${job.pane} agent=${job.agent} branch=${job.branch} worktree=${job.worktree}${extra}`);
}

function splitPane(fromPane, cwd, job, worker) {
  const split = herdr(["pane", "split", "--pane", fromPane, "--direction", "right", "--cwd", cwd, "--no-focus", "--env", `PATH=${pathPrefix()}`, ...portEnvArgs(job), ...jobEnvArgs(job, worker)]);
  const pane = split.json?.result?.pane?.pane_id;
  if (!pane) herdrFail(split, "pane split");
  return pane;
}

function workerAlias(job, args, role = "builder") {
  if (job.kind === "pi") {
    if ("model" in args) fail("--model is only for kind claude; pi workers have no model flag");
    return "";
  }
  const jobDefault = role === "verifier" ? job.verifierModel || job.workerModel : job.workerModel;
  return assertClaudeModel(flagValue(args, "model") || jobDefault || DEFAULT_WORKER_MODEL, role === "verifier" ? "verifier" : "worker");
}

function baseName(name) {
  return String(name).replace(/-\d+$/, "");
}

// Conversation activity in a pane: an assistant/tool marker line (⏺, ⎿) or any prompt line that
// holds text (a submitted prompt echo; the live input box is checked separately).
function paneShowsActivity(paneText) {
  return String(paneText || "").split(/\r?\n/).some((l) => /^\s*[│|]?\s*(?:[⏺⎿●]|[❯>]\s+[^\s│|])/.test(l));
}

// A pane is provably unused when orka recorded delivery failed (a missing or ok delivery is never
// proof), it wrote no results/notes file, and right now (re-issue time) agent get succeeds with
// status exactly idle and the pane read shows no conversation activity, no prompt echo and an
// empty input box. A recorded failure alone is not proof: a hand re-delivery makes the agent work.
// Any doubt (agent get or pane read failing, other status) keeps the pane.
function provablyUnused(repo, job, worker) {
  if (worker.delivery !== "failed" || worker.closed || worker.closedUnused || !worker.pane) return false;
  if (worker.pane === job.pane) return false;
  if ((job.workers || []).some((w) => w !== worker && w.pane === worker.pane)) return false;
  const dir = jobDir(repo, job.id);
  const resultFile = worker.role === "verifier" ? verifierResultPath(repo, job.id) : join(dir, "results", `${worker.name}.json`);
  if (existsSync(resultFile) || existsSync(join(dir, "notes", `${worker.name}.txt`))) return false;
  const got = herdr(["agent", "get", worker.name]);
  const info = got.code === 0 && !got.json?.error ? got.json?.result?.agent : null;
  if (!info || info.agent_status !== "idle" || info.interactive_ready === false) return false;
  const read = herdr(["pane", "read", worker.pane, "--source", "recent"]);
  if (read.code !== 0 || read.json?.error || typeof read.text !== "string") return false;
  if (paneShowsActivity(read.text) || unsubmittedInput(read.text)) return false;
  return !promptSeenInPane(read.text, worker.task);
}

// When a re-issued task got a fresh worker (builder-2), the earlier same-task pane that never
// started is closed and recorded on the job. A pane that worked or wrote results/notes stays.
function closeUnusedDuplicates(repo, job, name, requested, task, role) {
  for (const worker of job.workers || []) {
    if (worker.name === name || worker.role !== role) continue;
    if (worker.task !== task && baseName(worker.name) !== baseName(requested)) continue;
    if (!provablyUnused(repo, job, worker)) continue;
    const got = herdr(["pane", "close", worker.pane]);
    if (got.code !== 0 || got.json?.error) {
      console.error(`warning: could not close unused duplicate pane ${worker.pane} (${worker.name})`);
      continue;
    }
    const at = new Date().toISOString();
    worker.closed = at;
    worker.closedUnused = { at, reason: `never started working, no results/notes; replaced by ${name}` };
    console.log(`closed unused duplicate worker ${worker.name} pane=${worker.pane} (replaced by ${name})`);
  }
}

function cmdWorker(args) {
  if ("orchestrator-model" in args || "worker-model" in args) {
    fail("use --model to override a worker; the job default is workerModel (verifierModel for --role verifier)");
  }
  allowFlags(args, ["cwd", "dry-run", "job", "name", "task", "pane", "model", "role"]);
  const id = args.job;
  const requested = args.name;
  const task = args.task || args._.slice(1).join(" ");
  if (!id || !requested || !task) fail("need --job --name --task");
  assertAgentName(String(requested));
  const role = parseRole(args);
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, String(id));
  if (role === "verifier" && !args["dry-run"]) recordVerifier(repo, job);
  checkRole(role, String(requested), job);
  const first = freeWorkerName(job, String(requested));
  const round = verifierState(job).rounds + 1;
  const alias = workerAlias(job, args, role);
  const kind = job.kind === "pi" ? "pi" : "claude";
  if (role !== "verifier") {
    const missing = ["SCOPE", "ACCEPTANCE"].filter((k) => !new RegExp(`${k}:`).test(String(task)));
    if (missing.length) console.error(`warning: worker task has no ${missing.map((k) => `${k}:`).join(" or ")} (brief template: GOAL / SCOPE / CONTEXT / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT); starting anyway`);
  }
  if (args["dry-run"]) {
    const wt = job.worktree || worktreePath(repo, job.id);
    console.log(`dry-run worker ${first} job=${job.id} kind=${kind}${alias ? ` model=${alias}` : ""} role=${role}${role === "verifier" ? ` round=${round}` : ""}`);
    console.log(`worktree: ${wt}`);
    console.log("layout: shared worktree");
    console.log(`split: herdr pane split --pane ${q(job.pane || "<orchestrator-pane>")} --direction right --cwd ${q(wt)} --no-focus`);
    console.log(`spawn: herdr ${sh(startArgs(first, args.pane || "<pane>", kind, alias, "<session-id>"))}`);
    console.log(`pane: ${paneCommand(alias)}`);
    return;
  }
  if (!job.pane || !job.agent || !job.worktree) fail("orchestrator is not running");
  if (job.status !== "running") fail(`job ${id} is ${job.status}, not running`);
  ensureJobDir(repo, job.id);
  if (role === "verifier") {
    archiveVerifierResult(repo, job, round - 1);
    reapPreviousVerifier(job);
  }
  const ownPane = !args.pane;
  const pane = args.pane ? String(args.pane) : splitPane(job.pane, job.worktree, job, first);
  let name = first;
  const tried = [];
  let started;
  const sessionId = randomUUID();
  for (;;) {
    started = herdr(startArgs(name, pane, kind, alias, sessionId), 90000);
    const failed = started.code !== 0 || started.json?.error;
    if (!failed) break;
    if (!/already used/i.test(started.text) || tried.length >= 20) break;
    tried.push(name);
    name = freeWorkerName(job, String(requested), tried);
  }
  if (started.code !== 0 || started.json?.error) {
    // The pane was split just now and never held an agent: close only that one.
    if (ownPane) herdr(["pane", "close", pane]);
    herdrFail(started, "worker start");
  }
  const prompt = role === "verifier" ? verifierPrompt(job, String(name), String(task), alias, round) : workerPrompt(job, String(name), String(task), alias);
  const delivered = promptWithRetry(String(name), prompt);
  noteSession(repo, job, `${browserPrefix(job)}-${name}`);
  job.workers = job.workers || [];
  job.workers.push({
    delivery: delivered.ok ? "ok" : "failed",
    ...(delivered.ok ? {} : { deliveryReason: delivered.reason }),
    name: String(name),
    pane,
    kind,
    model: alias,
    role,
    task: String(task),
    sessionId,
    startedAt: new Date().toISOString(),
    result: role === "verifier" ? verifierResultPath(repo, job.id) : join(jobDir(repo, job.id), "results", `${name}.json`),
    note: join(jobDir(repo, job.id), "notes", `${name}.txt`),
  });
  if (!delivered.ok) {
    save(repo, job);
    fail(`worker ${name} did not start: ${delivered.reason}. Delivery failed; re-issue the task (orka worker ...) instead of waiting for a note.`);
  }
  if (role === "verifier") {
    const state = verifierState(job);
    const { head, patchId, patchRound, stale, ...rest } = job.verifier || {};
    job.verifier = { ...rest, rounds: round, verdict: null, history: state.history, stall: null };
  }
  closeUnusedDuplicates(repo, job, String(name), String(requested), String(task), role);
  save(repo, job);
  if (name !== String(requested)) console.log(`name ${requested} was taken, using ${name}`);
  console.log(`${id} worker ${name} pane=${pane} kind=${kind}${alias ? ` model=${alias}` : ""}${role === "verifier" ? ` role=verifier round=${round}` : ""} worktree=${job.worktree}`);
}

// Context handoff for builder workers (docs/handoff.md). The watcher runs handoffTick every poll:
// a live builder past handoff.threshold of its window and idle is asked for a note; once the note
// exists and it is idle again, it is renamed <name>-h<n> and a fresh agent starts under <name> in a
// new pane of the same worktree. The old pane stays open until done, stop or cleanup.
const HANDOFF_NOTE_WAIT_MS = Number(brand.env("HANDOFF_NOTE_WAIT_MS")) || 15 * 60 * 1000;
let orchestratorHandoffLogged = false;

function handoffSettingsOf(repo) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath(repo), "utf8"));
  } catch {
    config = {};
  }
  return context.handoffSettings(config?.handoff);
}

// Load, change, save: a handoff step takes minutes, so it never writes back a stale job record.
function updateJob(repo, id, fn) {
  const job = load(repo, id);
  const out = fn(job);
  save(repo, job);
  return out;
}

// The session id is the stable key of a worker record; its name changes on handoff.
const workerBySession = (job, sessionId) => (job.workers || []).find((w) => w.sessionId === sessionId);

function measureWorker(job, worker, settings) {
  const path = context.findTranscript({ kind: worker.kind, cwd: job.worktree, sessionId: worker.sessionId, home: homedir() });
  return path ? context.contextOf(context.readUsage(path), settings.contextWindow) : null;
}

const herdrOk = (got) => got.code === 0 && !got.json?.error;
const herdrDetail = (got) => String(got.json?.error?.message || got.json?.error || got.text || "").replace(/\s+/g, " ").slice(0, 200);
const pctOf = (pct) => Math.round(pct * 1000) / 1000;

function handoffFailed(repo, id, sessionId, reason, log) {
  updateJob(repo, id, (job) => {
    const w = workerBySession(job, sessionId);
    if (w?.handoff) Object.assign(w.handoff, { state: "failed", reason });
  });
  appendDecision(repo, id, ["handoff", "handoff abandoned", reason, "", "failed"]);
  log(`handoff failed: ${reason}`);
}

function askForNote(repo, job, worker, ctx, settings, log) {
  const n = context.handoffNumber(worker);
  const note = context.notePath(jobDir(repo, job.id), worker.name, n);
  mkdirSync(dirname(note), { recursive: true });
  const sent = promptWithRetry(worker.name, context.notePrompt({ path: note, context: ctx, threshold: settings.threshold }));
  const at = new Date().toISOString();
  updateJob(repo, job.id, (j) => {
    const w = workerBySession(j, worker.sessionId);
    if (w) w.handoff = { state: sent.ok ? "writing" : "failed", n, note, tokens: ctx.tokens, window: ctx.window, pct: pctOf(ctx.pct), at, ...(sent.ok ? {} : { reason: sent.reason }) };
  });
  appendDecision(repo, job.id, ["handoff", `ask ${worker.name} for handoff note h${n}`, `context ${context.pctLabel(ctx.pct)} >= ${context.pctLabel(settings.threshold)} of ${ctx.window}`, note, sent.ok ? "asked" : `failed: ${sent.reason}`]);
  log(`handoff ${worker.name}: context ${context.pctLabel(ctx.pct)} (${ctx.tokens}/${ctx.window}); ${sent.ok ? `asked for ${note}` : `note prompt failed: ${sent.reason}`}`);
}

// Note written and the agent idle: rename it, start the successor under its name, prompt it.
function startSuccessor(repo, id, sessionId, log) {
  const job = load(repo, id);
  const worker = workerBySession(job, sessionId);
  const h = worker.handoff;
  const name = worker.name;
  const from = context.retiredName(name, h.n);
  const renamed = herdr(["agent", "rename", name, from]);
  if (!herdrOk(renamed)) return handoffFailed(repo, id, sessionId, `herdr agent rename ${name} ${from}: ${herdrDetail(renamed)}`, log);
  const at = new Date().toISOString();
  updateJob(repo, id, (j) => {
    const w = workerBySession(j, sessionId);
    w.name = from;
    w.retired = { at, by: name, n: h.n };
    w.handoff.state = "done";
  });
  const rollback = (why) => {
    herdr(["agent", "rename", from, name]);
    updateJob(repo, id, (j) => {
      const w = workerBySession(j, sessionId);
      w.name = name;
      delete w.retired;
    });
    handoffFailed(repo, id, sessionId, why, log);
  };
  const split = herdr(["pane", "split", "--pane", worker.pane, "--direction", "down", "--cwd", job.worktree, "--no-focus", "--env", `PATH=${pathPrefix()}`, ...portEnvArgs(job), ...jobEnvArgs(job, name)]);
  const pane = split.json?.result?.pane?.pane_id;
  if (!pane) return rollback(`pane split: ${herdrDetail(split)}`);
  const nextSession = randomUUID();
  const started = herdr(startArgs(name, pane, worker.kind, worker.model, nextSession), 90000);
  if (!herdrOk(started)) {
    // The pane was split just now and never held an agent: close only that one.
    herdr(["pane", "close", pane]);
    return rollback(`agent start ${name}: ${herdrDetail(started)}`);
  }
  const prompt = `${workerPrompt(job, name, worker.task, worker.model)}\n${context.successorLines({ path: h.note, n: h.n, from })}`;
  const delivered = promptWithRetry(name, prompt);
  const record = { n: h.n, from, pane: worker.pane, sessionId, tokens: h.tokens, window: h.window, pct: h.pct, at, note: h.note };
  updateJob(repo, id, (j) => {
    j.workers.push({
      delivery: delivered.ok ? "ok" : "failed",
      ...(delivered.ok ? {} : { deliveryReason: delivered.reason }),
      name,
      pane,
      kind: worker.kind,
      model: worker.model,
      role: worker.role,
      task: worker.task,
      sessionId: nextSession,
      startedAt: at,
      result: worker.result,
      note: worker.note,
      handoffs: [...(Array.isArray(worker.handoffs) ? worker.handoffs : []), record],
    });
    j.handoffs = [...(Array.isArray(j.handoffs) ? j.handoffs : []), { worker: name, ...record }];
  });
  appendDecision(repo, id, ["handoff", `${from} -> fresh ${name} (h${h.n})`, `context ${context.pctLabel(h.pct)}; old pane ${worker.pane} stays open`, h.note, delivered.ok ? `ok pane=${pane}` : `delivery failed: ${delivered.reason}`]);
  log(`handoff ${name}: old agent renamed ${from} (pane ${worker.pane} stays open), fresh ${name} pane=${pane}${delivered.ok ? "" : ` delivery failed: ${delivered.reason}`}`);
}

// One pass over a job's workers. Returns what it saw, for orka handoff --dry-run and the tests.
function handoffTick(repo, id, { log = console.log, dry = false } = {}) {
  const settings = handoffSettingsOf(repo);
  const job = load(repo, id);
  const seen = [];
  if (!settings.enabled || job.status !== "running" || !job.worktree) return seen;
  if (settings.orchestrator && !orchestratorHandoffLogged) {
    orchestratorHandoffLogged = true;
    log("handoff.orchestrator is on, but orchestrator handoff is not built yet; only workers are handed off");
  }
  for (const worker of job.workers || []) {
    if (!worker?.sessionId) continue;
    if (worker.handoff?.state === "writing") {
      const ready = existsSync(worker.handoff.note) && statSync(worker.handoff.note).size > 0;
      const status = agentStatus(worker.name);
      seen.push({ name: worker.name, state: "writing", ready, status });
      if (dry) continue;
      if (ready && status === "idle") startSuccessor(repo, id, worker.sessionId, log);
      else if (Date.now() - Date.parse(worker.handoff.at) > HANDOFF_NOTE_WAIT_MS) {
        handoffFailed(repo, id, worker.sessionId, `${worker.name} wrote no handoff note in ${Math.round(HANDOFF_NOTE_WAIT_MS / 60000)} min`, log);
      }
      continue;
    }
    const resultExists = existsSync(join(jobDir(repo, id), "results", `${worker.name}.json`));
    if (!context.handoffCandidate(worker, { resultExists })) continue;
    const ctx = measureWorker(job, worker, settings);
    if (!ctx) {
      seen.push({ name: worker.name, state: "no usage" });
      continue;
    }
    const status = ctx.pct >= settings.threshold ? agentStatus(worker.name) : "";
    const due = context.handoffDue({ context: ctx, status, threshold: settings.threshold });
    seen.push({ name: worker.name, tokens: ctx.tokens, window: ctx.window, pct: pctOf(ctx.pct), status, due: due.due, why: due.why });
    if (dry) continue;
    updateJob(repo, id, (j) => {
      const w = workerBySession(j, worker.sessionId);
      if (w) w.context = { tokens: ctx.tokens, window: ctx.window, pct: pctOf(ctx.pct), at: new Date().toISOString() };
    });
    if (due.due) askForNote(repo, job, worker, ctx, settings, log);
  }
  return seen;
}

function cmdHandoff(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need: orka handoff <id> [--dry-run]");
  const repo = requireRepo(args.cwd || process.cwd());
  const settings = handoffSettingsOf(repo);
  if (args["dry-run"]) console.log(`handoff: ${settings.enabled ? `threshold ${context.pctLabel(settings.threshold)}` : "off"}${settings.orchestrator ? " orchestrator flag on (not built)" : ""}`);
  const seen = handoffTick(repo, String(id), { dry: Boolean(args["dry-run"]) });
  for (const s of seen) {
    if (s.state) console.log(`${s.name}: ${s.state}${s.state === "writing" ? ` note=${s.ready ? "written" : "not yet"} status=${s.status}` : ""}`);
    else console.log(`${s.name}: ${s.tokens}/${s.window} tokens ${context.pctLabel(s.pct)}${s.status ? ` ${s.status}` : ""} -> ${s.due ? "hand off" : "keep"} (${s.why})`);
  }
  if (!seen.length) console.log("no worker to measure");
}

// A new verifier round starts clean: the previous verifier's sessions are closed
// and any Chrome left from them (tagged or by session name) is killed.
function reapPreviousVerifier(job) {
  const prefix = browserPrefix(job);
  const names = [...new Set([...(job.workers || []).filter((w) => w.role === "verifier").map((w) => w.name), "verify", "verify-base"])];
  for (const n of names) {
    const s = `${prefix}-${n}`;
    if (closeBrowser(s, { jobId: job.id })) console.log(`cleanup: closed previous verifier browser ${s}`);
  }
  reapBrowsers(job, { workers: names });
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
    console.log(`  branch: ${brand.jobBranch(job)}`);
    console.log(`  worktree: ${job.worktree || "(not created)"}`);
    console.log(`  layout: ${job.workerLayout || "shared-worktree"}`);
    console.log(`  playbook: ${job.playbook || "feature"}`);
    if (job.port != null) console.log(`  port: ${job.port}${Array.isArray(job.ports) && job.ports.length > 1 ? ` ports=${job.ports.join(",")}` : ""}`);
    if (roundOf(job) > 1) console.log(`  round: ${roundOf(job)} (follow-up)`);
    if (job.watcherPid && job.status === "running") console.log(`  watcher: pid ${job.watcherPid}`);
    if (job.workspaceClosed) console.log(`  workspace: closed ${job.workspaceClosed}`);
    else if (FINISH_STATUSES.has(job.status) && job.workspace) console.log(`  workspace: ${job.workspace} open until idle ${staleLabel(repo)}`);
    if (job.cleanup) console.log(`  cleaned up: ${job.cleanup.browsers.length} browser(s), ${job.cleanup.servers.length} server(s), ${job.cleanup.panes.length} worker pane(s)`);
    if (job.kind === "claude") console.log(`  models: orchestrator=${job.orchestratorModel || job.model || "-"} worker=${job.workerModel || "-"} ${verifierLabel(job)}`);
    if (job.agent || job.pane) console.log(`  agent: ${job.agent || "-"} pane=${job.pane || "-"} workspace=${job.workspace || "-"} model=${job.orchestratorModel || job.model || "-"}${job.leadDelivery === "failed" ? ` delivery=failed${job.stopReason ? ` [${job.stopReason}]` : ""}` : ""}`);
    for (const worker of job.workers || []) console.log(`  worker: ${worker.name} pane=${worker.pane} ${worker.model ? `model=${worker.model}` : "kind=pi"}${worker.role === "verifier" ? " role=verifier" : ""}${worker.delivery ? ` delivery=${worker.delivery}` : ""}${worker.closedUnused ? ` closed-unused (${worker.closedUnused.reason})` : ""}${worker.delivery === "failed" && worker.deliveryReason ? ` [${worker.deliveryReason}]` : ""}${handoffLabel(worker)}`);
    for (const steer of (job.steers || []).filter((x) => x?.delivery === "failed")) console.log(`  steer: ${String(steer.message ?? "").slice(0, 200).replace(/[\r\n]+/g, " ")} delivery=failed${steer.deliveryReason ? ` [${steer.deliveryReason}]` : ""}`);
    const summary = summaryOf(repo, job);
    if (summary) console.log(`  summary: ${summary}`);
    if (job.stopReason) console.log(`  stop: ${job.stopReason}`);
    console.log(`  ${finishStatusLine(repo, job)}`);
    printVerifyStatus(repo, job);
    console.log(`  decisions: ${decisionRows(repo, job.id).length}`);
    if (job.verifier?.rounds && job.status === "running") recordVerifier(repo, job);
    if (verifierLine(job)) console.log(`  ${verifierLine(job)}`);
    printVerifierDetail(job);
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

function handoffLabel(worker) {
  const parts = [];
  if (worker.context?.pct != null && !worker.retired) parts.push(`ctx=${context.pctLabel(worker.context.pct)}`);
  if (worker.retired) parts.push(`handed-off->${worker.retired.by} (h${worker.retired.n}, pane open)`);
  else if (worker.handoff?.state === "writing") parts.push(`handoff=writing ${worker.handoff.note}`);
  else if (worker.handoff?.state === "failed") parts.push(`handoff=failed [${worker.handoff.reason}]`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function staleLabel(repo) {
  const ms = staleThreshold(repo);
  return `for ${Math.round(ms / 3600000 * 10) / 10}h`;
}

function printVerifierDetail(job) {
  const v = job.verifier;
  if (!v || !(Number(v.rounds) > 0)) return;
  const last = (v.history || []).at(-1);
  console.log(`  verifier rounds: ${v.rounds}${job.maxRounds ? ` (ceiling ${job.maxRounds})` : ""}`);
  if (last?.failing?.length) console.log(`  last failing: ${last.failing.join(", ")}`);
  if (last?.warnings?.length) console.log(`  warnings (non-blocking): ${last.warnings.join(", ")}`);
  if (v.stall) {
    console.log(`  stall: ${v.stall.checks.join(", ")} failed in rounds ${v.stall.rounds[0]} and ${v.stall.rounds[1]}; change strategy, then run orka strategy ${job.id} --premise "<shared premise>" "<what changed>"`);
  }
  for (const c of v.strategyChanges || []) console.log(`  strategy change (round ${c.round}): ${c.premise ? `premise: ${c.premise} | change: ` : ""}${c.change}`);
  if (v.stopReason) console.log(`  verifier stop: ${v.stopReason}`);
}

const DECISION_HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";

function decisionsPath(repo, id) {
  return join(jobDir(repo, id), "decisions.tsv");
}

function tsvCell(value) {
  return String(value ?? "").replace(/\r\n|\r|\n/g, "\\n").replace(/\t/g, "\\t");
}

function appendDecision(repo, id, cells) {
  const path = decisionsPath(repo, id);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, DECISION_HEADER);
  appendFileSync(path, `${[new Date().toISOString(), ...cells].map(tsvCell).join("\t")}\n`);
}

function decisionRows(repo, id) {
  const path = decisionsPath(repo, id);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split("\n").slice(1).filter(Boolean);
  } catch {
    return [];
  }
}

function cmdLog(args) {
  allowFlags(args, ["cwd"]);
  const [, id, phase, decision, why, evidence, result] = args._;
  if (args._.length !== 7) fail('need: orka log <id> <phase> <decision> <why> <evidence> <result> (quote each argument)');
  const repo = requireRepo(args.cwd || process.cwd());
  load(repo, id);
  appendDecision(repo, id, [phase, decision, why, evidence, result]);
  console.log(`decision ${decisionRows(repo, id).length} logged for ${id}`);
}

function cmdStrategy(args) {
  allowFlags(args, ["cwd", "premise"]);
  const id = args._[1];
  const premise = "premise" in args ? flagValue(args, "premise") : "";
  const change = args._.slice(2).join(" ").trim();
  if (!id || !change) fail('need id and what changed: orka strategy <id> "<what changed>"');
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  const v = job.verifier || {};
  const list = Array.isArray(v.strategyChanges) ? v.strategyChanges.slice() : [];
  list.push({ round: Number(v.rounds) || 0, change, ...(premise ? { premise } : {}), at: new Date().toISOString() });
  job.verifier = { rounds: Number(v.rounds) || 0, verdict: v.verdict ?? null, history: Array.isArray(v.history) ? v.history : [], ...v, strategyChanges: list };
  save(repo, job);
  appendDecision(repo, id, ["strategy", premise ? `premise: ${premise} | change: ${change}` : change, "", "", ""]);
  console.log(`strategy change ${list.length} recorded for ${id}`);
}

// Snapshot input only. Never copy workers[].task. Never open verify.log.
function digestView(job) {
  const workers = Array.isArray(job.workers)
    ? job.workers.map((worker) => ({ name: worker?.name, role: worker?.role, ...(worker?.retired ? { handedOffTo: worker.retired.by, handoffPct: worker.handoff?.pct } : {}) }))
    : [];
  return { ...job, workers };
}

function readCapped(path, maxBytes) {
  const size = statSync(path).size;
  const n = Math.min(size, maxBytes);
  if (n <= 0) return { size, text: "" };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const got = readSync(fd, buf, off, n - off, off);
      if (got <= 0) break;
      off += got;
    }
    return { size, text: buf.subarray(0, off).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

const SAFE_WORKER = /^[a-z][a-z0-9_-]{0,31}$/;

function workerOk(dir, worker, files) {
  if (worker.role === "verifier") return files.verifierSkipped == null && files.verifier?.verdict === "pass";
  const path = join(dir, "results", `${worker.name}.json`);
  if (!existsSync(path)) return false;
  try {
    const size = statSync(path).size;
    if (size > FILE_READ_MAX) return false;
    return JSON.parse(readCapped(path, size).text)?.ok === true;
  } catch {
    return false;
  }
}

function collectDigestFiles(repo, job) {
  const dir = jobDir(repo, job.id);
  const files = { notes: {}, ok: {}, stateDir: brand.stateDirName(repo) };
  const summaryPath = join(dir, "summary.txt");
  if (existsSync(summaryPath)) {
    try {
      files.summary = readCapped(summaryPath, FILE_READ_MAX).text.slice(0, SUMMARY_MAX);
    } catch {
      files.summary = "";
    }
  } else if (job.summary) {
    files.summary = String(job.summary).slice(0, SUMMARY_MAX);
  }
  const decisions = decisionRows(repo, job.id);
  if (decisions.length) files.decisions = { count: decisions.length, rows: decisions.slice(-DECISION_ROWS) };
  const verifierPath = join(dir, "results", `${VERIFIER_NAME}.json`);
  if (existsSync(verifierPath)) {
    try {
      const size = statSync(verifierPath).size;
      if (size > VERIFIER_JSON_MAX) files.verifierSkipped = size;
      else files.verifier = JSON.parse(readCapped(verifierPath, size).text);
    } catch {
      if (files.verifierSkipped == null) files.verifier = null;
    }
  }
  for (const worker of job.workers || []) {
    const name = worker?.name;
    if (typeof name !== "string" || !name) continue;
    if (!SAFE_WORKER.test(name)) {
      files.notes[name] = null;
      files.ok[name] = false;
      continue;
    }
    const notePath = join(dir, "notes", `${name}.txt`);
    if (!existsSync(notePath)) files.notes[name] = null;
    else {
      try {
        files.notes[name] = readCapped(notePath, FILE_READ_MAX).text;
      } catch {
        files.notes[name] = null;
      }
    }
    files.ok[name] = workerOk(dir, worker, files);
    // lib/digest.mjs renders only the note text, so delivery state rides in it.
    if (files.notes[name] == null && worker.closedUnused) files.notes[name] = "closed unused duplicate (never started)";
    else if (worker.delivery === "failed") {
      // Only a worker with neither results nor notes provably never ran; otherwise the task was re-delivered by hand.
      const hasResult = existsSync(join(dir, "results", `${name}.json`));
      if (files.notes[name] == null && !hasResult) files.notes[name] = "DELIVERY FAILED: prompt never started the agent; re-issue the task";
      else if (files.notes[name] != null) files.notes[name] += " (delivery retried by hand)";
    }
  }
  return files;
}

function cmdDigest(args) {
  allowFlags(args, ["cwd"]);
  const id = args._[1];
  if (!id) fail("need: orka digest <id>");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  const text = renderDigest(digestView(job), collectDigestFiles(repo, job));
  process.stdout.write(text.length < DIGEST_MAX ? `${text}\n` : text);
}

function cmdSteer(args) {
  allowFlags(args, ["cwd"]);
  const id = args._[1];
  const message = args._.slice(2).join(" ").trim();
  if (!id || !message) fail('need: orka steer <id> "message"');
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  const finished = FINISH_STATUSES.has(job.status);
  if ((job.status !== "running" && !finished) || !job.agent) fail(`${id} is ${job.status}; not steered`);
  // A finished job can be steered while its orchestrator pane is still open:
  // that starts a follow-up round, and the next orka done sends the wake again.
  if (finished && (job.workspaceClosed || !agentExists(job.agent))) {
    fail(`${id} is ${job.status} and its orchestrator pane is gone; not steered`);
  }
  const digest = renderDigest(digestView(job), collectDigestFiles(repo, job));
  const sent = promptWithRetry(job.agent, steerText(digest, message));
  const now = new Date().toISOString();
  if (!sent.ok) {
    job.steers = job.steers || [];
    job.steers.push({ at: now, message, delivery: "failed", deliveryReason: sent.reason });
    save(repo, job);
    fail(`steer not delivered: ${sent.reason}`);
  }
  job.steers = job.steers || [];
  job.steers.push({ at: now, message });
  job.steered = now;
  job.updated = now;
  if (finished) {
    job.round = roundOf(job) + 1;
    job.followUp = true;
    job.status = "running";
    job.stopReason = "";
  }
  save(repo, job);
  if (finished) startWatcher(repo, job);
  console.log(finished ? `steered ${id} (follow-up round ${job.round}; run orka done ${id} when finished)` : `steered ${id}`);
}

function agentExists(name) {
  const got = herdr(["agent", "get", name]);
  return got.code === 0 && !got.json?.error && Boolean(got.json?.result?.agent);
}

function interrupt(name) {
  const first = herdr(["agent", "send-keys", name, "ctrl+c"]);
  sleep(200);
  const second = herdr(["agent", "send-keys", name, "ctrl+c"]);
  return first.code === 0 && second.code === 0 && !first.json?.error && !second.json?.error;
}

async function cmdStop(args) {
  allowFlags(args, ["cwd", "dry-run", "keep"]);
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
    releaseJob(repo, job, { dryRun: true, keep: args.keep });
    return;
  }
  if (job.status !== "running" && job.status !== "queued") {
    console.log(`${id} is already ${job.status}`);
    return;
  }
  let how = "recorded";
  if (job.status === "running") {
    let ok = false;
    if (job.agent) {
      const lead = interrupt(job.agent);
      for (const worker of job.workers || []) interrupt(worker.name);
      if (lead) {
        ok = true;
        how = "interrupted";
      } else if (!agentExists(job.agent)) {
        // Nothing left to interrupt. The workspace stays for orka cleanup.
        ok = true;
        how = "agent already gone";
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
  releaseJob(repo, job, { keep: args.keep });
}

function verifierFailReason(rounds, blocking = []) {
  const checks = [...new Set(blocking.map((b) => b.check))];
  return `verifier failed after ${rounds} round${rounds === 1 ? "" : "s"}${checks.length ? `: ${checks.join(", ")}` : ""}`;
}

async function cmdDone(args) {
  allowFlags(args, ["cwd", "dry-run", "keep", "give-up"]);
  const id = args._[1];
  if (!id) fail("need id");
  const giveUp = "give-up" in args ? args["give-up"] : null;
  if (giveUp !== null && (typeof giveUp !== "string" || !giveUp.trim())) fail('--give-up needs a plain reason: orka done <id> --give-up "<reason>"');
  const reason = args._.slice(2).join(" ").trim() || "completed";
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status === "queued") fail(`orka done: ${id} is queued, not running; nothing finished`);
  const terminal = job.status !== "running";
  if (args["dry-run"]) {
    if (terminal) {
      console.log(`dry-run done ${id}: already ${job.status}; no status change; no finish webhook`);
      return;
    }
    const next = computeVerifier(repo, job);
    const view = { ...job, verifier: next || job.verifier };
    if (giveUp) view.verifier = { ...(view.verifier || { rounds: 0 }), stopReason: giveUp.trim() };
    const failing = Boolean(giveUp) || view.verifier?.verdict === "fail";
    if (!giveUp && view.verifier?.verdict === "pass" && view.verifier.stale) {
      console.log(`dry-run done ${id}: REFUSED, ${verifierLine(view)}; re-run the verifier first`);
      return;
    }
    const detail = verificationDetail(repo, view);
    const why = giveUp ? giveUp.trim() : failing ? verifierFailReason(view.verifier.rounds, detail.blocking) : reason;
    console.log(`dry-run done ${id}: running -> ${failing ? "failed" : "done"}`);
    console.log(`reason: ${why}`);
    if (verifierLine(view)) console.log(verifierLine(view));
    const preview = await deliverFinish(repo, { ...view, status: failing ? "failed" : "done" }, { dryRun: true });
    for (const line of preview.lines) console.log(`finish webhook: ${line}`);
    releaseJob(repo, job, { dryRun: true, keep: args.keep });
    return;
  }
  if (terminal) {
    console.log(`${id} is already ${job.status}`);
    return;
  }
  const verifier = recordVerifier(repo, job);
  if (!giveUp && verifier?.verdict === "pass" && verifier.stale) {
    console.error(`orka done: ${id} not marked done. ${verifierLine(job)}; the verifier pass no longer describes the code. Re-run the verifier (orka worker --job ${id} --name ${VERIFIER_NAME} --role verifier --task "..."), then run orka done again. To stop without a verified result: orka done ${id} --give-up "<reason>".`);
    process.exitCode = 1;
    return;
  }
  let failed = verifier?.verdict === "fail";
  let why = failed ? verifierFailReason(verifier.rounds, verificationDetail(repo, job).blocking) : reason;
  if (giveUp) {
    failed = true;
    why = giveUp.trim();
    job.verifier = { ...(job.verifier || { rounds: 0, verdict: null, history: [] }), stopReason: why };
    save(repo, job);
  }
  const wake = await markTerminal(repo, job, failed ? "failed" : "done", why);
  console.log(`${failed ? "failed" : "done"} ${id}: ${why}`);
  if (verifierLine(job)) console.log(verifierLine(job));
  console.log(finishLine(wake));
  releaseJob(repo, job, { keep: args.keep });
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
  if (cfg.verify === false) return { skip: true, reason: `disabled in ${brand.stateDirName(repo)}/config.json` };
  if (cfg.verify != null && cfg.verify !== "") {
    if (typeof cfg.verify !== "string") fail('config "verify" must be a path or false');
    const path = resolve(worktree, cfg.verify);
    if (!existsSync(path)) fail(`checks file not found: ${path}\nconfig verify is ${cfg.verify}`);
    assertChecksFile(path);
    return { path };
  }
  const path = join(worktree, verifyFile(worktree));
  if (!existsSync(path)) return { skip: true, reason: `no ${VERIFY_FILE}` };
  assertChecksFile(path);
  return { path };
}

function relTo(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..")) return path;
  return rel;
}

function verifySession(job) {
  return `${browserPrefix(job)}-verify`;
}

function classifyChecks(path) {
  if (path.endsWith(".json")) return "json";
  const head = readFileSync(path, "utf8").replace(/^\uFEFF/, "").slice(0, 200).trimStart();
  if (!head) fail(`checks file is empty: ${path}`);
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  return "script";
}

function expandDeep(value, job) {
  if (typeof value === "string") return ports.expandPortVars(value, job);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, job));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v, job)]));
  return value;
}

function loadSteps(path, job) {
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
  return job ? expandDeep(steps, job) : steps;
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
    fail("argv step must not set --session or --json; orka sets those");
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

function loadPlans(path, job) {
  const steps = loadSteps(path, job);
  const plans = steps.map((step, index) => {
    try {
      return planStep(step);
    } catch (err) {
      fail(`step ${index + 1}: ${err?.orka ? err.message : err?.message || err}`);
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
    killSignal: "SIGKILL",
    env: browserEnv(session),
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
      const msg = err?.orka ? err.message : err?.message || String(err);
      appendFileSync(logPath, `fail ${label}: ${msg}\n`);
      fail(`step ${index + 1}/${plans.length} (${describePlan(plan)}): ${msg}`);
    }
  });
}

// started: this run used the session, so close it for real. Otherwise (a reset
// before the run) a session with nothing alive is only cleaned, never launched.
function closeSession(session, cwd, { started = false } = {}) {
  try {
    closeBrowser(session, { force: started });
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
      ...brand.envOf({
        JOB: job.id,
        WORKER: brand.env("WORKER") || session.replace(/^or[ck]a-[0-9a-f]{8}-/, ""),
        REPO: job.repo,
        WORKTREE: job.worktree,
        BRANCH: job.branch || "",
      }),
      ...ports.portEnv(job),
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim().slice(-4000);
  if (out) appendFileSync(logPath, `${out}\n`);
  if (r.error && r.error.code === "ETIMEDOUT") fail("checks script timed out after 600s");
  if (r.error && r.error.code === "ENOENT") fail(`cannot run checks script: ${cmd} is not on PATH`);
  if ((r.status ?? 1) !== 0) fail(`checks script exited ${r.status ?? 1}${out ? `\n${out.slice(-800)}` : ""}`);
}

function recordFailed(repo, job, err, file) {
  const msg = err?.orka ? err.message : err?.message || String(err);
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
  console.log(`session: ${verifySession(job)}`);
  if (kind === "script") {
    console.log("would run the script with AGENT_BROWSER_SESSION set, then close that session");
    return;
  }
  const plans = loadPlans(path, job);
  console.log(`steps: ${plans.length}`);
  plans.forEach((plan, index) => console.log(`  ${index + 1}. ${describePlan(plan)}`));
}

function baseOf(repo, job) {
  if (job.baseCommit) return job.baseCommit;
  const branch = brand.jobBranch(job);
  for (const main of ["main", "master"]) {
    const got = git(repo, ["merge-base", branch, main]);
    if (got.code === 0 && got.out) return got.out;
  }
  fail(`cannot find the base commit of ${branch}: no baseCommit on the job and no merge-base with main`);
}

// Runs the same checks file against a temporary detached worktree at the base commit.
// Does not touch job.verify. This is the mechanical "pre-existing" test.
function cmdVerifyBase(repo, job, args) {
  const id = job.id;
  const base = baseOf(repo, job);
  const checks = resolveChecks(repo, job.worktree);
  if (checks.skip) fail(`verify --base needs a checks file: ${checks.reason}`);
  const kind = classifyChecks(checks.path);
  const rel = relTo(job.worktree, checks.path);
  if (args["dry-run"]) {
    console.log(`dry-run verify --base ${id}`);
    console.log(`base: ${base}`);
    console.log(`checks: ${checks.path} (${kind})`);
    console.log(`would add a detached worktree at ${base}, run the checks there, remove it, and write results/verify-base.json`);
    return;
  }
  const tmp = join(brand.stateDir(repo), "worktrees", `${id}-base-${process.pid}`);
  const added = git(repo, ["worktree", "add", "--detach", tmp, base]);
  if (added.code !== 0) fail(added.err || added.out || "git worktree add failed");
  const session = `${verifySession(job)}-base`;
  verifyJobId = job.id;
  const logPath = join(ensureJobDir(repo, id), "verify-base.log");
  writeFileSync(logPath, `verify --base ${id}\nbase ${base}\nfile ${checks.path}\n`);
  const steps = [];
  try {
    const target = join(tmp, relative(job.worktree, checks.path));
    if (!relTo(job.worktree, checks.path).startsWith("/")) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(checks.path));
    }
    const runPath = relTo(job.worktree, checks.path).startsWith("/") ? checks.path : target;
    noteSession(repo, job, session);
    closeSession(session, tmp);
    if (kind === "json") {
      const plans = loadPlans(runPath, job);
      plans.forEach((plan, index) => {
        let outcome = "pass";
        try {
          execPlan(session, plan, tmp);
        } catch (err) {
          outcome = "fail";
          appendFileSync(logPath, `fail ${index + 1}: ${err?.orka ? err.message : err?.message || String(err)}\n`);
        }
        steps.push({ index: index + 1, name: describePlan(plan), outcome });
      });
    } else {
      let outcome = "pass";
      try {
        runScript(runPath, tmp, session, logPath, { ...job, worktree: tmp });
      } catch (err) {
        outcome = "fail";
        appendFileSync(logPath, `fail: ${err?.orka ? err.message : err?.message || String(err)}\n`);
      }
      steps.push({ index: 1, name: rel, outcome });
    }
  } finally {
    closeSession(session, tmp, { started: true });
    git(repo, ["worktree", "remove", "--force", tmp]);
    rmSync(tmp, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
  }
  const failed = steps.filter((x) => x.outcome === "fail");
  const out = { base, file: rel, at: new Date().toISOString(), steps, failed: failed.length, passed: steps.length - failed.length, log: logPath };
  const resultsDir = join(ensureJobDir(repo, id), "results");
  mkdirSync(resultsDir, { recursive: true });
  const resultPath = join(resultsDir, "verify-base.json");
  writeFileSync(resultPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`verify --base ${id} at ${base}: ${out.passed} passed, ${out.failed} failed${failed.length ? ` (steps ${failed.map((x) => x.index).join(", ")})` : ""}`);
  console.log(`wrote ${resultPath}`);
}

function cmdVerify(args) {
  allowFlags(args, ["cwd", "dry-run", "base"]);
  const id = args._[1];
  if (!id) fail("need id");
  if (args._.length > 2) fail("verify takes one job id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (!job.worktree) fail(`job ${id} has no worktree; run it before verify`);
  if (!existsSync(job.worktree)) fail(`worktree missing: ${job.worktree}`);
  if (args.base) {
    cmdVerifyBase(repo, job, args);
    return;
  }
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
  const session = verifySession(job);
  verifyJobId = job.id;
  noteSession(repo, job, session);
  const logPath = join(ensureJobDir(repo, id), "verify.log");
  const file = relTo(job.worktree, checks.path);
  writeFileSync(logPath, `verify ${id}\nat ${new Date().toISOString()}\nfile ${checks.path}\nsession ${session}\nkind ${kind}\n`);
  let started = false;
  try {
    if (kind === "json") {
      const plans = loadPlans(checks.path, job);
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
    const msg = err?.orka ? err.message : err?.message || String(err);
    try {
      recordVerify(repo, job, { status: "failed", summary: msg, file, log: logPath });
    } catch {
      // keep the verify error
    }
    const withLog = msg.includes(logPath) ? msg : `${msg}\nlog: ${logPath}`;
    if (err?.orka) {
      err.message = `verify failed ${id}: ${withLog}`;
      throw err;
    }
    fail(`verify failed ${id}: ${withLog}`);
  } finally {
    if (started) closeSession(session, job.worktree, { started: true });
  }
}

// --older-than, else "staleAfter" in .orka/config.json (such as "12h"), else 12h.
function staleThreshold(repo, flag) {
  if (flag !== undefined) return lifecycle.parseDuration(flagValue({ "older-than": flag }, "older-than"));
  try {
    const configured = JSON.parse(readFileSync(configPath(repo), "utf8")).staleAfter;
    if (configured != null && configured !== "") return typeof configured === "number" ? configured : lifecycle.parseDuration(configured);
  } catch {
    // fall back to the default
  }
  return lifecycle.DEFAULT_STALE_MS;
}

// Kills orphan `orka.mjs watch` (and old `orca.mjs watch`) processes of this repo. Prints each one.
function reapWatchers(repo, jobs, dry) {
  const orphans = watch.selectOrphanWatchers(watch.listWatchers(), { repo, jobs, exists: (p) => Boolean(p) && existsSync(p) });
  for (const o of orphans) {
    console.log(`cleanup: ${dry ? "would kill" : "killed"} orphan watcher pid ${o.pid} (${o.jobId}, ${o.why})`);
    if (dry || brand.env("FAKE_WATCHERS")) continue;
    try {
      process.kill(o.pid, "SIGTERM");
    } catch {
      // gone already
    }
  }
  return orphans.length;
}

// Closes the workspace of finished jobs idle longer than the threshold. Browsers
// first, then workspaces. Returns what it did. quiet: no "nothing to close" line.
function sweep(repo, { dry = false, thresholdMs, orphans = true, quiet = false, orphanMinAgeMs = ORPHAN_BROWSER_HOURS * 3600000 } = {}) {
  const verb = dry ? "would close" : "closed";
  const jobs = loadAllJobs(repo);
  const live = jobs.filter((j) => j.status === "running");
  const now = Date.now();
  let count = 0;
  const workspaces = jobs.filter((j) => lifecycle.isStale(j, now, thresholdMs));
  if (orphans) {
    const names = new Set();
    for (const s of [...browserList(), ...jobs.flatMap((j) => j.browserSessions || [])]) {
      const owner = jobs.find((j) => s.startsWith(`${browserPrefix(j)}-`) || s === legacyVerifySession(j));
      if (owner && !live.includes(owner) && !owner.keep) names.add(s);
    }
    for (const s of orphanSessions()) names.add(s);
    const deadline = Date.now() + CLEANUP_BUDGET_MS;
    for (const s of names) {
      if (Date.now() > deadline) {
        console.log(`cleanup: time budget spent, skipping browser ${s}`);
        continue;
      }
      if (dry || closeBrowser(s)) {
        console.log(`cleanup: ${verb} browser ${s}`);
        count++;
      }
    }
    // Leftover browser processes of this repo's finished jobs (tagged ORKA_JOB/ORCA_JOB,
    // or named by session), then orphan agent-browser Chrome nobody owns.
    const finished = jobs.filter((j) => j.status !== "running" && j.status !== "queued" && !j.keep);
    const scan = browsers.scanBrowsers();
    const doomed = new Set();
    const procs = [
      ...browsers.selectReap(scan, { finishedJobIds: finished.map((j) => j.id) }),
      ...finished.flatMap((j) => browsers.selectReap(scan, { prefix: browserPrefix(j) })),
    ].filter((p) => !doomed.has(p.pid) && doomed.add(p.pid));
    count += killBrowserProcs(procs, dry).length;
    const orphanProcs = browsers.selectOrphans(scan.filter((p) => !doomed.has(p.pid)), {
      minAgeMs: orphanMinAgeMs,
      liveJobIds: live.map((j) => j.id),
      livePrefixes: live.map(browserPrefix),
    });
    if (orphanProcs.length) console.log(`cleanup: ${orphanProcs.filter((p) => p.chromeRoot).length} orphan agent-browser Chrome root(s) older than ${orphanMinAgeMs / 3600000}h, no running job`);
    count += killBrowserProcs(orphanProcs, dry).length;
    count += reapWatchers(repo, jobs, dry);
  }
  for (const j of workspaces) {
    console.log(`cleanup: ${verb} workspace ${j.workspace} (${j.id}, idle since ${new Date(lifecycle.lastActivity(j) || 0).toISOString()})`);
    count++;
  }
  if (!count && !quiet) console.log("cleanup: nothing to close");
  if (dry) return count;
  for (const j of workspaces) {
    // The record first: closing the workspace kills any pane in it.
    j.workspaceClosed = new Date().toISOString();
    save(repo, j);
    herdr(["workspace", "close", j.workspace]);
  }
  return count;
}

// Opportunistic sweep at orka new / run. Only stale workspaces; never fatal, never on stdout.
function sweepQuietly(repo) {
  try {
    const jobs = loadAllJobs(repo);
    const now = Date.now();
    const threshold = staleThreshold(repo);
    const stale = jobs.filter((j) => lifecycle.isStale(j, now, threshold));
    for (const j of stale) {
      j.workspaceClosed = new Date().toISOString();
      save(repo, j);
      herdr(["workspace", "close", j.workspace]);
    }
    if (stale.length) console.error(`cleanup: closed ${stale.length} stale workspace${stale.length === 1 ? "" : "s"} (${stale.map((j) => j.id).join(", ")})`);
  } catch {
    // a sweep must never block new or run
  }
}

// Closes one job's browsers (or one worker's) without touching panes. Safe mid-job.
function cmdReap(args) {
  allowFlags(args, ["cwd", "dry-run", "worker"]);
  const id = args._[1];
  if (!id) fail("need id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  const worker = args.worker ? String(args.worker) : null;
  const dry = Boolean(args["dry-run"]);
  const sessions = jobSessions(job).filter((s) => !worker || s === `${browserPrefix(job)}-${worker}`);
  for (const s of sessions) if (dry || closeBrowser(s, { jobId: job.id })) console.log(`cleanup: ${dry ? "would close" : "closed"} browser ${s}`);
  const pids = reapBrowsers(job, { worker, dry });
  if (!pids.length) console.log("reap: no browser processes left");
}

function cmdCleanup(args) {
  allowFlags(args, ["cwd", "dry-run", "older-than", "orphan-hours"]);
  const repo = requireRepo(args.cwd || process.cwd());
  let orphanMinAgeMs = (Number(brand.env("ORPHAN_BROWSER_HOURS")) || ORPHAN_BROWSER_HOURS) * 3600000;
  if (args["orphan-hours"] !== undefined) {
    const hours = Number(args["orphan-hours"]);
    if (!Number.isFinite(hours) || hours < 0) fail("--orphan-hours needs a number of hours, such as 2");
    orphanMinAgeMs = hours * 3600000;
  }
  sweep(repo, { dry: Boolean(args["dry-run"]), thresholdMs: staleThreshold(repo, args["older-than"]), orphanMinAgeMs });
}

// Hidden: runs detached from orka run. Posts needs-input to the finish webhook until the job is terminal.
async function cmdWatch(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  const log = (msg) => console.log(`${new Date().toISOString()} watch ${id}: ${msg}`);
  if (FINISH_STATUSES.has(job.status)) {
    log(`job is ${job.status}; nothing to watch`);
    return;
  }
  if (!job.agent || !job.pane) fail(`job ${id} has no orchestrator agent or pane to watch`);
  const config = readFinishConfig(repo);
  if (args["dry-run"]) {
    console.log(`dry-run watch ${id}: agent=${job.agent} pane=${job.pane}`);
    console.log(`would post {kind:"needs-input", job, title, status, question, pane} to ${config.origin || (config.off ? "(no webhook configured: log and skip)" : `(invalid config: ${config.error})`)}`);
    return;
  }
  const deps = {
    ...watch.defaultDeps(repo),
    loadJob: async (jobId) => {
      try {
        return load(repo, jobId);
      } catch {
        return null;
      }
    },
    repoExists: () => existsSync(repo),
    pathExists: (p) => existsSync(p),
    tick: () => handoffTick(repo, id, { log }),
    post: async (payload) => {
      const cfg = readFinishConfig(repo);
      if (cfg.off) return log("no finish webhook configured; needs-input not sent");
      if (cfg.error) return log(`finish webhook config invalid (${cfg.error}); needs-input not sent`);
      const sent = await postFinish(cfg, payload);
      log(`needs-input ${payload.status}: ${sent.outcome} (${sent.detail})`);
    },
    log,
  };
  log(`watching agent ${job.agent} pane ${job.pane}`);
  const result = await watch.watchJob({ jobId: id, agent: job.agent, pane: job.pane, deps });
  log(`exit: ${result.exit}`);
}

function help() {
  console.log(`orka — one job in a linked worktree

  orka init [--cwd <repo>]
  orka new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi] [--keep]
           [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds <N>]
  orka run <id> [--dry-run] [--cwd <repo>] [--keep]
           [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds <N>]
  orka worker --job <id> --name <agent> --task "..." [--model <alias>] [--role builder|verifier] [--dry-run]
           (--model is claude only; pi workers have no model flag; --role verifier defaults to the job's verifierModel)
           (--role verifier needs --name verifier; no round limit unless the job has --max-rounds)
           A name already used by a worker of this job, or by a herdr agent, gets -2, -3... appended and
           the real name is printed. Verifier rounds are verifier, verifier-2, verifier-3... Panes are
           never closed while the job runs; orka frees them on done/stop.
  orka status [id] [--cwd <repo>]
  orka digest <id> [--cwd <repo>]
  orka steer <id> "message"   (also on a finished job whose orchestrator pane is still open: starts a follow-up round)
  orka stop <id> [reason] [--dry-run] [--keep]
  orka strategy <id> [--premise "<shared premise>"] "<what changed>"
  orka log <id> <phase> <decision> <why> <evidence> <result>   (appends a row to .orka/jobs/<id>/decisions.tsv)
  orka done <id> [reason] [--give-up "<reason>"] [--dry-run] [--keep] [--cwd <repo>]
  orka cleanup [--dry-run] [--older-than <12h>] [--orphan-hours <2>] [--cwd <repo>]
  orka reap <id> [--worker <name>] [--dry-run] [--cwd <repo>]   (closes browsers only; panes stay)
  orka watch <id> [--dry-run] [--cwd <repo>]   (started by orka run; not for hand use)
  orka handoff <id> [--dry-run] [--cwd <repo>]   (one context-handoff pass; the watcher runs it every poll)
  orka webhook <id> [--dry-run] [--force] [--cwd <repo>]
  orka verify <id> [--base] [--dry-run] [--cwd <repo>]
  orka help

digest prints a capped snapshot and does not change the job.

Jobs: <repo>/.orka/jobs/<id>.json
Worktree: <repo>/.orka/worktrees/<id> on branch orka/<id>
Workers share that worktree. Sibling worktrees are not in v0.

kind claude (default)
  Defaults: orchestrator ${DEFAULT_ORCHESTRATOR_MODEL} (Opus 5.5), worker ${DEFAULT_WORKER_MODEL} (Sonnet 5.5).
  The job stores orchestratorModel and workerModel. new sets them. run may replace them.
  orka worker --model overrides one worker; the job default stays workerModel.
  Aliases are checked against claude --help. Unknown aliases fail. The error lists the aliases named there.
  A full model name (claude-…) is accepted when help says so.
  run starts the orchestrator (claude --model <orchestratorModel>) in a Herdr pane.
  It does not implement the goal. It starts workers with orka worker
  (claude --model <workerModel>) in extra panes, same worktree.
  Herdr has no --model flag. The alias is an agent argument.

kind pi
  run starts a Pi orchestrator (pi) in a Herdr pane. It does not implement the goal.
  It starts Pi workers with orka worker (pi, no model flag) in extra panes, same worktree.
  No Opus or Sonnet. --orchestrator-model, --worker-model and worker --model are refused.

Multi-worker (both kinds)
  The orchestrator splits the goal and starts one worker per task. Independent tasks
  start in parallel (several orka worker calls). All workers share one worktree, so no
  two workers get the same files.

Context handoff (builder workers, both kinds)
  Every pane starts with --session-id; the watcher reads that transcript's last turn each poll.
  An idle builder at or past handoff.threshold (default 0.5) of its window writes a note to
  .orka/jobs/<id>/handoff/<name>-<n>.md, is renamed <name>-h<n>, and a fresh <name> continues
  from the note in a new pane. The old pane stays open until done/stop/cleanup. Verifier exempt.
  Config: "handoff": {"threshold": 0.5, "contextWindow": 200000 | {"<model substring>": N}, "orchestrator": false}
  or "handoff": false. See docs/handoff.md.

Verifier (both kinds)
  After every builder reports, the orchestrator starts ONE verifier:
    orka worker --job <id> --name verifier --role verifier --task "<what was built + acceptance criteria>"
  Fresh context, same worktree, the job's worker model. It runs orka verify, npm test / npm run check when
  package.json has them, and targeted agent-browser checks in one session (<prefix>-verifier). It does not
  edit product code. It may extend orka.verify.json only to cover the acceptance criteria, never weaken a check.
  It writes results/verifier.json {"verdict","failures":[{"check","evidence"}],"warnings":[{"check","evidence","base","proof"}],...}
  and notes/verifier.txt. failures block; warnings (shown to fail on the base commit too, via orka verify <id> --base)
  never do: the verdict is "pass" when failures is empty.
  There is no round limit. orka new/run --max-rounds N sets an opt-in ceiling; a round beyond it is refused.
  orka records every round in job.verifier.history {round,verdict,failing,warnings}. If the same blocking check
  fails in two consecutive rounds, job.verifier.stall is set and orka status says so. The orchestrator must then
  change strategy and record it with orka strategy <id> "<what changed>" before re-verifying.
  The orchestrator never runs orka verify or edits checks. If it cannot progress (the same failure survived 3
  strategy changes, or a human decision or secret is needed): orka done <id> --give-up "<reason>" marks the job failed.
  Every round writes results/verifier.json; starting the next round moves the old one to verifier.round-N.json.
  orka done reads results/verifier.json, records job.verifier {rounds,verdict,history,stall,strategyChanges},
  and marks the job failed ("verifier failed after N rounds: <checks>") on a final fail. done and status print
  "verified by verifier: pass, round N" (or "verifier: fail, round N"). No verifier run: nothing changes.
  verify --base runs the same checks file in a temporary detached worktree at job.baseCommit (older jobs:
  git merge-base <branch> main) and writes results/verify-base.json {"base","steps":[{"index","name","outcome"}]}.
  It does not change job.verify.

A prompt that is still idle after ~8s is sent once more.
status reads the job file. It does not poll Herdr. One job also prints the finish-wake record and verify.
stop interrupts the lead and workers, then marks stopped. It does not close the workspace.
done marks a running job done (default reason "completed") and sends the finish wake. It refuses a queued job and leaves a finished one alone.
done does not close the orchestrator pane or the workspace: Olaf may still want to give feedback (see Follow-up rounds).
A failed run marks failed after the worktree or pane exists. Idle is not terminal.

Finish wake is automatic from this CLI when it marks a job done, failed, or stopped.
It POSTs {"job","status","branch"} once (plus "verifier": "verified by verifier: pass, round N" and a "verification" object
{"verdict","rounds","strategyChanges","blocking":[{"check","evidence"}],"warnings":[...],"stopReason"?} when a verifier ran), using <repo>/.orka/secrets/finish-webhook.env (mode 600).
Keys are WEBHOOK_URL and WEBHOOK_KEY, the same pair as herdr-finish-wake.env. Off if that file is missing.
This CLI does not read a home path and does not run herdr-finish-watch. Agents must not either.
A failed POST does not change job status. The attempt is <repo>/.orka/jobs/<id>.finish.json.
orka webhook retries a failed attempt and records it. --dry-run prints the payload and does not send.
Example (not a secret): examples/finish-webhook.env

verify
  Runs project checks in the job worktree through agent-browser.
  Default file: orka.verify.json at the worktree root. Commit it. It is not under .orka/.
  Override: "verify" in <repo>/.orka/config.json, a path relative to the worktree, or false to disable.
  No checks file skips (exit 0, verify.status skipped). That is not a pass.
  Invalid or failing checks fail closed (exit 1, verify.status failed).
  The checks file names the URL. This command does not assume a host, port, or app.
  agent-browser must be on PATH. This CLI does not install it.
  Example: {"steps":[["open","http://127.0.0.1:3000/"],{"visible":"h1"},{"text":"h1","includes":"Ready"}]}
  See README. examples/orka.verify.json is an example only; orka does not run it.

cleanup (delayed, not close-everything)
  On done, stop or a failed run orka frees at once only: the job's agent-browser sessions (names start with
  orka-<8 hex of sha1(id)>; workers use <prefix>-<worker>, verify <prefix>-verify), dev/preview servers whose
  process cwd is inside the job worktree (never orka itself or its ancestors), and the panes of finished
  workers and the verifier (herdr pane close). What was closed is stored in job.cleanup.
  The orchestrator pane and the Herdr workspace stay open so Olaf can still steer. The record, worktree and branch always stay.
  orka cleanup [--dry-run] [--older-than 12h] closes the workspace of jobs that are finished (done, failed,
  stopped) and idle longer than the threshold (default 12h; or "staleAfter": "<duration>" in .orka/config.json).
  Idle is measured from the latest of finished, steer, verifier and follow-up round times. A job is only closed once.
  It also closes orka- (and orca-) browser sessions of jobs that are not running and agent-browser sessions whose pid file names a dead process.
  Closing a session never launches a browser: a session with no live daemon or Chrome only has its state deleted.
  Browsers are found by ORKA_JOB (or ORCA_JOB) tag and by session name (AGENT_BROWSER_SESSION / --session in the process tree).
  It also kills orphan agent-browser-chrome-* roots (parent init, older than --orphan-hours, default 2, owned by no running job).
  The same stale sweep runs quietly at the start of orka new and orka run (stderr, one line, only if it closed something).
  No cron, no polling. --keep on new, run, done or stop opts out of everything. --dry-run lists "would close" lines.

Follow-up rounds
  orka steer <id> "message" works on a done, failed or stopped job whose orchestrator pane still exists. It sets the job
  back to running, bumps job.round, and updates the activity time so the job is not stale. When the orchestrator calls
  orka done again the finish wake is sent again for that round: the payload adds "round": N and "followUp": true and
  <id>.finish.json keeps a per-round record ("rounds" and a "round" on each attempt). Round 1 payloads are unchanged.

Ports
  orka new allocates a block of ports for the job (lib/ports.mjs), unique among the other unfinished jobs, and stores
  job.port and job.ports. ORKA_PORT, ORKA_PORTS and PORT (plus ORCA_PORT, ORCA_PORTS) are exported into the orchestrator and worker panes and into
  orka verify scripts; the prompts state them too. In orka.verify.json, \${ORKA_PORT}, \${ORKA_PORT_2} (or the old \${ORCA_PORT}, \${ORCA_PORT_2}) and {{port}} expand in
  every url and command. orka status prints the port. Older jobs without a port keep working (run allocates one).
  Prompts tell agents to use their job port for dev servers and to decide operational questions themselves
  (stop a stale server from a finished orka job, pick their own port); they ask only for a human decision or a secret.

Needs-input watcher
  orka run starts a detached watcher (orka watch <id>, log: <repo>/.orka/jobs/<id>/watcher.log, pid in job.watcherPid).
  When the orchestrator is blocked or idle on a question it POSTs, through the finish webhook config,
  {"kind":"needs-input","job","title","status":"blocked"|"idle","question","pane"}. It dedupes per episode and exits when the
  job is terminal (markTerminal also stops it). With no webhook configured it logs and skips. Workers never post;
  only orka done, stop or a failed run send the finish wake.

Formerly orca
  orca still works as a deprecated alias: same commands and output, plus one note on stderr.
  State dir: .orka/ if it exists, else an existing .orca/ (never moved), else .orka/ is created.
  Same fallback for orka.verify.json / orca.verify.json and orka.features.md / orca.features.md.
  New jobs use branch orka/<id>, workspace label orka-<id> and browser sessions orka-<sha8>; jobs from
  orca keep orca/<id> and orca-<sha8>. Env vars are exported as ORKA_* and ORCA_*; either is read.

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
  else if (cmd === "new") await cmdNew(args);
  else if (cmd === "run") await cmdRun(args);
  else if (cmd === "worker") cmdWorker(args);
  else if (cmd === "status") cmdStatus(args);
  else if (cmd === "digest") cmdDigest(args);
  else if (cmd === "steer") cmdSteer(args);
  else if (cmd === "strategy") cmdStrategy(args);
  else if (cmd === "log") cmdLog(args);
  else if (cmd === "stop") await cmdStop(args);
  else if (cmd === "done") await cmdDone(args);
  else if (cmd === "webhook") await cmdWebhook(args);
  else if (cmd === "verify") cmdVerify(args);
  else if (cmd === "cleanup") cmdCleanup(args);
  else if (cmd === "reap") cmdReap(args);
  else if (cmd === "watch") await cmdWatch(args);
  else if (cmd === "handoff") cmdHandoff(args);
  else fail(`unknown command ${cmd}\nrun: orka help`);
}

try {
  await main();
} catch (err) {
  console.error(err && err.orka ? err.message : err?.message || err);
  process.exit(1);
}
