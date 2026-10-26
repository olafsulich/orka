#!/usr/bin/env node
// orka v0 (formerly orca) — job file in <repo>/.orka/jobs, linked worktree at
// <repo>/.orka/worktrees/<id> on branch orka/<id>. Workers share that worktree.
// Repos and jobs from orca keep .orca/ and orca/<id>; lib/brand.mjs holds the fallbacks.
// Finish wake: when the CLI marks done|failed|stopped, POST {job, status, branch}
// if <repo>/.orka/secrets/finish-webhook.env exists. Never a home path.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { DECISION_ROWS, DIGEST_MAX, FILE_READ_MAX, SUMMARY_MAX, VERIFIER_JSON_MAX, renderDigest, steerText } from "../lib/digest.mjs";
import * as brand from "../lib/brand.mjs";
import * as browsers from "../lib/browsers.mjs";
import * as deps from "../lib/deps.mjs";
import * as gatesLib from "../lib/gates.mjs";
import * as doctor from "../lib/doctor.mjs";
import * as guard from "../lib/guard.mjs";
import * as context from "../lib/context.mjs";
import * as handoffHook from "../lib/handoff-hook.mjs";
import * as inbox from "../lib/inbox.mjs";
import * as wake from "../lib/wake.mjs";
import * as featureMap from "../lib/featuremap.mjs";
import * as lifecycle from "../lib/lifecycle.mjs";
import * as autonomy from "../lib/autonomy.mjs";
import * as ports from "../lib/ports.mjs";
import * as specs from "../lib/spec.mjs";
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
  "spec",
  "to",
  "hook",
  "accept",
  "signoff",
  "stack-on",
]);
const BOOL_FLAGS = new Set(["dry-run", "help", "force", "keep", "base", "ui", "stdin", "pr", "push", "no-gate", "fix"]);
const FINISH_STATUSES = new Set(["done", "failed", "stopped"]);
// Direction gate: a new-feature job pauses here after planning until orka approve (or orka steer revises the plan).
const AWAITING = "awaiting-direction";
// Result review: the verifier passed and summary.txt is written; the job waits for Olaf's sign-off (orka approve) before orka done.
const REVIEW = "review";
// Not finished: the panes are live and Olaf may still act (approve, steer, stop).
const LIVE_STATUSES = new Set(["running", AWAITING, REVIEW]);
const APPROACH_MAX = 2000;
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
  // Worker panes, and the panes of orchestrators replaced by a context handoff.
  const panes = [...(job.workers || []).map((w) => [w, "worker"]), ...(job.retiredLeads || []).map((r) => [r, "old orchestrator"])];
  for (const [w, what] of panes) {
    if (!w.pane || w.closed || w.pane === job.pane) continue;
    if (dry) {
      console.log(`cleanup: would close ${what} pane ${w.pane} (${w.name})`);
      continue;
    }
    const got = herdr(["pane", "close", w.pane]);
    if (got.code === 0 && !got.json?.error) {
      console.log(`cleanup: closed ${what} pane ${w.pane} (${w.name})`);
      w.closed = closed.at;
      closed.panes.push({ name: w.name, pane: w.pane });
    } else console.log(`cleanup: ${what} pane ${w.pane} (${w.name}) not closed`);
  }
  if ((opts.status || job.status) === "done" && lifecycle.removableWorktree({ ...job, status: "done" })) {
    if (removeWorktree(repo, job, { dry }).removed && !dry) closed.worktree = job.worktree;
  }
  if (dry) return;
  job.cleanup = closed;
  save(repo, job);
}

// Disk use of a directory in KB (du does not follow symlinks); 0 when unknown.
function diskKb(path) {
  const r = spawnSync("du", ["-sk", path], { encoding: "utf8", timeout: 120000 });
  return Number.parseInt(r.stdout, 10) || 0;
}

function registeredWorktrees(repo) {
  const list = git(repo, ["worktree", "list", "--porcelain"]);
  return new Set(list.out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => resolve(l.slice(9))));
}

// Removes a done job's worktree with git worktree remove (never --force), so
// uncommitted work is never deleted: a dirty worktree is kept and reported.
// The branch always stays. Only a registered worktree under the state dir.
function removeWorktree(repo, job, { dry = false, log = console.log } = {}) {
  const path = resolve(job.worktree);
  const branch = brand.jobBranch(job);
  const root = resolve(brand.stateDir(repo), "worktrees");
  if (!path.startsWith(root + sep)) {
    log(`cleanup: kept worktree ${path} (not under ${root})`);
    return { kept: "outside" };
  }
  if (!existsSync(path)) {
    if (!dry) {
      git(repo, ["worktree", "prune"]);
      job.worktreeRemoved = new Date().toISOString();
      save(repo, job);
    }
    return { removed: false, kb: 0 };
  }
  if (!registeredWorktrees(repo).has(path)) {
    log(`cleanup: kept worktree ${path} (not a registered git worktree)`);
    return { kept: "unregistered" };
  }
  const status = git(path, ["status", "--porcelain"]);
  const changes = status.out.split("\n").filter(Boolean).filter((l) => !deps.isLinkStatusLine(path, l));
  if (status.code !== 0 || changes.length) {
    const why = status.code !== 0 ? "git status failed" : `${changes.length} uncommitted change${changes.length === 1 ? "" : "s"}; commit or discard, then orka cleanup`;
    log(`cleanup: kept worktree ${path} (${why})`);
    return { kept: "dirty" };
  }
  const kb = diskKb(path);
  if (dry) {
    log(`cleanup: would remove worktree ${path} (${lifecycle.formatKb(kb)}, branch ${branch} kept)`);
    return { removed: true, kb };
  }
  deps.unlinkLinks(path);
  const removed = git(repo, ["worktree", "remove", path]);
  if (removed.code !== 0) {
    log(`cleanup: kept worktree ${path} (git worktree remove: ${(removed.err || removed.out).split("\n")[0]})`);
    return { kept: "git" };
  }
  job.worktreeRemoved = new Date().toISOString();
  save(repo, job);
  log(`cleanup: removed worktree ${path} (${lifecycle.formatKb(kb)}, branch ${branch} kept)`);
  return { removed: true, kb };
}

// A follow-up round on a done job whose worktree was removed: check the kept branch out again.
function restoreWorktree(repo, job) {
  if (!job.worktreeRemoved || !job.worktree || existsSync(job.worktree)) return;
  const added = git(repo, ["worktree", "add", job.worktree, brand.jobBranch(job)]);
  if (added.code !== 0) fail(`could not restore worktree ${job.worktree}: ${added.err || added.out}`);
  delete job.worktreeRemoved;
  save(repo, job);
  console.log(`restored worktree ${job.worktree} from branch ${brand.jobBranch(job)}`);
  setupDeps(repo, job);
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
  // herdr says "already used ... status=Blocked" when the agent of that name is stuck on a dialog.
  const blocked = /already used/i.test(msg) && /status=Blocked/i.test(msg) ? `\nThe agent under that name is blocked on a dialog in its pane, not a name clash: herdr pane read <pane> shows it (Claude's folder-trust dialog in an untrusted repo is the usual one).` : "";
  fail(`${what} failed:\n${msg.slice(0, 800)}${blocked}`);
}

function agentName(id) {
  return `j${String(id).replace(/[^a-z0-9]/g, "")}`.slice(0, 32);
}

function assertAgentName(name) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) fail(`agent name must match [a-z][a-z0-9_-]{0,31}, got ${name}`);
}

// sessionId names the agent's transcript (claude and pi both take --session-id), so orka reads
// the right file when it measures context; every pane of a job shares one transcript folder.
// resume (orka resume): claude reopens the session with --resume <id>; pi's --session-id already
// continues an existing session of that id.
function startArgs(name, pane, kind, alias, sessionId, job = null, { resume = false } = {}) {
  const args = ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "60000"];
  const session = sessionId ? [resume && kind === "claude" ? "--resume" : "--session-id", sessionId] : [];
  const extra = [...(kind === "claude" ? ["--model", alias] : []), ...session, ...(job ? paneExtras(job, kind) : [])];
  if (extra.length) args.push("--", ...extra);
  return args;
}

// orka's skills (plugin/: the handoff skill) for every pane, and the handoff hook
// (lib/handoff-hook.mjs: after each tool call, past handoff.threshold, the agent is told to hand off
// once). claude: a settings file with the hook as PostToolUse and a statusLine that records the
// window Claude Code reports for the session (lib/statusline.mjs -> <jobdir>/context). pi: a
// per-job extension file loaded with -e.
const PLUGIN_DIR = join(dirname(ORKA), "..", "plugin");
const HANDOFF_SKILL = join(PLUGIN_DIR, "skills", "handoff", "SKILL.md");
const HANDOFF_HOOK = join(dirname(ORKA), "..", "lib", "handoff-hook.mjs");

function captureDir(repo, id) {
  return join(jobDir(repo, id), "context");
}

function paneExtras(job, kind) {
  const dir = captureDir(job.repo, job.id);
  mkdirSync(dir, { recursive: true });
  const paths = { jobFile: jobPath(job.repo, job.id), jobDir: jobDir(job.repo, job.id), configFile: configPath(job.repo) };
  if (kind === "pi") {
    const ext = join(dir, "pi-handoff.mjs");
    writeFileSync(ext, `import { piExtension } from ${JSON.stringify(pathToFileURL(HANDOFF_HOOK).href)};\nexport default piExtension(${JSON.stringify(paths)});\n`);
    return ["--skill", dirname(HANDOFF_SKILL), "-e", ext];
  }
  const file = join(dir, "claude-settings.json");
  const command = sh([process.execPath, join(dirname(ORKA), "..", "lib", "statusline.mjs"), dir]);
  const hook = sh([process.execPath, HANDOFF_HOOK, "claude", paths.jobFile, paths.jobDir, paths.configFile]);
  const settings = { statusLine: { type: "command", command, padding: 0 }, hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, timeout: 10 }] }] } };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return ["--settings", file, "--plugin-dir", PLUGIN_DIR];
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
function isAgentReady(info, statuses = ["idle"]) {
  return Boolean(info) && info.interactive_ready === true && statuses.includes(info.agent_status);
}

// After the prompt was sent: working means it took. Blocked also counts: the agent received the
// prompt and waits on a permission dialog, and prompting again into that dialog is harmful.
// Called only once the prompt is out, so blocked before the prompt is never ready (isAgentReady).
function isDelivered(status, sawWorking) {
  return status === "working" || (status === "blocked" && sawWorking !== false);
}

