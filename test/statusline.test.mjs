import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureOf, userStatusLine } from "../lib/statusline.mjs";

const SCRIPT = join(import.meta.dirname, "..", "lib", "statusline.mjs");
const INPUT = { session_id: "s1", model: { id: "claude-haiku-5-5" }, context_window: { context_window_size: 1000000, used_percentage: 12, current_usage: { input_tokens: 10, cache_read_input_tokens: 110000, cache_creation_input_tokens: 9990 } } };

function home() {
  const base = mkdtempSync(join(tmpdir(), "orka-statusline-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  return base;
}

test("captureOf: the window Claude reports for the session, its tokens and percent", () => {
  const cap = captureOf(INPUT);
  assert.deepEqual({ ...cap, at: "-" }, { at: "-", sessionId: "s1", model: "claude-haiku-5-5", window: 1000000, tokens: 120000, pct: 0.12 });
  assert.equal(captureOf({ session_id: "s1", context_window: {} }), null);
  assert.equal(captureOf(null), null);
});

test("userStatusLine: project local, project, then user settings; none gives null", () => {
  const h = home();
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo mine" } }));
  assert.equal(userStatusLine(join(h, "nowhere"), h), "echo mine");
  const cwd = join(h, "proj");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "echo local" } }));
  assert.equal(userStatusLine(cwd, h), "echo local");
  assert.equal(userStatusLine(null, join(h, "x")), null);
});

test("the script writes <dir>/<session>.json and draws its own line when the user has no statusLine", () => {
  const h = home();
  const dir = join(h, "ctx");
  const got = spawnSync(process.execPath, [SCRIPT, dir], { input: JSON.stringify({ ...INPUT, cwd: h }), encoding: "utf8", env: { ...process.env, HOME: h } });
  assert.equal(got.status, 0, got.stderr);
  assert.equal(got.stdout, "ctx 12% of 1000k");
  assert.equal(JSON.parse(readFileSync(join(dir, "s1.json"), "utf8")).window, 1000000);
  // Garbage in: prints nothing, writes nothing, exits 0.
  const bad = spawnSync(process.execPath, [SCRIPT, dir], { input: "not json", encoding: "utf8", env: { ...process.env, HOME: h } });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
});
