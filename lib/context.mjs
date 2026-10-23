// Context usage per pane, read from the agent's own session transcript, and the pure rules of a
// handoff (when, where the note goes, what the old and new agents are called and told).
// Claude: ~/.claude/projects/<slug>/<session-id>.jsonl, message.usage on type "assistant" lines.
// Pi:     ~/.pi/agent/sessions/--<slug>--/<ts>_<session-id>.jsonl, message.usage on role "assistant".
// Current context = the input side of the last assistant turn (input + cache read + cache write).
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_THRESHOLD = 0.4;
export const DEFAULT_MAX_HANDOFFS = 3;
// How often the watcher measures while a watched pane is working (idle panes keep the normal poll).
export const DEFAULT_BUSY_POLL_MS = 5000;
const TAIL_CHUNK = 256 * 1024;
const TAIL_MAX = 32 * 1024 * 1024;

export function claudeSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9-]/g, "-");
}

export function piSlug(cwd) {
  return `--${String(cwd).replace(/^\//, "").replace(/\//g, "-")}--`;
}

// The transcript of one session, or null. Looks in the cwd's folder first, then in every folder
// (Claude shortens very long slugs, so the expected folder can be missing).
export function findTranscript({ kind, cwd, sessionId, home }) {
  if (!sessionId || !home) return null;
  const pi = kind === "pi";
  const root = pi ? join(home, ".pi", "agent", "sessions") : join(home, ".claude", "projects");
  const match = pi ? (f) => f === `${sessionId}.jsonl` || f.endsWith(`_${sessionId}.jsonl`) : (f) => f === `${sessionId}.jsonl`;
  const inDir = (dir) => {
    try {
      const hit = readdirSync(dir).find(match);
      return hit ? join(dir, hit) : null;
    } catch {
      return null;
    }
  };
  const first = cwd ? inDir(join(root, pi ? piSlug(cwd) : claudeSlug(cwd))) : null;
  if (first) return first;
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const hit = inDir(join(root, d));
    if (hit) return hit;
  }
  return null;
}

// { tokens, model } of one jsonl line when it is an assistant turn with usage, else null.
export function lineUsage(line) {
  if (!line || !line.includes("usage")) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const m = o?.message;
  if (!m || typeof m !== "object" || !m.usage) return null;
  if (o.type !== "assistant" && m.role !== "assistant") return null;
  const u = m.usage;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  // Claude names: input_tokens, cache_read_input_tokens, cache_creation_input_tokens. Pi: input, cacheRead, cacheWrite.
  const tokens = "input_tokens" in u || "cache_read_input_tokens" in u
    ? n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
    : n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
  // A zero-input turn (an aborted or synthetic message) says nothing about the context.
  if (!tokens) return null;
  return { tokens, model: String(m.model || o.model || ""), ...(m.provider ? { provider: String(m.provider) } : {}) };
}

// The last assistant usage in a transcript text, or null.
export function lastUsage(text) {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const got = lineUsage(lines[i].trim());
    if (got) return got;
  }
  return null;
}