// Blocks until isAgentReady(info), polling until READY_WAIT_MS; anything else keeps polling.
function waitAgentReady(name, statuses) {
  const deadline = Date.now() + READY_WAIT_MS;
  let info = agentInfo(name);
  for (;;) {
    if (isAgentReady(info, statuses)) return { ready: true };
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
// readyStatuses: the handoff also prompts an agent herdr reports as done (finished, not looked at).
function promptWithRetry(name, text, { readyStatuses } = {}) {
  const ready = waitAgentReady(name, readyStatuses);
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
const COMMIT_BEFORE_DONE = (job) =>
  `Before orka review, commit everything in the worktree on the job branch${job.playbook === "investigation" ? "" : `, including the checks file and feature map the verifier and orka wrote (${verifyFile(job.worktree)}, ${featureMapFile(job.worktree)}): they are meant to be committed`}. orka done removes a done job's worktree (the branch stays), and keeps it only when something is left uncommitted.`;
// Checkable acceptance and the choices made on Olaf's behalf: generic across CLIs, libraries, web apps,
// research and visual work. Never a reason to wait for a human.
const ACCEPTANCE_LINES = (job) => [
  `ACCEPTANCE must be checkable: each line names its proof, preferably one outside the agents (a command and its expected output, a test, a number or threshold, an HTTP response, a file diff, or the job's reference artifact such as an image or golden file). When the goal, spec or incoming brief already names the proof, copy it as-is; do not re-interpret the goal.`,
  `When no outside proof exists (taste or visual judgement), do not invent one and do not wait for an answer: make your first status line orka log ${job.id} plan "no external proof: <what is subjective>" "<why>" "-" "review is Olaf's", and say the same in the result, so Olaf knows that review is his.`,
  `Every REPORT asks the worker to list its choices made: one line each, "chose X over Y because Z", for decisions the task left open.`,
];
const CHOICES_MADE = `summary.txt ends with "Choices made:", one line per decision you or the workers made on Olaf's behalf that the goal left open ("chose X over Y because Z", merged from the workers' REPORTs; "none" if there were none), so review targets those, not the whole diff.`;

const SUMMARY_FROM_DIFF = (job) => `Before orka review, run git diff ${job.baseCommit || `$(git merge-base ${brand.jobBranch(job)} main)`} (--stat plus a skim) and write summary.txt from the diff, not from the workers' claims.`;

function portPromptLines(job) {
  const list = Array.isArray(job.ports) && job.ports.length ? job.ports : job.port != null ? [job.port] : [];
  const lines = [];
  if (list.length) {
    lines.push(`Your job port${list.length > 1 ? "s" : ""}: ${list.join(", ")} (env ORKA_PORT=${job.port ?? list[0]}${list.length > 1 ? `, ORKA_PORTS=${list.join(",")}` : ""}).`);
    lines.push(`Use your job port(s) ($ORKA_PORT / the ports listed above) for any dev or preview server, never a fixed default like 3000 or 5173, so concurrent orka jobs never collide.`);
  }
  const { level } = autonomy.readLevel(job.repo);
  lines.push(
    `Autonomy: this repo is at ${level} (${autonomy.LEVEL_TEXT[level]}). orka's git hooks in your pane refuse any commit, merge or push above it and log the refusal; never bypass them (no --no-verify, no other hooksPath).`,
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
  if (!dry) recordBrowserPids(job.repo, job, procs);
  return killBrowserProcs(procs, dry);
}

// <job dir>/browser-pids.json: every browser process orka has seen for the job
// ({ pid, startMs, worker, session, at }). orka cleanup kills a recorded pid
// once its job is finished or its pane is gone, even when the process lost its
// tag and session. The start time stops a recycled pid from ever matching.
function browserPidsPath(repo, id) {
  return join(jobDir(repo, id), "browser-pids.json");
}

function readBrowserPids(repo, id) {
  try {
    const data = JSON.parse(readFileSync(browserPidsPath(repo, id), "utf8"));
    return Array.isArray(data?.pids) ? data.pids : [];
  } catch {
    return [];
  }
}

const BROWSER_PIDS_MAX = 200;

// Records the job's browser processes (procs, else a fresh scan). Never fatal.
function recordBrowserPids(repo, job, procs = null) {
  try {
    if (!repo || !job?.id) return;
    const found = procs || browsers.selectReap(browsers.scanBrowsers(), { jobId: job.id, prefix: browserPrefix(job) });
    if (!found.length) return;
    const known = readBrowserPids(repo, job.id);
    const seen = new Set(known.map((r) => `${r.pid}:${r.startMs}`));
    const at = new Date().toISOString();
    const add = found.filter((p) => p.startMs && !seen.has(`${p.pid}:${p.startMs}`)).map((p) => ({ pid: p.pid, startMs: p.startMs, worker: p.worker || brand.SESSION_RE.exec(p.session || "")?.[2] || "", session: p.session || "", at }));
    if (!add.length) return;
    mkdirSync(jobDir(repo, job.id), { recursive: true });
    const path = browserPidsPath(repo, job.id);
    writeFileSync(`${path}.tmp`, JSON.stringify({ v: 1, pids: [...known, ...add].slice(-BROWSER_PIDS_MAX) }, null, 2) + "\n");
    renameSync(`${path}.tmp`, path);
  } catch {
    // a record is a help for cleanup, never a reason to fail a command
  }
}

// Live herdr pane ids, or null when herdr cannot say.
function livePaneIds() {
  const got = herdr(["pane", "list"], 10000);
  const panes = got.json?.result?.panes;
  return got.code === 0 && Array.isArray(panes) ? new Set(panes.map((p) => p?.pane_id).filter(Boolean)) : null;
}

function killBrowserProcs(procs, dry, log = console.log) {
  const pids = new Set(procs.map((p) => p.pid));
  for (const p of procs) {
    if (pids.has(p.ppid)) continue; // listed under its parent
    const kids = procs.filter((c) => c.ppid === p.pid).length;
    const who = [p.job, p.worker].filter(Boolean).join(" ");
    log(`cleanup: ${dry ? "would kill" : "killed"} browser pid ${p.pid} (${who || p.session || "untagged"}: ${p.cmdline.slice(0, 80)})${kids ? ` and ${procs.length - 1} child process(es)` : ""}`);
  }
  if (!dry && procs.length) {
    try {
      lifecycle.killProcesses(procs.map((p) => p.pid), { graceMs: 3000 });
    } catch (err) {
      log(`cleanup: could not kill a browser: ${err.message}`);
    }
  }
  return procs.map((p) => p.pid);
}

// Autonomy guard: job panes get core.hooksPath pointing at orka's generated hooks (they chain to the
// repo's own hooks). Written into the repo's state dir, never into the tracked tree.
function hooksDir(repo) {
  return join(brand.stateDir(repo), "hooks");
}

function installHooks(repo) {
  const dir = hooksDir(repo);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(autonomy.hookScripts(process.execPath, ORKA))) {
    const path = join(dir, name);
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  }
  return dir;
}

function guardEnvArgs(repo) {
  const dir = installHooks(repo);
  return ["--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=core.hooksPath", "--env", `GIT_CONFIG_VALUE_0=${dir}`];
}

// Refuses an action above the repo's level: logs it to the job's decisions.tsv (when there is a job) and fails.
function requireLevel(repo, action, { jobId = "", evidence = "" } = {}) {
  const { level, source } = autonomy.readLevel(repo);
  const { ok, need } = autonomy.allows(level, action);
  if (ok) return level;
  if (jobId && existsSync(jobPath(repo, jobId))) appendDecision(repo, jobId, ["autonomy", `refused ${action}`, `repo at ${level}; ${action} needs ${need}`, evidence, "refused"]);
  fail(autonomy.refusal(repo, level, source, action, need));
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

// A research worker reads and reports; it gets no GATES block (names start with research, as at the direction gate).
const isResearchWorker = (name, task) => /^research/.test(String(name)) || String(task).includes("RESEARCH REPORT FORMAT");

// The GATES block of a builder brief (docs/gates.md "Builders run the gates too"): the same
// detection and per-gate limit as the gate round before the verifier. [] when there are no gates.
function workerGateLines(job, name, task) {
  if (isResearchWorker(name, task)) return [];
  const config = readRepoConfig(job.repo);
  const found = gatesLib.detectGates(job.worktree || job.repo, config);
  if (!found.gates.length) return [];
  const secs = Math.max(1, Math.ceil(gatesLib.gateLimits(config).timeoutMs / 1000));
  return [
    `GATES (${found.reason}). orka runs the same gates before the verifier; catch them here first.`,
    `Before you write your result, run every gate below in ${job.worktree}, one at a time in this order, never in parallel or in the background, each exactly as written (the timeout is the per-gate limit):`,
    ...found.gates.map((g) => `  timeout -k 5 ${secs} sh -c ${q(g.command)}`),
    `A failure in a file inside your SCOPE is yours: fix it and rerun that gate. A failure in a file outside your SCOPE is not yours (other workers share this worktree): do not edit that file; report it. Rerun until your own files are green or your TIMEBOX ends.`,
    `Record the last run of each gate in your result as "gates": [{"cmd":"<the gate command, without the timeout prefix>","ok":<exit 0>,"ownFailures":["<file in your SCOPE>"],"otherFailures":["<file outside it>"]}], at most 5 files per list, no log text. If your own files are still red, set "ok": false and say why in "result".`,
    ``,
  ];
}

function workerPrompt(job, name, task, alias) {
  const dir = jobDir(job.repo, job.id);
  const result = join(dir, "results", `${name}.json`);
  const note = join(dir, "notes", `${name}.txt`);
  return [
    `You are a worker for orka job ${job.id} (${paneCommand(alias)}). Do this task and stop.`,
    `Work only in this shared checkout: ${job.worktree}`,
    `Branch: ${job.branch}`,
    `Other workers share this worktree. Do not revert their files. Do not create a branch, worktree, or push.`,
    ...depLinkLines(job),
    `Browser checks, if this task needs them, go in ${verifyFile(job.worktree)} at the worktree root, or the path in ${configPath(job.repo)} "verify".`,
    `Shape: {"steps":[["open","http://HOST:PORT/"],{"visible":"SELECTOR"},{"text":"SELECTOR","includes":"EXPECTED"}]}`,
    `Use this project's URL. Do not copy a host or port from another repo. Do not run orka verify unless the task says so.`,
    ...portPromptLines(job),
    `Use exactly one agent-browser session, named ${browserPrefix(job)}-${name} (agent-browser --session ${browserPrefix(job)}-${name}). Reuse it for every check. Never spawn a fresh session per check. When the task is done, close it: agent-browser --session ${browserPrefix(job)}-${name} close`,
    ``,
    String(task).trim(),
    ``,
    ...specPromptLines(job),
    `Feature map: ${featureMapFile(job.worktree)} at the worktree root, if it exists, records per feature how to reach, drive and prove it, and what to keep in mind. Read the entries for what you touch. Never edit it.`,
    ...workerGateLines(job, name, task),
    `When finished, write ${result} as JSON:`,
    `{"worker":"${name}","ok":true,"result":"<what you did, a few sentences>"}`,
    `If you learned a constraint the code does not show (an order that matters, a slow or flaky step, a required env var or service), add "keepInMind": ["<one line>"] to that JSON, or {"<feature heading in the map>": ["<one line>"]}. orka merges it into the map.`,
    `Also write one line at ${note}: at most 200 characters, no logs, diffs or the job file.`,
    `Do not message the orchestrator. When your turn ends with the result file written, orka sends it a short wake with your result; it runs orka digest for the rest.`,
    `Messages for you (from the orchestrator or Olaf) may arrive between your tool calls as "orka inbox" text: read them and follow them.`,
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
  if (v.verdict === "blocked") return `verifier: blocked by the environment, round ${round} (not a code failure; see orka doctor)`;
  if (v.verdict === "pass" && v.stale) return `verifier: pass (STALE, code changed since round ${round})`;
  const byGate = (v.history || []).some((h) => h.round === round && h.by === "gate");
  if (v.verdict === "pass") return `verified by ${byGate ? "gate" : "verifier"}: pass, round ${round}`;
  return `verifier: ${v.verdict}, round ${round}`;
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
  // A blocked round (environment) does not count toward --max-rounds.
  const state = verifierState(job);
  const rounds = state.rounds - state.history.filter((h) => h.verdict === "blocked").length;
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
    if (data?.verdict !== "pass" && data?.verdict !== "fail" && data?.verdict !== "blocked") return null;
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
  // blocked: the environment stopped the verifier, not the code. No failures to route, no stall.
  if (result.verdict === "blocked") return { verdict: "blocked", failures: [], warnings };
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
    // The job's own spec is excluded too: orka done commits lessons into it, which is not code.
    const exclude = [...brand.fileNames("verify.json"), ...(job.spec?.path ? [job.spec.path] : [])].map((f) => `:(exclude)${f}`);
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
    ...(result.by === "gate" ? { by: "gate" } : {}),
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
  // A blocked round runs orka doctor once, so the orchestrator and Olaf see what to fix.
  if (next.verdict === "blocked" && job.doctor?.verifierRound !== next.rounds) {
    const reason = blockedReason(repo, job);
    runDoctor(repo, job, { why: `verifier round ${next.rounds} blocked${reason ? `: ${reason}` : ""}`, verifierRound: next.rounds });
  }
  return job.verifier;
}

function blockedReason(repo, job) {
  const b = readVerifierResult(repo, job.id)?.blocked;
  return b && typeof b === "object" ? String(b.reason || "").slice(0, 200) : typeof b === "string" ? b.slice(0, 200) : "";
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
    ...approvedProofLines(job),
    ...specPromptLines(job),
    ...(job.playbook === "bug-fix" ? [...REPRO_VERIFIER_LINES(dir), ``] : []),
    `Evidence standard (a pass needs proof, not a claim):`,
    `- Test the real user path: run the feature the way a user would (the real command, page or API), not only unit tests or a private helper.`,
    `- Check side effects (files written, network calls, state changed), not just the exit code.`,
    `- Suspect the observation method first: when a check fails or looks odd, ask whether the check itself is wrong (wrong URL, stale server, wrong directory, cached output) before blaming or clearing the code.`,
    `- Save proof under ${join(dir, "results")}/ (screenshots, command output) and name the file in the check notes or failure evidence.`,
    `- "Inconclusive" or "could not test" is a fail, not a pass. If you cannot show it works, the verdict is fail.`,
    ``,
    `Feature map: before running checks, read ${featureMapFile(job.worktree)} at the worktree root. Per feature it records how to reach it (URL or command), how to drive it, how to prove it works, when it was last verified (date + commit), and what to keep in mind (constraints the code does not show; orka merges them from the builders' results). Use it to start faster and check consistently, and keep the Keep in mind lines when you update an entry.`,
    `Staleness guard: each entry carries the commit it was last proven at. Every entry whose commit is older than HEAD (git rev-parse HEAD) must be re-proved by you before you rely on it or mark it verified, never trusted, whether or not this job touched the feature.`,
    `If ${featureMapFile(job.worktree)} is missing, that is fine: create it with one entry per feature you check. On a pass, update the entries you touched (reach, drive, prove, last-verified date and HEAD commit). Editing ${featureMapFile(job.worktree)} is allowed even though you do not edit product code. On a fail, do not mark entries as proven.`,
    `Stale entries: when an entry's Reach step fails on HEAD and also on the base commit, do not delete it: add the line "- Stale: marked by ${job.id}" to it. orka drops an entry that stays stale for ${featureMap.STALE_JOBS} more jobs. When a Stale entry's Reach works again, prove it and remove its Stale line.`,
    ``,
    `Run these checks:`,
    `1. orka verify ${job.id} (if orka is not on PATH, run ${ORKA} verify ${job.id}).`,
    gatePromptLine(job),
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
    `{"name":"${name}","role":"verifier","round":${round},"verdict":"pass"|"fail"|"blocked","blocked":{"reason":"...","evidence":"..."} (only with blocked),"checks":[{"name":"...","outcome":"pass"|"fail"|"skipped","scope":"job"|"preexisting","notes":"..."}],"failures":[{"check":"<stable check name>","evidence":"<exact error, step, url, command output>"}],"warnings":[{"check":"...","evidence":"...","base":"<sha>","proof":"<how it was shown pre-existing, e.g. fails on base via orka verify --base>"}],"summary":"..."}`,
    `If you cannot test at all because of the environment (a missing tool, a broken install, a port in use, a browser that will not start, a dialog), do not report a code failure. Example: a tool the acceptance needs prints "command not found" (exit 127) or "not on PATH", and it is not something this job was meant to build. Then write "verdict":"blocked" with "blocked":{"reason":"<one line>","evidence":"<exact error or command output>"} and failures empty. orka then runs orka doctor; nothing goes back to the builders.`,
    `verdict is "pass" when failures is empty, even if warnings are present. failures are blocking and cover what this job changed; warnings are pre-existing or unrelated failures proven on the base commit. Use the same check name for the same check every round. Evidence must be concrete: the exact error, step, url or command output.`,
    `Also write one line at ${note}.`,
    `Do not message the orchestrator. When your turn ends with the result file written, orka sends it a short wake with your verdict.`,
    `Your round ends with one last command: orka reap ${job.id} --worker ${name} (or ${ORKA} reap ${job.id} --worker ${name}). It records and kills every Chrome your round started; your pane stays open. To check, use a bracketed pattern so pgrep never matches itself: pgrep -af '[a]gent-browser-chrome'.`,
    ``,
    NEVER_CLOSE_PANES,
    `Finish wake is automatic from the orka CLI when it marks the job done, failed, or stopped. That is not your job. Do not run herdr-finish-watch. Do not run orka stop, orka done or orka webhook. Do not start another agent.`,
  ].join("\n");
}

// The finish of every playbook: the job waits in review for Olaf's sign-off, and only then does the orchestrator run orka done.
const SIGNOFF_LINES = (job, { refuses = "", redo, records }) => [
  `Then hand the result to Olaf for review. This does NOT finish the job:`,
  `  orka review ${job.id}`,
  `It sets the job to ${REVIEW} and notifies Olaf (webhook status ${REVIEW}).${refuses ? ` ${refuses}` : ""} Then stop and wait; your pane and the workers' panes stay open.`,
  `Olaf answers with orka steer or orka approve. A steer is a change request: the job is running again, so make the changes (${redo}), rewrite summary.txt and run orka review ${job.id} again.`,
  `orka approve on a job in ${REVIEW} is Olaf's sign-off: you get "Olaf signed off". Only then mark the job done, which sends the finish wake${records} and removes this job's worktree (the branch stays):`,
  `  orka done ${job.id}`,
  `orka done refuses without Olaf's sign-off. Never run orka approve yourself. The only finish without a sign-off is giving up: orka done ${job.id} --give-up "<plain reason>".`,
  `If orka is not on PATH, run ${ORKA} review ${job.id} and ${ORKA} done ${job.id}.`,
];

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
    `Build the verifier --task from the builders' ACCEPTANCE lines (copy them in with their proof, one per builder), plus the job goal.`,
    `orka worker --role verifier first runs the repo's static gates itself (lint, typecheck, check, test; see orka digest). If it exits with "gates round N: FAIL", no verifier started: route each failing gate with the output it printed to the builder that owns those files, wait for the report, then run the same verifier command again (the gates run first again). A gate that also fails on the base commit is only a warning.`,
    `When the whole acceptance is one command, write it as ACCEPTANCE: \`<command>\` (or pass --accept "<command>"): orka runs it after green gates and, on a pass, records the round as pass by gate with no verifier pane. A UI job always gets the verifier.`,
    `The verifier runs orka verify, the project's own checks and targeted agent-browser checks, and may extend ${verifyFile(job.worktree)} only to cover the acceptance criteria.`,
    `It writes ${dir}/results/${VERIFIER_NAME}.json: "verdict" pass or fail, "failures" (blocking: what this job changed, each with its evidence) and "warnings" (pre-existing failures the verifier showed also fail on the base commit; they never block a pass).`,
    `If the verdict is blocked, the environment stopped the verifier, not the code: do not route anything to the builders, and it does not count as a round. orka has run orka doctor (see orka digest). If a listed fix is repo-local, run orka doctor ${job.id} --fix or do it, then start the verifier again; anything else (a system package, a trust dialog, sudo) you report to Olaf and wait.`,
    `If the verdict is fail, read ${dir}/results/${VERIFIER_NAME}.json and route each blocking failure WITH its evidence to the builder that owns those files (a new or resumed builder worker). Ignore warnings for routing. Wait for their reports, then start the verifier again.`,
    `Run orka status ${job.id} after each verifier round. If it reports a stall (the same check failing two rounds in a row), do NOT repeat the same instruction.`,
    `Before changing strategy, attack the premise: write in one sentence the premise the failed fixes share, list what else could explain the failure (a census), and pick the strategy that drops that premise.`,
    `Change strategy instead: rewrite the worker prompt using the verifier's evidence verbatim, split the work differently, start a fresh worker instead of resuming one, or take a different approach.`,
    `Record the change with: orka strategy ${job.id} --premise "<the shared premise you dropped>" "<what you changed>", then re-verify.`,
    `Log every split, routing and strategy decision so it survives compaction: orka log ${job.id} <phase> "<decision>" "<why>" "<evidence>" "<result>" (phase: split, routing or strategy). orka strategy logs its own row.`,
    job.maxRounds
      ? `There is a round ceiling of ${job.maxRounds} verifier rounds (--max-rounds). orka refuses a round beyond it; if the verdict is still fail, run orka done ${job.id} --give-up "<the failing checks>".`
      : `There is no round limit. Keep going until the verdict is pass.`,
    `Stop only when you genuinely cannot progress: the same failure survived 3 different strategy changes, or the fix needs a human decision or a secret. Then run: orka done ${job.id} --give-up "<plain reason>".`,
    `You never run orka verify yourself and never edit ${verifyFile(job.worktree)} or any check. You may only run trivial read-only commands to read results.`,
    `Do not invent a URL or a checks file unless the goal asked for checks.`,
  ],
  done: [
    `Keep every other field, including verify.`,
    `Do not change verify or verifier; the verifier and orka done write those.`,
    ...SIGNOFF_LINES(job, { refuses: "It refuses while the verifier verdict is fail or stale.", redo: "workers, then the verifier again", records: ", records the verifier verdict" }),
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
    ...SIGNOFF_LINES(job, { redo: "workers, then check the citations again", records: "" }),
  ],
});
const PLAYBOOK_FLOW = { investigation: INVESTIGATION_FLOW };

function gatePromptLines(job, dir) {
  if (!gatePending(job)) return [];
  return [
    `DIRECTION GATE (on: this is a new feature). Plan first, then wait for Olaf's direction before building:`,
    `1. Plan only. Read what you need. You may start research workers (names starting with research); orka refuses builder and verifier workers until the approach is approved.`,
    `2. Write ${dir}/approach.md as the agreement Olaf approves: a few lines, one labelled field each (${APPROACH_FIELDS.map(([, label]) => `${label}:`).join(" ")}).`,
    `   Outcome: what Olaf can do afterwards. Scope: the files or areas that change, and what is out of scope. Boundaries: the principles to keep, each with its reason, and what counts as failure.`,
    `   Proof: one line per outcome, how it will be shown, by the same rule as a checkable ACCEPTANCE line (an outside proof preferred: a command and its expected output, a test, a number, an HTTP response, a file diff, a reference image; "no external proof: <what is subjective>" when it is taste).`,
    `3. Run orka propose ${job.id}. It sets the job to ${AWAITING} and notifies Olaf. Then stop and wait; do not build.`,
    `4. orka approve sends you "Direction approved" with the Proof lines, which orka copies into the job: then split and build as below, and put every Proof line into the verifier --task with its proof. orka steer sends a revision: update approach.md, run orka propose ${job.id} again, and wait again.`,
    ``,
  ];
}

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
    ...gatePromptLines(job, dir),
    `Start each worker with orka, which opens a Herdr pane in this same worktree:`,
    `  orka worker --job ${job.id} --name <worker> --task "<task>"`,
    `If orka is not on PATH, run ${ORKA} instead. The binary is the same file.`,
    `orka worker waits (queues) while memory or panes are tight, up to ${Math.round(guardLimitsOf(job.repo).waitMs / 60000)} minutes, then refuses. Give that call a long timeout (600000 ms) or run it in the background.`,
    `Write every worker --task as this brief, one labelled section per line: GOAL / SCOPE (files it owns) / CONTEXT (file pointers, not pasted text) / ACCEPTANCE / VERIFY / TIMEBOX / FORBIDDEN / REPORT. Workers cannot ask questions, so a vague task fails quietly.`,
    ...ACCEPTANCE_LINES(job),
    `Builders run the repo's gates themselves before they write a result and report them in its "gates" field (orka digest shows one gates line per builder). A builder that reports its own gates red is not done: steer it back with orka steer --to <worker> to fix them.`,
    `When ${featureMapFile(job.worktree)} exists at the repo root, point workers at it in CONTEXT.`,
    ...(job.spec?.path ? [`This job has a spec: ${job.spec.path} in the worktree. orka pastes it into every worker and verifier brief, so do not copy it into a --task. Every "Done when" line of it goes into the verifier --task as an acceptance criterion.`] : []),
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
    `Each worker writes ${dir}/results/<name>.json and a one-line note at ${dir}/notes/<name>.txt. Workers never message you: when a worker's turn ends with its result file written, orka sends you one short "orka wake: worker <name> finished" message (state, commits, the start of the result; the full text stays on disk). Do not poll for results or wait on a worker ping.`,
    `To send a worker a message mid-task, use orka steer ${job.id} --to <worker> "<message>": it lands in that worker's inbox and reaches it at its next tool call (or at once when it is idle). Never type into a worker pane yourself.`,
    flow.digest,
    `The finish wake is sent by the orka CLI when orka done marks the job done (or when the job goes failed or stopped). Do not run herdr-finish-watch. Do not run orka stop or orka webhook.`,
    ``,
    ...flow.verify,
    ``,
    SUMMARY_FROM_DIFF(job),
    CHOICES_MADE,
    COMMIT_BEFORE_DONE(job),
    `Before orka review, run orka digest ${job.id}, use it only for ${flow.digestUse}; write ${dir}/summary.txt ${flow.summaryFrom} (per the rule above), and set the summary field. Do not load the job JSON into the turn to copy fields.`,
    ...flow.done,
    `Then stop working. After orka done your pane stays open, so Olaf can still give feedback with orka steer; a follow-up message starts a new round, which ends the same way: orka review ${job.id}, Olaf's orka approve, then orka done ${job.id} (the finish wake is sent again, marked followUp).`,
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

// --spec <path>: specs/<feature>/spec.md (or its folder), relative to the repo root. It must be
// committed at HEAD, because the job worktree is checked out from HEAD.
function resolveSpec(repo, raw) {
  let rel = String(raw).trim().replace(/\/+$/, "");
  const abs = resolve(repo, rel);
  rel = relative(repo, abs);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) fail(`--spec must be inside the repo: ${raw}`);
  if (!rel.endsWith(".md")) rel = join(rel, specs.SPEC_FILE);
  const shown = git(repo, ["show", `HEAD:${rel}`]);
  if (shown.code !== 0) {
    const where = existsSync(join(repo, rel)) ? "exists but is not committed" : "not found";
    fail(`spec ${rel} ${where} at HEAD; commit it first (the job worktree is checked out from HEAD)\nscaffold one with: orka spec init <feature>`);
  }
  const text = `${shown.out}\n`;
  const parsed = specs.parseSpec(text);
  const missing = specs.missingSections(parsed);
  if (missing.length) fail(`spec ${rel} has no ${missing.map((m) => `"## ${m[0].toUpperCase()}${m.slice(1)}"`).join(" or ")} text; fill it in and commit`);
  const disk = existsSync(join(repo, rel)) ? readFileSync(join(repo, rel), "utf8") : null;
  if (disk !== null && disk.trim() !== shown.out.trim()) console.error(`warning: ${rel} has uncommitted changes; the job uses the committed version`);
  const commit = git(repo, ["rev-parse", "HEAD"]).out.trim();
  const feature = rel.split(sep).at(-2) || parsed.title || "spec";
  return { rel, text, parsed, commit, feature };
}

// The spec text as the job sees it: the job branch copy in the worktree (lessons included), else the committed one.
function jobSpecText(job) {
  if (!job.spec?.path) return "";
  const inTree = job.worktree ? join(job.worktree, job.spec.path) : "";
  if (inTree && existsSync(inTree)) {
    try {
      return readFileSync(inTree, "utf8");
    } catch {}
  }
  const shown = git(job.repo, ["show", `${job.spec.commit || "HEAD"}:${job.spec.path}`]);
  return shown.code === 0 ? shown.out : "";
}

// The Proof lines Olaf approved with approach.md (orka approve): acceptance criteria with their proof.
function approvedProofLines(job) {
  if (!Array.isArray(job.proof) || !job.proof.length) return [];
  return [`Approved proof (Olaf approved these with approach.md; each is an acceptance criterion, shown by the proof it names):`, ...job.proof.map((l) => `- ${l}`), ``];
}

function specPromptLines(job) {
  const text = jobSpecText(job);
  return text ? [specs.specBlock(text, job.spec.path), ``] : [];
}

// The direction gate is on for new-feature jobs. Off with --no-gate, for any other playbook, and when the
// intake says it is a fix or trivial (title starts with fix/bug/hotfix/typo, or a "Kind: bugfix|trivial" line).
// A --spec job takes Kind: from the spec header (specKind), which the spec intake goal does not carry.
const GATE_SKIP_TITLE = /^\s*(fix|bug|bugfix|hotfix|typo|trivial)\b/i;
const GATE_SKIP_KIND = /^\s*kind:\s*(bug-?fix|fix|trivial)\s*$/im;

function decideGate(args, playbook, title, goal, specKind = "") {
  if (args["no-gate"]) return { on: false, reason: "--no-gate" };
  if (playbook !== "feature") return { on: false, reason: `playbook ${playbook}` };
  if (specKind && GATE_SKIP_KIND.test(`Kind: ${specKind}`)) return { on: false, reason: `spec: Kind: ${specKind}` };
  if (GATE_SKIP_TITLE.test(String(title))) return { on: false, reason: "intake: title names a fix or trivial change" };
  if (GATE_SKIP_KIND.test(String(goal))) return { on: false, reason: `intake: ${GATE_SKIP_KIND.exec(String(goal))[0].trim()}` };
  return { on: true, reason: "new feature", state: "planning" };
}

function gateLine(job) {
  const g = job.gate;
  if (!g) return "";
  if (!g.on) return `gate: off (${g.reason})`;
  if (job.status === AWAITING) return `gate: awaiting direction since ${g.proposedAt} (proposal ${g.proposals || 1}); orka approve ${job.id} approves the plan, or orka steer ${job.id} "..."`;
  if (g.state === "approved") return `gate: approved ${g.approvedAt}${Array.isArray(job.proof) && job.proof.length ? `; ${job.proof.length} proof line(s) for the verifier` : ""}`;
  return `gate: on, ${g.state === "revising" ? "revising the approach" : "planning"} (builders wait for orka approve)`;
}

function reviewLine(job) {
  if (job.status === REVIEW && signedOff(job)) return `review: signed off ${job.signoff.at}; the orchestrator runs orka done ${job.id}`;
  if (job.status === REVIEW) return `review: awaiting Olaf's sign-off since ${job.review?.at || "?"}; orka approve ${job.id} signs off the result (then orka done), or orka steer ${job.id} "..." requests changes`;
  return "";
}

const gatePending = (job) => Boolean(job.gate?.on) && job.gate.state !== "approved";
// An orchestrator paused at the gate has ended its turn; herdr reports that as done, never idle.
const GATE_READY = ["idle", "done"];

async function cmdNew(args) {
  if ("model" in args) fail("use --worker-model on orka new, not --model");
  allowFlags(args, ["cwd", "title", "goal", "kind", "orchestrator-model", "worker-model", "verifier-model", "keep", "max-rounds", "ui", "playbook", "spec", "no-gate", "stack-on"]);
  const kind = args.kind || "claude";
  const repo = requireRepo(args.cwd || process.cwd());
  const spec = "spec" in args ? resolveSpec(repo, flagValue(args, "spec")) : null;
  const title = args.title || spec?.parsed.title || spec?.feature;
  const goal = spec ? [typeof args.goal === "string" ? args.goal.trim() : "", specs.specIntake(spec.parsed, spec.rel, spec.commit)].filter(Boolean).join("\n\n") : args.goal;
  if (!title || !goal) fail("need --title and --goal (or --spec <path>)");
  if (kind !== "pi" && kind !== "claude") fail("kind must be pi or claude");
  if (kind === "pi" && (args["orchestrator-model"] || args["worker-model"] || args["verifier-model"])) {
    fail("--orchestrator-model, --worker-model and --verifier-model are only for kind claude");
  }
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
    gate: decideGate(args, playbook, title, goal, spec?.parsed.kind),
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
  if (spec) job.spec = { path: spec.rel, feature: spec.feature, commit: spec.commit, ...(spec.parsed.kind ? { kind: spec.parsed.kind } : {}) };
  // orka chain --signoff end: the job's worktree starts from the previous chained job's branch.
  if ("stack-on" in args) {
    const ref = flagValue(args, "stack-on");
    if (git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code !== 0) fail(`--stack-on ${ref}: no such branch or commit`);
    job.stackOn = ref;
  }
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
  const from = job.stackOn || "HEAD";
  const base = git(repo, ["rev-parse", from]).out.trim();
  const added = git(repo, ["worktree", "add", "-b", branch, path, from]);
  if (added.code !== 0) fail(added.err || added.out || "git worktree add failed");
  if (base) job.baseCommit = base;
  return path;
}

const DEPS_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// Links node_modules (lib/deps.mjs DEP_DIRS) to the main checkout, or runs a real
// install when the worktree's lockfile differs from main's; repairs a missing or
// broken link. Runs at orka run, at every orka worker and on a restored worktree.
// Lines go to stderr. Never fatal: a job without shared deps still runs.
function setupDeps(repo, job) {
  if (!job.worktree || !existsSync(job.worktree)) return;
  try {
    const plan = deps.planDeps(repo, job.worktree);
    const done = deps.applyDeps(repo, job.worktree, plan, { run: runInstall, log: (msg) => console.error(msg) });
    for (const d of done) if (d.action !== "install") ensureIgnored(job.worktree, d.dir);
    if (done.length) job.deps = [...(job.deps || []), ...done.map((d) => ({ ...d, at: new Date().toISOString() }))].slice(-10);
  } catch (err) {
    console.error(`deps: skipped (${err?.message || err})`);
  }
}

function runInstall(cmd, cwd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", timeout: DEPS_INSTALL_TIMEOUT_MS, killSignal: "SIGKILL", env: { ...process.env, PATH: pathPrefix() } });
  if (r.error) return { ok: false, detail: r.error.code === "ENOENT" ? `${cmd[0]} is not on PATH` : r.error.message };
  if (r.status === 0) return { ok: true, detail: "" };
  return { ok: false, detail: `exit ${r.status}: ${String(r.stderr || r.stdout || "").trim().split("\n").at(-1) || "no output"}` };
}

// "node_modules/" in .gitignore matches only a real directory, so a link would be
// untracked and could be committed by git add -A. Such a link goes into the repo's
// local info/exclude (never committed), once.
function ensureIgnored(wt, name) {
  if (git(wt, ["check-ignore", "-q", name]).code === 0) return;
  const path = git(wt, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).out;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.split("\n").includes(`/${name}`)) return;
  appendFileSync(path, `${cur && !cur.endsWith("\n") ? "\n" : ""}# orka: dependency links in job worktrees\n/${name}\n`);
}

// Worker prompt lines when the worktree shares a dep dir with the main checkout.
function depLinkLines(job) {
  const linked = deps.linkNames().filter((name) => deps.linkState(join(job.worktree || "", name), join(job.repo, name)) === "link");
  if (!linked.length) return [];
  return [`${linked.join(", ")} in this worktree is a symlink to the main checkout's. Never install into it. Before you add, remove or upgrade a dependency, replace the link with an install of its own: rm ${linked[0]}, then the repo's install command (npm install, pnpm install...).`];
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
    ...guardEnvArgs(job.repo),
  ]);
  const pane = got.json?.result?.root_pane?.pane_id;
  const workspace = got.json?.result?.workspace?.workspace_id;
  if (!pane) herdrFail(got, "workspace create");
  return { pane, workspace: workspace || "" };
}

