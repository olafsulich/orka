// Context handoff asked by the agent's own hook, not only by the watcher's poll: Claude Code runs
// this file as a PostToolUse hook (node lib/handoff-hook.mjs claude <job file> <job dir> <config>),
// Pi loads piExtension() as an extension on tool_result. After each tool call it measures the pane
// and, once per session, at or past handoff.threshold, tells the model to run the handoff skill now.
// The ask is recorded in <job dir>/context/<session-id>.hook.json; the watcher adopts that marker as
// a "nudged" handoff (mode hook) and never asks the same pane again, and the hook stays quiet while
// the watcher's own ask is in flight. A successor has a new session id, so it starts with no marker.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as context from "./context.mjs";
import * as inbox from "./inbox.mjs";

const SKILL_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "skills", "handoff", "SKILL.md");
const PENDING = new Set(["nudged", "writing", "failed"]);

export const markerFile = (jobDir, sessionId) => join(jobDir, "context", `${sessionId}.hook.json`);

export function readMarker(jobDir, sessionId) {
  if (!jobDir || !sessionId) return null;
  try {
    return JSON.parse(readFileSync(markerFile(jobDir, sessionId), "utf8"));
  } catch {
    return null;
  }
}

// The pane this session is, from the job record: the orchestrator or a measured builder. null for
// the verifier, a retired or finished worker, or a session orka does not know.
export function slotOf(job, sessionId, settings, { resultExists = () => false } = {}) {
  if (!job || !sessionId) return null;
  if (job.sessionId === sessionId) {
    if (!settings.orchestrator) return null;
    return { role: "orchestrator", name: job.agent, base: "orchestrator", kind: job.kind === "pi" ? "pi" : "claude", alias: job.orchestratorModel || job.model || "", rec: job.lead || {} };
  }
  const w = (job.workers || []).find((x) => x?.sessionId === sessionId);
  if (!w || !context.handoffCandidate(w, { resultExists: resultExists(w.name) })) return null;
  return { role: "worker", name: w.name, base: w.name, kind: w.kind === "pi" ? "pi" : "claude", alias: w.model || "", rec: w };
}

// Told after a tool call: run the skill now, before anything else.
export function hookPrompt({ kind, path, role, context: c, threshold, skillFile = SKILL_FILE }) {
  const run = kind === "pi" ? `read ${skillFile} and follow it with the arguments ${path} role=${role}` : `run /orka:handoff ${path} role=${role} (the orka:handoff skill)`;
  return [
    `orka: your context is at ${context.pctLabel(c.pct)} (${Math.round(c.tokens / 1000)}k of ${Math.round(c.window / 1000)}k tokens, cap ${context.pctLabel(threshold)}). A fresh agent will take over.`,
    `Hand off now: start no new step and make no other tool call first; ${run}.`,
    kind === "pi" ? `Then end your turn.` : `If the skill is not available, read ${skillFile} and follow it with those arguments. Then end your turn.`,
  ].join("\n");
}

