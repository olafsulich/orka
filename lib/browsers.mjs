// Finds browser processes that orca jobs started, by the ORCA_JOB / ORCA_WORKER
// env vars orca exports into every job pane. Children (agent-browser daemons,
// Chrome, chrome-devtools-mcp, Playwright) inherit them, so the tag survives
// when a daemon detaches and is reparented to init. Untagged processes are
// never touched.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const BROWSER = /(^|[\/\s-])(chrome|chromium|chromium-browser|google-chrome|headless_shell|chrome_crashpad_handler|chrome-devtools-mcp|agent-browser)(\s|$|[-.])|ms-playwright|playwright[^\s]*\/(cli|driver)|playwright-mcp/i;

export function isBrowserProcess(cmdline) {
  const text = String(cmdline || "");
  if (!text.trim()) return false;
  const first = basename(text.trim().split(/\s+/)[0]);
  if (/^(bash|sh|zsh|grep|rg|ps|pgrep|pkill|orca|orca\.mjs|herdr|claude)$/.test(first)) return false;
  if (/orca\.mjs/.test(text)) return false;
  return BROWSER.test(text);
}

function readEnv(procRoot, pid) {
  try {
    const out = {};
    for (const kv of readFileSync(join(procRoot, String(pid), "environ"), "utf8").split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0 && (kv.startsWith("ORCA_JOB=") || kv.startsWith("ORCA_WORKER="))) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch {
    return null;
  }
}

function readCmdline(procRoot, pid) {
  try {
    return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

// [{ pid, job, worker, cmdline }] for every tagged browser process.
export function findTaggedBrowsers({ procRoot = procRootOf(), selfPid = process.pid } = {}) {
  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid || pid <= 1) continue;
    const cmdline = readCmdline(procRoot, pid);
    if (!isBrowserProcess(cmdline)) continue;
    const env = readEnv(procRoot, pid);
    if (!env?.ORCA_JOB) continue;
    out.push({ pid, job: env.ORCA_JOB, worker: env.ORCA_WORKER || "", cmdline });
  }
  return out;
}

// Which of procs to kill. jobId (+ optional worker) targets one job;
// finishedJobIds adds every process of those jobs. A job id that is neither
// (unknown to this repo, or still running) is never selected.
export function selectReap(procs, { jobId = null, worker = null, workers = null, prefix = null, finishedJobIds = [] } = {}) {
  const finished = new Set(finishedJobIds.map(String));
  const names = workers ? new Set(workers.map(String)) : worker ? new Set([String(worker)]) : null;
  return procs.filter((p) => {
    if (jobId != null && p.job === String(jobId) && (!names || names.has(p.worker))) return true;
    // Untagged job Chrome: the session name orca-<sha8>-<worker> identifies it.
    if (prefix && p.session.startsWith(`${prefix}-`)) {
      const who = p.session.slice(prefix.length + 1);
      if (!names || names.has(who)) return true;
    }
    return p.job !== "" && finished.has(p.job);
  });
}

// ---- Attribution beyond the env tag -------------------------------------
// agent-browser's daemon does not always pass the pane environment on to Chrome,
// so a job's Chrome can carry no ORCA_JOB. These helpers map a process to its
// agent-browser session (orca-<sha8>-<worker>) by, in order: its own
// AGENT_BROWSER_SESSION env, a `--session <name>` argument, the nearest browser
// ancestor that has either (daemon -> Chrome root -> renderers). Job tags are
// inherited down the same tree.
export function procRootOf(env = process.env) {
  return env.ORCA_PROC_ROOT || "/proc";
}

function readStat(procRoot, pid) {
  try {
    const text = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(rest[1]), start: Number(rest[19]) };
  } catch {
    return { ppid: 0, start: 0 };
  }
}

function bootTimeMs(procRoot) {
  try {
    const m = /^btime\s+(\d+)/m.exec(readFileSync(join(procRoot, "stat"), "utf8"));
    if (m) return Number(m[1]) * 1000;
  } catch {
    // fall through
  }
  return 0;
}

function readTags(procRoot, pid) {
  try {
    const out = {};
    for (const kv of readFileSync(join(procRoot, String(pid), "environ"), "utf8").split("\0")) {
      const i = kv.indexOf("=");
      if (i <= 0) continue;
      const k = kv.slice(0, i);
      if (k === "ORCA_JOB" || k === "ORCA_WORKER" || k === "AGENT_BROWSER_SESSION") out[k] = kv.slice(i + 1);
    }
    return out;
  } catch {
    return {};
  }
}