// Claude Code stops a new session on its folder-trust dialog in a repo it has not trusted yet (trust is
// kept per repo root in ~/.claude.json). The pane then sits there; herdr reports the agent Blocked, and a
// retried start used to fail with a misleading "agent name already used". orka reads the pane, says what
// it is and how to fix it once, by hand. It never accepts the dialog.
const TRUST_DIALOG = /Quick safety check: Is this a project you created or one you trust|Do you trust the files in this folder|Yes, I trust this folder/i;

function trustDialogShown(pane) {
  if (!pane) return false;
  const got = herdr(["pane", "read", pane, "--source", "recent"], 10000);
  return got.code === 0 && TRUST_DIALOG.test(got.text);
}

function trustMessage(repo, pane, what) {
  return [
    `${what} did not start: Claude Code is waiting on its folder-trust dialog in pane ${pane}.`,
    `Claude has not trusted ${repo} yet (job worktrees inherit the trust of their repo).`,
    `One-time fix, by hand: cd ${repo} && claude, choose "Yes, I trust this folder", then /exit. Then run the orka command again.`,
    `orka does not accept the dialog for you.`,
  ].join("\n");
}

// After a start (or a failed one): fail at once when the pane shows the trust dialog.
function assertNotTrustBlocked(repo, kind, pane, what) {
  if (kind === "claude" && trustDialogShown(pane)) fail(trustMessage(repo, pane, what));
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
    last = herdr(startArgs(name, job.pane, kind, alias, job.sessionId, job), 90000);
    if (last.code === 0 && !last.json?.error) {
      assertNotTrustBlocked(job.repo, kind, job.pane, "the orchestrator");
      return name;
    }
    // Never retry into the dialog: a second start only reports the name as already used.
    assertNotTrustBlocked(job.repo, kind, job.pane, "the orchestrator");
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
  allowFlags(args, ["cwd", "dry-run", "orchestrator-model", "worker-model", "verifier-model", "keep", "max-rounds", "ui", "playbook", "no-gate"]);
  const id = args._[1];
  if (!id) fail("need id");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status !== "queued") fail(`job ${id} is ${job.status}, not queued`);
  assignClaudeModels(job, args);
  const playbook = parsePlaybook(args);
  if (playbook) job.playbook = playbook;
  // Jobs filed before the gate existed have no job.gate and run ungated.
  if (job.gate && (playbook || args["no-gate"])) job.gate = decideGate(args, job.playbook || "feature", job.title, job.goal, job.spec?.kind);
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
    setupDeps(repo, job);
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
    if (!lead.ok) assertNotTrustBlocked(repo, job.kind === "pi" ? "pi" : "claude", job.pane, "the orchestrator");
    if (!lead.ok) fail(`orchestrator prompt not delivered: ${lead.reason}`);
    job.status = "running";
    job.started = new Date().toISOString();
    save(repo, job);
    startWatcher(repo, job);
  } catch (err) {
    if (job.worktree || job.pane || job.agent) {
      console.error(doctorOnStartFailure(repo, job, "the orchestrator"));
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
  const split = herdr(["pane", "split", "--pane", fromPane, "--direction", "right", "--cwd", cwd, "--no-focus", "--env", `PATH=${pathPrefix()}`, ...portEnvArgs(job), ...jobEnvArgs(job, worker), ...guardEnvArgs(job.repo)]);
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

// Static gates before a verifier round (docs/gates.md, lib/gates.mjs).
function readRepoConfig(repo) {
  try {
    return JSON.parse(readFileSync(configPath(repo), "utf8")) || {};
  } catch {
    return {};
  }
}

const gateEnv = (job) => ({ ...process.env, PATH: pathPrefix(), ...ports.portEnv(job) });

// The single acceptance command this round would run instead of a verifier, or null (UI jobs never).
function acceptanceOf(job, task, flag) {
  if (job.jobType === "ui") return null;
  if (typeof flag === "string" && flag.trim()) return flag.trim();
  return gatesLib.singleCommand(task);
}

function gatePlanLines(repo, job, task, flag) {
  const found = gatesLib.detectGates(job.worktree || repo, readRepoConfig(repo));
  const out = [`gates: ${found.gates.length ? found.gates.map((g) => g.command).join("; ") : "none"} (${found.reason})`];
  const accept = acceptanceOf(job, task, flag);
  out.push(accept ? `acceptance by gate: \`${accept}\` (a pass skips the verifier pane)` : `acceptance by gate: no${job.jobType === "ui" ? " (UI job: always verified)" : ""}`);
  return out;
}

// A failing gate run once at baseCommit, in a temporary detached worktree; cached per (base, command).
function baseGateResult(repo, job, gate, limits, dir) {
  const cachePath = join(brand.stateDir(repo), "gates-base.json");
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8")) || {};
  } catch {
    cache = {};
  }
  const base = baseOf(repo, job);
  const key = `${base} ${gate.command}`;
  if (cache[key]) return { ...cache[key], cached: true };
  const tmp = join(brand.stateDir(repo), "worktrees", `${job.id}-gate-base-${process.pid}`);
  const added = git(repo, ["worktree", "add", "--detach", tmp, base]);
  if (added.code !== 0) return { base, exit: null, error: (added.err || added.out).split("\n")[0] };
  let got;
  try {
    try {
      deps.applyDeps(repo, tmp, deps.planDeps(repo, tmp), { run: runInstall });
    } catch {
      // no deps: the gate result says so
    }
    got = gatesLib.runGate(gate.command, tmp, { timeoutMs: limits.timeoutMs, logPath: join(dir, `base-${gate.name}.log`), env: gateEnv({ ...job, worktree: tmp }) });
  } finally {
    deps.unlinkLinks(tmp);
    git(repo, ["worktree", "remove", "--force", tmp]);
    rmSync(tmp, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
  }
  const rec = { base, command: gate.command, exit: got.exit, at: new Date().toISOString() };
  writeFileSync(cachePath, `${JSON.stringify({ ...cache, [key]: rec }, null, 2)}\n`);
  return rec;
}

const clip = (text, n = 600) => (text.length > n ? `...${text.slice(-n)}` : text);

// One gate round: every gate in the job worktree, a base check for each failure, then the single
// acceptance command when there is one and the gates are green. Records job.gates and
// results/gates/round-N.json; prints the failures for the orchestrator. { ok, round, results, accept }.
function runGateRound(repo, job, { task, accept: flag }) {
  const config = readRepoConfig(repo);
  const found = gatesLib.detectGates(job.worktree, config);
  const limits = gatesLib.gateLimits(config);
  const accept = acceptanceOf(job, task, flag);
  if (!found.gates.length && !accept) {
    console.error(`gates: none (${found.reason})`);
    return { ok: true, results: [] };
  }
  const round = (Number(job.gates?.rounds) || 0) + 1;
  const dir = join(ensureJobDir(repo, job.id), "results", "gates", `round-${round}`);
  const deadline = Date.now() + limits.budgetMs;
  const env = gateEnv(job);
  const run = (g) => {
    const left = deadline - Date.now();
    if (left <= 0) return { ...g, status: "skipped", why: "round budget spent" };
    const logPath = join(dir, `${g.name}.log`);
    const got = gatesLib.runGate(g.command, job.worktree, { timeoutMs: Math.min(limits.timeoutMs, left), logPath, env });
    return { ...g, status: got.exit === 0 ? "pass" : got.timedOut ? "timeout" : "fail", exit: got.exit, ms: got.ms, tail: got.tail, log: logPath };
  };
  const results = [];
  for (const g of found.gates) {
    const r = run(g);
    if (r.status === "fail") {
      const base = baseGateResult(repo, job, g, limits, dir);
      r.base = { commit: base.base, exit: base.exit, ...(base.cached ? { cached: true } : {}), ...(base.error ? { error: base.error } : {}) };
      if (Number.isInteger(base.exit) && base.exit !== 0) r.status = "preexisting";
    }
    results.push(r);
    console.error(`gate ${r.name}: ${r.status}${r.exit != null ? ` (exit ${r.exit}, ${Math.round((r.ms || 0) / 100) / 10}s)` : ""}${r.status === "preexisting" ? `; fails on base ${String(r.base.commit).slice(0, 8)} too (warning)` : ""}`);
  }
  const blocking = results.filter((r) => r.status === "fail" || r.status === "timeout");
  let acceptResult = null;
  if (!blocking.length && accept) {
    acceptResult = run({ name: "acceptance", command: accept });
    console.error(`acceptance \`${accept}\`: ${acceptResult.status}${acceptResult.exit != null ? ` (exit ${acceptResult.exit})` : ""}`);
    if (acceptResult.status !== "pass" && acceptResult.status !== "skipped") blocking.push(acceptResult);
  }
  const verdict = blocking.length ? "fail" : "pass";
  const summary = { round, at: new Date().toISOString(), verdict, source: found.source, results, ...(acceptResult ? { accept: acceptResult } : {}) };
  writeFileSync(join(dirname(dir), `round-${round}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  const entry = {
    round,
    at: summary.at,
    verdict,
    failing: blocking.map((r) => r.name),
    warnings: results.filter((r) => r.status === "preexisting").map((r) => r.name),
    ...(acceptResult ? { accept: { command: accept, status: acceptResult.status } } : {}),
    evidence: blocking.map((r) => ({ gate: r.name, command: r.command, exit: r.exit, tail: clip(r.tail || "") })),
  };
  job.gates = { rounds: round, verdict, history: [...(Array.isArray(job.gates?.history) ? job.gates.history : []), entry].slice(-20) };
  save(repo, job);
  const names = (list) => list.map((r) => `${r.name}${r.exit != null ? ` exit ${r.exit}` : ""}`).join(", ");
  appendDecision(repo, job.id, ["gate", `gate round ${round}: ${verdict}`, blocking.length ? `blocking: ${names(blocking)}` : `${results.length} gate(s) green${entry.warnings.length ? `; pre-existing: ${entry.warnings.join(", ")}` : ""}${acceptResult ? `; acceptance ${acceptResult.status}` : ""}`, join(dirname(dir), `round-${round}.json`), verdict === "fail" ? "no verifier started" : acceptResult?.status === "pass" ? "verifier skipped: pass by gate" : "verifier starts"]);
  if (blocking.length) {
    console.error(`gates round ${round}: FAIL; no verifier started.`);
    for (const r of blocking) {
      console.error(`--- ${r.name}: \`${r.command}\` ${r.status === "timeout" ? `timed out after ${Math.round(limits.timeoutMs / 1000)}s` : `exit ${r.exit}`}${r.base?.error ? ` (base check failed: ${r.base.error})` : ""}; log ${r.log}`);
      if (r.tail) console.error(r.tail);
    }
    console.error(`Route each failing gate with this output to the builder that owns those files. When they report, start the verifier again with the same command; the gates run first.`);
  }
  return { ok: !blocking.length, round, results, accept: acceptResult };
}

// The verifier round, decided by orka: green gates and the single acceptance command passed.
function passByGate(repo, job, round, gated) {
  archiveVerifierResult(repo, job, round - 1);
  const path = verifierResultPath(repo, job.id);
  mkdirSync(dirname(path), { recursive: true });
  const warnings = gated.results
    .filter((r) => r.status === "preexisting")
    .map((r) => ({ check: r.name, evidence: (r.tail || "").split("\n").slice(-3).join(" | "), base: r.base.commit, proof: `\`${r.command}\` exits ${r.base.exit} on the base commit too` }));
  const checks = [...gated.results, gated.accept].map((r) => ({ name: r.name, outcome: r.status === "pass" ? "pass" : r.status === "preexisting" ? "fail" : "skipped", scope: r.status === "preexisting" ? "preexisting" : "job", notes: r.command }));
  const result = { name: "gate", role: "verifier", by: "gate", round, verdict: "pass", checks, failures: [], warnings, summary: `acceptance \`${gated.accept.command}\` passed and the gates are green; orka started no verifier pane` };
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  const state = verifierState(job);
  const { head, patchId, patchRound, stale, ...rest } = job.verifier || {};
  job.verifier = { ...rest, rounds: round, verdict: null, history: state.history, stall: null };
  save(repo, job);
  recordVerifier(repo, job);
  appendDecision(repo, job.id, ["gate", `verifier round ${round}: pass by gate`, `acceptance \`${gated.accept.command}\` exit 0, gates green`, path, "no verifier pane"]);
  console.log(`verifier round ${round}: pass by gate (acceptance \`${gated.accept.command}\`); no verifier pane started`);
}

function gatePromptLine(job) {
  const g = job.gates?.history?.at(-1);
  if (!g) return `2. The project's own checks: npm test and npm run check, each only when package.json has that script (orka found no static gates to run first).`;
  return `2. orka already ran the static gates for this round (gate round ${g.round}: ${g.verdict}${g.warnings?.length ? `, pre-existing on base: ${g.warnings.join(", ")}` : ""}); see orka digest ${job.id}. Do not re-run them; spend the round on the acceptance criteria.`;
}

function cmdWorker(args) {
  if ("orchestrator-model" in args || "worker-model" in args) {
    fail("use --model to override a worker; the job default is workerModel (verifierModel for --role verifier)");
  }
  allowFlags(args, ["cwd", "dry-run", "job", "name", "task", "pane", "model", "role", "accept"]);
  const id = args.job;
  const requested = args.name;
  const task = args.task || args._.slice(1).join(" ");
  if (!id || !requested || !task) fail("need --job --name --task");
  assertAgentName(String(requested));
  const role = parseRole(args);
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, String(id));
  // A dry run starts nothing, so only a real start is held at the gate.
  if (!args["dry-run"] && job.status === AWAITING) fail(`job ${id} waits at the direction gate for orka approve; no worker starts until then`);
  if (!args["dry-run"] && gatePending(job) && (role === "verifier" || !/^research/.test(String(requested)))) {
    fail(`direction gate: job ${id} has no approved approach yet; only research workers (name research...) may start. Write approach.md, run orka propose ${id}, and wait for orka approve.`);
  }
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
  if (args.accept !== undefined && (role !== "verifier" || typeof args.accept !== "string" || !args.accept.trim())) fail('--accept "<command>" is for --role verifier only, with a command');
  if (args["dry-run"]) {
    const wt = job.worktree || worktreePath(repo, job.id);
    console.log(`dry-run worker ${first} job=${job.id} kind=${kind}${alias ? ` model=${alias}` : ""} role=${role}${role === "verifier" ? ` round=${round}` : ""}`);
    if (role === "verifier") for (const l of gatePlanLines(repo, job, String(task), args.accept)) console.log(l);
    console.log(`worktree: ${wt}`);
    console.log("layout: shared worktree");
    console.log(`split: herdr pane split --pane ${q(job.pane || "<orchestrator-pane>")} --direction right --cwd ${q(wt)} --no-focus`);
    console.log(`spawn: herdr ${sh(startArgs(first, args.pane || "<pane>", kind, alias, "<session-id>"))}`);
    console.log(`pane: ${paneCommand(alias)}`);
    return;
  }
  if (!job.pane || !job.agent || !job.worktree) fail("orchestrator is not running");
  if (job.status !== "running") fail(`job ${id} is ${job.status}, not running`);
  if (role === "verifier") {
    // The static gates run first: a red gate starts no verifier; a passing single-command acceptance replaces it.
    const gated = runGateRound(repo, job, { task: String(task), accept: args.accept });
    if (!gated.ok) {
      process.exitCode = 1;
      return;
    }
    if (gated.accept?.status === "pass") return passByGate(repo, job, round, gated);
  }
  waitForRoom(repo, job, first, role);
  ensureJobDir(repo, job.id);
  setupDeps(repo, job);
  recordBrowserPids(repo, job);
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
    started = herdr(startArgs(name, pane, kind, alias, sessionId, job), 90000);
    const failed = started.code !== 0 || started.json?.error;
    if (kind === "claude" && trustDialogShown(pane)) {
      if (ownPane) herdr(["pane", "close", pane]);
      fail(trustMessage(repo, pane, `worker ${name}`));
    }
    if (!failed) break;
    if (!/already used/i.test(started.text) || tried.length >= 20) break;
    tried.push(name);
    name = freeWorkerName(job, String(requested), tried);
  }
  if (started.code !== 0 || started.json?.error) {
    // The pane was split just now and never held an agent: close only that one.
    if (ownPane) herdr(["pane", "close", pane]);
    console.error(doctorOnStartFailure(repo, job, `worker ${name}`));
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
    fail(`worker ${name} did not start: ${delivered.reason}. Delivery failed; re-issue the task (orka worker ...) instead of waiting for a note.\n${doctorOnStartFailure(repo, job, `worker ${name}`)}`);
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

function guardLimitsOf(repo) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(repo), "utf8")).memoryGuard || {};
  } catch {
    // defaults
  }
  return guard.guardLimits(cfg, (key) => brand.env(key));
}

// Orka's own live panes on this host (ORKA_JOB-tagged pane shells, any repo); Olaf's other Herdr
// panes do not count. When /proc cannot be read, the panes this repo's running jobs hold.
function livePaneCount(repo) {
  const tagged = guard.orkaPaneCount(browsers.procRootOf());
  if (tagged !== null) return tagged;
  return loadAllJobs(repo)
    .filter((j) => LIVE_STATUSES.has(j.status))
    .reduce((n, j) => n + (j.pane ? 1 : 0) + (j.workers || []).filter((w) => w.pane && !w.closed && w.pane !== j.pane).length, 0);
}

function hostSample(repo) {
  return { availableMb: guard.memAvailableMb(browsers.procRootOf()), panes: livePaneCount(repo) };
}

const sampleText = (s, limits) => `MemAvailable ${s.availableMb ?? "?"}MB (min ${limits.minAvailableMb}MB), live panes ${s.panes ?? "?"}/${limits.maxPanes}`;

// The memory guard. Before a worker or verifier pane starts: when MemAvailable or
// the live pane count is past its limit, or earlier starts are already queued,
// queue and wait (poll) until there is room and this start is first in line.
// Logged to decisions.tsv. Past the wait limit the start is refused (exit 1).
function waitForRoom(repo, job, name, role) {
  const limits = guardLimitsOf(repo);
  if (limits.off) return;
  const dir = guard.queueDir(brand.stateDir(repo));
  let sample = hostSample(repo);
  let verdict = guard.guardVerdict(sample, limits);
  const ahead = guard.liveQueue(dir, pidAlive);
  if (verdict.ok && !ahead.length) return;
  const since = new Date().toISOString();
  const file = guard.enqueue(dir, { job: job.id, name, role, pid: process.pid, since });
  const leave = () => guard.dequeue(file);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(sig, () => {
      leave();
      process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[sig]));
    });
  }
  const why = verdict.ok ? `${ahead.length} earlier start(s) queued` : verdict.reasons.join("; ");
  appendDecision(repo, job.id, ["memory-guard", `queued ${role} ${name}`, why, sampleText(sample, limits), "waiting"]);
  console.error(`memory guard: ${why}; ${role} ${name} queued, waiting up to ${Math.round(limits.waitMs / 1000)}s`);
  const started = Date.now();
  for (;;) {
    sleep(limits.pollMs);
    sample = hostSample(repo);
    verdict = guard.guardVerdict(sample, limits);
    const head = guard.liveQueue(dir, pidAlive)[0];
    const waited = Math.round((Date.now() - started) / 1000);
    if (verdict.ok && head?.file === file) {
      leave();
      appendDecision(repo, job.id, ["memory-guard", `started ${role} ${name} after ${waited}s`, "room again", sampleText(sample, limits), "started"]);
      console.error(`memory guard: room again after ${waited}s; starting ${name}`);
      return;
    }
    if (Date.now() - started >= limits.waitMs) {
      leave();
      const still = verdict.ok ? "earlier starts still queued" : verdict.reasons.join("; ");
      appendDecision(repo, job.id, ["memory-guard", `did not start ${role} ${name} after ${waited}s`, still, sampleText(sample, limits), "not started"]);
      fail(`memory guard: ${still}; ${name} not started after ${waited}s. Wait for a worker to finish (or run orka cleanup), then run orka worker again.`);
    }
  }
}

// Host lines for orka status: free memory, live panes against the guard, and the queue.
function printHost(repo, jobId = null) {
  const limits = guardLimitsOf(repo);
  const sample = hostSample(repo);
  const queue = guard.liveQueue(guard.queueDir(brand.stateDir(repo)), pidAlive);
  const mem = sample.availableMb == null ? "unknown" : `${sample.availableMb}MB available`;
  const guardNote = limits.off ? "guard off" : `guard: min ${limits.minAvailableMb}MB, max ${limits.maxPanes} panes`;
  const indent = jobId ? "  " : "";
  console.log(`${indent}host: memory ${mem}, live panes ${sample.panes}, queue ${queue.length} (${guardNote})`);
  for (const q of queue.filter((e) => !jobId || e.job === jobId)) console.log(`${indent}queued: ${q.job} ${q.name} (${q.role}) since ${q.since}`);
}

// Context handoff (docs/handoff.md). The watcher runs handoffTick every poll over two kinds of
// pane: live builder workers and, unless handoff.orchestrator is false, the orchestrator. A pane at
// or past handoff.threshold of its detected window runs the handoff skill (plugin/skills/handoff):
// at once when idle or done, or at its next clean stopping point through a message queued mid-turn.
// Once the note exists and the agent is idle again, it is renamed <name>-h<n> and a fresh agent
// starts under <name> in a new pane of the same worktree. Old panes stay open until done, stop or
// cleanup. A pane whose window cannot be detected is never handed off automatically.
const HANDOFF_NOTE_WAIT_MS = Number(brand.env("HANDOFF_NOTE_WAIT_MS")) || 15 * 60 * 1000;
// A nudged agent seen idle this long without a note is sent the skill command directly.
const HANDOFF_NUDGE_GRACE_MS = Number(brand.env("HANDOFF_NUDGE_GRACE_MS")) || 20 * 1000;
const PENDING = new Set(["nudged", "writing"]);

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

// One pane the tick looks at. The orchestrator's handoff state lives on job.lead.
function workerSlot(worker) {
  return { role: "worker", name: worker.name, kind: worker.kind === "pi" ? "pi" : "claude", alias: worker.model || "", sessionId: worker.sessionId, pane: worker.pane };
}

function leadSlot(job) {
  const kind = job.kind === "pi" ? "pi" : "claude";
  return { role: "orchestrator", name: job.agent, kind, alias: kind === "claude" ? job.orchestratorModel || job.model || "" : "", sessionId: job.sessionId, pane: job.pane };
}

function slotRecord(job, slot) {
  if (slot.role === "orchestrator") return (job.lead ||= {});
  return workerBySession(job, slot.sessionId);
}

const noteBase = (slot) => (slot.role === "orchestrator" ? "orchestrator" : slot.name);

function measurePane(repo, job, slot, settings) {
  const home = homedir();
  const path = context.findTranscript({ kind: slot.kind, cwd: job.worktree, sessionId: slot.sessionId, home });
  const usage = path ? context.readUsage(path) : null;
  if (!usage) return null;
  const pi = slot.kind === "pi";
  const win = context.detectWindow({
    kind: slot.kind,
    model: usage.model,
    provider: usage.provider,
    alias: slot.alias,
    capture: pi ? null : context.readCapture(captureDir(repo, job.id), slot.sessionId),
    piRegistry: pi ? context.readPiRegistry(home) : null,
    override: settings.contextWindow,
  });
  return context.contextOf(usage, win);
}

