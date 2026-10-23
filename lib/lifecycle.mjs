// Pure helpers for orka's delayed cleanup: durations, staleness, and finding
// dev servers that still run inside a job worktree. No dependencies.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export const DEFAULT_STALE_MS = 12 * 60 * 60 * 1000;
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const STALE_STATUSES = new Set(["done", "failed", "stopped"]);

// "12h", "30m", "45s", "2d" (optionally fractional, e.g. "1.5h") -> ms.
// A bare number is ambiguous (ms? hours?), so it is rejected.
export function parseDuration(str) {
  const text = typeof str === "string" ? str.trim() : "";
  if (/^[0-9]+(\.[0-9]+)?$/.test(text)) {
    throw new Error(`duration "${text}" needs a unit: s, m, h or d (for example 12h)`);
  }
  const m = /^([0-9]+(?:\.[0-9]+)?)([smhd])$/i.exec(text);
  if (!m) throw new Error(`bad duration "${str}": use a number and a unit s, m, h or d (for example 12h)`);
  return Math.round(Number(m[1]) * UNIT_MS[m[2].toLowerCase()]);
}

function ms(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string" || !value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

// Latest activity time of a job, in epoch ms (0 when nothing is recorded).
// Fields read, each an ISO string (or epoch ms):
//   job.finished, job.updated, job.steered, job.lastSteer,
//   job.steers[].at, job.verifier.history[].at, job.verifier.finished,
//   job.finishRounds[] (strings, or objects with at/finished/settled).
export function lastActivity(job) {
  if (!job || typeof job !== "object") return 0;
  const times = [job.finished, job.updated, job.steered, job.lastSteer].map(ms);
  for (const s of Array.isArray(job.steers) ? job.steers : []) times.push(ms(s?.at));
  const v = job.verifier;
  if (v && typeof v === "object") {
    times.push(ms(v.finished), ms(v.updated));
    for (const h of Array.isArray(v.history) ? v.history : []) times.push(ms(h?.at));
  }
  for (const r of Array.isArray(job.finishRounds) ? job.finishRounds : []) {
    times.push(typeof r === "object" && r ? Math.max(ms(r.at), ms(r.finished), ms(r.settled)) : ms(r));
  }
  return Math.max(0, ...times);
}

// True only for a finished (done/failed/stopped), non-kept job whose workspace
// is still open and idle for longer than thresholdMs. extraActivityMs is an
// optional additional timestamp (such as pane last activity) from the caller.
export function isStale(job, nowMs, thresholdMs = DEFAULT_STALE_MS, extraActivityMs = 0) {
  if (!job || !STALE_STATUSES.has(job.status)) return false;
  if (job.keep || !job.workspace || job.workspaceClosed) return false;
  const last = Math.max(lastActivity(job), ms(extraActivityMs));
  return nowMs - last > thresholdMs;
}

function readStatusPpid(procRoot, pid) {
  try {
    const m = /^PPid:\s*([0-9]+)/m.exec(readFileSync(join(procRoot, String(pid), "status"), "utf8"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function ancestorPids(procRoot, selfPid) {
  const seen = new Set();
  let pid = selfPid;
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    pid = readStatusPpid(procRoot, pid);
  }
  return seen;
}

function readCmdline(procRoot, pid) {
  try {
    return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

// Processes whose cwd is the worktree or inside it. Excludes selfPid and its
// ancestors. Path boundary safe: /a/wt does not match /a/wt2.
export function findWorktreeProcesses(worktree, { procRoot = "/proc", selfPid = process.pid } = {}) {
  const root = resolve(worktree);
  const prefix = root.endsWith(sep) ? root : root + sep;
  const skip = ancestorPids(procRoot, selfPid);
  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    let cwd;
    try {
      cwd = resolve(readlinkSync(join(procRoot, name, "cwd")).replace(/ \(deleted\)$/, ""));
    } catch {
      continue;
    }
    if (cwd !== root && !cwd.startsWith(prefix)) continue;
    found.push({ pid, cwd, cmdline: readCmdline(procRoot, pid) });
  }
  return found;
}

const EXCLUDED = new Set(["claude", "herdr", "agent-browser", "pi", "bash", "sh", "zsh", "fish", "dash", "git", "orka", "orka.mjs", "orca", "orca.mjs"]);
const SERVER_RUNTIMES = /^(node|nodejs|bun|deno|python|python[0-9.]*|vite|next|npx|tsx)$/;

// Heuristic: does this command line look like a dev/http server?
export function isServerProcess(cmdline) {
  const argv = String(cmdline || "").trim().split(/\s+/).filter(Boolean);
  if (!argv.length) return false;
  const bases = argv.map((a) => basename(a));
  // Excluded tools, directly or as the script of an interpreter (node .../claude).
  if (EXCLUDED.has(bases[0]) || (argv.length > 1 && EXCLUDED.has(bases[1]))) return false;
  if (bases.some((b) => b === "orka.mjs" || b === "orca.mjs" || b === "herdr" || b === "agent-browser")) return false;
  if (SERVER_RUNTIMES.test(bases[0])) return true;
  if (/^(npm|pnpm|yarn)$/.test(bases[0]) && /\b(run\s+)?(dev|serve|start)\b/.test(argv.slice(1).join(" "))) return true;
  if (argv.slice(1).some((a) => a === "-p" || a === "--port" || a.startsWith("--port=") || a === "http.server")) return true;
  return bases.slice(1).some((b) => /server/i.test(b));
}

export function findWorktreeServers(worktree, opts = {}) {
  return findWorktreeProcesses(worktree, opts).filter((p) => isServerProcess(p.cmdline));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Send signal to each pid; ESRCH (already gone) is ignored. Returns the pids
// signalled. With graceMs, pids still alive afterwards get SIGKILL.
export function killProcesses(pids, { signal = "SIGTERM", graceMs = 0 } = {}) {
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      killed.push(pid);
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
  }
  if (graceMs > 0 && killed.length) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && killed.some(alive)) sleepMs(50);
    for (const pid of killed.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
    }
  }
  return killed;
}

// A job worktree orka may remove: the job is done (not failed, stopped, queued
// or running), not kept, and its worktree is recorded and not yet removed.
export function removableWorktree(job) {
  return Boolean(job && job.status === "done" && !job.keep && job.worktree && !job.worktreeRemoved);
}

export function formatKb(kb) {
  const n = Number(kb) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}G`;
  if (n >= 1024) return `${Math.round(n / 1024)}M`;
  return `${n}K`;
}
