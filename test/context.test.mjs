import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as ctx from "../lib/context.mjs";

const FIX = join(import.meta.dirname, "fixtures", "context");

function home() {
  const base = mkdtempSync(join(tmpdir(), "orka-context-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  return base;
}

test("claude transcript: last assistant usage is input + cache read + cache creation, zero turns skipped", () => {
  const got = ctx.lastUsage(readFileSync(join(FIX, "claude.jsonl"), "utf8"));
  assert.deepEqual(got, { tokens: 5 + 1824 + 123000, model: "claude-sonnet-5-5" });
});

test("pi transcript: last assistant usage is input + cacheRead + cacheWrite, tool results ignored", () => {
  const got = ctx.lastUsage(readFileSync(join(FIX, "pi.jsonl"), "utf8"));
  assert.deepEqual(got, { tokens: 82 + 89344, model: "grok-4.7", provider: "xai" });
});

test("no usage, broken lines and user lines give null", () => {
  assert.equal(ctx.lastUsage(""), null);
  assert.equal(ctx.lastUsage('{"type":"user","message":{"role":"user","usage":{"input_tokens":5}}}\n{not json usage'), null);
});

test("readUsage reads only the tail of a long transcript and still finds the last turn", () => {
  const dir = home();
  const path = join(dir, "long.jsonl");
  writeFileSync(path, readFileSync(join(FIX, "claude.jsonl"), "utf8"));
  const filler = `${JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(4000) } })}\n`;
  for (let i = 0; i < 200; i++) appendFileSync(path, filler);
  assert.equal(ctx.readUsage(path).tokens, 124829);
  assert.equal(ctx.readUsage(join(dir, "missing.jsonl")), null);
});

test("findTranscript: claude <slug>/<id>.jsonl, pi --<slug>--/<ts>_<id>.jsonl, any folder as fallback", () => {
  const h = home();
  const cwd = "/home/u/projects/app/.orka/worktrees/20261022-x";
  assert.equal(ctx.claudeSlug(cwd), "-home-u-projects-app--orka-worktrees-20261022-x");
  assert.equal(ctx.piSlug(cwd), "--home-u-projects-app-.orka-worktrees-20261022-x--");
  const c = join(h, ".claude", "projects", ctx.claudeSlug(cwd));
  mkdirSync(c, { recursive: true });
  copyFileSync(join(FIX, "claude.jsonl"), join(c, "aaa.jsonl"));
  assert.equal(ctx.findTranscript({ kind: "claude", cwd, sessionId: "aaa", home: h }), join(c, "aaa.jsonl"));
  const p = join(h, ".pi", "agent", "sessions", ctx.piSlug(cwd));
  mkdirSync(p, { recursive: true });
  copyFileSync(join(FIX, "pi.jsonl"), join(p, "2026-10-22T10-00-00-000Z_bbb.jsonl"));
  assert.equal(ctx.findTranscript({ kind: "pi", cwd, sessionId: "bbb", home: h }), join(p, "2026-10-22T10-00-00-000Z_bbb.jsonl"));
  const other = join(h, ".claude", "projects", "-shortened-slug-1a2b");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "ccc.jsonl"), "");
  assert.equal(ctx.findTranscript({ kind: "claude", cwd, sessionId: "ccc", home: h }), join(other, "ccc.jsonl"));
  assert.equal(ctx.findTranscript({ kind: "claude", cwd, sessionId: "nope", home: h }), null);
  assert.equal(ctx.findTranscript({ kind: "claude", cwd, sessionId: "", home: h }), null);
});

test("window from the runtime: claude statusline capture first, then a [1m] model id", () => {
  const capture = { window: 1000000, model: "claude-opus-5-5" };
  assert.deepEqual(ctx.detectWindow({ kind: "claude", model: "claude-opus-5-5", capture }), { window: 1000000, source: "claude statusline" });
  // The capture wins over the override: the runtime's own number comes first.
  assert.equal(ctx.detectWindow({ kind: "claude", model: "claude-haiku-5-5", capture: { window: 200000 }, override: 50000 }).window, 200000);
  assert.deepEqual(ctx.detectWindow({ kind: "claude", model: "claude-opus-5-5", alias: "opus[1m]" }), { window: 1000000, source: "model id opus[1m]" });
});