const herdrOk = (got) => got.code === 0 && !got.json?.error;
const herdrDetail = (got) => String(got.json?.error?.message || got.json?.error || got.text || "").replace(/\s+/g, " ").slice(0, 200);
const pctOf = (pct) => (pct == null ? null : Math.round(pct * 1000) / 1000);
const contextRecord = (ctx) => ({ tokens: ctx.tokens, window: ctx.window, source: ctx.source, pct: pctOf(ctx.pct), at: new Date().toISOString() });

// A message typed while the agent works: Claude and Pi queue it and hand it to the model after the
// current tool call. Never waits for idle and never interrupts the turn.
function queuePrompt(name, text) {
  const sent = herdr(["agent", "prompt", name, text], 60000);
  if (!herdrOk(sent)) return { ok: false, reason: herdrDetail(sent) };
  sleep(PROMPT_POLL_MS * 2);
  const pane = agentPane(name);
  if (pane && unsubmittedInput(herdr(["pane", "read", pane, "--source", "recent"]).text)) herdr(["agent", "send-keys", name, "Enter"]);
  return { ok: true };
}

function handoffFailed(repo, id, slot, reason, log) {
  updateJob(repo, id, (job) => {
    const rec = slotRecord(job, slot);
    if (rec?.handoff) Object.assign(rec.handoff, { state: "failed", reason });
  });
  appendDecision(repo, id, ["handoff", `handoff of ${slot.name} abandoned`, reason, "", "failed"]);
  log(`handoff failed: ${reason}`);
}

// mode "now": the skill command at a safe point. mode "queue": a mid-turn message asking the agent
// to run the skill at its next clean stopping point.
function askForNote(repo, job, slot, rec, ctx, settings, mode, log) {
  const n = (Array.isArray(rec.handoffs) ? rec.handoffs.length : 0) + 1;
  const note = context.notePath(jobDir(repo, job.id), noteBase(slot), n);
  mkdirSync(dirname(note), { recursive: true });
  const args = { kind: slot.kind, path: note, role: slot.role, context: ctx, threshold: settings.threshold };
  const sent = mode === "queue"
    ? queuePrompt(slot.name, context.nudgePrompt({ ...args, skillFile: HANDOFF_SKILL }))
    : promptWithRetry(slot.name, context.notePrompt(args), { readyStatuses: context.SAFE_STATUSES });
  const at = new Date().toISOString();
  const state = !sent.ok ? "failed" : mode === "queue" ? "nudged" : "writing";
  updateJob(repo, job.id, (j) => {
    const r = slotRecord(j, slot);
    if (r) r.handoff = { state, mode, n, note, tokens: ctx.tokens, window: ctx.window, source: ctx.source, pct: pctOf(ctx.pct), at, ...(sent.ok ? {} : { reason: sent.reason }) };
  });
  const how = mode === "queue" ? "queued mid-turn: run the handoff skill at the next clean stopping point" : "handoff skill run at a safe point";
  appendDecision(repo, job.id, ["handoff", `ask ${slot.name} for handoff note h${n}`, `context ${context.pctLabel(ctx.pct)} >= ${context.pctLabel(settings.threshold)} of ${ctx.window} (${ctx.source}); ${how}`, note, sent.ok ? state : `failed: ${sent.reason}`]);
  log(`handoff ${slot.name}: context ${context.pctLabel(ctx.pct)} (${ctx.tokens}/${ctx.window}, ${ctx.source}); ${sent.ok ? `${how} -> ${note}` : `note prompt failed: ${sent.reason}`}`);
}

// Note written and the agent idle: rename it, start the successor under its name, prompt it.
function startSuccessor(repo, id, slot, log) {
  const job = load(repo, id);
  const settings = handoffSettingsOf(repo);
  const rec = slotRecord(job, slot);
  const h = rec.handoff;
  const name = slot.name;
  const from = context.retiredName(name, h.n);
  // The old agent's context once the note is written: how far it went past the cap.
  const end = measurePane(repo, job, slot, settings);
  const renamed = herdr(["agent", "rename", name, from]);
  if (!herdrOk(renamed)) return handoffFailed(repo, id, slot, `herdr agent rename ${name} ${from}: ${herdrDetail(renamed)}`, log);
  const at = new Date().toISOString();
  const lead = slot.role === "orchestrator";
  updateJob(repo, id, (j) => {
    const r = slotRecord(j, slot);
    r.handoff.state = "done";
    if (end) r.handoff.pctEnd = pctOf(end.pct);
    if (!lead) {
      r.name = from;
      r.retired = { at, by: name, n: h.n };
    }
  });
  const rollback = (why) => {
    herdr(["agent", "rename", from, name]);
    updateJob(repo, id, (j) => {
      const r = slotRecord(j, slot);
      if (!lead) {
        r.name = name;
        delete r.retired;
      }
    });
    handoffFailed(repo, id, slot, why, log);
  };
  const env = lead ? jobEnvArgs(job, "orchestrator") : jobEnvArgs(job, name);
  const split = herdr(["pane", "split", "--pane", slot.pane, "--direction", "down", "--cwd", job.worktree, "--no-focus", "--env", `PATH=${pathPrefix()}`, ...portEnvArgs(job), ...env]);
  const pane = split.json?.result?.pane?.pane_id;
  if (!pane) return rollback(`pane split: ${herdrDetail(split)}`);
  const nextSession = randomUUID();
  const started = herdr(startArgs(name, pane, slot.kind, slot.alias, nextSession, job), 90000);
  const trust = slot.kind === "claude" && trustDialogShown(pane);
  if (!herdrOk(started) || trust) {
    // The pane was split just now and never held an agent: close only that one.
    herdr(["pane", "close", pane]);
    return rollback(trust ? trustMessage(repo, pane, `successor ${name}`).replace(/\n/g, " ") : `agent start ${name}: ${herdrDetail(started)}`);
  }
  const record = { n: h.n, from, pane: slot.pane, sessionId: slot.sessionId, tokens: h.tokens, window: h.window, source: h.source, pct: h.pct, pctEnd: end ? pctOf(end.pct) : null, mode: h.mode, at, note: h.note };
  let prompt;
  if (lead) {
    // The record first, so the watcher follows the new pane while the prompt is delivered.
    updateJob(repo, id, (j) => {
      j.pane = pane;
      j.sessionId = nextSession;
      j.lead = { handoffs: [...(Array.isArray(j.lead?.handoffs) ? j.lead.handoffs : []), record] };
      j.retiredLeads = [...(Array.isArray(j.retiredLeads) ? j.retiredLeads : []), { name: from, pane: slot.pane, sessionId: slot.sessionId, n: h.n, at }];
      j.handoffs = [...(Array.isArray(j.handoffs) ? j.handoffs : []), { worker: "orchestrator", ...record }];
    });
    prompt = `${leadPrompt(job)}\n${context.leadSuccessorLines({ path: h.note, n: h.n, from, jobFile: jobPath(repo, id), decisions: decisionsPath(repo, id), id })}`;
  } else {
    const worker = rec;
    prompt = `${workerPrompt(job, name, worker.task, worker.model)}\n${context.successorLines({ path: h.note, n: h.n, from })}`;
  }
  const delivered = promptWithRetry(name, prompt);
  if (lead) {
    updateJob(repo, id, (j) => {
      j.leadDelivery = delivered.ok ? "ok" : "failed";
    });
  } else {
    const worker = rec;
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
  }
  const past = end ? `; ${context.pctLabel(end.pct)} when the note was done` : "";
  appendDecision(repo, id, ["handoff", `${from} -> fresh ${name} (h${h.n})`, `context ${context.pctLabel(h.pct)}${past}; old pane ${slot.pane} stays open`, h.note, delivered.ok ? `ok pane=${pane}` : `delivery failed: ${delivered.reason}`]);
  log(`handoff ${name}: old agent renamed ${from} (pane ${slot.pane} stays open), fresh ${name} pane=${pane}${past}${delivered.ok ? "" : ` delivery failed: ${delivered.reason}`}`);
}

// A note asked for and not yet used: start the successor once it exists and the agent is idle.
function pendingStep(repo, id, slot, rec, { dry, log, seen }) {
  const h = rec.handoff;
  const ready = existsSync(h.note) && statSync(h.note).size > 0;
  const status = agentStatus(slot.name);
  seen.push({ name: slot.name, role: slot.role, state: h.state, ready, status });
  if (dry) return;
  const safe = context.SAFE_STATUSES.includes(status);
  if (ready && safe) return startSuccessor(repo, id, slot, log);
  if (Date.now() - Date.parse(h.at) > HANDOFF_NOTE_WAIT_MS) {
    return handoffFailed(repo, id, slot, `${slot.name} wrote no handoff note in ${Math.round(HANDOFF_NOTE_WAIT_MS / 60000)} min`, log);
  }
  // Nudged, but the turn ended without the skill: run it directly, after a grace period so a
  // queued message that is about to start a turn is not doubled.
  if (h.state === "nudged" && safe && !ready) {
    if (!h.safeSince) return updateJob(repo, id, (j) => void (slotRecord(j, slot).handoff.safeSince = new Date().toISOString()));
    if (Date.now() - Date.parse(h.safeSince) < HANDOFF_NUDGE_GRACE_MS) return;
    const sent = promptWithRetry(slot.name, context.notePrompt({ kind: slot.kind, path: h.note, role: slot.role, context: h, threshold: handoffSettingsOf(repo).threshold }), { readyStatuses: context.SAFE_STATUSES });
    updateJob(repo, id, (j) => {
      const r = slotRecord(j, slot).handoff;
      r.state = sent.ok ? "writing" : "failed";
      if (!sent.ok) r.reason = sent.reason;
    });
    log(`handoff ${slot.name}: idle after the queued ask without a note; ${sent.ok ? "ran the handoff skill" : `skill prompt failed: ${sent.reason}`}`);
  } else if (h.safeSince && !safe) {
    updateJob(repo, id, (j) => void delete slotRecord(j, slot).handoff.safeSince);
  }
}

// A hook ask becomes a "nudged" handoff (mode hook): pendingStep then waits for the note, starts the
// successor, and runs the skill itself if the agent ends its turn without a note.
function adoptHookAsk(repo, job, slot, m, settings, { dry, log, seen }) {
  seen.push({ name: slot.name, role: slot.role, tokens: m.tokens, window: m.window, source: m.source, pct: m.pct, status: "", due: false, why: `asked by its hook at ${context.pctLabel(m.pct)}` });
  if (dry) return;
  updateJob(repo, job.id, (j) => {
    const r = slotRecord(j, slot);
    if (r && !r.handoff) r.handoff = { state: "nudged", mode: "hook", n: m.n, note: m.note, tokens: m.tokens, window: m.window, source: m.source, pct: m.pct, at: m.at };
  });
  appendDecision(repo, job.id, ["handoff", `ask ${slot.name} for handoff note h${m.n}`, `context ${context.pctLabel(m.pct)} >= ${context.pctLabel(settings.threshold)} of ${m.window} (${m.source}); asked by its own ${slot.kind} hook after a tool call`, m.note, "nudged"]);
  log(`handoff ${slot.name}: its hook asked at ${context.pctLabel(m.pct)} (${m.tokens}/${m.window}, ${m.source}) -> ${m.note}`);
}

// Measure one pane and act on it. force: orka handoff <id> <name> (no threshold, no cap; still
// needs the agent idle, done or working).
function measureStep(repo, job, slot, rec, settings, { dry, log, seen, force = false }) {
  // The pane's own hook already asked this session: adopt that ask instead of asking again.
  const marker = force ? null : handoffHook.readMarker(jobDir(repo, job.id), slot.sessionId);
  if (marker) return adoptHookAsk(repo, job, slot, marker, settings, { dry, log, seen });
  const ctx = measurePane(repo, job, slot, settings);
  if (!ctx && !force) {
    seen.push({ name: slot.name, role: slot.role, state: "no usage" });
    return;
  }
  const status = force || (ctx?.window && ctx.pct >= settings.threshold) ? agentStatus(slot.name) : "";
  let due = context.handoffDue({ context: ctx, status, threshold: settings.threshold });
  const capped = !force && due.due && context.capReached(rec.handoffs, settings.maxHandoffs);
  if (capped) due = { due: false, why: `cap of ${settings.maxHandoffs} handoffs reached` };
  if (force) {
    const mode = context.SAFE_STATUSES.includes(status) ? "now" : status === "working" ? "queue" : "";
    due = mode ? { due: true, mode, why: "asked by hand" } : { due: false, why: `asked by hand but ${status || "unknown"}` };
  }
  seen.push({ name: slot.name, role: slot.role, tokens: ctx?.tokens, window: ctx?.window, source: ctx?.source, pct: pctOf(ctx?.pct), status, due: due.due, mode: due.mode, why: due.why });
  if (dry) return;
  const flags = {};
  if (ctx && !ctx.window && !rec.windowUnknown) flags.windowUnknown = true;
  if (capped && !rec.capLogged) flags.capLogged = true;
  updateJob(repo, job.id, (j) => {
    const r = slotRecord(j, slot);
    if (!r) return;
    if (ctx) r.context = contextRecord(ctx);
    Object.assign(r, flags);
  });
  if (flags.windowUnknown) {
    appendDecision(repo, job.id, ["handoff", `no automatic handoff for ${slot.name}`, `window unknown (${slot.kind}, model ${ctx.model || "-"}): no statusline capture, [1m] id or registry entry, and no handoff.contextWindow`, "", "skipped; orka handoff <id> <name> still works"]);
    log(`handoff ${slot.name}: window unknown for model ${ctx.model || "-"}; no automatic handoff`);
  }
  if (flags.capLogged) {
    appendDecision(repo, job.id, ["handoff", `no more handoffs for ${slot.name}`, `context ${context.pctLabel(ctx.pct)}; cap of ${settings.maxHandoffs} handoffs (handoff.maxHandoffs) reached`, "", "skipped"]);
    log(`handoff ${slot.name}: cap of ${settings.maxHandoffs} reached; not handed off again`);
  }
  if (due.due) askForNote(repo, job, slot, rec, ctx || { tokens: 0, window: 0, pct: 0, source: "unknown" }, settings, due.mode, log);
}

// One pass over a job's panes. Returns what it saw, for orka handoff --dry-run and the tests.
// only: a worker name, or "orchestrator", for a handoff asked by hand.
function handoffTick(repo, id, { log = console.log, dry = false, only = "" } = {}) {
  const settings = handoffSettingsOf(repo);
  const job = load(repo, id);
  const seen = [];
  if ((!settings.enabled && !only) || job.status !== "running" || !job.worktree) return seen;
  const ctx = { dry, log, seen };
  const leadWanted = only ? only === "orchestrator" || only === job.agent : settings.orchestrator;
  if (leadWanted && job.agent && job.sessionId) {
    const slot = leadSlot(job);
    const rec = job.lead || {};
    if (PENDING.has(rec.handoff?.state)) pendingStep(repo, id, slot, rec, ctx);
    else if (only || rec.handoff?.state !== "failed") measureStep(repo, job, slot, rec, settings, { ...ctx, force: Boolean(only) });
  }
  for (const worker of job.workers || []) {
    if (!worker?.sessionId) continue;
    if (only && worker.name !== only) continue;
    const slot = workerSlot(worker);
    if (PENDING.has(worker.handoff?.state)) {
      pendingStep(repo, id, slot, worker, ctx);
      continue;
    }
    const resultExists = existsSync(join(jobDir(repo, id), "results", `${worker.name}.json`));
    if (only ? worker.retired || worker.closed : !context.handoffCandidate(worker, { resultExists })) continue;
    measureStep(repo, job, slot, worker, settings, { ...ctx, force: Boolean(only) });
  }
  return seen;
}

// True when a pane the tick measures is working: the watcher then polls every handoff.busyPollMs
// instead of every 30 s, so one batch of reads cannot run far past the cap between two checks.
// One herdr agent list per call.
function handoffBusy(repo, id) {
  const settings = handoffSettingsOf(repo);
  if (!settings.enabled || !settings.busyPollMs) return false;
  const job = load(repo, id);
  if (job.status !== "running" || !job.worktree) return false;
  const names = new Set();
  if (settings.orchestrator && job.agent && job.sessionId) names.add(job.agent);
  for (const w of job.workers || []) {
    if (!w?.sessionId) continue;
    const resultExists = existsSync(join(jobDir(repo, id), "results", `${w.name}.json`));
    if (PENDING.has(w.handoff?.state) || context.handoffCandidate(w, { resultExists })) names.add(w.name);
  }
  if (!names.size) return false;
  const agents = herdr(["agent", "list"]).json?.result?.agents || [];
  return agents.some((a) => names.has(a.name) && a.agent_status === "working");
}

// Feature map write-back (docs/feature-map.md), once per finished result file: a builder's
// "keepInMind" is merged into orka.features.md; at a verifier result, Stale entries are carried one
// job further or dropped. Returns the line for the wake, or "" when the map did not change.
function featureMapStep(repo, job, w, key) {
  if (!key || job.featureMap?.[key] || !job.worktree || !existsSync(job.worktree)) return "";
  const path = join(job.worktree, featureMapFile(job.worktree));
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  let after = before;
  let note = "";
  if (w.role === "verifier") {
    if (before == null) return "";
    const got = featureMap.pruneStale(before, job.id);
    after = got.text;
    const parts = [got.dropped.length && `dropped ${got.dropped.join(", ")} (stale for ${featureMap.STALE_JOBS} jobs)`, got.carried.length && `stale: ${got.carried.join(", ")}`].filter(Boolean);
    if (parts.length) note = `feature map: ${parts.join("; ")}`;
  } else {
    let data = null;
    try {
      data = JSON.parse(readFileSync(w.result, "utf8"));
    } catch {}
    const notes = featureMap.keepFromResult(data?.keepInMind);
    if (!notes.length) return "";
    const got = featureMap.mergeKeep(before ?? `# Feature map\n`, notes);
    after = got.text;
    if (got.added.length) note = `feature map: ${got.added.length} keep-in-mind line(s) merged into ${[...new Set(got.added.map((a) => a.feature))].join(", ")}`;
  }
  if (after !== before) writeFileSync(path, after);
  updateJob(repo, job.id, (j) => {
    j.featureMap = { ...(j.featureMap || {}), [key]: { worker: w.name, at: new Date().toISOString(), note } };
  });
  if (note) appendDecision(repo, job.id, ["feature-map", note, w.name, path, "commit it with the job"]);
  return note;
}

// Harness-sent wake and inbox delivery (docs/workers.md). The watcher runs this every poll:
// 1. a worker or verifier whose turn ended with its result file written gets one wake to the current
//    orchestrator (held while the orchestrator hands off; queued mid-turn while it works);
// 2. steers waiting in an inbox go to an idle target with herdr agent prompt (its hook delivers them
//    between tool calls while it works). Always to whichever pane holds the name now.
function wakeTick(repo, id, { log = console.log, dry = false } = {}) {
  const job = load(repo, id);
  const seen = [];
  if (job.status !== "running" || !job.agent) return seen;
  const dir = jobDir(repo, id);
  const leadHandoff = PENDING.has(job.lead?.handoff?.state);
  // Verifier rounds share results/verifier.json: only the newest worker on a result file owns its wakes.
  const owner = new Map((job.workers || []).filter((w) => w?.result).map((w) => [w.result, w.name]));
  for (const w of job.workers || []) {
    if (!w?.result || w.retired || owner.get(w.result) !== w.name) continue;
    const key = wake.wakeKey(w.name, w.result);
    if (!key || job.wakes?.[key]) continue;
    const status = agentStatus(w.name);
    if (status === "working" || status === "blocked") {
      seen.push({ kind: "wake", worker: w.name, state: `waiting: ${w.name} is ${status}` });
      continue;
    }
    const mapNote = dry ? "" : featureMapStep(repo, job, w, key);
    if (leadHandoff) {
      seen.push({ kind: "wake", worker: w.name, state: "held: the orchestrator is handing off" });
      continue;
    }
    const lead = agentStatus(job.agent);
    const mode = context.SAFE_STATUSES.includes(lead) ? "now" : lead === "working" ? "queue" : "";
    if (!mode) {
      seen.push({ kind: "wake", worker: w.name, state: `held: orchestrator ${lead}` });
      continue;
    }
    let raw = "";
    try {
      raw = readFileSync(w.result, "utf8");
    } catch {
      continue;
    }
    const got = wake.readResult(raw);
    const commits = w.startedAt && job.worktree && existsSync(job.worktree) ? git(job.worktree, ["log", "--oneline", `-${wake.COMMIT_LINES}`, `--since=${w.startedAt}`]) : null;
    const text = wake.wakeText({ jobId: id, worker: w.name, role: w.role, state: got.state, text: got.text, path: w.result, commits: commits && commits.code === 0 ? commits.out.split("\n").filter(Boolean) : null, undelivered: inbox.pendingTotal(dir) }) + (mapNote || job.featureMap?.[key]?.note ? `\n${mapNote || job.featureMap[key].note}` : "");
    seen.push({ kind: "wake", worker: w.name, state: `wake ${mode === "now" ? "sent" : "queued mid-turn"}`, text });
    if (dry) continue;
    const sent = mode === "now" ? promptWithRetry(job.agent, text, { readyStatuses: context.SAFE_STATUSES }) : queuePrompt(job.agent, text);
    if (!sent.ok) {
      log(`wake ${w.name}: not delivered (${sent.reason}); retrying next poll`);
      continue;
    }
    const at = new Date().toISOString();
    updateJob(repo, id, (j) => {
      j.wakes = { ...(j.wakes || {}), [key]: { worker: w.name, at, mode, agent: j.agent, pane: j.pane } };
    });
    appendDecision(repo, id, ["wake", `wake orchestrator: ${w.name} finished`, got.state, w.result, mode === "now" ? `delivered to ${job.agent} (${job.pane})` : `queued mid-turn for ${job.agent} (${job.pane})`]);
    log(`wake ${w.name} -> ${job.agent} (${job.pane}): ${mode === "now" ? "delivered" : "queued mid-turn"}`);
  }
  for (const target of Object.keys(inbox.pendingCounts(dir))) {
    const lead = target === "orchestrator";
    const rec = lead ? job.lead : (job.workers || []).filter((w) => w.name === target && !w.retired).at(-1);
    const name = lead ? job.agent : rec?.name;
    if (!name) continue;
    if (PENDING.has(rec?.handoff?.state)) {
      seen.push({ kind: "steer", target, state: "held: handing off" });
      continue;
    }
    const status = agentStatus(name);
    if (!context.SAFE_STATUSES.includes(status)) {
      seen.push({ kind: "steer", target, state: `left for its hook: ${status}` });
      continue;
    }
    seen.push({ kind: "steer", target, state: "delivered by the watcher" });
    if (dry) continue;
    const entries = inbox.claim(dir, target, "watcher");
    if (!entries.length) continue;
    const sent = promptWithRetry(name, inbox.deliveryText(entries), { readyStatuses: context.SAFE_STATUSES });
    if (!sent.ok) {
      inbox.release(dir, target, entries);
      log(`inbox ${target}: not delivered (${sent.reason}); back in the inbox`);
      continue;
    }
    appendDecision(repo, id, ["steer", `inbox delivered to ${target}`, `${entries.length} message(s), agent idle`, inbox.deliveredDir(dir, target), `herdr prompt ${name}`]);
    log(`inbox ${target}: ${entries.length} message(s) delivered to idle ${name}`);
  }
  return seen;
}