// The decision for one tool call. Pure: { ask, why } plus { n, note, text, slot } when it asks.
export function decide({ job, jobDir, sessionId, settings, ctx, marker, resultExists }) {
  if (!settings.enabled) return { ask: false, why: "handoff off" };
  if (job?.status !== "running") return { ask: false, why: `job ${job?.status || "missing"}` };
  const slot = slotOf(job, sessionId, settings, { resultExists });
  if (!slot) return { ask: false, why: "not a measured pane" };
  if (marker) return { ask: false, why: "already asked this session" };
  if (PENDING.has(slot.rec.handoff?.state)) return { ask: false, why: `handoff already ${slot.rec.handoff.state}` };
  if (context.capReached(slot.rec.handoffs, settings.maxHandoffs)) return { ask: false, why: `cap of ${settings.maxHandoffs} handoffs reached` };
  if (!ctx) return { ask: false, why: "no usage yet" };
  if (!ctx.window) return { ask: false, why: "window unknown" };
  if (ctx.pct < settings.threshold) return { ask: false, why: `${context.pctLabel(ctx.pct)} < ${context.pctLabel(settings.threshold)}` };
  const n = context.handoffNumber(slot.rec);
  const note = context.notePath(jobDir, slot.base, n);
  const text = hookPrompt({ kind: slot.kind, path: note, role: slot.role, context: ctx, threshold: settings.threshold });
  return { ask: true, why: `${context.pctLabel(ctx.pct)} >= ${context.pctLabel(settings.threshold)}`, n, note, text, slot };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Measures the pane the way the watcher does (transcript tail and the detected window), unless the
// runtime hands over a live reading ({ tokens, window, source }).
function measure({ kind, job, jobDir, sessionId, transcriptPath, alias, settings, live, home }) {
  if (live && Number(live.tokens) > 0 && Number(live.window) > 0) {
    return { tokens: Number(live.tokens), window: Number(live.window), pct: Number(live.tokens) / Number(live.window), source: live.source || `${kind} runtime` };
  }
  const path = transcriptPath && existsSync(transcriptPath) ? transcriptPath : context.findTranscript({ kind, cwd: job.worktree, sessionId, home });
  const usage = path ? context.readUsage(path) : null;
  if (!usage) return null;
  const pi = kind === "pi";
  const win = context.detectWindow({
    kind,
    model: usage.model,
    provider: usage.provider,
    alias,
    capture: pi ? null : context.readCapture(join(jobDir, "context"), sessionId),
    piRegistry: pi ? context.readPiRegistry(home) : null,
    override: settings.contextWindow,
  });
  return context.contextOf(usage, win);
}

// Whose inbox this session reads: "orchestrator" for the current lead, a live worker's name, or null
// (a retired pane, or a pane mid-handoff: its successor gets the messages).
export function inboxTarget(job, sessionId) {
  if (!job || !sessionId || job.status !== "running") return null;
  if (job.sessionId === sessionId) return PENDING.has(job.lead?.handoff?.state) ? null : "orchestrator";
  const w = (job.workers || []).find((x) => x?.sessionId === sessionId);
  if (!w || w.retired || w.closed || (w.handoff && w.handoff.state !== "done")) return null;
  return w.name;
}

// Pending steers for this pane, claimed for delivery now: the text, or "".
export function takeSteers({ job, jobDir, sessionId, via }) {
  const target = inboxTarget(job, sessionId);
  if (!target) return "";
  const entries = inbox.claim(jobDir, target, via);
  return entries.length ? inbox.deliveryText(entries) : "";
}

// One hook call: the handoff ask (once per session, marker written) and any steers waiting in the
// pane's inbox. { ask, text?, steer }.
export function runHook(opts) {
  const got = handoffAsk(opts);
  const job = readJson(opts.jobFile);
  const steer = takeSteers({ job, jobDir: opts.jobDir, sessionId: opts.sessionId, via: `${opts.kind} hook` });
  return { ...got, steer };
}

// The handoff half of a hook call. Writes the marker when it asks, so the next tool call stays quiet.
function handoffAsk({ jobFile, jobDir, configFile, sessionId, kind, transcriptPath = "", live = null, home = homedir(), now = () => new Date().toISOString() }) {
  const job = readJson(jobFile);
  const settings = context.handoffSettings(readJson(configFile)?.handoff);
  const resultExists = (name) => existsSync(join(jobDir, "results", `${name}.json`));
  const marker = readMarker(jobDir, sessionId);
  const slot = job ? slotOf(job, sessionId, settings, { resultExists }) : null;
  const ctx = slot && !marker && settings.enabled ? measure({ kind, job, jobDir, sessionId, transcriptPath, alias: slot.alias, settings, live, home }) : null;
  const got = decide({ job, jobDir, sessionId, settings, ctx, marker, resultExists });
  if (!got.ask) return got;
  mkdirSync(join(jobDir, "context"), { recursive: true });
  mkdirSync(dirname(got.note), { recursive: true });
  const record = { sessionId, kind, role: got.slot.role, name: got.slot.name, n: got.n, note: got.note, tokens: ctx.tokens, window: ctx.window, source: ctx.source, pct: Math.round(ctx.pct * 1000) / 1000, at: now() };
  writeFileSync(markerFile(jobDir, sessionId), `${JSON.stringify(record)}\n`);
  return { ...got, record };
}

// Pi: a factory for the per-job extension file orka writes (<job dir>/context/pi-handoff.mjs).
// tool_result fires after each tool call; the ask is queued as a steer, delivered after the current
// tool calls and before the next model call.
export function piExtension({ jobFile, jobDir, configFile }) {
  return function orkaHandoff(pi) {
    pi.on("tool_result", async (_event, ctx) => {
      try {
        const usage = ctx.getContextUsage?.();
        const window = Number(usage?.contextWindow) || Number(ctx.model?.contextWindow) || 0;
        const live = usage && usage.tokens != null && window ? { tokens: usage.tokens, window, source: `pi runtime ${ctx.model?.provider || ""}/${ctx.model?.id || ""}` } : null;
        const got = runHook({ jobFile, jobDir, configFile, sessionId: ctx.sessionManager.getSessionId(), kind: "pi", live });
        if (got.steer) pi.sendMessage({ customType: "orka-inbox", content: got.steer, display: true }, { deliverAs: "steer" });
        if (got.ask) pi.sendMessage({ customType: "orka-handoff", content: got.text, display: true }, { deliverAs: "steer" });
      } catch {
        // a hook never breaks the agent's turn; the watcher's poll is the fallback
      }
    });
  };
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// Claude Code PostToolUse: stdin is the hook JSON (session_id, transcript_path, ...). A
// {"decision":"block","reason"} answer is fed to the model after the tool result; silence otherwise.
async function main(argv) {
  const [kind, jobFile, jobDir, configFile] = argv;
  if (kind !== "claude") return;
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const got = runHook({ jobFile: resolve(jobFile), jobDir: resolve(jobDir), configFile: resolve(configFile), sessionId: input.session_id, kind, transcriptPath: input.transcript_path || "" });
  const reason = [got.steer, got.ask ? got.text : ""].filter(Boolean).join("\n\n");
  if (reason) process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {});
}
