import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decide, hookPrompt, markerFile, piExtension, readMarker, runHook, slotOf } from "../lib/handoff-hook.mjs";
import { handoffSettings } from "../lib/context.mjs";

const HOOK = join(import.meta.dirname, "..", "lib", "handoff-hook.mjs");
const settings = handoffSettings(undefined);
const at = (pct, window = 1000000) => ({ tokens: Math.round(pct * window), window, pct, source: "claude statusline" });
const job = (extra = {}) => ({
  status: "running",
  kind: "claude",
  agent: "orch",
  sessionId: "lead-1",
  workers: [
    { name: "builder", sessionId: "w-1", model: "haiku" },
    { name: "verifier", role: "verifier", sessionId: "v-1" },
    { name: "old", sessionId: "w-0", retired: { by: "builder" } },
  ],
  ...extra,
});

test("decide: asks at 40% by default, not below; the note path follows the handoff number", () => {
  const base = { job: job(), jobDir: "/j", sessionId: "w-1", settings, marker: null, resultExists: () => false };
  assert.deepEqual(decide({ ...base, ctx: at(0.39) }), { ask: false, why: "39% < 40%" });
  const got = decide({ ...base, ctx: at(0.4) });
  assert.equal(got.ask, true);
  assert.equal(got.why, "40% >= 40%");
  assert.equal(got.note, "/j/handoff/builder-1.md");
  assert.match(got.text, /^orka: your context is at 40% \(400k of 1000k tokens, cap 40%\)/);
  assert.match(got.text, /run \/orka:handoff \/j\/handoff\/builder-1\.md role=worker/);
  const second = { ...job(), workers: [{ name: "builder", sessionId: "w-2", handoffs: [{ n: 1 }] }] };
  assert.equal(decide({ ...base, job: second, sessionId: "w-2", ctx: at(0.5) }).note, "/j/handoff/builder-2.md");
  const lead = decide({ ...base, sessionId: "lead-1", ctx: at(0.45) });
  assert.equal(lead.note, "/j/handoff/orchestrator-1.md");
  assert.match(lead.text, /role=orchestrator/);
});

test("decide: never for the verifier, a retired or finished worker, an unknown window, the cap, an ask in flight, a stopped job", () => {
  const base = { job: job(), jobDir: "/j", settings, marker: null, resultExists: () => false, ctx: at(0.9) };
  assert.equal(decide({ ...base, sessionId: "v-1" }).why, "not a measured pane");
  assert.equal(decide({ ...base, sessionId: "w-0" }).why, "not a measured pane");
  assert.equal(decide({ ...base, sessionId: "w-1", resultExists: (n) => n === "builder" }).why, "not a measured pane");
  assert.equal(decide({ ...base, sessionId: "w-1", ctx: { tokens: 5, window: null, pct: null } }).why, "window unknown");
  assert.equal(decide({ ...base, sessionId: "w-1", marker: { n: 1 } }).why, "already asked this session");
  const capped = job({ lead: { handoffs: [{}, {}, {}] } });
  assert.equal(decide({ ...base, job: capped, sessionId: "lead-1" }).why, "cap of 3 handoffs reached");
  const inFlight = job({ lead: { handoff: { state: "nudged" } } });
  assert.equal(decide({ ...base, job: inFlight, sessionId: "lead-1" }).why, "handoff already nudged");
  assert.equal(decide({ ...base, job: job({ status: "review" }), sessionId: "w-1" }).why, "job review");
  assert.equal(decide({ ...base, settings: handoffSettings(false), sessionId: "w-1" }).why, "handoff off");
  assert.equal(slotOf(job(), "lead-1", handoffSettings({ orchestrator: false })), null);
});

test("hookPrompt: pi is told to read the skill file", () => {
  const p = hookPrompt({ kind: "pi", path: "/n.md", role: "worker", context: at(0.42, 500000), threshold: 0.4, skillFile: "/s/SKILL.md" });
  assert.match(p, /210k of 500k tokens/);
  assert.match(p, /read \/s\/SKILL\.md and follow it with the arguments \/n\.md role=worker/);
});