function cmdWake(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need: orka wake <id> [--dry-run]");
  const repo = requireRepo(args.cwd || process.cwd());
  const seen = wakeTick(repo, String(id), { dry: Boolean(args["dry-run"]) });
  for (const s of seen) console.log(`${s.kind} ${s.worker || s.target}: ${s.state}`);
  if (!seen.length) console.log("nothing to wake or deliver");
}

function cmdHandoff(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  const only = args._[2] ? String(args._[2]) : "";
  if (!id) fail("need: orka handoff <id> [<worker>|orchestrator] [--dry-run]");
  const repo = requireRepo(args.cwd || process.cwd());
  const settings = handoffSettingsOf(repo);
  if (args["dry-run"]) console.log(`handoff: ${settings.enabled ? `threshold ${context.pctLabel(settings.threshold)}, orchestrator ${settings.orchestrator ? "on" : "off"}, cap ${settings.maxHandoffs}` : "off"}`);
  const seen = handoffTick(repo, String(id), { dry: Boolean(args["dry-run"]), only });
  for (const s of seen) {
    const who = `${s.name}${s.role === "orchestrator" ? " (orchestrator)" : ""}`;
    if (s.state) console.log(`${who}: ${s.state}${PENDING.has(s.state) ? ` note=${s.ready ? "written" : "not yet"} status=${s.status}` : ""}`);
    else {
      const size = s.window ? `${s.tokens}/${s.window} tokens ${context.pctLabel(s.pct)} (${s.source})` : `${s.tokens ?? 0} tokens, window unknown`;
      console.log(`${who}: ${size}${s.status ? ` ${s.status}` : ""} -> ${s.due ? (s.mode === "queue" ? "hand off (queued mid-turn)" : "hand off") : "keep"} (${s.why})`);
    }
  }
  if (!seen.length) console.log(only ? `no pane named ${only} to hand off` : "no pane to measure");
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
    console.log(`  worktree: ${job.worktree || "(not created)"}${job.worktreeRemoved ? ` (removed ${job.worktreeRemoved}; branch kept)` : ""}`);
    console.log(`  layout: ${job.workerLayout || "shared-worktree"}`);
    console.log(`  playbook: ${job.playbook || "feature"}`);
    if (job.spec?.path) console.log(`  spec: ${job.spec.path}${job.spec.commit ? ` @${job.spec.commit.slice(0, 8)}` : ""}`);
    if (job.lessons) console.log(`  lessons: ${job.lessons.added} added, ${job.lessons.bumped} seen again${job.lessons.commit ? ` (commit ${job.lessons.commit})` : " (not committed)"}`);
    if (gateLine(job)) console.log(`  ${gateLine(job)}`);
    if (reviewLine(job)) console.log(`  ${reviewLine(job)}`);
    if (job.status === AWAITING && job.gate?.approach) for (const l of job.gate.approach.split("\n").slice(0, 12)) console.log(`    ${l}`);
    if (job.port != null) console.log(`  port: ${job.port}${Array.isArray(job.ports) && job.ports.length > 1 ? ` ports=${job.ports.join(",")}` : ""}`);
    if (roundOf(job) > 1) console.log(`  round: ${roundOf(job)} (follow-up)`);
    if (job.watcherPid && job.status === "running") console.log(`  watcher: pid ${job.watcherPid}`);
    if (job.workspaceClosed) console.log(`  workspace: closed ${job.workspaceClosed}`);
    else if (FINISH_STATUSES.has(job.status) && job.workspace) console.log(`  workspace: ${job.workspace} open until idle ${staleLabel(repo)}`);
    if (job.cleanup) console.log(`  cleaned up: ${job.cleanup.browsers.length} browser(s), ${job.cleanup.servers.length} server(s), ${job.cleanup.panes.length} worker pane(s)`);
    if (job.kind === "claude") console.log(`  models: orchestrator=${job.orchestratorModel || job.model || "-"} worker=${job.workerModel || "-"} ${verifierLabel(job)}`);
    if (job.agent || job.pane) console.log(`  agent: ${job.agent || "-"} pane=${job.pane || "-"} workspace=${job.workspace || "-"} model=${job.orchestratorModel || job.model || "-"}${job.leadDelivery === "failed" ? ` delivery=failed${job.stopReason ? ` [${job.stopReason}]` : ""}` : ""}${handoffLabel(job.lead)}`);
    for (const r of job.retiredLeads || []) console.log(`  orchestrator: ${r.name} pane=${r.pane} handed-off->${job.agent} (h${r.n}, pane open)`);
    for (const worker of job.workers || []) console.log(`  worker: ${worker.name} pane=${worker.pane} ${worker.model ? `model=${worker.model}` : "kind=pi"}${worker.role === "verifier" ? " role=verifier" : ""}${worker.delivery ? ` delivery=${worker.delivery}` : ""}${worker.closedUnused ? ` closed-unused (${worker.closedUnused.reason})` : ""}${worker.delivery === "failed" && worker.deliveryReason ? ` [${worker.deliveryReason}]` : ""}${handoffLabel(worker)}`);
    for (const steer of (job.steers || []).filter((x) => x?.delivery === "failed")) console.log(`  steer: ${String(steer.message ?? "").slice(0, 200).replace(/[\r\n]+/g, " ")} delivery=failed${steer.deliveryReason ? ` [${steer.deliveryReason}]` : ""}`);
    const queued = inbox.pendingCounts(jobDir(repo, job.id));
    if (Object.keys(queued).length) console.log(`  steer inbox: ${Object.entries(queued).map(([t, n]) => `${t} ${n}`).join(", ")} undelivered`);
    const summary = summaryOf(repo, job);
    if (summary) console.log(`  summary: ${summary}`);
    if (job.stopReason) console.log(`  stop: ${job.stopReason}`);
    console.log(`  ${finishStatusLine(repo, job)}`);
    printVerifyStatus(repo, job);
    console.log(`  decisions: ${decisionRows(repo, job.id).length}`);
    if (job.verifier?.rounds && job.status === "running") recordVerifier(repo, job);
    if (job.status === "running") recordBrowserPids(repo, job);
    if (verifierLine(job)) console.log(`  ${verifierLine(job)}`);
    const lastGate = job.gates?.history?.at(-1);
    if (lastGate) console.log(`  gates: round ${lastGate.round} ${lastGate.verdict}${lastGate.failing.length ? ` (blocking: ${lastGate.failing.join(", ")})` : ""}${lastGate.warnings.length ? ` (pre-existing: ${lastGate.warnings.join(", ")})` : ""}${lastGate.accept ? `, acceptance ${lastGate.accept.status}` : ""}`);
    printVerifierDetail(job);
    printHost(repo, job.id);
    return;
  }
  mkdirSync(jobsDir(repo), { recursive: true });
  const files = readdirSync(jobsDir(repo)).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) console.log("no jobs");
  for (const file of files) line(JSON.parse(readFileSync(join(jobsDir(repo), file), "utf8")));
  printHost(repo);
}