const SESSION_ARG = /--session[ =](\S+)/;

// Every browser-ish process: { pid, ppid, cmdline, job, worker, session, startMs, chromeRoot, ageMs }.
export function scanBrowsers({ procRoot = procRootOf(), selfPid = process.pid, now = Date.now() } = {}) {
  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return [];
  }
  const boot = bootTimeMs(procRoot);
  const byPid = new Map();
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid || pid <= 1) continue;
    const cmdline = readCmdline(procRoot, pid);
    if (!isBrowserProcess(cmdline)) continue;
    const { ppid, start } = readStat(procRoot, pid);
    const tags = readTags(procRoot, pid);
    byPid.set(pid, {
      pid,
      ppid,
      cmdline,
      job: tags.ORCA_JOB || "",
      worker: tags.ORCA_WORKER || "",
      session: tags.AGENT_BROWSER_SESSION || SESSION_ARG.exec(cmdline)?.[1] || "",
      startMs: boot && start ? boot + start * 10 : 0,
      chromeRoot: /agent-browser-chrome-/.test(cmdline) && !/--type=/.test(cmdline),
    });
  }
  for (const p of byPid.values()) {
    // inherit from the nearest browser ancestors; stop on cycles
    let up = byPid.get(p.ppid);
    for (let hops = 0; up && hops < 64 && (!p.job || !p.session); hops++, up = byPid.get(up.ppid)) {
      if (!p.job && up.job) {
        p.job = up.job;
        p.worker = p.worker || up.worker;
      }
      if (!p.session && up.session) p.session = up.session;
    }
    p.ageMs = p.startMs ? Math.max(0, now - p.startMs) : 0;
  }
  return [...byPid.values()];
}

// Compat shape of the old tag-only finder.
export function findAttributed(opts) {
  return scanBrowsers(opts).filter((p) => p.job);
}

export function userDataDir(cmdline) {
  return /--user-data-dir[ =](\S+)/.exec(String(cmdline))?.[1] || "";
}

// Orphans: agent-browser Chrome roots whose parent is init (or the user systemd
// subreaper), older than minAgeMs, that no running job owns (by tag or by
// session prefix). Returns the roots and all their descendants.
export function selectOrphans(procs, { minAgeMs, liveJobIds = [], livePrefixes = [], isInitLike = defaultInitLike(procs) } = {}) {
  const live = new Set(liveJobIds.map(String));
  const owned = (p) => (p.job && live.has(p.job)) || livePrefixes.some((x) => p.session.startsWith(`${x}-`));
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) || []), p]);
  const out = [];
  for (const root of procs) {
    if (!root.chromeRoot || !isInitLike(root.ppid)) continue;
    if (root.ageMs < minAgeMs || owned(root)) continue;
    // Tagged for a job we cannot see (another repo's, or unknown): not ours to judge.
    if (root.job) continue;
    const tree = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      tree.push(p);
      stack.push(...(children.get(p.pid) || []));
    }
    if (tree.some(owned)) continue;
    out.push(...tree);
  }
  return out;
}

function defaultInitLike(procs) {
  const known = new Set(procs.map((p) => p.pid));
  // 1 is init; a parent we did not list as a browser process (systemd --user
  // subreaper) counts too unless it is an agent-browser daemon, which is listed.
  return (ppid) => ppid <= 1 || (!known.has(ppid) && subreaper(ppid));
}

function subreaper(pid, procRoot = procRootOf()) {
  return /systemd|init|subreaper|tini/.test(readCmdline(procRoot, pid));
}

export const SESSION_FILE_EXTS = [".config", ".target", ".pid", ".sock", ".stream", ".version", ".engine"];

// Session names agent-browser keeps state for, read from its socket dir.
// No process is spawned: `agent-browser session list` is not needed.
export function stateSessions(dir) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const names = new Set();
  for (const f of files) {
    const ext = SESSION_FILE_EXTS.find((e) => f.endsWith(e));
    if (ext) names.add(f.slice(0, -ext.length));
  }
  return [...names];
}

export function sessionPidAlive(dir, session, alive) {
  try {
    const pid = Number.parseInt(readFileSync(join(dir, `${session}.pid`), "utf8"), 10);
    return Number.isInteger(pid) && pid > 1 && alive(pid);
  } catch {
    return false;
  }
}

// Deletes the state files of a session whose daemon and Chrome are gone.
export function deleteSessionState(dir, session) {
  const removed = [];
  for (const ext of SESSION_FILE_EXTS) {
    const f = join(dir, `${session}${ext}`);
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed.push(f);
    }
  }
  return removed;
}
