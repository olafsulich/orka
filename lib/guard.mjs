// Memory guard for orka worker: before a worker or verifier pane starts, check
// MemAvailable and the number of live panes against limits, and queue (wait)
// while it is tight. The queue is one file per waiting orka worker process in
// <state dir>/queue/, so parallel callers never rewrite a shared record. No disk
// guard here (the VPS agent owns disk).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { formatKb, parseDuration } from "./lifecycle.mjs";

export const DEFAULT_LIMITS = { minAvailableMb: 1024, maxPanes: 20, maxMemPsi: 10, waitMs: 8 * 60 * 1000, pollMs: 15 * 1000 };

// MemAvailable in MB from <procRoot>/meminfo, or null when unreadable.
export function memAvailableMb(procRoot = "/proc") {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(readFileSync(join(procRoot, "meminfo"), "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

// SwapTotal in MB from <procRoot>/meminfo, or null when unreadable.
export function swapTotalMb(procRoot = "/proc") {
  try {
    const m = /^SwapTotal:\s+(\d+)\s*kB/m.exec(readFileSync(join(procRoot, "meminfo"), "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

// Memory pressure: the share of the last 10 seconds in which some task waited for memory
// ("some avg10" in <procRoot>/pressure/memory, a percentage), or null without PSI.
export function memPressure(procRoot = "/proc") {
  try {
    const m = /^some\b.*\bavg10=([0-9.]+)/m.exec(readFileSync(join(procRoot, "pressure", "memory"), "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function dur(value, fallback) {
  if (typeof value === "number" && value >= 0) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  return parseDuration(value);
}

// Limits from "memoryGuard" in .orka/config.json ({ minAvailableMb, maxPanes, maxMemPsi, wait,
// poll, enabled }), overridden by env ORKA_MIN_MEM_MB, ORKA_MAX_PANES, ORKA_MAX_MEM_PSI,
// ORKA_GUARD_WAIT, ORKA_GUARD_POLL, ORKA_MEMORY_GUARD=off. maxMemPsi 0 turns the pressure
// check off. env is a getter: (key) => value.
export function guardLimits(cfg = {}, env = () => undefined) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const off = env("MEMORY_GUARD") === "off" || c.enabled === false;
  return {
    off,
    minAvailableMb: num(env("MIN_MEM_MB"), num(c.minAvailableMb, DEFAULT_LIMITS.minAvailableMb)),
    maxPanes: num(env("MAX_PANES"), num(c.maxPanes, DEFAULT_LIMITS.maxPanes)),
    maxMemPsi: num(env("MAX_MEM_PSI"), num(c.maxMemPsi, DEFAULT_LIMITS.maxMemPsi)),
    waitMs: dur(env("GUARD_WAIT"), dur(c.wait, DEFAULT_LIMITS.waitMs)),
    pollMs: dur(env("GUARD_POLL"), dur(c.poll, DEFAULT_LIMITS.pollMs)),
  };
}

// { ok, reasons }. An unknown reading (null) never blocks.
export function guardVerdict({ availableMb, panes, psi = null }, limits) {
  const reasons = [];
  if (psi != null && limits.maxMemPsi > 0 && psi > limits.maxMemPsi) reasons.push(`memory pressure ${psi}% > ${limits.maxMemPsi}%`);
  if (availableMb != null && availableMb < limits.minAvailableMb) reasons.push(`MemAvailable ${availableMb}MB < ${limits.minAvailableMb}MB`);
  if (panes != null && limits.maxPanes > 0 && panes >= limits.maxPanes) reasons.push(`${panes} live panes >= ${limits.maxPanes}`);
  return { ok: reasons.length === 0, reasons };
}

function readProc(procRoot, pid, file) {
  try {
    return readFileSync(join(procRoot, String(pid), file), "utf8");
  } catch {
    return "";
  }
}

// What a pane's first process is a child of: the herdr server, or hc's holder (herdr-core hold).
const PANE_HOSTS = new Set(["herdr", "herdr-core"]);

// Orka's own panes on this host: a pane's shell is a child of the herdr server (or of herdr-core) and carries the
// ORKA_JOB (or ORCA_JOB) tag orka passes to every pane it starts. Its children share the tag but
// have a tagged parent, so each pane counts once; Olaf's own Herdr panes are untagged. null when
// procRoot cannot be read.
export function orkaPaneCount(procRoot = "/proc") {
  let names;
  try {
    names = readdirSync(procRoot).filter((n) => /^[0-9]+$/.test(n));
  } catch {
    return null;
  }
  const tagged = (pid) => /(^|\0)OR[CK]A_JOB=[^\0]/.test(readProc(procRoot, pid, "environ"));
  let count = 0;
  for (const pid of names) {
    if (!tagged(pid)) continue;
    const ppid = /^PPid:\s*([0-9]+)/m.exec(readProc(procRoot, pid, "status"))?.[1];
    if (!ppid || tagged(ppid)) continue;
    const parent = readProc(procRoot, ppid, "cmdline").split("\0")[0];
    if (PANE_HOSTS.has(basename(parent))) count++;
  }
  return count;
}

// Memory each orka job holds on this host: the PSS of every ORKA_JOB (or ORCA_JOB) tagged
// process, from smaps_rollup (VmRSS when that is unreadable), summed per job and per worker
// (ORKA_WORKER, else "other"). PSS splits shared pages between the processes that map them,
// so Chrome's renderers are not counted many times. [{ job, kb, procs, workers: [{ name, kb }] }],
// largest first; [] when procRoot cannot be read.
export function jobMemory(procRoot = "/proc") {
  let names;
  try {
    names = readdirSync(procRoot).filter((n) => /^[0-9]+$/.test(n));
  } catch {
    return [];
  }
  const jobs = new Map();
  for (const pid of names) {
    const tags = {};
    for (const kv of readProc(procRoot, pid, "environ").split("\0")) {
      const m = /^OR([CK])A_(JOB|WORKER)=(.+)$/s.exec(kv);
      if (m && (m[1] === "K" || !tags[m[2]])) tags[m[2]] = m[3];
    }
    if (!tags.JOB) continue;
    const kb = Number(/^Pss:\s+(\d+)\s*kB/m.exec(readProc(procRoot, pid, "smaps_rollup"))?.[1] ?? /^VmRSS:\s+(\d+)\s*kB/m.exec(readProc(procRoot, pid, "status"))?.[1] ?? 0);
    const j = jobs.get(tags.JOB) || { job: tags.JOB, kb: 0, procs: 0, workers: new Map() };
    const worker = tags.WORKER || "other";
    j.kb += kb;
    j.procs++;
    j.workers.set(worker, (j.workers.get(worker) || 0) + kb);
    jobs.set(tags.JOB, j);
  }
  return [...jobs.values()]
    .map((j) => ({ ...j, workers: [...j.workers].map(([name, kb]) => ({ name, kb })).sort((a, b) => b.kb - a.kb) }))
    .sort((a, b) => b.kb - a.kb);
}

const FINISHED = new Set(["done", "stopped", "failed"]);

// "<job> 1.2G (w1 800M, orchestrator 300M), ..." for the largest `limit` jobs. statusOf(job id) is
// the job's status in this repo, or "" for a job of another repo.
export function jobMemoryText(usage, { limit = 3, statusOf = () => "" } = {}) {
  return usage
    .slice(0, limit)
    .map((u) => `${u.job}${statusOf(u.job) ? ` [${statusOf(u.job)}]` : ""} ${formatKb(u.kb)} (${u.workers.slice(0, 3).map((w) => `${w.name} ${formatKb(w.kb)}`).join(", ")})`)
    .join(", ");
}

// What finished jobs of this repo still hold, and how to see what closing them frees; "" when none.
export function finishedHint(usage, statusOf) {
  const held = usage.filter((u) => FINISHED.has(statusOf(u.job)));
  if (!held.length) return "";
  const kb = held.reduce((n, u) => n + u.kb, 0);
  return `finished jobs still hold ${formatKb(kb)} (${held.slice(0, 3).map((u) => `${u.job} [${statusOf(u.job)}] ${formatKb(u.kb)}`).join(", ")}); timeout 120 orka cleanup --dry-run --older-than 0s lists what closing their workspaces frees`;
}

export const queueDir = (stateDir) => join(stateDir, "queue");

// Adds a waiting entry ({ job, name, role, pid, since }); returns its file path.
export function enqueue(dir, entry) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${entry.pid}.json`);
  writeFileSync(file, JSON.stringify(entry) + "\n");
  return file;
}

export function dequeue(file) {
  rmSync(file, { force: true });
}

// Waiting entries, oldest first, each with its file. An entry whose process is
// gone (killed by a caller's timeout) is dropped from the queue.
export function liveQueue(dir, alive) {
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    const file = join(dir, f);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!alive(Number(entry.pid))) {
      rmSync(file, { force: true });
      continue;
    }
    out.push({ ...entry, file });
  }
  return out;
}