// rec: a worker record or job.lead. ctx=NN% of <window>k (<source>), or ctx=window-unknown.
function handoffLabel(rec) {
  const parts = [];
  const c = rec?.context;
  if (c && !rec.retired) parts.push(c.window ? `ctx=${context.pctLabel(c.pct)} of ${context.windowLabel(c)}` : `ctx=window-unknown (${Math.round(c.tokens / 1000)}k tokens, no auto handoff)`);
  if (rec?.retired) parts.push(`handed-off->${rec.retired.by} (h${rec.retired.n}, pane open)`);
  else if (PENDING.has(rec?.handoff?.state)) parts.push(`handoff=${rec.handoff.state} ${rec.handoff.note}`);
  else if (rec?.handoff?.state === "failed") parts.push(`handoff=failed [${rec.handoff.reason}]`);
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
  return { ...job, workers, inboxPending: inbox.pendingCounts(jobDir(job.repo, job.id)) };
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

// A builder's results/<name>.json, parsed, or null (missing, too big, unreadable).
function builderResult(dir, worker) {
  const path = join(dir, "results", `${worker.name}.json`);
  if (!existsSync(path)) return null;
  try {
    const size = statSync(path).size;
    if (size > FILE_READ_MAX) return null;
    return JSON.parse(readCapped(path, size).text);
  } catch {
    return null;
  }
}

function workerOk(dir, worker, files) {
  if (worker.role === "verifier") return files.verifierSkipped == null && files.verifier?.verdict === "pass";
  const data = builderResult(dir, worker);
  // The builder's own gate run rides along for the digest; a result without "gates" is from an older worker.
  if (Array.isArray(data?.gates)) files.gates[worker.name] = data.gates;
  return data?.ok === true;
}

function collectDigestFiles(repo, job) {
  const dir = jobDir(repo, job.id);
  const files = { notes: {}, ok: {}, gates: {}, stateDir: brand.stateDirName(repo) };
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
  if (job.status === "running") recordBrowserPids(repo, job);
  const text = renderDigest(digestView(job), collectDigestFiles(repo, job));
  process.stdout.write(text.length < DIGEST_MAX ? `${text}\n` : text);
}

// A running job's steer goes through the inbox: delivered now when the target is idle, else by its
// hook at the next tool call (or by the watcher once it is idle). --to <worker>: a worker's inbox.
function steerInbox(repo, job, target, message) {
  const id = job.id;
  const dir = jobDir(repo, id);
  const lead = target === "orchestrator";
  const rec = lead ? job.lead : (job.workers || []).filter((w) => w.name === target && !w.retired).at(-1);
  if (!lead && !rec) fail(`job ${id} has no live worker named ${target}`);
  const name = lead ? job.agent : rec.name;
  const from = brand.env("JOB") ? "orchestrator" : "olaf";
  const text = lead ? steerText(renderDigest(digestView(job), collectDigestFiles(repo, job)), message) : `orka inbox: a message for you from the ${from}:\n${message}`;
  const status = agentStatus(name);
  if (lead && status === "unknown" && !agentExists(name)) fail(paneGone(id, "not steered"));
  const file = inbox.enqueue(dir, target, { from, message, text });
  let delivery = "inbox";
  let reason = "";
  if (!PENDING.has(rec?.handoff?.state) && context.SAFE_STATUSES.includes(status)) {
    const entries = inbox.claim(dir, target, "orka steer");
    if (entries.length) {
      const sent = promptWithRetry(name, inbox.deliveryText(entries), { readyStatuses: context.SAFE_STATUSES });
      // A prompt that never started the agent may still sit in its input box: not re-queued, so it is
      // never sent twice. The failure is recorded and reported, as before the inbox.
      delivery = sent.ok ? "delivered" : "failed";
      reason = sent.ok ? "" : sent.reason;
    }
  }
  const now = new Date().toISOString();
  job.steers = job.steers || [];
  job.steers.push({ at: now, message, ...(lead ? {} : { to: target }), from, delivery, file, ...(reason ? { deliveryReason: reason } : {}) });
  if (delivery === "failed") {
    save(repo, job);
    fail(`steer not delivered: ${reason}`);
  }
  if (lead) job.steered = now;
  job.updated = now;
  save(repo, job);
  appendDecision(repo, id, ["steer", `steer ${target}`, message.slice(0, 200), file, delivery === "delivered" ? `delivered to idle ${name}` : `in the inbox (${status}); its hook delivers it at the next tool call, the watcher once it is idle`]);
  console.log(delivery === "delivered" ? `steered ${id}${lead ? "" : ` (${target})`}` : `steer for ${target} queued in the inbox (${name} is ${status}); delivered at its next tool call, or by the watcher once idle`);
}

function cmdSteer(args) {
  allowFlags(args, ["cwd", "to"]);
  const id = args._[1];
  const message = args._.slice(2).join(" ").trim();
  if (!id || !message) fail('need: orka steer <id> [--to <worker>] "message"');
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (args.to !== undefined) {
    if (typeof args.to !== "string" || !args.to.trim()) fail("--to needs a worker name");
    if (job.status !== "running") fail(`${id} is ${job.status}; a worker steer needs a running job`);
    return steerInbox(repo, job, String(args.to).trim(), message);
  }
  if (job.status === "running" && job.agent) return steerInbox(repo, job, "orchestrator", message);
  const finished = FINISH_STATUSES.has(job.status);
  const awaiting = job.status === AWAITING;
  const inReview = job.status === REVIEW;
  if ((job.status !== "running" && !finished && !awaiting && !inReview) || !job.agent) fail(`${id} is ${job.status}; not steered`);
  // A finished job can be steered while its orchestrator pane is still open:
  // that starts a follow-up round, and the next orka done sends the wake again.
  if (finished && (job.workspaceClosed || !agentExists(job.agent))) {
    fail(`${id} is ${job.status} and its orchestrator pane is gone; not steered`);
  }
  if ((awaiting || inReview) && !agentExists(job.agent)) fail(paneGone(id, "not steered"));
  if (finished) restoreWorktree(repo, job);
  const digest = renderDigest(digestView(job), collectDigestFiles(repo, job));
  // At the gate a steer revises the plan: the orchestrator rewrites approach.md and proposes again.
  // In review a steer is a change request: the job runs again and comes back through orka review.
  const text = awaiting
    ? `Direction gate: Olaf asks you to revise the approach, not to build yet.\n${message}\nUpdate ${join(jobDir(repo, id), "approach.md")} (Outcome / Scope / Boundaries / Proof), run orka propose ${id} again, and wait.`
    : inReview
      ? `Review: Olaf asks for changes before he signs off. No sign-off yet; do not run orka done.\n${message}\nMake the changes (workers, then the verifier again), rewrite summary.txt, run orka review ${id} again, and wait.`
      : message;
  const sent = promptWithRetry(job.agent, steerText(digest, text), awaiting || inReview ? { readyStatuses: GATE_READY } : {});
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
  if (awaiting) {
    job.status = "running";
    job.gate = { ...job.gate, state: "revising" };
    appendDecision(repo, id, ["gate", "steer: revise the approach", message, "approach.md", "revising"]);
  }
  if (inReview) {
    job.status = "running";
    delete job.signoff;
    appendDecision(repo, id, ["review", "steer: changes requested", message, "orka steer", "running"]);
  }
  save(repo, job);
  if (finished) startWatcher(repo, job);
  if (finished) console.log(`steered ${id} (follow-up round ${job.round}; it comes back through orka review)`);
  else if (awaiting) console.log(`steered ${id} (direction gate: revising the approach; it proposes again)`);
  else if (inReview) console.log(`steered ${id} (review: changes requested; running again, it comes back through orka review)`);
  else console.log(`steered ${id}`);
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
  const live = LIVE_STATUSES.has(job.status);
  if (args["dry-run"]) {
    if (!live && job.status !== "queued") {
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
  if (!live && job.status !== "queued") {
    console.log(`${id} is already ${job.status}`);
    return;
  }
  let how = "recorded";
  if (live) {
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

// First evidence line per failing check, from this job's verifier result files (current and archived rounds).
function checkEvidence(repo, job) {
  const dir = join(jobDir(repo, job.id), "results");
  const out = {};
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^verifier(\.round-\d+)?\.json$/.test(f)).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const data = JSON.parse(readCapped(join(dir, f), VERIFIER_JSON_MAX).text);
      for (const { check, evidence } of entryList(data.failures, false)) if (!out[check] && evidence) out[check] = String(evidence).slice(0, 80);
    } catch {}
  }
  return out;
}

// orka done on a spec'd job: append the lessons (rejected approaches, steers, failed and pre-existing
// checks, a give-up reason) to "## Lessons" in the spec and commit that file on the job branch.
// Never on main: it only writes in the job worktree, and only while it is on the job's own branch.
function appendSpecLessons(repo, job, { dry = false } = {}) {
  if (!job.spec?.path) return;
  const say = (msg) => console.log(`lessons: ${msg}`);
  const wt = job.worktree;
  if (!wt || !existsSync(wt)) return say("skipped (no job worktree)");
  const branch = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch !== brand.jobBranch(job)) return say(`skipped (worktree is on ${branch || "no branch"}, not ${brand.jobBranch(job)}; lessons are written on the job branch only)`);
  const path = join(wt, job.spec.path);
  if (!existsSync(path)) return say(`skipped (${job.spec.path} is not on the job branch)`);
  const rows = decisionRows(repo, job.id).map((row) => row.split("\t"));
  const lessons = specs.collectLessons({ job, rows, evidence: checkEvidence(repo, job) });
  if (!lessons.length) return say("none to add");
  // L0 is read-only: the commit would be refused, and a written but uncommitted spec would dirty the worktree.
  const { level } = autonomy.readLevel(repo);
  if (!autonomy.allows(level, "commit").ok) {
    if (!dry) appendDecision(repo, job.id, ["lessons", `${lessons.length} not written`, `repo at autonomy ${level}, read-only`, "-", "skipped"]);
    return say(`skipped (${lessons.length} found; the repo is at autonomy ${level}, read-only: no lessons commit)`);
  }
  const before = readFileSync(path, "utf8");
  const merged = specs.mergeLessons(before, lessons, { date: new Date().toISOString().slice(0, 10), jobId: job.id });
  if (!merged.added && !merged.bumped) return say(`${lessons.length} already in ${job.spec.path}`);
  const counts = `${merged.added} added, ${merged.bumped} seen again${merged.compressed ? `, ${merged.compressed} folded (over ${specs.LESSONS_MAX_LINES} lines)` : ""}`;
  if (dry) return say(`would update ${job.spec.path} on ${branch}: ${counts}`);
  writeFileSync(path, merged.text);
  git(wt, ["add", "--", job.spec.path]);
  const committed = git(wt, ["commit", "-q", "-m", `Spec lessons: ${job.spec.feature || job.spec.path} (job ${job.id})`, "--", job.spec.path]);
  const sha = committed.code === 0 ? git(wt, ["rev-parse", "--short", "HEAD"]).out : "";
  job.lessons = { at: new Date().toISOString(), added: merged.added, bumped: merged.bumped, compressed: merged.compressed, commit: sha || null };
  save(repo, job);
  appendDecision(repo, job.id, ["lessons", `${counts} in ${job.spec.path}`, "orka done on a spec'd job", sha || "not committed", committed.code === 0 ? "committed" : `commit failed: ${committed.err.slice(0, 120)}`]);
  say(committed.code === 0 ? `${counts} in ${job.spec.path}, committed ${sha} on ${branch}` : `${counts} in ${job.spec.path}, written but NOT committed (${committed.err.split("\n")[0] || "git commit failed"})`);
}

function verifierFailReason(rounds, blocking = []) {
  const checks = [...new Set(blocking.map((b) => b.check))];
  return `verifier failed after ${rounds} round${rounds === 1 ? "" : "s"}${checks.length ? `: ${checks.join(", ")}` : ""}`;
}

// Olaf's sign-off (orka approve on a job in review) for the current round.
const signedOff = (job) => Boolean(job.signoff) && job.signoff.round === roundOf(job);

function noSignoff(job) {
  const id = job.id;
  const give = `To stop without a result: orka done ${id} --give-up "<reason>" (or orka stop ${id}).`;
  if (job.status === REVIEW) return `no sign-off from Olaf yet; the job is in ${REVIEW}, waiting for orka approve ${id}. ${give}`;
  return `no sign-off from Olaf. Run orka review ${id} (status ${REVIEW}; Olaf is notified) and wait for orka approve ${id}. ${give}`;
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
  if (job.status === AWAITING) fail(`orka done: ${id} is waiting at the direction gate; orka approve ${id}, orka steer ${id} "...", or orka stop ${id}`);
  const terminal = job.status !== "running" && job.status !== REVIEW;
  const unsigned = !terminal && !giveUp && !signedOff(job) ? noSignoff(job) : "";
  if (args["dry-run"]) {
    if (terminal) {
      console.log(`dry-run done ${id}: already ${job.status}; no status change; no finish webhook`);
      return;
    }
    if (unsigned) {
      console.log(`dry-run done ${id}: REFUSED, ${unsigned}`);
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
    appendSpecLessons(repo, view, { dry: true });
    releaseJob(repo, job, { dryRun: true, keep: args.keep });
    releaseJob(repo, job, { dryRun: true, keep: args.keep, status: failing ? "failed" : "done" });
    return;
  }
  if (terminal) {
    console.log(`${id} is already ${job.status}`);
    return;
  }
  // An environment block is the more useful answer than a missing sign-off.
  const early = giveUp ? null : computeVerifier(repo, job) || job.verifier;
  if (early?.verdict === "blocked") {
    console.error(`orka done: ${id} not marked done. ${verifierLine({ ...job, verifier: early })}. Fix what orka doctor ${id} reports and re-run the verifier, or: orka done ${id} --give-up "<reason>".`);
    process.exitCode = 1;
    return;
  }
  if (unsigned) {
    console.error(`orka done: ${id} not marked done: ${unsigned}`);
    process.exitCode = 1;
    return;
  }
  const verifier = recordVerifier(repo, job);
  if (!giveUp && verifier?.verdict === "pass" && verifier.stale) {
    console.error(`orka done: ${id} not marked done. ${verifierLine(job)}; the verifier pass no longer describes the code. Re-run the verifier (orka worker --job ${id} --name ${VERIFIER_NAME} --role verifier --task "..."), then run orka done again. To stop without a verified result: orka done ${id} --give-up "<reason>".`);
    process.exitCode = 1;
    return;
  }
  if (!giveUp && verifier?.verdict === "blocked") {
    console.error(`orka done: ${id} not marked done. ${verifierLine(job)}. Fix what orka doctor ${id} reports and re-run the verifier, or: orka done ${id} --give-up "<reason>".`);
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
  try {
    appendSpecLessons(repo, job);
  } catch (err) {
    console.log(`lessons: failed (${err?.message || err}); the job status stands`);
  }
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
function reapWatchers(repo, jobs, dry, log = console.log) {
  const orphans = watch.selectOrphanWatchers(watch.listWatchers(), { repo, jobs, exists: (p) => Boolean(p) && existsSync(p) });
  for (const o of orphans) {
    log(`cleanup: ${dry ? "would kill" : "killed"} orphan watcher pid ${o.pid} (${o.jobId}, ${o.why})`);
    if (dry || brand.env("FAKE_WATCHERS")) continue;
    try {
      process.kill(o.pid, "SIGTERM");
    } catch {
      // gone already
    }
  }
  return orphans.length;
}

// One pass over this repo's finished jobs: their browser sessions and browser
// processes, orphan watchers, the worktrees of done jobs (the branch stays),
// then the workspaces idle longer than the threshold. Returns how many things it
// closed, orphan agent-browser Chrome no job owns included.
// Only orka cleanup runs it: orka new and orka run never sweep other jobs.
function sweep(repo, { dry = false, thresholdMs, log = console.log, budgetMs = CLEANUP_BUDGET_MS, orphanMinAgeMs = ORPHAN_BROWSER_HOURS * 3600000 } = {}) {
  const verb = dry ? "would close" : "closed";
  const jobs = loadAllJobs(repo);
  const live = jobs.filter((j) => LIVE_STATUSES.has(j.status));
  const now = Date.now();
  let count = 0;
  const workspaces = jobs.filter((j) => lifecycle.isStale(j, now, thresholdMs));
  const names = new Set();
  for (const s of [...browserList(), ...jobs.flatMap((j) => j.browserSessions || [])]) {
    const owner = jobs.find((j) => s.startsWith(`${browserPrefix(j)}-`) || s === legacyVerifySession(j));
    if (owner && !live.includes(owner) && !owner.keep) names.add(s);
  }
  // Dead-daemon sessions of any name.
  for (const s of orphanSessions()) names.add(s);
  const deadline = Date.now() + budgetMs;
  for (const s of names) {
    if (Date.now() > deadline) {
      log(`cleanup: time budget spent, skipping browser ${s}`);
      continue;
    }
    if (dry || closeBrowser(s)) {
      log(`cleanup: ${verb} browser ${s}`);
      count++;
    }
  }
  // Leftover browser processes of this repo's finished jobs (tagged ORKA_JOB/ORCA_JOB,
  // or named by session), then orphan agent-browser Chrome nobody owns.
  const finished = jobs.filter((j) => !LIVE_STATUSES.has(j.status) && j.status !== "queued" && !j.keep);
  const scan = browsers.scanBrowsers();
  const doomed = new Set();
  const procs = [
    ...browsers.selectReap(scan, { finishedJobIds: finished.map((j) => j.id) }),
    ...finished.flatMap((j) => browsers.selectReap(scan, { prefix: browserPrefix(j) })),
  ].filter((p) => !doomed.has(p.pid) && doomed.add(p.pid));
  count += killBrowserProcs(procs, dry, log).length;
  // Browsers whose job or pane no longer exists (by tag, session or process cwd),
  // then recorded pids of finished jobs and of gone panes.
  const panes = live.length ? livePaneIds() : null;
  const gone = browsers.selectGone(scan.filter((p) => !doomed.has(p.pid)), { jobs, prefixOf: browserPrefix, worktreesRoot: join(brand.stateDir(repo), "worktrees"), livePanes: panes });
  const goneWorker = (j, name) => {
    const w = (j.workers || []).filter((x) => x.name === name).at(-1);
    return Boolean(w && (w.closed || (panes && w.pane && !panes.has(w.pane))));
  };
  for (const j of jobs) {
    if (j.keep) continue;
    const records = readBrowserPids(repo, j.id).filter((r) => !LIVE_STATUSES.has(j.status) || goneWorker(j, r.worker));
    if (j.status !== "queued" && records.length) gone.push(...browsers.selectRecorded(scan.filter((p) => !doomed.has(p.pid)), records));
  }
  const goneProcs = gone.filter((p) => !doomed.has(p.pid) && doomed.add(p.pid));
  for (const p of goneProcs) log(`cleanup: browser pid ${p.pid} has no owner left (${p.why})`);
  count += killBrowserProcs(goneProcs, dry, log).length;
  const orphanProcs = browsers.selectOrphans(scan.filter((p) => !doomed.has(p.pid)), {
    minAgeMs: orphanMinAgeMs,
    liveJobIds: live.map((j) => j.id),
    livePrefixes: live.map(browserPrefix),
  });
  if (orphanProcs.length) log(`cleanup: ${orphanProcs.filter((p) => p.chromeRoot).length} orphan agent-browser Chrome root(s) older than ${orphanMinAgeMs / 3600000}h, no running job`);
  count += killBrowserProcs(orphanProcs, dry, log).length;
  count += reapWatchers(repo, jobs, dry, log);
  let freedKb = 0;
  for (const j of jobs.filter(lifecycle.removableWorktree)) {
    const got = removeWorktree(repo, j, { dry, log });
    if (got.kb) {
      count++;
      freedKb += got.kb;
    }
  }
  if (freedKb) log(`cleanup: ${dry ? "would free" : "freed"} ${lifecycle.formatKb(freedKb)} of done-job worktrees`);
  for (const j of workspaces) {
    log(`cleanup: ${verb} workspace ${j.workspace} (${j.id}, idle since ${new Date(lifecycle.lastActivity(j) || 0).toISOString()})`);
    count++;
  }
  // Claude scratch folders of jobs whose workspace is closed, or closes in this pass.
  const scratch = jobs.filter((j) => j.workspaceClosed || workspaces.includes(j)).map((j) => ({ job: j, dir: claudeScratchOf(repo, j) })).filter((s) => s.dir && existsSync(s.dir));
  count += scratch.length;
  if (!count) log("cleanup: nothing to close");
  if (dry) {
    for (const s of scratch) log(`cleanup: would remove Claude scratch ${s.dir} (${lifecycle.formatKb(diskKb(s.dir))}, ${s.job.id})`);
    return count;
  }
  for (const j of workspaces) {
    // The record first: closing the workspace kills any pane in it.
    j.workspaceClosed = new Date().toISOString();
    save(repo, j);
    herdr(["workspace", "close", j.workspace]);
  }
  for (const s of scratch) removeClaudeScratch(repo, s.job, s.dir, log);
  return count;
}

// Claude Code's scratch root: <tmpdir>/claude-<uid>, or ORKA_CLAUDE_TMP (tests point it at a sandbox).
function claudeScratchRoot() {
  return brand.env("CLAUDE_TMP") || join(tmpdir(), `claude-${process.getuid()}`);
}

// The scratch folder of a finished, non-kept job's own worktree (under the state dir), or null.
function claudeScratchOf(repo, job) {
  if (job.keep || LIVE_STATUSES.has(job.status) || job.status === "queued" || !job.worktree) return null;
  if (!resolve(job.worktree).startsWith(resolve(brand.stateDir(repo), "worktrees") + sep)) return null;
  return lifecycle.claudeScratchDir(job.worktree, claudeScratchRoot());
}

// Removes a job's Claude scratch folder once no process works in it or in the worktree.
// Panes of a just-closed workspace get a few seconds to exit; one still running keeps the folder.
function removeClaudeScratch(repo, job, dir, log) {
  const users = () => [...lifecycle.findWorktreeProcesses(job.worktree), ...lifecycle.findWorktreeProcesses(dir)];
  let busy = users();
  for (let i = 0; i < 20 && busy.length; i++) {
    sleep(250);
    busy = users();
  }
  if (busy.length) {
    log(`cleanup: kept Claude scratch ${dir} (pid ${busy[0].pid} still works in it: ${busy[0].cmdline.slice(0, 60)})`);
    return false;
  }
  const kb = diskKb(dir);
  rmSync(dir, { recursive: true, force: true });
  job.scratchRemoved = new Date().toISOString();
  save(repo, job);
  log(`cleanup: removed Claude scratch ${dir} (${lifecycle.formatKb(kb)}, ${job.id})`);
  return true;
}

// orka doctor (lib/doctor.mjs, docs/doctor.md): this host's probes. Read-only.
function doctorChecks(repo, job = null) {
  const env = { ...process.env, PATH: pathPrefix() };
  const which = (cmd) => {
    const r = spawnSync("sh", ["-c", `command -v ${q(cmd)}`], { encoding: "utf8", env });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const nodeVersion = () => spawnSync("node", ["--version"], { encoding: "utf8", env }).stdout?.trim() || "";
  const checks = [...doctor.cliChecks({ which }), doctor.nodeCheck({ nodeVersion })];
  const wt = job?.worktree && existsSync(job.worktree) ? job.worktree : null;
  checks.push(doctor.depsCheck({ repo, worktree: wt, plan: wt ? deps.planDeps(repo, wt) : null, jobId: job?.id }));
  if (job && (Array.isArray(job.ports) ? job.ports.length : job.port != null)) checks.push(...doctor.portChecks(portUsers(job)));
  let disk = null;
  try {
    const st = statfsSync(repo);
    disk = { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    disk = null;
  }
  checks.push(doctor.diskCheck(disk));
  checks.push(doctor.memoryCheck(guard.memAvailableMb(browsers.procRootOf()), guardLimitsOf(repo).minAvailableMb));
  if (!job || job.kind !== "pi") checks.push(doctor.trustCheck({ repo, claudeJson: join(homedir(), ".claude.json") }));
  const live = loadAllJobs(repo).filter((j) => j.status === "running");
  const orphans = browsers.selectOrphans(browsers.scanBrowsers(), { minAgeMs: ORPHAN_BROWSER_HOURS * 3600000, liveJobIds: live.map((j) => j.id), livePrefixes: live.map(browserPrefix) });
  checks.push(doctor.chromeCheck(orphans.filter((p) => p.chromeRoot).map((p) => p.pid)));
  return checks;
}

// The process listening on each of the job's ports, from ss; "" when free. null when ss is missing.
function portUsers(job) {
  const list = Array.isArray(job.ports) && job.ports.length ? job.ports : [job.port];
  return list.map((port) => {
    const r = spawnSync("ss", ["-Hltnp", `sport = :${port}`], { encoding: "utf8" });
    const line = r.status === 0 ? r.stdout.trim().split("\n")[0] || "" : "";
    const user = line ? (/users:\(\("([^"]+)",pid=(\d+)/.exec(line)?.slice(1).join(" pid ") || "listening") : "";
    return { port, user };
  });
}

// Runs the checks for a job, records them (job.doctor, decisions.tsv) and returns the summary.
function runDoctor(repo, job, { why = "orka doctor --job", verifierRound, quiet = false } = {}) {
  const checks = doctorChecks(repo, job);
  const s = doctor.summary(checks);
  const at = new Date().toISOString();
  const fixes = checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.fix}`);
  job.doctor = { at, why, ok: s.ok, failed: s.failed, warnings: s.warnings, fixes: fixes.slice(0, 6), ...(verifierRound ? { verifierRound } : {}) };
  save(repo, job);
  appendDecision(repo, job.id, ["doctor", why, s.ok ? `ok${s.warnings.length ? `; warnings: ${s.warnings.join(", ")}` : ""}` : `failed: ${s.failed.join(", ")}`, fixes.join(" | ").slice(0, 600), s.ok ? "ok" : `${s.failed.length} failed`]);
  if (!quiet) console.error(`orka doctor (${why}):\n${doctor.render(checks)}`);
  return { checks, ...s };
}

function cmdDoctor(args) {
  allowFlags(args, ["cwd", "job", "fix"]);
  const repo = requireRepo(args.cwd || process.cwd());
  const job = args.job ? load(repo, String(args.job)) : null;
  if (args.fix) {
    if (!job) fail("--fix needs --job <id>: it only repairs that job's worktree (node_modules link); system packages and Claude's trust stay for you");
    setupDeps(repo, job);
    save(repo, job);
  }
  console.log(`orka doctor ${repo}${job ? ` job ${job.id}` : ""}`);
  const checks = job ? runDoctor(repo, job, { why: `orka doctor --job${args.fix ? " --fix" : ""}`, quiet: true }).checks : doctorChecks(repo);
  console.log(doctor.render(checks));
  if (!doctor.summary(checks).ok) process.exitCode = 1;
}

// A pane that did not start (or never took its prompt): run the doctor once and say what it found.
function doctorOnStartFailure(repo, job, what) {
  try {
    const got = runDoctor(repo, job, { why: `${what} did not start`, quiet: true });
    return got.ok ? "orka doctor found nothing wrong with the environment" : `orka doctor: ${got.failed.join(", ")} failed (${job.doctor.fixes.join(" | ").slice(0, 400)})`;
  } catch (err) {
    return `orka doctor could not run: ${err?.message || err}`;
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
  const pids = reapWorker(job, worker, Boolean(args["dry-run"]));
  if (!pids.length) console.log("reap: no browser processes left");
}

// Closes the sessions and kills (after recording) the browser processes of one worker, or of the whole job.
function reapWorker(job, worker, dry = false) {
  const sessions = jobSessions(job).filter((s) => !worker || s === `${browserPrefix(job)}-${worker}`);
  for (const s of sessions) if (dry || closeBrowser(s, { jobId: job.id })) console.log(`cleanup: ${dry ? "would close" : "closed"} browser ${s}`);
  return reapBrowsers(job, { worker, dry });
}

// The watcher's per-poll housekeeping for a running job: record its browser pids,
// and when the verifier wrote a new results/verifier.json (its round is over),
// kill that verifier's Chrome. The result present at watcher start is not a new round.
function watchTick(repo, id) {
  const mtime = () => {
    try {
      return statSync(verifierResultPath(repo, id)).mtimeMs;
    } catch {
      return 0;
    }
  };
  let seen = mtime();
  return (job) => {
    if (!job || job.status !== "running") return;
    recordBrowserPids(repo, job);
    const now = mtime();
    if (!now || now === seen) return;
    seen = now;
    const verifier = (job.workers || []).filter((w) => w.role === "verifier").at(-1);
    if (!verifier) return;
    console.log(`${new Date().toISOString()} watch ${id}: verifier ${verifier.name} wrote its result; reaping its browsers`);
    reapWorker(job, verifier.name);
  };
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
    tick: () => {
      wakeTick(repo, id, { log });
      handoffTick(repo, id, { log });
    },
    busy: () => handoffBusy(repo, id),
    post: async (payload) => {
      const cfg = readFinishConfig(repo);
      if (cfg.off) return log("no finish webhook configured; needs-input not sent");
      if (cfg.error) return log(`finish webhook config invalid (${cfg.error}); needs-input not sent`);
      const sent = await postFinish(cfg, payload);
      log(`needs-input ${payload.status}: ${sent.outcome} (${sent.detail})`);
    },
    log,
    housekeep: watchTick(repo, id),
  };
  log(`watching agent ${job.agent} pane ${job.pane}`);
  const result = await watch.watchJob({ jobId: id, agent: job.agent, pane: job.pane, deps, busyMs: handoffSettingsOf(repo).busyPollMs });
  log(`exit: ${result.exit}`);
}

function cmdSpec(args) {
  allowFlags(args, ["cwd"]);
  const sub = args._[1];
  if (sub !== "init") fail("need: orka spec init <feature>");
  const feature = specs.assertFeature(args._[2]);
  const { top } = gitMeta(args.cwd || process.cwd());
  const rel = specs.specRelPath(feature);
  const path = join(top, rel);
  if (existsSync(path)) fail(`${rel} already exists`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, specs.specTemplate(feature));
  console.log(`created ${path}`);
  console.log(`fill What, Why, Limits and Done when, commit it, then: orka new --spec ${rel}`);
}

function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
}

// main and master, plus origin's HEAD branch when it names another.
function mainBranches(repo) {
  const set = new Set(autonomy.MAIN_BRANCHES);
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out) set.add(head.out.replace(/^origin\//, ""));
  return [...set];
}

// The repo's main branch: the first of mainBranches that exists locally.
function mainOf(repo) {
  return mainBranches(repo).find((b) => git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`]).code === 0) || "main";
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function cmdAutonomy(args) {
  allowFlags(args, ["cwd", "hook", "stdin", "job"]);
  const sub = args._[1] || "show";
  const cwd = args.cwd || process.cwd();
  const repo = requireRepo(cwd);
  if (sub === "show") {
    const { level, source } = autonomy.readLevel(repo);
    console.log(`autonomy: ${level} (${autonomy.LEVEL_TEXT[level]}) for ${repo}`);
    console.log(`source: ${source === "default" ? `default (no entry in ${autonomy.configFile()})` : source}`);
    for (const l of autonomy.LEVELS) console.log(`  ${l === level ? "*" : " "} ${l}  ${autonomy.LEVEL_TEXT[l]}`);
    return;
  }
  if (sub === "set") {
    const level = String(args._[2] || "").toUpperCase();
    if (!autonomy.LEVELS.includes(level)) fail(`need: orka autonomy set <${autonomy.LEVELS.join("|")}>`);
    if (brand.env("JOB")) fail("orka autonomy set is refused inside a job pane (ORKA_JOB is set); Olaf sets levels from his own shell");
    const path = autonomy.writeLevel(repo, level);
    console.log(`autonomy: ${repo} set to ${level} (${autonomy.LEVEL_TEXT[level]}) in ${path}`);
    return;
  }
  if (sub === "check") {
    // Called by the guard hooks. Exit 0 allows. A refusal prints why on stderr, is logged to the job's decisions.tsv, and exits 1.
    const action = args._[2];
    if (!action) fail("need: orka autonomy check <action>");
    const jobId = flagValue(args, "job") || brand.env("JOB") || "";
    const branch = currentBranch(cwd);
    const mains = mainBranches(repo);
    let actions = [action];
    if (action === "push" && args.stdin) actions = autonomy.pushActions(readStdin(), mains);
    else if (action === "commit" && mains.includes(branch)) actions = ["commit-main"];
    // A merge commit on a job branch is a branch commit; on main it is landing.
    else if (action === "merge") actions = [mains.includes(branch) ? "merge" : "commit"];
    for (const a of actions) requireLevel(repo, a, { jobId, evidence: `${args.hook || "check"} on ${branch || "?"} in ${cwd}` });
    return;
  }
  fail("need: orka autonomy [show] | set <L0|L1|L2|L3> | check <action>");
}

// L2: push the job branch to origin, and with --pr open a PR for it.
function cmdPush(args) {
  allowFlags(args, ["cwd", "dry-run", "pr"]);
  const id = args._[1];
  if (!id) fail("need: orka push <id> [--pr]");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  const branch = brand.jobBranch(job);
  const level = requireLevel(repo, args.pr ? "pr" : "push", { jobId: id, evidence: `orka push ${id}${args.pr ? " --pr" : ""}` });
  if (git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code !== 0) fail(`branch ${branch} does not exist`);
  const base = mainOf(repo);
  if (args["dry-run"]) {
    console.log(`dry-run push ${id} (autonomy ${level}): git push -u origin ${branch}${args.pr ? `; gh pr create --head ${branch} --base ${base}` : ""}`);
    return;
  }
  const pushed = git(repo, ["push", "-u", "origin", `${branch}:${branch}`]);
  if (pushed.code !== 0) fail(`git push failed:\n${(pushed.err || pushed.out).slice(0, 800)}`);
  appendDecision(repo, id, ["autonomy", `pushed ${branch}`, `repo at ${level}`, "git push -u origin", "ok"]);
  console.log(`pushed ${branch} to origin`);
  if (!args.pr) return;
  const r = spawnSync("gh", ["pr", "create", "--head", branch, "--base", base, "--title", job.title, "--body", summaryOf(repo, job) || String(job.goal).slice(0, 2000)], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: pathPrefix() }, timeout: 120000 });
  if (r.error || r.status !== 0) fail(`gh pr create failed:\n${String(r.stderr || r.error?.message || "").slice(0, 800)}`);
  appendDecision(repo, id, ["autonomy", `opened PR for ${branch}`, `repo at ${level}`, r.stdout.trim().slice(0, 200), "ok"]);
  console.log(r.stdout.trim());
}

const LAND_TEST_TIMEOUT_MS = 1800000;

function hasTestScript(dir) {
  try {
    return Boolean(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.test);
  } catch {
    return false;
  }
}

// L3: merge --no-ff the job branch into main in the primary checkout, run npm test when the repo has one
// (twice before giving up, to rule out a flaky run), commit, and with push push main. Aborts the merge on
// a conflict or red tests. Throws an orka error with the reason.
// chainAuto: orka chain --signoff auto merges locally at any level (Olaf's decision, 2026-10-23);
// pushing main still needs L3.
function landJob(repo, job, { push = false, log = console.log, chainAuto = false } = {}) {
  const branch = brand.jobBranch(job);
  const base = mainOf(repo);
  const evidence = chainAuto ? `orka chain --signoff auto ${job.id}` : `orka land ${job.id}${push ? " --push" : ""}`;
  if (!chainAuto) requireLevel(repo, "merge", { jobId: job.id, evidence });
  if (push) requireLevel(repo, "push-main", { jobId: job.id, evidence });
  const on = currentBranch(repo);
  if (on !== base) fail(`primary checkout ${repo} is on ${on}, not ${base}; land merges there`);
  if (git(repo, ["diff", "--quiet"]).code !== 0 || git(repo, ["diff", "--cached", "--quiet"]).code !== 0) fail(`${base} has uncommitted tracked changes; land refused`);
  log(`merging ${branch} into ${base}`);
  const merged = git(repo, ["merge", "--no-ff", "--no-commit", branch]);
  if (merged.code !== 0) {
    git(repo, ["merge", "--abort"]);
    const text = `${merged.out}\n${merged.err}`;
    // Only a real conflict is called one: a missing git identity or a dirty file fails here too.
    const why = /CONFLICT/.test(text) ? "merge conflict" : `git merge failed: ${(merged.err || merged.out).split("\n").find((l) => l.trim()) || "unknown error"}`;
    fail(`${why} for ${branch}; merge aborted\n${text.trim().slice(0, 400)}`);
  }
  let tested = "no test script";
  if (hasTestScript(repo)) {
    const out = join(brand.stateDir(repo), "land-test.out");
    let ok = false;
    for (let run = 1; run <= 2 && !ok; run++) {
      const r = spawnSync("npm", ["test"], { cwd: repo, encoding: "utf8", timeout: LAND_TEST_TIMEOUT_MS, env: { ...process.env, PATH: pathPrefix() } });
      writeFileSync(out, `${r.stdout || ""}${r.stderr || ""}`);
      ok = r.status === 0;
      log(`npm test (run ${run}): ${ok ? "green" : "red"}`);
    }
    if (!ok) {
      git(repo, ["merge", "--abort"]);
      fail(`npm test red after merging ${branch}; merge aborted, see ${out}`);
    }
    tested = "npm test green";
  }
  const committed = git(repo, ["commit", "-q", "--no-edit", "-m", `Merge ${branch}: ${job.title}`]);
  if (committed.code !== 0) {
    git(repo, ["merge", "--abort"]);
    fail(`merge commit failed for ${branch}; merge aborted\n${committed.err.slice(0, 400)}`);
  }
  const sha = git(repo, ["rev-parse", "--short", "HEAD"]).out;
  appendDecision(repo, job.id, ["autonomy", `landed ${branch} on ${base}`, `repo at ${autonomy.readLevel(repo).level}`, `${sha}; ${tested}`, "ok"]);
  log(`landed ${branch} on ${base} as ${sha} (${tested})`);
  if (push) {
    const pushed = git(repo, ["push", "origin", base]);
    if (pushed.code !== 0) fail(`git push origin ${base} failed after landing ${sha}\n${(pushed.err || pushed.out).slice(0, 400)}`);
    appendDecision(repo, job.id, ["autonomy", `pushed ${base}`, "after land", sha, "ok"]);
    log(`pushed ${base} to origin`);
  }
  return { sha, tested, pushed: push };
}

function cmdLand(args) {
  allowFlags(args, ["cwd", "dry-run", "push"]);
  const id = args._[1];
  if (!id) fail("need: orka land <id> [--push]");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status !== "done") fail(`job ${id} is ${job.status}; land merges only a done job`);
  if (args["dry-run"]) {
    const level = requireLevel(repo, "merge", { jobId: id, evidence: `orka land ${id} --dry-run` });
    if (args.push) requireLevel(repo, "push-main", { jobId: id, evidence: `orka land ${id} --dry-run` });
    console.log(`dry-run land ${id} (autonomy ${level}): git merge --no-ff ${brand.jobBranch(job)} into ${mainOf(repo)}${hasTestScript(repo) ? ", npm test" : ""}${args.push ? `, git push origin ${mainOf(repo)}` : ""}`);
    return;
  }
  landJob(repo, job, { push: Boolean(args.push) });
}

// orka chain: runs a queue of tasks one job at a time (the old ~/bin/orca-chain, generalised). What happens
// on a verifier pass depends on chain.signoff (docs/autonomy.md): auto (default) merges into main, signs
// off and starts the next task from there; each waits for orka approve, then lands per the autonomy level
// (L0/L1 keep the branch, L2 pushes it and opens a PR, L3 merges, tests and pushes main); end leaves
// every job in review and stacks the next task on its branch. Pushing main always needs L3.
//   queue   <state>/chain-queue    lines "NN [verifier-model]" (tasks/NN-*.md; first line runs next)
//   current <state>/chain-current  "NN job-id attempt verifier-model"
//   log     <state>/chain.log
const CHAIN_POLL_MS = Number(brand.env("CHAIN_POLL_MS")) || 60000;
const CHAIN_RESOURCE_WAIT_MS = Number(brand.env("CHAIN_RESOURCE_WAIT_MS")) || 300000;
const CHAIN_MIN_MEM_MB = Number(brand.env("CHAIN_MIN_MEM_MB") ?? 1200);
const CHAIN_MAX_LOAD = Number(brand.env("CHAIN_MAX_LOAD")) || 6;
const CHAIN_WAIT_WARN_MS = 4 * 3600000;

class ChainStop extends Error {}

function chainPaths(repo) {
  const d = brand.stateDir(repo);
  return { queue: join(d, "chain-queue"), current: join(d, "chain-current"), log: join(d, "chain.log"), lock: join(d, "chain.lock"), stack: join(d, "chain-stack") };
}

function takeChainLock(path) {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && pidAlive(pid)) fail(`orka chain already running (pid ${pid}, lock ${path})`);
    writeFileSync(path, `${process.pid}\n`);
  }
  process.on("exit", () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
    } catch {}
  });
}

