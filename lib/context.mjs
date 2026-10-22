// Context usage per pane, read from the agent's own session transcript, and the pure rules of a
// handoff (when, where the note goes, what the old and new agents are called and told).
// Claude: ~/.claude/projects/<slug>/<session-id>.jsonl, message.usage on type "assistant" lines.
// Pi:     ~/.pi/agent/sessions/--<slug>--/<ts>_<session-id>.jsonl, message.usage on role "assistant".
// Current context = the input side of the last assistant turn (input + cache read + cache write).
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_WINDOW = 200000;
// First match wins. Model ids come from the transcript (claude-sonnet-5-5, grok-4.7, ...).
// The transcript has no window size, so this is a guess per family; handoff.contextWindow overrides it.
export const WINDOWS = [
  [/\[1m\]|-1m\b/i, 1000000],
  [/claude|opus|sonnet|haiku/i, 200000],
];
export const NOTE_WORDS = 200;
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
  return { tokens, model: String(m.model || o.model || "") };
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

// override: a number (every model) or { "<substring or /regex/>": tokens } checked before the table.
export function contextWindow(model, override) {
  const m = String(model || "");
  if (Number(override) > 0) return Number(override);
  if (override && typeof override === "object") {
    for (const [key, size] of Object.entries(override)) {
      if (!(Number(size) > 0)) continue;
      const re = /^\/(.+)\/([a-z]*)$/.exec(key);
      if (re ? new RegExp(re[1], re[2]).test(m) : m.includes(key)) return Number(size);
    }
  }
  for (const [re, size] of WINDOWS) if (re.test(m)) return size;
  return DEFAULT_WINDOW;
}

// config: the "handoff" value of .orka/config.json. false turns handoffs off.
export function handoffSettings(config) {
  if (config === false) return { enabled: false, threshold: DEFAULT_THRESHOLD, orchestrator: false, contextWindow: null };
  const c = config && typeof config === "object" ? config : {};
  const t = Number(c.threshold);
  return {
    enabled: c.enabled !== false,
    threshold: t > 0 && t <= 1 ? t : DEFAULT_THRESHOLD,
    orchestrator: c.orchestrator === true,
    contextWindow: c.contextWindow ?? null,
  };
}

export function contextOf(usage, override) {
  if (!usage) return null;
  const window = contextWindow(usage.model, override);
  return { tokens: usage.tokens, window, pct: usage.tokens / window, model: usage.model };
}

export const pctLabel = (pct) => `${Math.round(pct * 100)}%`;

// Which workers the watcher measures: live builders that started with a session id and have not
// finished (a written result file means the task is done; a fresh agent would have nothing to do).
export function handoffCandidate(worker, { resultExists = false } = {}) {
  if (!worker || worker.role === "verifier" || worker.closed || worker.retired || !worker.sessionId) return false;
  if (worker.handoff && worker.handoff.state !== "done") return false;
  return !resultExists;
}

// The decision for one candidate: hand off only when it is idle and at or past the threshold.
export function handoffDue({ context, status, threshold }) {
  if (!context) return { due: false, why: "no usage yet" };
  if (context.pct < threshold) return { due: false, why: `${pctLabel(context.pct)} < ${pctLabel(threshold)}` };
  if (status !== "idle") return { due: false, why: `${pctLabel(context.pct)} but ${status || "unknown"}` };
  return { due: true, why: `${pctLabel(context.pct)} >= ${pctLabel(threshold)}` };
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

// Matt Pocock's handoff skill (mattpocock/skills productivity/handoff), adapted: orka fixes the path,
// orka triggers it, "suggested skills" became next commands, and the sections are Limen's
// final-message checklist (templates/worker.md).
export function notePrompt({ path, context, threshold }) {
  return [
    `orka: your context is at ${pctLabel(context.pct)} (${Math.round(context.tokens / 1000)}k of ${Math.round(context.window / 1000)}k tokens, cap ${pctLabel(threshold)}). A fresh agent will take over your task.`,
    `Write a handoff note so it can continue, then end your turn. Start no new work. Do not write your results file or notes line, and do not message the orchestrator.`,
    `Write the note to: ${path}`,
    `At most ~${NOTE_WORDS} words. Do not duplicate what other artifacts hold (your task brief, commits, diffs, decisions.tsv, results/ and notes/): point to them by path, SHA or command, never paste them. Redact secrets.`,
    `Sections, in order:`,
    `- Changes: files touched, paths only.`,
    `- Checks run: only commands you actually ran, with pass/fail.`,
    `- Commits: SHA and one line each, or "none".`,
    `- Still running: servers, browser sessions, background processes, anything outside the worktree.`,
    `- Notes: decisions, dead ends, what not to redo.`,
    `- Remaining slice: what is left of your task, the next concrete step first.`,
    `- Next commands: the commands or checks the next agent should run first.`,
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
