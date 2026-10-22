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
  assert.deepEqual(got, { tokens: 82 + 89344, model: "grok-4.7" });
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

test("window: table per model family, config number or map overrides it", () => {
  assert.equal(ctx.contextWindow("claude-sonnet-5-5"), 200000);
  assert.equal(ctx.contextWindow("claude-opus-5-5[1m]"), 1000000);
  assert.equal(ctx.contextWindow("grok-4.7"), ctx.DEFAULT_WINDOW);
  assert.equal(ctx.contextWindow("claude-opus-5-5", 1000000), 1000000);
  assert.equal(ctx.contextWindow("claude-opus-5-5", { opus: 1000000 }), 1000000);
  assert.equal(ctx.contextWindow("grok-4.7", { "/^grok-/": 256000, opus: 1 }), 256000);
  assert.equal(ctx.contextWindow("claude-haiku-5-5", { opus: 1000000 }), 200000);
  const c = ctx.contextOf({ tokens: 100000, model: "claude-sonnet-5-5" });
  assert.deepEqual(c, { tokens: 100000, window: 200000, pct: 0.5, model: "claude-sonnet-5-5" });
});

test("settings: default threshold 0.5, orchestrator off, false or enabled:false turns it off, bad values fall back", () => {
  assert.deepEqual(ctx.handoffSettings(undefined), { enabled: true, threshold: 0.5, orchestrator: false, contextWindow: null });
  assert.equal(ctx.handoffSettings(false).enabled, false);
  assert.equal(ctx.handoffSettings({ enabled: false }).enabled, false);
  assert.equal(ctx.handoffSettings({ threshold: 0.01 }).threshold, 0.01);
  assert.equal(ctx.handoffSettings({ threshold: 7 }).threshold, 0.5);
  assert.equal(ctx.handoffSettings({ threshold: "x" }).threshold, 0.5);
  assert.equal(ctx.handoffSettings({ orchestrator: true }).orchestrator, true);
});

test("threshold: due only when idle or done and at or past the cap", () => {
  const at = (pct) => ({ tokens: pct * 200000, window: 200000, pct });
  assert.equal(ctx.handoffDue({ context: at(0.5), status: "idle", threshold: 0.5 }).due, true);
  // herdr reports a finished turn nobody has looked at as done, not idle.
  assert.equal(ctx.handoffDue({ context: at(0.5), status: "done", threshold: 0.5 }).due, true);
  assert.equal(ctx.handoffDue({ context: at(0.62), status: "idle", threshold: 0.5 }).why, "62% >= 50%");
  assert.equal(ctx.handoffDue({ context: at(0.49), status: "idle", threshold: 0.5 }).due, false);
  for (const status of ["working", "blocked", "unknown", undefined]) {
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

test("prompts: note prompt names the path, the cap and Limen's checklist; successor reads the note first", () => {
  const p = ctx.notePrompt({ path: "/j/handoff/builder-1.md", context: { tokens: 124829, window: 200000, pct: 0.624 }, threshold: 0.5 });
  assert.match(p, /\/j\/handoff\/builder-1\.md/);
  assert.match(p, /62% \(125k of 200k tokens, cap 50%\)/);
  assert.match(p, /~200 words/);
  for (const s of ["Changes", "Checks run", "Commits", "Still running", "Notes", "Remaining slice", "Next commands"]) assert.match(p, new RegExp(`- ${s}:`));
  assert.match(p, /never paste/);
  assert.match(p, /Do not write your results file/);
  const s = ctx.successorLines({ path: "/j/handoff/builder-1.md", n: 1, from: "builder-h1" });
  assert.match(s, /HANDOFF \(h1\)/);
  assert.match(s, /Read \/j\/handoff\/builder-1\.md first/);
  assert.match(s, /builder-h1\) stays open/);
});