function chainGoal(file, attempt, failure) {
  let goal = `Implement task ${basenameOf(file).split("-")[0]} exactly as specified in tasks/${basenameOf(file)} (read it first, and tasks/README.md when it exists). Meet every acceptance criterion in that file; nothing beyond its scope. Earlier tasks are already on main; locate code by function name, not line number.

Wrap-up:
- Tests for the new behaviour; keep the project's tests green.
- Mark the task done in its file (Status: done plus a short Done note: what changed, test counts).
- Commit on the job branch. Do NOT merge and do NOT push: orka chain lands the branch after a verifier pass (chain.signoff and the repo's autonomy level decide how).
- summary.txt: what changed and the test pass/fail counts.

Resources: ONE builder worker at a time plus ONE verifier. No browsers unless the task file asks for them; then one named agent-browser session, closed before reporting.`;
  if (failure) goal += `\n\nRETRY (attempt ${attempt}): the previous job for this task failed. Its failure summary: ${failure}\nStart from main, change the approach that failed, and fix the failing checks.`;
  return goal;
}

const basenameOf = (path) => String(path).split(sep).at(-1);

const CHAIN_MODES = ["auto", "each", "end"];
const CHAIN_MODE_TEXT = {
  auto: "auto: orka signs off a job whose verifier passed, merges it into main and starts the next task from there",
  each: "each: every job stops in review for orka approve",
  end: "end: jobs stop in review without blocking; each task stacks on the previous branch; one review at the end",
};

// One line from the terminal, read synchronously (orka chain asks at most once per repo).
function askLine(question) {
  process.stderr.write(question);
  const buf = Buffer.alloc(256);
  let text = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      break;
    }
    if (!n) break;
    text += buf.subarray(0, n).toString("utf8");
    if (text.includes("\n")) break;
  }
  return text.split("\n")[0].trim().toLowerCase();
}

// chain.signoff in .orka/config.json. --signoff sets and saves it. Unset: ask once on a TTY
// (each / end / auto [auto]); without a TTY use auto, say so once and save it.
function chainSignoff(repo, flag, { dry = false } = {}) {
  const path = configPath(repo);
  const cfg = readRepoConfig(repo);
  const save = (mode) => {
    if (dry) return;
    writeFileSync(path, `${JSON.stringify({ ...cfg, chain: { ...(cfg.chain || {}), signoff: mode } }, null, 2)}\n`);
  };
  if (flag !== undefined) {
    const mode = String(flag).toLowerCase();
    if (!CHAIN_MODES.includes(mode)) fail(`--signoff must be each, end or auto, got ${flag}`);
    if (cfg.chain?.signoff !== mode) save(mode);
    return mode;
  }
  if (CHAIN_MODES.includes(cfg.chain?.signoff)) return cfg.chain.signoff;
  let mode = "auto";
  if (process.stdin.isTTY && !dry) {
    console.error(`orka chain: how should chained jobs be signed off in this repo?\n  ${CHAIN_MODES.map((m) => CHAIN_MODE_TEXT[m]).join("\n  ")}`);
    for (;;) {
      const got = askLine("sign-off: each / end / auto [auto] ");
      if (!got) break;
      if (CHAIN_MODES.includes(got)) {
        mode = got;
        break;
      }
    }
  } else {
    console.error(`orka chain: no chain.signoff set for this repo; using auto (${CHAIN_MODE_TEXT.auto}). Change it with orka chain --signoff each|end|auto, or "chain": {"signoff": ...} in ${path}.`);
  }
  save(mode);
  return mode;
}