test("measured statusline captures (Claude Code 2.1.309): haiku, opus and sonnet all report 1,000k", () => {
  const measured = JSON.parse(readFileSync(join(FIX, "statusline-measured.json"), "utf8"));
  assert.deepEqual(measured.map((m) => m.model), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  for (const capture of measured) assert.deepEqual(ctx.detectWindow({ kind: "claude", model: capture.model, capture }), { window: 1000000, source: "claude statusline" });
});

test("window from pi's model registry: models-store.json and models.json, provider/model of the session", () => {
  const h = home();
  mkdirSync(join(h, ".pi", "agent"), { recursive: true });
  writeFileSync(join(h, ".pi", "agent", "models-store.json"), JSON.stringify({ xai: { models: [{ id: "grok-4.7", contextWindow: 500000 }] }, openrouter: { models: [{ id: "x-ai/grok-4.7", contextWindow: 400000 }] } }));
  writeFileSync(join(h, ".pi", "agent", "models.json"), JSON.stringify({ providers: { local: { models: [{ id: "qwen", contextWindow: 32768 }] } } }));
  const reg = ctx.readPiRegistry(h);
  assert.deepEqual(ctx.detectWindow({ kind: "pi", model: "grok-4.7", provider: "xai", piRegistry: reg }), { window: 500000, source: "pi registry xai/grok-4.7" });
  assert.equal(ctx.detectWindow({ kind: "pi", model: "qwen", provider: "local", piRegistry: reg }).window, 32768);
  assert.deepEqual(ctx.readPiRegistry(join(h, "nope")), {});
});

test("window override only by explicit config, and unknown when nothing reports it (no 200k guess)", () => {
  assert.deepEqual(ctx.detectWindow({ kind: "claude", model: "claude-sonnet-5-5" }), { window: null, source: "unknown" });
  assert.deepEqual(ctx.detectWindow({ kind: "pi", model: "grok-9", provider: "xai", piRegistry: {} }), { window: null, source: "unknown" });
  assert.deepEqual(ctx.detectWindow({ kind: "claude", model: "claude-sonnet-5-5", override: 200000 }), { window: 200000, source: "handoff.contextWindow" });
  assert.equal(ctx.detectWindow({ kind: "pi", model: "grok-4.7", override: { "/^grok-/": 256000, opus: 1 } }).window, 256000);
  assert.equal(ctx.detectWindow({ kind: "claude", model: "claude-haiku-5-5", override: { opus: 1000000 } }).window, null);
  const known = ctx.contextOf({ tokens: 100000, model: "m" }, { window: 200000, source: "claude statusline" });
  assert.deepEqual(known, { tokens: 100000, window: 200000, pct: 0.5, model: "m", source: "claude statusline" });
  const unknown = ctx.contextOf({ tokens: 100000, model: "m" }, { window: null, source: "unknown" });
  assert.equal(unknown.pct, null);
  assert.equal(ctx.windowLabel(known), "200k (claude statusline)");
  assert.equal(ctx.windowLabel(unknown), "window unknown");
  assert.deepEqual(ctx.handoffDue({ context: unknown, status: "idle", threshold: 0.5 }), { due: false, why: "window unknown" });
});

test("statusline capture: readCapture gives the window lib/statusline.mjs wrote; missing or broken gives null", () => {
  const dir = home();
  writeFileSync(ctx.captureFile(dir, "s1"), JSON.stringify({ sessionId: "s1", window: 200000, tokens: 24000 }));
  assert.equal(ctx.readCapture(dir, "s1").window, 200000);
  assert.equal(ctx.readCapture(dir, "s2"), null);
  writeFileSync(ctx.captureFile(dir, "s3"), "{broken");
  assert.equal(ctx.readCapture(dir, "s3"), null);
});

test("settings: default threshold 0.5, orchestrator on, cap 3, false or enabled:false turns it off, bad values fall back", () => {
  assert.deepEqual(ctx.handoffSettings(undefined), { enabled: true, threshold: 0.5, orchestrator: true, contextWindow: null, maxHandoffs: 3 });
  assert.equal(ctx.handoffSettings(false).enabled, false);
  assert.equal(ctx.handoffSettings({ enabled: false }).enabled, false);
  assert.equal(ctx.handoffSettings({ threshold: 0.01 }).threshold, 0.01);
  assert.equal(ctx.handoffSettings({ threshold: 7 }).threshold, 0.5);
  assert.equal(ctx.handoffSettings({ threshold: "x" }).threshold, 0.5);
  assert.equal(ctx.handoffSettings({ orchestrator: false }).orchestrator, false);
  assert.equal(ctx.handoffSettings({ maxHandoffs: 1 }).maxHandoffs, 1);
  assert.equal(ctx.handoffSettings({ maxHandoffs: -2 }).maxHandoffs, 3);
  assert.equal(ctx.capReached([{ n: 1 }], 1), true);
  assert.equal(ctx.capReached(undefined, 1), false);
});

test("threshold: at the cap, now when idle or done, queued mid-turn when working, wait otherwise", () => {
  const at = (pct) => ({ tokens: pct * 200000, window: 200000, pct });
  assert.deepEqual(ctx.handoffDue({ context: at(0.5), status: "idle", threshold: 0.5 }), { due: true, mode: "now", why: "50% >= 50%" });
  // herdr reports a finished turn nobody has looked at as done, not idle.
  assert.equal(ctx.handoffDue({ context: at(0.5), status: "done", threshold: 0.5 }).mode, "now");
  assert.equal(ctx.handoffDue({ context: at(0.62), status: "idle", threshold: 0.5 }).why, "62% >= 50%");
  assert.equal(ctx.handoffDue({ context: at(0.49), status: "idle", threshold: 0.5 }).due, false);
  assert.deepEqual(ctx.handoffDue({ context: at(0.55), status: "working", threshold: 0.5 }), { due: true, mode: "queue", why: "55% >= 50% while working" });
  assert.equal(ctx.handoffDue({ context: at(0.49), status: "working", threshold: 0.5 }).due, false);
  for (const status of ["blocked", "unknown", undefined]) {
    assert.equal(ctx.handoffDue({ context: at(0.9), status, threshold: 0.5 }).due, false, String(status));
  }
  assert.equal(ctx.handoffDue({ context: null, status: "idle", threshold: 0.5 }).due, false);
});

test("candidates: live builders with a session id and no result; verifier, closed, retired and in-flight are exempt", () => {
  const w = { name: "builder", role: "builder", sessionId: "s" };
  assert.equal(ctx.handoffCandidate(w), true);
  assert.equal(ctx.handoffCandidate(w, { resultExists: true }), false);
  assert.equal(ctx.handoffCandidate({ ...w, name: "verifier", role: "verifier" }), false);
  assert.equal(ctx.handoffCandidate({ ...w, closed: "t" }), false);
  assert.equal(ctx.handoffCandidate({ ...w, retired: { by: "builder" } }), false);
  assert.equal(ctx.handoffCandidate({ ...w, sessionId: undefined }), false);
  assert.equal(ctx.handoffCandidate({ ...w, handoff: { state: "writing" } }), false);
  assert.equal(ctx.handoffCandidate({ ...w, handoff: { state: "failed" } }), false);
});

test("note path and names: handoff/<name>-<n>.md, old agent <name>-h<n>, cut to herdr's 32 characters", () => {
  assert.equal(ctx.notePath("/r/.orka/jobs/1", "builder", 1), "/r/.orka/jobs/1/handoff/builder-1.md");
  assert.equal(ctx.handoffNumber({}), 1);
  assert.equal(ctx.handoffNumber({ handoffs: [{ n: 1 }, { n: 2 }] }), 3);
  assert.equal(ctx.retiredName("builder", 1), "builder-h1");
  assert.equal(ctx.retiredName("api-2", 12), "api-2-h12");
  const long = ctx.retiredName("a".repeat(32), 3);
  assert.equal(long.length, 32);
  assert.match(long, /^a+-h3$/);
});

test("prompts: the handoff skill by slash command now, by queued message mid-turn; successors read the note first", () => {
  const c = { tokens: 124829, window: 200000, pct: 0.624 };
  const p = ctx.notePrompt({ kind: "claude", path: "/j/handoff/builder-1.md", role: "worker", context: c, threshold: 0.5 });
  assert.match(p, /^\/orka:handoff \/j\/handoff\/builder-1\.md role=worker\n/);
  assert.match(p, /62% \(125k of 200k tokens, cap 50%\)/);
  assert.match(ctx.notePrompt({ kind: "pi", path: "/n.md", role: "orchestrator", context: c, threshold: 0.5 }), /^\/skill:handoff \/n\.md role=orchestrator/);
  const q = ctx.nudgePrompt({ kind: "claude", path: "/n.md", role: "worker", context: c, threshold: 0.5, skillFile: "/orka/plugin/skills/handoff/SKILL.md" });
  assert.match(q, /next clean stopping point/);
  assert.match(q, /\/orka:handoff \/n\.md role=worker/);
  assert.match(q, /read \/orka\/plugin\/skills\/handoff\/SKILL\.md/);
  assert.match(ctx.notePrompt({ kind: "claude", path: "/n.md", role: "worker", context: { tokens: 5, window: null, pct: null }, threshold: 0.5 }), /asked for by hand/);
  const s = ctx.successorLines({ path: "/j/handoff/builder-1.md", n: 1, from: "builder-h1" });
  assert.match(s, /HANDOFF \(h1\)/);
  assert.match(s, /Read \/j\/handoff\/builder-1\.md first/);
  assert.match(s, /builder-h1\) stays open/);
  const l = ctx.leadSuccessorLines({ path: "/j/handoff/orchestrator-1.md", n: 1, from: "jx-h1", jobFile: "/j.json", decisions: "/j/decisions.tsv", id: "7" });
  assert.match(l, /take over as orchestrator/);
  assert.match(l, /\/j\/handoff\/orchestrator-1\.md \(the note\), \/j\.json .*\/j\/decisions\.tsv/);
  assert.match(l, /orka digest 7/);
  assert.match(l, /Do not restart, re-task or close any worker or verifier pane/);
});

test("the shipped handoff skill: Pocock's skill, credited, with both role checklists", () => {
  const skill = readFileSync(join(import.meta.dirname, "..", "plugin", "skills", "handoff", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: handoff\n/);
  assert.match(skill, /mattpocock\/skills/);
  for (const s of ["Changes", "Checks run", "Commits", "Still running", "Remaining slice", "Plan", "Workers", "Verifier", "Steers", "Waiting on"]) assert.match(skill, new RegExp(`- ${s}:`));
  assert.match(skill, /do not close any pane/);
  const plugin = JSON.parse(readFileSync(join(import.meta.dirname, "..", "plugin", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "orka");
});
