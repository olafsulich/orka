// Memory guard for orka worker: before a worker or verifier pane starts, check
// MemAvailable and the number of live panes against limits, and queue (wait)
// while it is tight. The queue is one file per waiting orka worker process in
// <state dir>/queue/, so parallel callers never rewrite a shared record. No disk
// guard here (the VPS agent owns disk).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseDuration } from "./lifecycle.mjs";

export const DEFAULT_LIMITS = { minAvailableMb: 1024, maxPanes: 20, waitMs: 8 * 60 * 1000, pollMs: 15 * 1000 };

// MemAvailable in MB from <procRoot>/meminfo, or null when unreadable.
export function memAvailableMb(procRoot = "/proc") {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(readFileSync(join(procRoot, "meminfo"), "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
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

// Limits from "memoryGuard" in .orka/config.json ({ minAvailableMb, maxPanes, wait, poll,
// enabled }), overridden by env ORKA_MIN_MEM_MB, ORKA_MAX_PANES, ORKA_GUARD_WAIT,
// ORKA_GUARD_POLL, ORKA_MEMORY_GUARD=off. env is a getter: (key) => value.
export function guardLimits(cfg = {}, env = () => undefined) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const off = env("MEMORY_GUARD") === "off" || c.enabled === false;
  return {
    off,
    minAvailableMb: num(env("MIN_MEM_MB"), num(c.minAvailableMb, DEFAULT_LIMITS.minAvailableMb)),
    maxPanes: num(env("MAX_PANES"), num(c.maxPanes, DEFAULT_LIMITS.maxPanes)),
    waitMs: dur(env("GUARD_WAIT"), dur(c.wait, DEFAULT_LIMITS.waitMs)),
    pollMs: dur(env("GUARD_POLL"), dur(c.poll, DEFAULT_LIMITS.pollMs)),
  };
}

// { ok, reasons }. An unknown reading (null) never blocks.
export function guardVerdict({ availableMb, panes }, limits) {
  const reasons = [];
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

// Orka's own panes on this host: a pane's shell is a child of the herdr server and carries the
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
    if (basename(parent) === "herdr") count++;
  }
  return count;
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
