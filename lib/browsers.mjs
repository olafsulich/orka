// Finds browser processes that orca jobs started, by the ORCA_JOB / ORCA_WORKER
// env vars orca exports into every job pane. Children (agent-browser daemons,
// Chrome, chrome-devtools-mcp, Playwright) inherit them, so the tag survives
// when a daemon detaches and is reparented to init. Untagged processes are
// never touched.
import { readdirSync, readFileSync } from "node:fs";
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
export function findTaggedBrowsers({ procRoot = "/proc", selfPid = process.pid } = {}) {
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
export function selectReap(procs, { jobId = null, worker = null, finishedJobIds = [] } = {}) {
  const finished = new Set(finishedJobIds.map(String));
  return procs.filter((p) => {
    if (jobId != null && p.job === String(jobId)) return worker ? p.worker === String(worker) : true;
    return finished.has(p.job);
  });
}
