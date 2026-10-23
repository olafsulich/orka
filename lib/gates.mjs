// Static gates (docs/gates.md): the repo's cheap checks that orka runs itself in the job worktree
// before every verifier round. From "gates" in .orka/config.json, else detected from package.json
// scripts. Each gate runs under GNU timeout, which makes it a process group and signals the whole
// group on timeout; afterwards the group is killed again so nothing is left behind.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDuration } from "./lifecycle.mjs";

export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_GATE_BUDGET_MS = 20 * 60 * 1000;
// Fast checks first. lint, check and format:check cover oxlint/oxfmt-style scripts too.
export const GATE_SCRIPTS = ["typecheck", "type-check", "lint", "format:check", "check", "test"];
export const TAIL_LINES = 20;
const NPM_PLACEHOLDER = /no test specified/i;
const LABELS = ["GOAL", "SCOPE", "CONTEXT", "ACCEPTANCE", "VERIFY", "TIMEBOX", "FORBIDDEN", "REPORT"];

export function packageManager(dir) {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  return "npm";
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "gate";

// { gates: [{ name, command }], source, reason }. config: the parsed .orka/config.json.
export function detectGates(dir, config = {}) {
  const set = config?.gates;
  if (set === false) return { gates: [], source: "off", reason: '"gates": false in .orka/config.json' };
  if (Array.isArray(set)) {
    const gates = set.filter((c) => typeof c === "string" && c.trim()).map((command) => ({ name: slug(command), command: command.trim() }));
    return { gates, source: "config", reason: gates.length ? `"gates" in .orka/config.json` : '"gates" in .orka/config.json is empty' };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return { gates: [], source: "none", reason: "no package.json and no \"gates\" in .orka/config.json" };
  }
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const pm = packageManager(dir);
  const gates = [];
  for (const name of GATE_SCRIPTS) {
    const body = scripts[name];
    if (typeof body !== "string" || !body.trim()) continue;
    if (name === "test" && NPM_PLACEHOLDER.test(body)) continue;
    gates.push({ name, command: name === "test" ? `${pm} test` : `${pm} run ${name}` });
  }
  return { gates, source: "package.json", reason: gates.length ? `package.json scripts: ${gates.map((g) => g.name).join(", ")}` : `package.json has none of: ${GATE_SCRIPTS.join(", ")}` };
}

function ms(value, fallback) {
  if (typeof value === "number" && value > 0) return value;
  if (typeof value === "string" && value.trim()) return parseDuration(value);
  return fallback;
}

// "gateTimeout" (per gate) and "gateBudget" (per round) in .orka/config.json, e.g. "10m".
export function gateLimits(config = {}) {
  return { timeoutMs: ms(config?.gateTimeout, DEFAULT_GATE_TIMEOUT_MS), budgetMs: ms(config?.gateBudget, DEFAULT_GATE_BUDGET_MS) };
}

export function tailOf(path, lines = TAIL_LINES) {
  try {
    const text = readFileSync(path, "utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, sig);
    } catch {
      return; // the group is gone
    }
  }
}

// Runs one command in cwd with output to logPath. { exit, timedOut, ms, tail }.
export function runGate(command, cwd, { timeoutMs = DEFAULT_GATE_TIMEOUT_MS, logPath, env = process.env } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  const started = Date.now();
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  let r;
  try {
    r = spawnSync("timeout", ["-k", "5", String(secs), "sh", "-c", command], { cwd, stdio: ["ignore", fd, fd], env: { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
  } finally {
    closeSync(fd);
  }
  // timeout made itself the group leader: anything the gate left running in that group goes too.
  killGroup(r.pid);
  const exit = r.status ?? (r.signal ? 128 : 1);
  return { exit, timedOut: exit === 124 || exit === 137, ms: Date.now() - started, tail: tailOf(logPath) };
}

// The verifier --task's ACCEPTANCE section, when it is exactly one backticked command (optionally
// followed by "passes", "exits 0", "succeeds" or "is green"). null otherwise.
export function singleCommand(task) {
  const text = String(task || "");
  const m = new RegExp(`(?:^|\\n|\\s)ACCEPTANCE:([\\s\\S]*?)(?=(?:^|\\n|\\s)(?:${LABELS.join("|")}):|$)`).exec(text);
  if (!m) return null;
  const items = m[1].split("\n").map((l) => l.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
  if (items.length !== 1) return null;
  const one = /^`([^`]+)`(?:\s+(?:passes|exits 0|succeeds|is green))?\.?$/i.exec(items[0]);
  return one ? one[1].trim() : null;
}
