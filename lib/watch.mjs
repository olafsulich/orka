import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync } from "node:fs";

const TERMINAL = new Set(["done", "failed", "stopped"]);
const WAIT_MS = 10 * 60 * 1000;
const IDLE_GRACE_MS = 60 * 1000;
const GONE_LIMIT = 3;
const MAX_DISMISSALS = 3;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const BOX_ONLY = /^[\s─-╿▀-▟]*$/u;

export function extractQuestion(text, max = 1500) {
  const lines = String(text ?? "")
    .replace(ANSI, "")
    .replaceAll("\r", "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  // Frame characters around a line (│ ... │) are decoration, not content.
  const cleaned = lines.map((l) => l.replace(/^[\s│┃]+/u, (m) => (/[│┃]/u.test(m) ? "" : m)).replace(/[\s│┃]+$/u, ""));
  const meaningful = cleaned.map((l) => (BOX_ONLY.test(l) ? "" : l));
  while (meaningful.length && !meaningful[meaningful.length - 1].trim()) meaningful.pop();
  const OPTION = /^\s*(?:[❯>›▶→]\s*)?\(?\d+[.)]\s|^\s*[❯>›▶→]\s/u;
  let start = meaningful.length;
  const back = () => {
    while (start > 0 && meaningful[start - 1].trim()) start -= 1;
  };
  back();
  // A block of only options is incomplete: pull in the question above it.
  while (start > 0 && meaningful.slice(start).filter((l) => l.trim()).every((l) => OPTION.test(l))) {
    while (start > 0 && !meaningful[start - 1].trim()) start -= 1;
    back();
  }
  const out = meaningful.slice(start).join("\n").trim();
  return out.length > max ? out.slice(out.length - max) : out;
}

// Claude Code / Pi product popups that are not agent questions. Add an entry to
// teach the watcher a new one: `match` runs on the ANSI-stripped pane text and
// `keys` are sent via `herdr agent send-keys`, picking the least intrusive
// option ("Don't show again" > "Not now" > Esc).
export const HOUSEKEEPING_POPUPS = [
  { name: "teach-auto-mode", match: /Teach auto mode about your environment\?/i, keys: ["down", "down", "enter"] },
  { name: "session-feedback", match: /How is (?:Claude|Pi) doing this session\?/i, keys: ["0"] },
  { name: "update-available", match: /(?:update available|new version (?:of \w+ )?is available)/i, keys: ["esc"] },
  { name: "tips", match: /^\s*(?:[│┃]\s*)?(?:Tip|Tips):.*\n?.*(?:Don't show again|Not now)/im, keys: ["esc"] },
];

export function matchHousekeeping(text) {
  const clean = String(text ?? "").replace(ANSI, "");
  return HOUSEKEEPING_POPUPS.find((p) => p.match.test(clean)) || null;
}

export function episodeKey(status, question) {
  return createHash("sha256").update(`${status}\n${question}`).digest("hex").slice(0, 16);
}

export function needsInputPayload({ job, status, paneText, pane }) {
  return {
    kind: "needs-input",
    job: job.id,
    title: job.title,
    status: status === "blocked" ? "blocked" : "idle",
    question: extractQuestion(paneText),
    pane,
  };
}

export async function watchJob({ jobId, agent, pane, deps, waitMs = WAIT_MS, graceMs = IDLE_GRACE_MS }) {
  const { loadJob, waitAgent, readPane, post, sendKeys, log = () => {} } = deps;
  let lastKey = null;
  let dismissals = 0;
  // True when the pane shows a known housekeeping popup that we dismissed.
  // After a few dismissals in a row it stops, so a stuck popup still alerts.
  const dismissHousekeeping = async (paneText) => {
    const popup = matchHousekeeping(paneText);
    if (!popup || !sendKeys || dismissals >= MAX_DISMISSALS) return false;
    dismissals += 1;
    await sendKeys(agent, popup.keys);
    log(`housekeeping-dismissed ${jobId} ${popup.name}`);
    return true;
  };
  let gone = 0;
  const isTerminal = (job) => !job || TERMINAL.has(job.status);

  for (;;) {
    let job = await loadJob(jobId);
    if (isTerminal(job)) return { exit: "terminal" };

    // In an episode we already reported: just wait for the agent to resume working.
    const states = lastKey ? ["working"] : ["blocked", "idle"];
    const status = await waitAgent(agent, states, waitMs);

    if (status === "unknown" || status === "error" || !status) {
      gone += 1;
      if (gone >= GONE_LIMIT) return { exit: "agent-gone" };
      continue;
    }
    gone = 0;

    if (status === "working") {
      lastKey = null;
      dismissals = 0;
      continue;
    }
    if (lastKey) continue;

    if (status === "blocked") {
      job = await loadJob(jobId);
      if (isTerminal(job)) return { exit: "terminal" };
      const paneText = await readPane(pane);
      if (await dismissHousekeeping(paneText)) continue;
      const payload = needsInputPayload({ job, status, paneText, pane });
      const key = episodeKey("blocked", payload.question);
      if (key !== lastKey) {
        lastKey = key;
        log(`needs-input blocked ${jobId}`);
        await post(payload);
      }
    } else if (status === "idle") {
      // Grace: the orchestrator may be about to call orca done, or resume.
      const after = await waitAgent(agent, ["working", "blocked"], graceMs);
      if (after !== "idle") {
        if (after === "working") lastKey = null;
        continue;
      }
      job = await loadJob(jobId);
      if (isTerminal(job)) return { exit: "terminal" };
      const paneText = await readPane(pane);
      if (await dismissHousekeeping(paneText)) continue;
      const payload = needsInputPayload({ job, status: "idle", paneText, pane });
      lastKey = episodeKey("idle", payload.question);
      log(`needs-input idle ${jobId}`);
      await post(payload);
    }
  }
}

function paneTextOf(got) {
  const r = got.json?.result;
  const t = r?.read?.text ?? r?.text ?? r?.output ?? r?.read;
  return typeof t === "string" ? t : got.text;
}

export function defaultDeps(repo) {
  const run = (args, timeout) => {
    const r = spawnSync("herdr", args, { encoding: "utf8", timeout, cwd: repo });
    const text = `${r.stdout || ""}${r.stderr || ""}`;
    let json = null;
    try {
      json = JSON.parse(text.trim());
    } catch {}
    return { code: r.status ?? 1, text, json };
  };
  return {
    waitAgent(agent, until, timeoutMs) {
      const args = ["agent", "wait", agent, "--timeout", String(timeoutMs)];
      for (const s of until) args.push("--until", s);
      run(args, timeoutMs + 15000);
      const got = run(["agent", "get", agent], 30000);
      return got.json?.result?.agent?.agent_status || "unknown";
    },
    readPane(pane) {
      return paneTextOf(run(["pane", "read", pane, "--source", "recent", "--lines", "80", "--format", "ansi"], 30000));
    },
    sendKeys(agent, keys) {
      return run(["agent", "send-keys", agent, ...keys], 30000);
    },
    loadJob: null,
    post: null,
    log: () => {},
    now: () => Date.now(),
  };
}

export function spawnWatcher({ orcaBin, jobId, repo, logPath }) {
  const out = logPath ? openSync(logPath, "a") : "ignore";
  const child = spawn(process.execPath, [orcaBin, "watch", jobId, "--cwd", repo], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}