// A job dir with a Claude transcript (tokens) and a statusline capture (window), like a real pane.
function box({ tokens = 420000, window = 1000000, handoff } = {}) {
  const base = mkdtempSync(join(tmpdir(), "orka-hook-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const jobDir = join(base, "jobs", "j1");
  const jobFile = join(base, "jobs", "j1.json");
  const configFile = join(base, "config.json");
  mkdirSync(join(jobDir, "context"), { recursive: true });
  writeFileSync(jobFile, JSON.stringify(job({ worktree: join(base, "wt") })));
  writeFileSync(configFile, JSON.stringify(handoff === undefined ? {} : { handoff }));
  const transcript = (sessionId, n = tokens) => {
    const path = join(base, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-haiku-5-5", usage: { input_tokens: 10, cache_read_input_tokens: n - 10, cache_creation_input_tokens: 0 } } })}\n`);
    writeFileSync(join(jobDir, "context", `${sessionId}.json`), JSON.stringify({ window, model: "claude-haiku-5-5" }));
    return path;
  };
  return { base, jobDir, jobFile, configFile, transcript, home: join(base, "home") };
}

test("runHook: asks once per session at or past the threshold; a successor's new session starts fresh", () => {
  const b = box();
  const args = { jobFile: b.jobFile, jobDir: b.jobDir, configFile: b.configFile, kind: "claude", home: b.home };
  const first = runHook({ ...args, sessionId: "w-1", transcriptPath: b.transcript("w-1") });
  assert.equal(first.ask, true, first.why);
  assert.deepEqual([first.record.n, first.record.pct, first.record.window, first.record.source], [1, 0.42, 1000000, "claude statusline"]);
  assert.deepEqual(readMarker(b.jobDir, "w-1").note, join(b.jobDir, "handoff", "builder-1.md"));
  const again = runHook({ ...args, sessionId: "w-1", transcriptPath: b.transcript("w-1", 600000) });
  assert.deepEqual(again, { ask: false, why: "already asked this session", steer: "" });
  // After the handoff the record has a fresh builder with a new session id and one handoff behind it.
  const j = JSON.parse(readFileSync(b.jobFile, "utf8"));
  j.workers = [{ name: "builder", sessionId: "w-2", handoffs: [{ n: 1 }] }];
  writeFileSync(b.jobFile, JSON.stringify(j));
  assert.equal(runHook({ ...args, sessionId: "w-2", transcriptPath: b.transcript("w-2", 100000) }).ask, false);
  const next = runHook({ ...args, sessionId: "w-2", transcriptPath: b.transcript("w-2", 450000) });
  assert.equal(next.ask, true);
  assert.equal(next.note, join(b.jobDir, "handoff", "builder-2.md"));
});

test("runHook: handoff.threshold from config, and quiet below it", () => {
  const b = box({ handoff: { threshold: 0.5 } });
  const args = { jobFile: b.jobFile, jobDir: b.jobDir, configFile: b.configFile, kind: "claude", home: b.home, sessionId: "w-1" };
  assert.deepEqual(runHook({ ...args, transcriptPath: b.transcript("w-1", 450000) }), { ask: false, why: "45% < 50%", steer: "" });
  assert.equal(existsSync(markerFile(b.jobDir, "w-1")), false);
});

test("Claude PostToolUse: the hook answers decision block with the ask once, then stays silent", () => {
  const b = box();
  const input = JSON.stringify({ session_id: "w-1", transcript_path: b.transcript("w-1"), hook_event_name: "PostToolUse", tool_name: "Read" });
  const run = () => spawnSync(process.execPath, [HOOK, "claude", b.jobFile, b.jobDir, b.configFile], { input, encoding: "utf8", env: { ...process.env, HOME: b.home } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /orka: your context is at 42% .*\nHand off now: .*run \/orka:handoff .*builder-1\.md role=worker/s);
  const second = run();
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "");
  const bad = spawnSync(process.execPath, [HOOK, "claude", b.jobFile, b.jobDir, b.configFile], { input: "not json", encoding: "utf8" });
  assert.deepEqual([bad.status, bad.stdout], [0, ""]);
});

test("Pi extension: tool_result reads the live usage and steers the ask once", async () => {
  const b = box();
  const handlers = {};
  const sent = [];
  const pi = { on: (name, fn) => (handlers[name] = fn), sendMessage: (msg, opts) => sent.push({ msg, opts }) };
  piExtension({ jobFile: b.jobFile, jobDir: b.jobDir, configFile: b.configFile })(pi);
  const ctx = (tokens) => ({
    getContextUsage: () => ({ tokens, contextWindow: 500000, percent: (tokens / 500000) * 100 }),
    model: { provider: "xai", id: "grok-4.7", contextWindow: 500000 },
    sessionManager: { getSessionId: () => "w-1" },
  });
  const j = JSON.parse(readFileSync(b.jobFile, "utf8"));
  j.workers[0].kind = "pi";
  writeFileSync(b.jobFile, JSON.stringify(j));
  await handlers.tool_result({}, ctx(150000));
  assert.equal(sent.length, 0, "30% stays quiet");
  await handlers.tool_result({}, ctx(205000));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.deliverAs, "steer");
  assert.equal(sent[0].msg.customType, "orka-handoff");
  assert.match(sent[0].msg.content, /41% \(205k of 500k tokens, cap 40%\)/);
  assert.match(sent[0].msg.content, /SKILL\.md and follow it with the arguments .*builder-1\.md role=worker/);
  assert.equal(readMarker(b.jobDir, "w-1").source, "pi runtime xai/grok-4.7");
  await handlers.tool_result({}, ctx(300000));
  assert.equal(sent.length, 1, "once per crossing");
  // A broken context never throws into pi.
  await handlers.tool_result({}, {});
});
