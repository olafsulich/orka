import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync } from "node:fs";

const TERMINAL = new Set(["done", "failed", "stopped"]);
const WAIT_MS = 10 * 60 * 1000;
const IDLE_GRACE_MS = 60 * 1000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60 * 1000;
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

// Claude Code / Pi product popups that are not agent questions. Entry shape:
//   { name, match, keys }
// `match` runs on the ANSI-stripped bottom of the pane only (last
// HOUSEKEEPING_TAIL_LINES non-empty lines, where the active dialog sits), and
// must hit the dialog's own title text, never a loose phrase an agent question
// could contain. `keys` are sent via `herdr agent send-keys`, picking the least
// intrusive option ("Don't show again" > "Not now" > Esc). Update/tip notices
// are deliberately absent: their exact dialog text is unverified, and a loose
// regex would swallow real questions.
export const HOUSEKEEPING_TAIL_LINES = 15;
export const HOUSEKEEPING_POPUPS = [
  { name: "teach-auto-mode", match: /Teach auto mode about your environment\?/i, keys: ["down", "down", "enter"] },
  { name: "session-feedback", match: /How is (?:Claude|Pi) doing this session\?/i, keys: ["0"] },
];

export function matchHousekeeping(text) {
  const lines = String(text ?? "").replace(ANSI, "").split("\n").filter((l) => l.trim());
  const tail = lines.slice(-HOUSEKEEPING_TAIL_LINES).join("\n");
  return HOUSEKEEPING_POPUPS.find((p) => p.match.test(tail)) || null;
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

// Never exits because of herdr: a closed worker pane, a re-layout or a missing
// orchestrator agent only produce unknown/error statuses, which are retried with
// backoff (and logged once). It exits when the job is terminal or its file is
// gone. `goneLimit` (default: never) is only for tests.
export async function watchJob({ jobId, agent, pane, deps, waitMs = WAIT_MS, graceMs = IDLE_GRACE_MS, goneLimit = Infinity }) {
  const { loadJob, post, log = () => {} } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      log(`herdr call failed: ${err?.message || err}`);
      return fallback;
    }
  };
  const waitAgent = (a, s, t) => safe(() => deps.waitAgent(a, s, t), "unknown");
  const readPane = (p) => safe(() => deps.readPane(p), "");
  const sendKeys = deps.sendKeys ? (a, k) => safe(() => deps.sendKeys(a, k)) : null;
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
    let job = await safe(() => loadJob(jobId), undefined);
    if (job === undefined) {
      await sleep(RETRY_MIN_MS);
      continue;
    }
    if (isTerminal(job)) return { exit: "terminal" };

    // In an episode we already reported: just wait for the agent to resume working.
    const states = lastKey ? ["working"] : ["blocked", "idle"];
    const status = await waitAgent(agent, states, waitMs);

    if (status === "unknown" || status === "error" || !status) {
      gone += 1;
      if (gone >= goneLimit) return { exit: "agent-gone" };
      if (gone === 1) log(`orchestrator agent ${agent} not answering; retrying until the job finishes`);
      await sleep(Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(gone - 1, 6)));
      continue;
    }
    if (gone) log(`orchestrator agent ${agent} reachable again`);
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
        await safe(() => post(payload));
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
      await safe(() => post(payload));
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