async function cmdChain(args) {
  allowFlags(args, ["cwd", "dry-run", "signoff"]);
  const repo = requireRepo(args.cwd || process.cwd());
  const dry = Boolean(args["dry-run"]);
  const p = chainPaths(repo);
  const log = (msg) => {
    const text = `${new Date().toISOString().replace("T", " ").slice(0, 19)}Z ${msg}`;
    console.error(text);
    if (!dry) appendFileSync(p.log, `${text}\n`);
  };
  const self = (argv, timeout) => spawnSync(process.execPath, [ORKA, ...argv, "--cwd", repo], { encoding: "utf8", env: { ...process.env, PATH: pathPrefix() }, timeout });
  const { level } = autonomy.readLevel(repo);
  const mode = chainSignoff(repo, args.signoff, { dry });
  const pushText = level === "L3" ? "push main" : level === "L2" ? "push the job branch" : "no push";
  const onPass = mode === "auto"
    ? `sign off, merge into main (${pushText})`
    : mode === "end"
      ? "leave it in review and stack the next task on its branch"
      : level === "L3" ? "merge into main, test, push main" : level === "L2" ? "push the branch and open a PR" : "keep the branch for review";
  const notify = async (status, message) => {
    log(`NOTIFY [${status}] ${message}`);
    if (dry) return;
    const cfg = readFinishConfig(repo);
    if (cfg.off || cfg.error) return log(`no webhook (${cfg.error || "off"}), skipped`);
    const sent = await postFinish(cfg, { kind: status === "done" ? "orka-chain" : "needs-input", job: "orka-chain", title: `orka chain ${basenameOf(repo)}`, status, question: message, log: p.log });
    log(`webhook ${sent.outcome}${sent.http ? ` http=${sent.http}` : ""}`);
  };
  const stop = async (why) => {
    await notify("blocked", why);
    log(`CHAIN STOPPED: ${why}`);
    throw new ChainStop(why);
  };
  const readJob = (id) => {
    try {
      return JSON.parse(readFileSync(jobPath(repo, id), "utf8"));
    } catch {
      return null;
    }
  };
  const waitResources = async () => {
    for (let waited = 1; ; waited++) {
      let avail = Infinity;
      let load = 0;
      try {
        avail = Math.floor(Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1]) / 1024);
        load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
      } catch {}
      if (avail >= CHAIN_MIN_MEM_MB && load < CHAIN_MAX_LOAD) return log(`resources ok: avail=${avail}MB load=${load}`);
      log(`waiting for resources: avail=${avail}MB (need ${CHAIN_MIN_MEM_MB}) load=${load} (need <${CHAIN_MAX_LOAD})`);
      if (dry) return;
      if (waited === 12) await notify("blocked", `chain waiting >1h for RAM/load (avail=${avail}MB load=${load})`);
      sleep(CHAIN_RESOURCE_WAIT_MS);
    }
  };
  const nextFromQueue = () => {
    if (!existsSync(p.queue)) return "";
    const lines = readFileSync(p.queue, "utf8").split("\n");
    const i = lines.findIndex((l) => l.trim() && !l.trim().startsWith("#"));
    if (i < 0) return "";
    const line = lines[i].trim();
    if (!dry) {
      lines.splice(i, 1);
      writeFileSync(`${p.queue}.tmp`, lines.join("\n"));
      renameSync(`${p.queue}.tmp`, p.queue);
    }
    return line;
  };
  // end mode: the branch the next task stacks on, and the jobs waiting for the one review at the end.
  const stacked = () => (existsSync(p.stack) ? readFileSync(p.stack, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")) : []);
  const startTask = async (nn, vm, attempt, failure = "") => {
    const file = existsSync(join(repo, "tasks")) ? readdirSync(join(repo, "tasks")).find((f) => f.startsWith(`${nn}-`) && f.endsWith(".md")) : null;
    if (!file) {
      log(`task ${nn}: no tasks/${nn}-*.md, skipped`);
      return false;
    }
    const title = `task ${file.replace(/\.md$/, "").replace("-", " ")}`;
    const goal = chainGoal(file, attempt, failure);
    const on = mode === "end" ? stacked().at(-1)?.[1] : "";
    log(`starting task ${nn} (${file}) attempt ${attempt}${vm ? `, verifier ${vm}` : ""}${on ? `, stacked on ${on}` : ""}`);
    if (dry) {
      log(`dry-run: orka new --title '${title}'${vm ? ` --verifier-model ${vm}` : ""}${on ? ` --stack-on ${on}` : ""} --goal <${goal.length} chars>; orka run <id>`);
      return true;
    }
    const models = [["orchestrator-model", brand.env("CHAIN_ORCHESTRATOR_MODEL")], ["worker-model", brand.env("CHAIN_WORKER_MODEL")]].flatMap(([flag, alias]) => (alias ? [`--${flag}`, alias] : []));
    // The task file Olaf wrote is the approved direction: chained jobs skip the direction gate.
    const made = self(["new", "--title", title, "--goal", goal, "--no-gate", ...models, ...(vm ? ["--verifier-model", vm] : []), ...(on ? ["--stack-on", on] : [])]);
    const id = (made.stdout || "").trim().split("\n").find((l) => /^\d{17}-/.test(l));
    if (!id) await stop(`orka new failed for task ${nn} (it is no longer in the queue; re-add the line '${nn}${vm ? ` ${vm}` : ""}' at the top): ${(made.stderr || "").trim().slice(0, 300)}`);
    writeFileSync(p.current, `${nn} ${id} ${attempt} ${vm || "-"}\n`);
    const ran = self(["run", id]);
    appendFileSync(p.log, `${ran.stdout || ""}${ran.stderr || ""}`);
    if (ran.status !== 0) log(`orka run ${id} exited ${ran.status} (job status decides)`);
    log(`task ${nn} running as ${id}`);
    return true;
  };
  // Until the job is finished, or (auto and end) waiting in review.
  const waitSettled = async (id, { review = mode !== "each" } = {}) => {
    const started = Date.now();
    let warned = false;
    for (;;) {
      const job = readJob(id);
      if (!job || FINISH_STATUSES.has(job.status) || (review && job.status === REVIEW) || dry) return job;
      if (!warned && Date.now() - started > CHAIN_WAIT_WARN_MS) {
        warned = true;
        await notify("blocked", `job ${id} still '${job.status}' after 4h of chain waiting`);
      }
      sleep(CHAIN_POLL_MS);
    }
  };
  const failureSummary = (job) => `${String(job?.stopReason || job?.summary || "").slice(0, 600)}; failing checks: ${(job?.verifier?.history?.at(-1)?.failing || []).join(", ")}`;
  const verified = (job) => job?.verifier?.verdict === "pass" && !job.verifier.stale;
  // each: today's landing, as far as the autonomy level allows.
  const land = async (nn, job) => {
    const branch = brand.jobBranch(job);
    if (dry) return log(`dry-run: autonomy ${level}: would ${onPass} for ${branch}`);
    if (level === "L3") {
      try {
        landJob(repo, job, { push: true, log });
      } catch (err) {
        await stop(`land failed for task ${nn} (${branch}): ${err.message}`);
      }
    } else if (level === "L2") {
      const r = self(["push", job.id, "--pr"], 180000);
      if (r.status !== 0) await stop(`push/PR failed for task ${nn} (${branch}): ${(r.stderr || "").trim().slice(0, 400)}`);
      log(`task ${nn}: pushed ${branch}; ${(r.stdout || "").trim().split("\n").at(-1)}`);
    } else {
      appendDecision(repo, job.id, ["autonomy", `chain kept ${branch} for review`, `repo at ${level}; landing needs L2 (push, PR) or L3 (merge)`, "orka chain", "kept"]);
      log(`task ${nn}: verifier pass; kept on ${branch} for review (autonomy ${level}: no push, no merge)`);
    }
  };
  const merged = (job) => git(repo, ["merge-base", "--is-ancestor", brand.jobBranch(job), mainOf(repo)]).code === 0;
  // auto: merge first, so a conflict or a red test leaves the job in review; then sign off and let
  // the orchestrator run orka done; anything done added to the branch (spec lessons) is merged too.
  const autoFinish = async (nn, job) => {
    const branch = brand.jobBranch(job);
    if (dry) return log(`dry-run: would merge ${branch} into ${mainOf(repo)}, sign off ${job.id} (auto), wait for done (${pushText})`);
    try {
      if (!merged(job)) landJob(repo, job, { push: level === "L3", log, chainAuto: true });
    } catch (err) {
      await stop(`task ${nn}: ${branch} not merged (${err.message.split("\n")[0]}); job ${job.id} stays in review for Olaf (orka approve ${job.id}, or orka steer ${job.id} "...")`);
    }
    if (job.status === REVIEW) {
      const sent = approveResult(repo, job, "verifier passed; merged into main by orka chain", { by: "auto" });
      if (!sent.ok) await stop(`task ${nn}: signed off ${job.id} automatically but the orchestrator was not prompted (${sent.reason}); run orka done ${job.id}`);
      const after = await waitSettled(job.id, { review: false });
      if (after?.status !== "done") await stop(`task ${nn}: job ${job.id} ended ${after?.status || "missing"} after the auto sign-off`);
      try {
        if (!merged(after)) landJob(repo, after, { push: level === "L3", log, chainAuto: true });
      } catch (err) {
        await stop(`task ${nn}: the commits orka done added to ${branch} did not merge (${err.message.split("\n")[0]})`);
      }
    }
    if (level === "L2") {
      const r = self(["push", job.id], 180000);
      log(`task ${nn}: ${r.status === 0 ? `pushed ${branch}` : `push of ${branch} failed: ${(r.stderr || "").trim().slice(0, 200)}`}`);
    }
    log(`task ${nn}: ${branch} merged into ${mainOf(repo)}${level === "L3" ? " and pushed" : ""}; the next task starts from there`);
  };

  if (!dry) takeChainLock(p.lock);
  log(`orka chain start (pid ${process.pid}, sign-off ${mode}, autonomy ${level}: on a verifier pass ${onPass}, dry-run=${dry})`);
  try {
    for (;;) {
      const cur = existsSync(p.current) ? readFileSync(p.current, "utf8").trim() : "";
      if (!cur) {
        const line = nextFromQueue();
        if (!line) {
          const waiting = mode === "end" ? stacked() : [];
          const review = waiting.length ? ` ${waiting.length} job(s) wait for one review, oldest first: ${waiting.map(([jid, br]) => `${jid} (${br})`).join(", ")}; orka approve <id> each` : "";
          await notify("done", `orka chain finished: queue empty.${review} See ${p.log}`);
          if (!dry && mode === "end") rmSync(p.stack, { force: true });
          log(`queue empty, chain done${review}`);
          return;
        }
        const [nn, vm] = line.split(/\s+/);
        await waitResources();
        await startTask(nn, vm, 1);
        if (dry) return log("dry-run end");
        continue;
      }
      const [nn, id, attemptText, vmText] = cur.split(/\s+/);
      const attempt = Number(attemptText) || 1;
      const vm = vmText && vmText !== "-" ? vmText : "";
      log(`watching task ${nn} job ${id} (attempt ${attempt})`);
      const job = await waitSettled(id);
      const v = job?.verifier || {};
      log(`task ${nn} job ${id}: status=${job?.status || "missing"} verdict=${v.verdict || "none"} stale=${Boolean(v.stale)}`);
      if (dry) {
        log(`dry-run: on a verifier pass the chain would ${onPass} (sign-off ${mode}, autonomy ${level}), then start the next queue item`);
        return log("dry-run end");
      }
      const passed = (job?.status === "done" || job?.status === REVIEW) && verified(job);
      if (passed && mode === "auto") await autoFinish(nn, job);
      else if (passed && mode === "end") {
        appendFileSync(p.stack, `${job.id} ${brand.jobBranch(job)}\n`);
        appendDecision(repo, job.id, ["chain", "left in review (chain.signoff end)", "the next task stacks on this branch", brand.jobBranch(job), job.status]);
        log(`task ${nn}: ${job.id} ${job.status === REVIEW ? "waits in review" : "is done"}; the next task stacks on ${brand.jobBranch(job)}`);
      } else if (passed) await land(nn, job);
      else {
        const summary = failureSummary(job);
        log(`task ${nn} did not pass: ${summary}`);
        if (attempt < 2) {
          await waitResources();
          writeFileSync(p.current, "");
          await startTask(nn, vm, 2, `status=${job?.status} verdict=${v.verdict || "none"}. ${summary}`);
          continue;
        }
        log(`SKIPPED task ${nn} after 2 failed attempts`);
        await notify("blocked", `task ${nn} skipped after 2 failed attempts (last job ${id}): ${summary}. Chain continues.`);
      }
      writeFileSync(p.current, "");
    }
  } catch (err) {
    if (err instanceof ChainStop) {
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

function readApproach(repo, id) {
  const path = join(jobDir(repo, id), "approach.md");
  if (!existsSync(path)) fail(`no approach.md for ${id}: write ${path} (${APPROACH_FIELDS.map(([, label]) => label).join(" / ")}) first`);
  const text = readCapped(path, FILE_READ_MAX).text.trim();
  if (!text) fail(`${path} is empty`);
  return { path, raw: text, text: text.length > APPROACH_MAX ? `${text.slice(0, APPROACH_MAX)}\n[cut at ${APPROACH_MAX} characters; see ${path}]` : text };
}

// approach.md is the agreement: Outcome / Scope / Boundaries / Proof, one labelled field each. A label is
// "Proof:", "- Proof: ...", "**Proof:**" or a "## Proof" heading; its value runs to the next label.
const APPROACH_FIELDS = [
  ["outcome", "Outcome"],
  ["scope", "Scope"],
  ["boundaries", "Boundaries"],
  ["proof", "Proof"],
];
const PROOF_MAX_LINES = 12;
const PROOF_LINE_MAX = 400;

function approachLabel(line) {
  const m = /^\s*(?:[-*]\s+)?(#{1,6}\s+)?(?:\*\*|__)?(outcome|scope|boundaries|proof)s?(?:\*\*|__)?\s*(:)?\s*(?:\*\*|__)?\s*(:)?\s*(.*)$/i.exec(line);
  if (!m || !(m[1] || m[3] || m[4])) return null;
  return { key: m[2].toLowerCase(), rest: m[5].trim() };
}

function parseApproach(text) {
  const fields = {};
  let key = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const label = approachLabel(line);
    if (label) {
      key = label.key;
      fields[key] = fields[key] || [];
      if (label.rest) fields[key].push(label.rest);
    } else if (key && line.trim()) fields[key].push(line.trim());
  }
  const item = (l) => l.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
  const proof = (fields.proof || []).map(item).filter(Boolean).slice(0, PROOF_MAX_LINES).map((l) => (l.length > PROOF_LINE_MAX ? `${l.slice(0, PROOF_LINE_MAX)}…` : l));
  return { fields, proof, missing: APPROACH_FIELDS.filter(([k]) => !fields[k]?.length).map(([, label]) => label) };
}

// The orchestrator runs this after planning: the job pauses at the gate and Olaf is notified once per proposal.
async function cmdPropose(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need: orka propose <id>");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (!job.gate?.on) fail(`job ${id} has no direction gate (${job.gate?.reason || "filed before the gate"}); build it`);
  if (job.gate.state === "approved") fail(`job ${id}: the approach is already approved; build it`);
  if (job.status === AWAITING) fail(`job ${id} is already awaiting direction; wait for orka approve or orka steer`);
  if (job.status !== "running") fail(`job ${id} is ${job.status}, not running`);
  const approach = readApproach(repo, id);
  const shape = parseApproach(approach.raw);
  // Warned, not refused: a job planned on the older What / How / Files / Risks template still proposes.
  if (shape.missing.length) console.error(`warning: ${approach.path} has no ${shape.missing.join(", ")} field; the approach is ${APPROACH_FIELDS.map(([, label]) => `${label}:`).join(" ")} (see the DIRECTION GATE block). Proposed anyway.`);
  const payload = {
    kind: AWAITING,
    job: job.id,
    title: job.title,
    status: AWAITING,
    branch: brand.jobBranch(job),
    approach: approach.text,
    question: `Direction for "${job.title}"? Approve: orka approve ${job.id}. Revise: orka steer ${job.id} "<what to change>".`,
  };
  const cfg = readFinishConfig(repo);
  if (args["dry-run"]) {
    console.log(`dry-run propose ${id}: running -> ${AWAITING}`);
    console.log(`payload: ${JSON.stringify(payload)}`);
    console.log(`notify: ${cfg.off ? "off" : cfg.error ? `invalid: ${cfg.error}` : cfg.origin}`);
    return;
  }
  const now = new Date().toISOString();
  job.status = AWAITING;
  job.updated = now;
  job.gate = { ...job.gate, state: "awaiting", proposedAt: now, proposals: (job.gate.proposals || 0) + 1, approach: approach.text };
  save(repo, job);
  appendDecision(repo, id, ["gate", `proposal ${job.gate.proposals}: awaiting direction`, "new-feature job, direction gate on", approach.path, AWAITING]);
  let notified = "off";
  if (cfg.error) notified = `invalid config: ${cfg.error}`;
  else if (!cfg.off) {
    const sent = await postFinish(cfg, payload);
    notified = `${sent.outcome}${sent.http ? ` (HTTP ${sent.http})` : ""}`;
  }
  job.gate.notified = notified;
  save(repo, job);
  console.log(`${id} ${AWAITING} (proposal ${job.gate.proposals}); notification: ${notified}`);
  console.log(`approve: orka approve ${id}   revise: orka steer ${id} "..."`);
}

// The orchestrator runs this when the verifier passed and summary.txt is written: the job waits in review
// for Olaf's sign-off and he is notified once per request. It does not finish the job.
async function cmdReview(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need: orka review <id>");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status === REVIEW) fail(`job ${id} is already in ${REVIEW}; wait for orka approve or orka steer`);
  if (job.status !== "running") fail(`job ${id} is ${job.status}, not running`);
  const verifier = args["dry-run"] ? computeVerifier(repo, job) || job.verifier : recordVerifier(repo, job) || job.verifier;
  const view = { ...job, verifier };
  if (verifier?.verdict === "fail") fail(`orka review: ${verifierLine(view)}. Route the failures and re-verify, or orka done ${id} --give-up "<reason>"`);
  if (verifier?.verdict === "blocked") fail(`orka review: ${verifierLine(view)}. Fix what orka doctor ${id} reports, re-run the verifier, or tell Olaf`);
  if (verifier?.verdict === "pass" && verifier.stale) fail(`orka review: ${verifierLine(view)}; the verifier pass no longer describes the code. Re-run the verifier first`);
  const summaryPath = join(jobDir(repo, id), "summary.txt");
  const summary = existsSync(summaryPath) ? readCapped(summaryPath, FILE_READ_MAX).text.trim() : "";
  if (!summary) fail(`orka review: write ${summaryPath} first (from the git diff)`);
  const payload = {
    ...payloadOf(view, REVIEW),
    kind: REVIEW,
    title: job.title,
    summary: summary.slice(0, 2000),
    question: `Sign off "${job.title}"? Approve the result: orka approve ${id}. Request changes: orka steer ${id} "<what to change>".`,
  };
  const cfg = readFinishConfig(repo);
  if (args["dry-run"]) {
    console.log(`dry-run review ${id}: running -> ${REVIEW}`);
    console.log(`payload: ${JSON.stringify(payload)}`);
    console.log(`notify: ${cfg.off ? "off" : cfg.error ? `invalid: ${cfg.error}` : cfg.origin}`);
    return;
  }
  const now = new Date().toISOString();
  job.status = REVIEW;
  job.updated = now;
  delete job.signoff;
  job.review = { round: roundOf(job), at: now, requests: (job.review?.requests || 0) + 1 };
  save(repo, job);
  appendDecision(repo, id, ["review", `request ${job.review.requests}: awaiting sign-off`, verifierLine(job) || "no verifier", summaryPath, REVIEW]);
  let notified = "off";
  if (cfg.error) notified = `invalid config: ${cfg.error}`;
  else if (!cfg.off) {
    const sent = await postFinish(cfg, payload);
    notified = `${sent.outcome}${sent.http ? ` (HTTP ${sent.http})` : ""}`;
  }
  job.review.notified = notified;
  save(repo, job);
  console.log(`${id} ${REVIEW} (round ${roundOf(job)}); notification: ${notified}`);
  console.log(`sign off: orka approve ${id}   request changes: orka steer ${id} "..."   (orka done waits for the sign-off)`);
}

// Olaf's verb for a job waiting on him, dispatched on status: at the direction gate it approves the plan
// (the orchestrator builds), in review it signs off the result (the orchestrator runs orka done).
function cmdApprove(args) {
  allowFlags(args, ["cwd"]);
  const id = args._[1];
  if (!id) fail('need: orka approve <id> ["note"]');
  if (brand.env("JOB")) fail("orka approve is Olaf's sign-off; it is refused inside a job pane (ORKA_JOB is set)");
  const note = args._.slice(2).join(" ").trim();
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (job.status === AWAITING) return approvePlan(repo, job, note);
  if (job.status === REVIEW) return approveResult(repo, job, note);
  fail(`orka approve needs a job waiting for Olaf: ${AWAITING} (approves the plan) or ${REVIEW} (signs off the result); ${id} is ${job.status}${job.gate?.on || job.status !== "queued" ? "" : ` (gate ${job.gate ? `off: ${job.gate.reason}` : "not used"})`}`);
}

function approvePlan(repo, job, note) {
  const id = job.id;
  if (!job.agent || !agentExists(job.agent)) fail(paneGone(id, `the job stays ${AWAITING}`));
  const approachFile = join(jobDir(repo, id), "approach.md");
  const { proof } = parseApproach(existsSync(approachFile) ? readCapped(approachFile, FILE_READ_MAX).text : job.gate?.approach);
  const proofLines = proof.length
    ? [`Proof (from approach.md; orka copied it into the job as job.proof and pastes it into the verifier brief): put each line into the verifier --task as an acceptance criterion, with its proof as written:`, ...proof.map((l) => `- ${l}`)]
    : [`approach.md has no Proof lines: build the verifier --task from the builders' ACCEPTANCE lines as usual.`];
  const text = [`Direction approved by Olaf${note ? `: ${note}` : "."}`, `Build it now, following ${approachFile}${note ? " and the note above" : ""}: split into worker tasks and continue with the flow in your first prompt.`, ...proofLines].join("\n");
  const sent = promptWithRetry(job.agent, text, { readyStatuses: GATE_READY });
  if (!sent.ok) fail(`approve not delivered: ${sent.reason}; the job stays ${AWAITING}`);
  const now = new Date().toISOString();
  job.status = "running";
  job.updated = now;
  job.gate = { ...job.gate, state: "approved", approvedAt: now, ...(note ? { note } : {}) };
  if (proof.length) job.proof = proof;
  else delete job.proof;
  save(repo, job);
  appendDecision(repo, id, ["gate", "approved", note || "approach accepted", "orka approve", `building; ${proof.length} proof line(s) copied`]);
  console.log(`approved the plan of ${id} (direction gate); the orchestrator builds now`);
}

// The sign-off is recorded first, so it stands even when the prompt fails: then Olaf runs orka done himself.
// by "auto": orka chain --signoff auto signs off itself (the CLI's decision, never the orchestrator's).
function approveResult(repo, job, note, { by = "olaf" } = {}) {
  const id = job.id;
  const now = new Date().toISOString();
  job.signoff = { round: roundOf(job), at: now, ...(by === "auto" ? { by } : {}), ...(note ? { note } : {}) };
  job.updated = now;
  save(repo, job);
  appendDecision(repo, id, ["review", by === "auto" ? "signed off by orka chain (auto)" : "signed off", note || "result accepted", by === "auto" ? "chain.signoff auto" : "orka approve", "finishing"]);
  const who = by === "auto" ? "orka chain signed off the result automatically (chain.signoff auto)" : "Olaf signed off the result";
  const gone = !job.agent || !agentExists(job.agent);
  const sent = gone ? { ok: false, reason: `the orchestrator pane is gone (orka resume ${id} reattaches it; then orka done ${id} can run)` } : promptWithRetry(job.agent, `${who}${note ? `: ${note}` : "."}\nRun orka done ${id} now (or ${ORKA} done ${id}). Start no new work.`, { readyStatuses: GATE_READY });
  if (by === "auto") return sent;
  if (!sent.ok) {
    console.error(`signed off ${id} (review), but the orchestrator was not prompted: ${sent.reason}. Run orka done ${id} yourself.`);
    process.exitCode = 1;
    return;
  }
  console.log(`signed off the result of ${id} (review); the orchestrator runs orka done now`);
}

const RESUMABLE = new Set(["running", AWAITING, REVIEW]);

const paneGone = (id, what) => `${id}: the orchestrator pane is gone (herdr restart, reboot or a closed workspace); ${what}. Run orka resume ${id} to reattach it, then run this again.`;

function paneAlive(pane) {
  if (!pane) return false;
  const got = herdr(["pane", "get", pane], 10000);
  return got.code === 0 && !got.json?.error;
}

// Where the new orchestrator pane goes: next to the old one if its pane still exists (the agent in it
// died), else next to a live worker pane, else a new workspace. No pane is closed or reused.
function resumePlace(job) {
  const candidates = [job.pane, ...[...(job.workers || [])].reverse().map((w) => w.pane)].filter(Boolean);
  const from = [...new Set(candidates)].find(paneAlive);
  return from ? { split: from } : { workspace: true };
}

// The watcher of a job that is waiting on Olaf or running: stop the recorded one (and any other for this
// job in this repo), start a fresh one that follows the new pane.
function restartWatcher(repo, job) {
  killWatcher(job);
  for (const w of watch.listWatchers()) {
    if (w.jobId !== job.id || w.cwd !== repo || w.pid === Number(job.watcherPid)) continue;
    try {
      process.kill(w.pid, "SIGTERM");
    } catch {
      // gone already
    }
  }
  delete job.watcherPid;
  if (brand.env("NO_WATCH") === "1") return;
  try {
    job.watcherPid = watch.spawnWatcher({ bin: ORKA, jobId: job.id, repo, logPath: join(ensureJobDir(repo, job.id), "watcher.log") });
  } catch (err) {
    console.error(`watcher not started: ${err?.message || err}`);
  }
}

function resumeLines(job, mode, pane) {
  const waiting = {
    [AWAITING]: `Status ${AWAITING}: approach.md is proposed. Start nothing; wait for Olaf's orka approve or orka steer.`,
    [REVIEW]: `Status ${REVIEW}: the result is waiting for Olaf's sign-off. Start nothing; wait for orka approve (then run orka done ${job.id}) or orka steer.`,
    running: `Status running: continue the flow where the digest shows it. Workers' panes were not touched: a worker whose result is there is done; start a worker again only when its pane is gone and its result is missing.`,
  }[job.status];
  const head =
    mode === "resume"
      ? `orka resume: your pane was gone (herdr restart, reboot or a closed workspace), and orka reopened this session in a new pane ${pane}.`
      : `orka resume: you replace an orchestrator whose pane and session are gone (no transcript was found). You do not have its memory; the digest below, ${decisionsPath(job.repo, job.id)} and the job file are what remains.`;
  return [head, waiting, `Current state (orka digest ${job.id}):`].join("\n");
}

// Reattach the orchestrator of a running, awaiting-direction or review job whose pane is gone. The
// claude session is reopened (--resume <sessionId>; pi continues the same --session-id); with no
// transcript a fresh orchestrator starts on the first prompt plus the digest. Workers are not touched.
function cmdResume(args) {
  allowFlags(args, ["cwd", "dry-run"]);
  const id = args._[1];
  if (!id) fail("need: orka resume <id> [--dry-run]");
  const repo = requireRepo(args.cwd || process.cwd());
  const job = load(repo, id);
  if (!RESUMABLE.has(job.status)) {
    const why = FINISH_STATUSES.has(job.status) ? ` (a finished job: orka steer starts a follow-up round while its pane is open)` : job.status === "queued" ? ` (start it with orka run ${id})` : "";
    fail(`${id} is ${job.status}; orka resume only reattaches a running, ${AWAITING} or ${REVIEW} job${why}`);
  }
  if (!job.worktree || !existsSync(job.worktree)) fail(`${id}: worktree ${job.worktree || "(none)"} is missing; cannot resume`);
  const name = job.agent || agentName(id);
  if (agentExists(name)) fail(`${id}: the orchestrator ${name} is still alive (pane ${agentPane(name) || job.pane}); nothing to resume. orka steer ${id} "..." talks to it`);
  const kind = job.kind === "pi" ? "pi" : "claude";
  const alias = kind === "claude" ? job.orchestratorModel || job.model : "";
  if (kind === "claude" && !alias) fail("job has no orchestratorModel");
  const transcript = context.findTranscript({ kind, cwd: job.worktree, sessionId: job.sessionId, home: homedir() });
  const mode = transcript ? "resume" : "fresh";
  const place = resumePlace(job);
  const where = place.split ? `split from pane ${place.split}` : "a new workspace";
  if (args["dry-run"]) {
    console.log(`dry-run resume ${id} (${job.status}): ${mode === "resume" ? `reopen session ${job.sessionId} (${transcript})` : `no transcript for session ${job.sessionId || "(none)"}: fresh orchestrator, first prompt plus digest`}`);
    console.log(`  pane: ${where}; agent ${name} (${kind}${alias ? ` ${alias}` : ""}); watcher restarted; workers untouched`);
    return;
  }
  const old = { pane: job.pane, sessionId: job.sessionId };
  let pane;
  if (place.split) pane = splitPane(place.split, job.worktree, job, "orchestrator");
  else {
    const made = createWorkspace(job);
    pane = made.pane;
    job.workspace = made.workspace;
    delete job.workspaceClosed;
  }
  const sessionId = mode === "resume" ? job.sessionId : randomUUID();
  const started = herdr(startArgs(name, pane, kind, alias, sessionId, job, { resume: mode === "resume" }), 90000);
  assertNotTrustBlocked(repo, kind, pane, "the resumed orchestrator");
  if (!herdrOk(started)) herdrFail(started, `agent start (resume; the new pane ${pane} stays open)`);
  const at = new Date().toISOString();
  // The record first, so the watcher follows the new pane.
  job.agent = name;
  job.pane = pane;
  job.sessionId = sessionId;
  job.resumes = [...(Array.isArray(job.resumes) ? job.resumes : []), { at, mode, status: job.status, from: old, pane, sessionId }];
  job.updated = at;
  save(repo, job);
  const digest = renderDigest(digestView(job), collectDigestFiles(repo, job));
  // A reopened session that was waiting on Olaf keeps waiting: orka approve or steer prompts it.
  const text = mode === "fresh" ? `${leadPrompt(job)}\n\n${resumeLines(job, mode, pane)}\n${digest}` : job.status === "running" ? `${resumeLines(job, mode, pane)}\n${digest}` : "";
  const sent = text ? promptWithRetry(name, text, job.status === "running" ? {} : { readyStatuses: GATE_READY }) : { ok: true, skipped: true };
  job.leadDelivery = sent.ok ? "ok" : "failed";
  restartWatcher(repo, job);
  save(repo, job);
  appendDecision(repo, id, ["resume", `orchestrator reattached (${mode === "resume" ? "session reopened" : "fresh, from the digest"})`, `old pane ${old.pane || "-"} gone; status ${job.status}`, mode === "resume" ? transcript : "no transcript", sent.ok ? `pane=${pane}${sent.skipped ? " (waiting on Olaf, not prompted)" : ""}` : `prompt failed: ${sent.reason}`]);
  if (!sent.ok) fail(`resumed ${id} in pane ${pane}, but the prompt was not delivered: ${sent.reason}`);
  console.log(`${id} resumed (${mode === "resume" ? `session ${sessionId} reopened` : "fresh orchestrator from the digest"}) pane=${pane} agent=${name}${sent.skipped ? `; ${job.status}: waiting on Olaf (orka approve / orka steer)` : ""}`);
}

function help() {
  console.log(`orka — one job in a linked worktree

  orka init [--cwd <repo>]
  orka new --title "..." --goal "..." [--cwd <repo>] [--kind claude|pi] [--keep]
  orka new --spec specs/<feature>/spec.md [--title "..."] [--goal "extra"] [...]   (intake built from a committed spec)
  orka spec init <feature> [--cwd <repo>]   (scaffolds specs/<feature>/spec.md; you fill and commit it)
           [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds <N>]
  orka run <id> [--dry-run] [--cwd <repo>] [--keep]
           [--orchestrator-model <alias>] [--worker-model <alias>] [--verifier-model <alias>] [--max-rounds <N>]
  orka worker --job <id> --name <agent> --task "..." [--model <alias>] [--role builder|verifier] [--accept "<cmd>"] [--dry-run]
           (--role verifier first runs the static gates; a red gate starts no verifier; a single acceptance
           command that passes records the round as pass by gate. See docs/gates.md)
           (--model is claude only; pi workers have no model flag; --role verifier defaults to the job's verifierModel)
           (--role verifier needs --name verifier; no round limit unless the job has --max-rounds)
           A name already used by a worker of this job, or by a herdr agent, gets -2, -3... appended and
           the real name is printed. Verifier rounds are verifier, verifier-2, verifier-3... Panes are
           never closed while the job runs; orka frees them on done/stop.
  orka status [id] [--cwd <repo>]
  orka digest <id> [--cwd <repo>]
  orka steer <id> [--to <worker>] "message"   (running job: via the target's inbox, delivered between tool calls or when idle;
           also on a finished job whose orchestrator pane is still open: starts a follow-up round)
  orka wake <id> [--dry-run]   (one pass of the watcher's finish wakes and inbox delivery; docs/workers.md)
  orka propose <id> [--dry-run]   (orchestrator, direction gate: approach.md written; pause and notify Olaf)
  orka review <id> [--dry-run]   (orchestrator: verifier passed, summary.txt written; status review, Olaf is notified)
  orka approve <id> ["note"]   (Olaf only; by status: awaiting-direction -> approves the plan, the orchestrator builds;
           review -> signs off the result, the orchestrator runs orka done. orka steer revises / requests changes instead)
  orka new ... --no-gate   (skip the direction gate; it is on for new-feature jobs, off for other playbooks and fixes)
  orka resume <id> [--dry-run]   (reattach the orchestrator of a running, awaiting-direction or review job whose pane is gone:
           reopens its session in a new pane, or starts it fresh from the digest; restarts the watcher; workers untouched)
  orka stop <id> [reason] [--dry-run] [--keep]
  orka strategy <id> [--premise "<shared premise>"] "<what changed>"
  orka log <id> <phase> <decision> <why> <evidence> <result>   (appends a row to .orka/jobs/<id>/decisions.tsv)
  orka done <id> [reason] [--give-up "<reason>"] [--dry-run] [--keep] [--cwd <repo>]
           (refused until orka approve signed off the job in review; --give-up and orka stop always work)
  orka cleanup [--dry-run] [--older-than <12h>] [--orphan-hours <2>] [--cwd <repo>]
  orka reap <id> [--worker <name>] [--dry-run] [--cwd <repo>]   (closes browsers only; panes stay)
  orka doctor [--job <id>] [--fix] [--cwd <repo>]   (environment check with a fix per problem; read-only, --fix
           only relinks the job's node_modules; runs by itself on a blocked verdict or a pane that did not start)
  orka watch <id> [--dry-run] [--cwd <repo>]   (started by orka run; not for hand use)
  orka handoff <id> [<worker>|orchestrator] [--dry-run] [--cwd <repo>]   (one context-handoff pass; the watcher runs it every poll; a name hands that pane off now)
  orka webhook <id> [--dry-run] [--force] [--cwd <repo>]
  orka verify <id> [--base] [--dry-run] [--cwd <repo>]
  orka autonomy [--cwd <repo>] | autonomy set <L0|L1|L2|L3>   (per-repo level, kept in ~/.config/orka/config.json)
  orka push <id> [--pr] [--dry-run]   (L2: push the job branch, --pr opens a PR)
  orka land <id> [--push] [--dry-run]   (L3: merge the job branch into main, npm test, --push pushes main)
  orka chain [--signoff auto|each|end] [--dry-run] [--cwd <repo>]   (runs <state>/chain-queue one job at a time;
           auto (default): merge into main + sign off; each: wait for orka approve; end: stack, one review at the end)
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

Context handoff (builder workers and the orchestrator, both kinds)
  Every pane starts with --session-id; the watcher reads that transcript's last turn each poll.
  Window per pane, never guessed: Claude's statusline context_window_size (captured per session),
  a [1m] model id, Pi's model registry, then handoff.contextWindow; else "window unknown" and no
  automatic handoff. At handoff.threshold (default 0.4) the pane runs the handoff skill
  (plugin/skills/handoff): at once when idle, or at its next clean stopping point via a message
  queued mid-turn. The note goes to .orka/jobs/<id>/handoff/<name>-<n>.md, the agent is renamed
  <name>-h<n>, and a fresh <name> continues in a new pane. Old panes stay open until done/stop/cleanup.
  Verifier exempt. At most handoff.maxHandoffs (default 3) per pane.
  Config: "handoff": {"threshold": 0.4, "orchestrator": true, "maxHandoffs": 3,
  "contextWindow": N | {"<model substring>": N}} or "handoff": false. See docs/handoff.md.

Verifier (both kinds)
  After every builder reports, the orchestrator starts ONE verifier:
    orka worker --job <id> --name verifier --role verifier --task "<what was built + acceptance criteria>"
  Before the pane starts, orka runs the static gates (lint, typecheck, check, test, or "gates" in config); a
  red gate starts no verifier (docs/gates.md). Fresh context, same worktree, the job's worker model. It runs
  orka verify and targeted agent-browser checks in one session (<prefix>-verifier). It does not
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
status reads the job file; the host line counts Orka's own panes (ORKA_JOB-tagged, from /proc). One job also prints the finish-wake record and verify.
stop interrupts the lead and workers, then marks stopped. It does not close the workspace.
review: after the verifier passes and summary.txt is written the orchestrator runs orka review <id>: status review,
  the finish webhook gets {"kind":"review","status":"review",...,"summary","question"}, panes stay open, the job is not
  finished. orka steer in review is a change request (back to running, sign-off cleared). orka approve in review
  records job.signoff {round,at,note} and prompts the orchestrator to run orka done.
done marks a job done (default reason "completed") and sends the finish wake, only with Olaf's sign-off for the current
  round; without it, it refuses (exit 1) unless --give-up. It refuses a queued job and leaves a finished one alone.
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
  On done only, it also removes the worktree (git worktree remove, never --force; a worktree with uncommitted
  changes is kept). The branch always stays. A steer on a done job checks the branch out again.
  The orchestrator pane and the Herdr workspace stay open so Olaf can still steer. The record and branch always stay.
  orka cleanup [--dry-run] [--older-than 12h] closes the workspace of jobs that are finished (done, failed,
  stopped) and idle longer than the threshold (default 12h; or "staleAfter": "<duration>" in .orka/config.json).
  Idle is measured from the latest of finished, steer, verifier and follow-up round times. A job is only closed once.
  It also closes orka- (and orca-) browser sessions of jobs that are not running and agent-browser sessions whose pid file names a dead process.
  Closing a session never launches a browser: a session with no live daemon or Chrome only has its state deleted.
  Browsers are found by ORKA_JOB (or ORCA_JOB) tag and by session name (AGENT_BROWSER_SESSION / --session in the process tree).
  It kills Chrome whose pane or job is gone, and recorded pids (<job dir>/browser-pids.json, same start time) of
  finished jobs and gone panes. It removes the worktrees of past done jobs (the branch stays).
  It also kills orphan agent-browser-chrome-* roots (parent init, older than --orphan-hours, default 2, owned by no running job).
  Only orka cleanup sweeps other jobs: orka new and orka run never do. orka done cleans only its own job.
  No cron, no polling. --keep on new, run, done or stop opts out of everything. --dry-run lists "would close",
  "would kill" and "would remove worktree" lines with sizes. Wrap orka cleanup in timeout in scripts.

Shared dependencies
  A job worktree links node_modules to the main checkout's when the lockfile matches, and runs a real install when it
  differs. orka run and every orka worker repair a missing or broken link.

Memory guard
  orka worker checks MemAvailable and Orka's live panes (ORKA_JOB-tagged pane shells on the host, not
  Olaf's other Herdr panes) before it starts a pane. When tight it queues (.orka/queue/)
  and waits, then refuses past the limit. "memoryGuard": {"minAvailableMb":1024,"maxPanes":20,"wait":"8m","poll":"15s"}
  in .orka/config.json, or ORKA_MIN_MEM_MB, ORKA_MAX_PANES, ORKA_GUARD_WAIT, ORKA_GUARD_POLL, ORKA_MEMORY_GUARD=off.
  Logged to decisions.tsv; orka status shows memory, live panes and the queue. No disk guard.

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
  else if (cmd === "doctor") cmdDoctor(args);
  else if (cmd === "watch") await cmdWatch(args);
  else if (cmd === "spec") cmdSpec(args);
  else if (cmd === "autonomy") cmdAutonomy(args);
  else if (cmd === "push") cmdPush(args);
  else if (cmd === "land") cmdLand(args);
  else if (cmd === "chain") await cmdChain(args);
  else if (cmd === "propose") await cmdPropose(args);
  else if (cmd === "approve") cmdApprove(args);
  else if (cmd === "review") await cmdReview(args);
  else if (cmd === "handoff") cmdHandoff(args);
  else if (cmd === "wake") cmdWake(args);
  else if (cmd === "resume") cmdResume(args);
  else fail(`unknown command ${cmd}\nrun: orka help`);
}

try {
  await main();
} catch (err) {
  console.error(err && err.orka ? err.message : err?.message || err);
  process.exit(1);
}
