#!/usr/bin/env node
// Claude Code statusLine command for orka panes: node lib/statusline.mjs <capture dir>.
// Claude Code pipes its statusline JSON to stdin on every message, mid-turn too. That JSON carries the
// window Claude itself computed for the session's model and betas (context_window.context_window_size),
// which no transcript holds. This writes <capture dir>/<session_id>.json = { at, model, window, tokens,
// pct } for lib/context.mjs, then draws the user's own statusLine (their settings files) unchanged, or
// a short "ctx NN% of Wk" when they have none. It never fails the pane: any error prints nothing.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The statusLine the user configured, highest precedence first (project local, project, user).
export function userStatusLine(cwd, home = homedir()) {
  const files = [...(cwd ? [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json")] : []), join(home, ".claude", "settings.json")];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(f, "utf8"))?.statusLine;
      if (s?.type === "command" && s.command) return String(s.command);
    } catch {}
  }
  return null;
}

export function captureOf(input) {
  const c = input?.context_window || {};
  const window = Number(c.context_window_size);
  if (!input?.session_id || !(window > 0)) return null;
  const u = c.current_usage || {};
  const tokens = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
  return {
    at: new Date().toISOString(),
    sessionId: String(input.session_id),
    model: String(input.model?.id || ""),
    window,
    tokens,
    pct: Number.isFinite(Number(c.used_percentage)) ? Number(c.used_percentage) / 100 : null,
  };
}

function main() {
  const dir = process.argv[2];
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {}
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {}
  const cap = captureOf(input);
  if (dir && cap) {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${cap.sessionId}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(cap));
      renameSync(tmp, join(dir, `${cap.sessionId}.json`));
    } catch {}
  }
  const cwd = input?.workspace?.current_dir || input?.cwd || process.cwd();
  const own = userStatusLine(cwd);
  if (own) {
    const got = spawnSync("sh", ["-c", own], { input: raw, encoding: "utf8", cwd, timeout: 5000 });
    process.stdout.write(got.stdout || "");
    return;
  }
  if (cap?.pct != null) process.stdout.write(`ctx ${Math.round(cap.pct * 100)}% of ${Math.round(cap.window / 1000)}k`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