// Reads the file from the end in growing chunks, so a long transcript costs one small read.
export function readUsage(path) {
  let fd;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    for (let want = TAIL_CHUNK; ; want *= 4) {
      const n = Math.min(size, want, TAIL_MAX);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, size - n);
      let text = buf.toString("utf8");
      // The first line of a partial read is cut; drop it.
      if (n < size) text = text.slice(text.indexOf("\n") + 1);
      const got = lastUsage(text);
      if (got || n >= size || n >= TAIL_MAX) return got;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// handoff.contextWindow: a number (every model) or { "<substring or /regex/>": tokens }. null when
// it does not cover this model.
export function overrideWindow(model, override) {
  const m = String(model || "");
  if (Number(override) > 0) return Number(override);
  if (override && typeof override === "object") {
    for (const [key, size] of Object.entries(override)) {
      if (!(Number(size) > 0)) continue;
      const re = /^\/(.+)\/([a-z]*)$/.exec(key);
      if (re ? new RegExp(re[1], re[2]).test(m) : m.includes(key)) return Number(size);
    }
  }
  return null;
}

// What lib/statusline.mjs captured for one Claude session: Claude Code's own statusline JSON, cut to
// { at, model, window, tokens, pct }. null when the pane never drew its statusline.
export function captureFile(dir, sessionId) {
  return join(dir, `${sessionId}.json`);
}

export function readCapture(dir, sessionId) {
  if (!dir || !sessionId) return null;
  try {
    const got = JSON.parse(readFileSync(captureFile(dir, sessionId), "utf8"));
    return Number(got?.window) > 0 ? got : null;
  } catch {
    return null;
  }
}

// Pi's model registry: models-store.json (the catalog pi update writes) and models.json (the user's
// own models), both { <provider>: { models: [{ id, contextWindow }] } } (models.json may nest it
// under "providers"). Later files win.
export function readPiRegistry(home) {
  const out = {};
  for (const f of ["models-store.json", "models.json"]) {
    let got;
    try {
      got = JSON.parse(readFileSync(join(home, ".pi", "agent", f), "utf8"));
    } catch {
      continue;
    }
    const providers = got?.providers && typeof got.providers === "object" ? got.providers : got;
    for (const [provider, v] of Object.entries(providers || {})) {
      for (const m of Array.isArray(v?.models) ? v.models : []) {
        if (m?.id && Number(m.contextWindow) > 0) out[`${provider}/${m.id}`] = Number(m.contextWindow);
      }
    }
  }
  return out;
}

// The window of one pane, never guessed. First hit wins:
// 1. what the runtime reports: Claude's statusline context_window_size (capture), a [1m] model id
//    (Claude's own 1M suffix), Pi's registry contextWindow for the session's provider/model;
// 2. handoff.contextWindow, an explicit user override;
// 3. nothing: { window: null, source: "unknown" }, and the pane gets no automatic handoff.
export function detectWindow({ kind, model, provider, alias, capture, piRegistry, override }) {
  if (kind !== "pi") {
    if (Number(capture?.window) > 0) return { window: Number(capture.window), source: "claude statusline" };
    const id = [alias, model, capture?.model].find((x) => /\[1m\]/i.test(String(x || "")));
    if (id) return { window: 1000000, source: `model id ${id}` };
  } else if (piRegistry && model) {
    const key = provider ? `${provider}/${model}` : Object.keys(piRegistry).find((k) => k.endsWith(`/${model}`));
    if (key && piRegistry[key]) return { window: piRegistry[key], source: `pi registry ${key}` };
  }
  const forced = overrideWindow(model || alias, override);
  if (forced) return { window: forced, source: "handoff.contextWindow" };
  return { window: null, source: "unknown" };
}

// config: the "handoff" value of .orka/config.json. false turns handoffs off.
// orchestrator is on unless set to false; maxHandoffs caps the handoffs of one pane's task.
export function handoffSettings(config) {
  const off = { enabled: false, threshold: DEFAULT_THRESHOLD, orchestrator: false, contextWindow: null, maxHandoffs: DEFAULT_MAX_HANDOFFS, busyPollMs: 0 };
  if (config === false) return off;
  const c = config && typeof config === "object" ? config : {};
  const t = Number(c.threshold);
  const max = Number(c.maxHandoffs);
  const busy = Number(c.busyPollMs);
  return {
    enabled: c.enabled !== false,
    threshold: t > 0 && t <= 1 ? t : DEFAULT_THRESHOLD,
    orchestrator: c.orchestrator !== false,
    contextWindow: c.contextWindow ?? null,
    maxHandoffs: Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX_HANDOFFS,
    // 0 turns the fast poll off.
    busyPollMs: c.busyPollMs === 0 ? 0 : busy >= 1000 ? busy : DEFAULT_BUSY_POLL_MS,
  };
}

// usage: { tokens, model } from the transcript; win: detectWindow's answer. pct is null when the
// window is unknown.
export function contextOf(usage, win) {
  if (!usage) return null;
  const window = win?.window || null;
  return { tokens: usage.tokens, window, pct: window ? usage.tokens / window : null, model: usage.model, source: win?.source || "unknown" };
}

export const windowLabel = (c) => (c?.window ? `${Math.round(c.window / 1000)}k (${c.source})` : "window unknown");

export const pctLabel = (pct) => `${Math.round(pct * 100)}%`;

// Which workers the watcher measures: live builders that started with a session id and have not
// finished (a written result file means the task is done; a fresh agent would have nothing to do).
export function handoffCandidate(worker, { resultExists = false } = {}) {
  if (!worker || worker.role === "verifier" || worker.closed || worker.retired || !worker.sessionId) return false;
  if (worker.handoff && worker.handoff.state !== "done") return false;
  return !resultExists;
}

// Safe points: herdr says idle, or done (the turn finished and nobody looked at the pane yet).
export const SAFE_STATUSES = ["idle", "done"];

// The decision for one pane at or past the cap. At a safe point orka runs the handoff skill now;
// while the agent works, a queued message tells it to run the skill at its next clean stopping
// point (Claude and Pi both deliver a message typed mid-turn after the current tool call, so the
// turn is never interrupted). blocked or unknown: wait.
export function handoffDue({ context, status, threshold }) {
  if (!context) return { due: false, why: "no usage yet" };
  if (!context.window) return { due: false, why: "window unknown" };
  if (context.pct < threshold) return { due: false, why: `${pctLabel(context.pct)} < ${pctLabel(threshold)}` };
  if (SAFE_STATUSES.includes(status)) return { due: true, mode: "now", why: `${pctLabel(context.pct)} >= ${pctLabel(threshold)}` };
  if (status === "working") return { due: true, mode: "queue", why: `${pctLabel(context.pct)} >= ${pctLabel(threshold)} while working` };
  return { due: false, why: `${pctLabel(context.pct)} but ${status || "unknown"}` };
}

// The cap on one task's handoffs (a successor that is due again at once would loop).
export function capReached(handoffs, max) {
  return (Array.isArray(handoffs) ? handoffs.length : 0) >= max;
}

// n counts the handoffs of one task: 1 for the first agent's note, 2 for its successor's...
export function handoffNumber(worker) {
  return (Array.isArray(worker?.handoffs) ? worker.handoffs.length : 0) + 1;
}

export function notePath(jobDir, name, n) {
  return join(jobDir, "handoff", `${name}-${n}.md`);
}

// The old agent's new herdr name. herdr names are at most 32 characters, so the base is cut to fit.
export function retiredName(name, n) {
  const suffix = `-h${n}`;
  return `${String(name).slice(0, 32 - suffix.length)}${suffix}`;
}

// The handoff skill ships in plugin/ (Matt Pocock's mattpocock/skills productivity/handoff, adapted):
// claude panes load it with --plugin-dir as orka:handoff, pi panes with --skill as handoff.
export function skillCommand(kind, path, role) {
  return `${kind === "pi" ? "/skill:handoff" : "/orka:handoff"} ${path} role=${role}`;
}

const capLine = (context, threshold) =>
  context?.window
    ? `orka: your context is at ${pctLabel(context.pct)} (${Math.round(context.tokens / 1000)}k of ${Math.round(context.window / 1000)}k tokens, cap ${pctLabel(threshold)}). A fresh agent will take over.`
    : `orka: a handoff was asked for by hand. A fresh agent will take over.`;

// Sent at a safe point: the slash command runs the skill at once.
export function notePrompt({ kind, path, role, context, threshold }) {
  return `${skillCommand(kind, path, role)}\n${capLine(context, threshold)}`;
}

// Queued while the agent works: it runs the skill itself at its next clean stopping point.
export function nudgePrompt({ kind, path, role, context, threshold, skillFile }) {
  return [
    capLine(context, threshold),
    `At your next clean stopping point (finish the step you are on, start nothing new), run the handoff skill: ${skillCommand(kind, path, role)}`,
    `If you cannot run it, read ${skillFile} and follow it with those arguments. Then end your turn.`,
  ].join("\n");
}

export function successorLines({ path, n, from }) {
  return [
    ``,
    `HANDOFF (h${n}): you continue this task from an earlier agent (${from}) that reached its context cap.`,
    `Read ${path} first. Then do its Remaining slice. Do not redo what it lists as done; check git log and git status instead of re-reading everything.`,
    `The earlier pane (${from}) stays open and idle. Do not prompt it or close it.`,
  ].join("\n");
}

// The fresh orchestrator resumes from the note, the job record and the decision log.
export function leadSuccessorLines({ path, n, from, jobFile, decisions, id }) {
  return [
    ``,
    `HANDOFF (h${n}): you take over as orchestrator from an earlier agent (${from}) that reached its context cap. The job is already running; do not start it again.`,
    `Read, in this order: ${path} (the note), ${jobFile} (workers, verifier rounds, steers), ${decisions} (decisions so far). Then run orka digest ${id} for the workers' results and notes.`,
    `Workers already started keep running under their names and report to you (they prompt this agent's name). Do not restart, re-task or close any worker or verifier pane. Start a worker only for work the note lists as not yet assigned.`,
    `The earlier pane (${from}) stays open and idle. Do not prompt it or close it. Continue from the note's Next steps.`,
  ].join("\n");
}
