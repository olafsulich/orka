// The terminal backend orka starts and drives its panes through (docs/backends.md):
//   herdr  the herdr TUI server (the default), called as it always was;
//   hc     herdr-core, the runtime the Herdr desktop app shows.
// The interface is herdr's own verb set: call(args) takes herdr CLI args and returns
// { code, text, json } in herdr's JSON shape. herdr runs them as they are; hc translates each verb
// to herdr-core's JSON-RPC API (`hc connect`), so every call site in orka works on both.
//
// What hc lacks and how it is covered:
//   panes/workspaces  hc has no empty pane. workspace create / pane split only record a pending pane
//                     (cwd, env, workspace, parent) in a small file; agent start runs the agent in a
//                     new terminal with it. The terminal carries the labels orka_pane, orka_ws,
//                     orka_agent and orka_job, and every later lookup goes through those labels.
//   agent names       hc names are fixed at start, so orka's agent name is the orka_agent label
//                     (rename relabels). The hc name is the agent name when it was free at start.
//   status            Claude Code reports idle/working/done/blocked to hc itself (OSC 7501). pi
//                     reports nothing, so the hc backend runs claude agents only.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env as brandEnv } from "./brand.mjs";

export const BACKENDS = ["herdr", "hc"];

let current = null;

// ORKA_BACKEND (or ORCA_BACKEND): herdr when unset.
export function defaultBackend(source = process.env) {
  return String(brandEnv("BACKEND", source) || "herdr").trim().toLowerCase();
}

export function use(name) {
  current = name || null;
}

export function backend() {
  return current || defaultBackend();
}

export function binary(name = backend()) {
  return name === "hc" ? "hc" : "herdr";
}

export function call(args, { timeoutMs = 30000, env = process.env } = {}) {
  return backend() === "hc" ? hcCall(args, { timeoutMs, env }) : herdrCall(args, { timeoutMs, env });
}

function parseJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const i = trimmed.indexOf("{");
    const j = trimmed.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(trimmed.slice(i, j + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function herdrCall(args, { timeoutMs, env }) {
  const r = spawnSync("herdr", args, { encoding: "utf8", timeout: timeoutMs, env });
  const text = `${r.stdout || ""}${r.stderr || ""}${r.error ? `\n${r.error.message}` : ""}`;
  return { code: r.status ?? 1, text, json: parseJson(text) };
}

// ---- hc ----

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const POLL_MS = Number(brandEnv("HC_POLL_MS")) || 500;

const ok = (result) => ({ code: 0, text: JSON.stringify({ result }), json: { result } });
const err = (message, code = "error") => ({ code: 1, text: message, json: { error: { code, message } } });

// One JSON-RPC request through `hc connect`: { result } or { error: { message, data: { kind } } }.
export function rpc(method, params, { timeoutMs = 30000, env = process.env } = {}) {
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`;
  const r = spawnSync("hc", ["connect"], { input, encoding: "utf8", timeout: timeoutMs, env });
  for (const line of String(r.stdout || "").split("\n")) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg?.id !== 1) continue;
    return msg.error ? { error: msg.error } : { result: msg.result };
  }
  const why = String(r.stderr || "").trim() || r.error?.message || `hc connect gave no answer (exit ${r.status})`;
  return { error: { message: why, data: { kind: "unavailable" } } };
}

const errText = (got) => String(got.error?.message || "hc error");
const errKind = (got) => got.error?.data?.kind || "";

// Pending panes (made, no agent in them yet) live in <runtime dir>/orka-hc/<pane>.json.
function pendingDir(env) {
  return join(brandEnv("HC_STATE", env) || env.XDG_RUNTIME_DIR || tmpdir(), "orka-hc");
}

function pendingPath(env, pane) {
  return /^hp-[a-z0-9]+$/.test(pane) ? join(pendingDir(env), `${pane}.json`) : "";
}

function readPending(env, pane) {
  const path = pendingPath(env, pane);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writePending(env, pane, spec) {
  mkdirSync(pendingDir(env), { recursive: true });
  writeFileSync(pendingPath(env, pane), `${JSON.stringify(spec)}\n`);
}

function dropPending(env, pane) {
  const path = pendingPath(env, pane);
  if (path) rmSync(path, { force: true });
}

const newId = (prefix) => `${prefix}-${randomBytes(4).toString("hex")}`;

// --flag value pairs (repeatable ones collected), `--` ends them; the rest are positionals.
function parseFlags(args, boolFlags = []) {
  const flags = { env: [] };
  const pos = [];
  let rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest = args.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (boolFlags.includes(key)) flags[key] = true;
      else if (key === "env" || key === "until") (flags[key] = flags[key] || []).push(args[++i]);
      else flags[key] = args[++i];
    } else pos.push(a);
  }
  return { flags, pos, rest };
}

function envObject(pairs) {
  const out = {};
  for (const p of pairs || []) {
    const i = String(p).indexOf("=");
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

function list(env, labels = {}, all = false) {
  const got = rpc("terminal.list", { all, labels }, { env });
  return got.error ? null : got.result?.terminals || [];
}

function getTerminal(env, address) {
  const got = rpc("terminal.get", { terminal: address }, { env });
  return got.error ? null : got.result;
}

// The live terminal of an orka agent: its orka_agent label, else (a terminal orka did not start)
// its hc name.
function byAgent(env, name) {
  const live = list(env);
  if (!live) return null;
  return live.find((t) => t.labels?.orka_agent === name) || live.find((t) => !t.labels?.orka_agent && t.name === name) || null;
}

// The terminal behind an orka pane id, live ones first; also takes a plain hc address (t7).
function byPane(env, pane) {
  if (!pane) return null;
  const found = list(env, { orka_pane: pane }, true) || [];
  const live = found.find((t) => t.state === "live");
  if (live || found.length) return live || found[found.length - 1];
  return /^([a-z0-9_-]+\/)?t[0-9a-z]+$/.test(pane) ? getTerminal(env, pane) : null;
}

const statusOf = (t) => (t?.state === "live" ? t.status?.state || "unknown" : "exited");

function agentView(t) {
  return {
    name: t.labels?.orka_agent || t.name || t.address,
    agent_status: statusOf(t),
    interactive_ready: t.state === "live" && Boolean(t.status?.state),
    pane_id: t.labels?.orka_pane || t.address,
    workspace_id: t.labels?.orka_ws || "",
    terminal_id: t.address,
    hc_name: t.name || null,
    cwd: t.cwd,
  };
}

const capital = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function startAgent(env, args) {
  const { flags, pos, rest } = parseFlags(args.slice(2));
  const name = pos[0];
  const pane = flags.pane;
  if (flags.kind !== "claude") return err(`the hc backend runs claude agents only (${flags.kind} reports no status to hc); use ORKA_BACKEND=herdr for --kind ${flags.kind}`, "unsupported_kind");
  const spec = readPending(env, pane);
  if (!spec) return err(`pane ${pane} is not a pane orka opened on hc (no agent can start in it)`, "pane_not_found");
  const taken = byAgent(env, name);
  if (taken) return err(`agent name ${name} already used (terminal ${taken.address}, status=${capital(statusOf(getTerminal(env, taken.address) || taken))})`, "agent_name_taken");
  const parent = spec.parent ? byPane(env, spec.parent) : null;
  const labels = { orka_agent: name, orka_pane: pane, ...(spec.workspace ? { orka_ws: spec.workspace } : {}) };
  const jobId = spec.env?.ORKA_JOB || spec.env?.ORCA_JOB;
  if (jobId) labels.orka_job = String(jobId).slice(0, 64);
  const params = {
    argv: ["claude", ...rest],
    cwd: spec.cwd,
    env: spec.env || {},
    labels,
    name,
    no_notify: true,
    outlive_parent: true,
    ...(parent?.state === "live" ? { parent: parent.address } : { no_parent: true }),
  };
  let ran = rpc("terminal.run", params, { env });
  if (errKind(ran) === "name_taken") {
    delete params.name;
    ran = rpc("terminal.run", params, { env });
  }
  if (ran.error) return err(`hc run ${name}: ${errText(ran)}`, errKind(ran) || "spawn_failed");
  dropPending(env, pane);
  const address = ran.result.address;
  const deadline = Date.now() + (Number(flags.timeout) || 30000);
  for (;;) {
    const t = getTerminal(env, address);
    const status = statusOf(t);
    if (t && (status === "idle" || status === "done")) return ok({ agent: agentView(t) });
    if (status === "blocked") return err(`agent ${name} not ready in ${address}: status=Blocked`, "agent_not_ready");
    if (t?.state === "finished") return err(`agent ${name} exited in ${address} (${t.reason || "exited"}, code ${t.exit_code ?? "?"})`, "agent_exited");
    if (Date.now() >= deadline) return err(`agent ${name} not ready in ${address} after ${flags.timeout || 30000} ms (status ${status})`, "agent_not_ready");
    sleepMs(POLL_MS);
  }
}

function agentVerb(env, verb, rest) {
  if (verb === "list") return ok({ agents: (list(env) || []).map(agentView) });
  const name = rest[0];
  const found = byAgent(env, name);
  const t = found && getTerminal(env, found.address);
  if (!t) return err(`no agent ${name}`, "agent_not_found");
  if (verb === "get") return ok({ agent: agentView(t) });
  if (verb === "prompt") {
    const sent = rpc("terminal.send", { terminal: t.address, text: rest[1] }, { env, timeoutMs: 60000 });
    return sent.error ? err(errText(sent), errKind(sent)) : ok({ agent: agentView(t), send: sent.result });
  }
  if (verb === "send-keys") {
    const pressed = rpc("terminal.keys", { terminal: t.address, keys: rest.slice(1).map((k) => String(k).toLowerCase()) }, { env });
    return pressed.error ? err(errText(pressed), errKind(pressed)) : ok({ keys: pressed.result });
  }
  if (verb === "rename") {
    const to = rest[1];
    if (byAgent(env, to)) return err(`agent name ${to} already used`, "agent_name_taken");
    const labelled = rpc("terminal.label", { terminal: t.address, labels: { orka_agent: to } }, { env });
    return labelled.error ? err(errText(labelled), errKind(labelled)) : ok({ agent: { ...agentView(t), name: to } });
  }
  if (verb === "wait") {
    const { flags } = parseFlags(rest.slice(1));
    const until = flags.until || [];
    const deadline = Date.now() + (Number(flags.timeout) || 30000);
    for (let cur = t; ; ) {
      if (!cur || until.includes(statusOf(cur)) || Date.now() >= deadline) return ok({ agent: agentView(cur || t) });
      sleepMs(POLL_MS * 4);
      cur = getTerminal(env, t.address);
    }
  }
  return err(`hc backend: herdr agent ${verb} has no hc equivalent`, "unsupported");
}

// Ends a terminal and removes it from hc (so it leaves the app too). Finished ones are only removed.
function closeTerminal(env, t) {
  if (t.state === "live") {
    const killed = rpc("terminal.kill", { terminal: t.address }, { env });
    if (killed.error && errKind(killed) !== "finished") return killed;
  }
  let removed;
  for (let i = 0; i < 20; i++) {
    removed = rpc("terminal.rm", { terminal: t.address }, { env });
    if (!removed.error || errKind(removed) === "not_found") return {};
    sleepMs(250);
  }
  return removed;
}

function paneVerb(env, verb, rest) {
  const { flags, pos } = parseFlags(rest, ["no-focus"]);
  if (verb === "split") {
    const from = flags.pane;
    const pane = newId("hp");
    const workspace = readPending(env, from)?.workspace || byPane(env, from)?.labels?.orka_ws || "";
    writePending(env, pane, { cwd: flags.cwd, env: envObject(flags.env), workspace, parent: from });
    return ok({ pane: { pane_id: pane, workspace_id: workspace } });
  }
  if (verb === "list") {
    const live = list(env);
    if (!live) return err("hc did not answer terminal.list", "unavailable");
    const pending = existsSync(pendingDir(env)) ? readdirSync(pendingDir(env)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    return ok({ panes: [...live.map((t) => ({ pane_id: t.labels?.orka_pane || t.address, terminal_id: t.address, agent_status: statusOf(t) })), ...pending.map((p) => ({ pane_id: p, agent_status: "unknown" }))] });
  }
  const pane = pos[0];
  const spec = readPending(env, pane);
  if (verb === "get") {
    if (spec) return ok({ pane: { pane_id: pane, agent_status: "unknown", workspace_id: spec.workspace || "" } });
    const t = byPane(env, pane);
    if (!t || t.state !== "live") return err(`pane ${pane} not found`, "pane_not_found");
    return ok({ pane: { pane_id: pane, terminal_id: t.address, agent_status: statusOf(t), workspace_id: t.labels?.orka_ws || "" } });
  }
  if (verb === "read") {
    if (spec) return { code: 0, text: "", json: null };
    const t = byPane(env, pane);
    if (!t) return err(`pane ${pane} not found`, "pane_not_found");
    const got = rpc("terminal.read", { terminal: t.address, lines: Number(flags.lines) || 200 }, { env });
    return got.error ? err(errText(got), errKind(got)) : { code: 0, text: String(got.result?.text || ""), json: null };
  }
  if (verb === "close") {
    if (spec) {
      dropPending(env, pane);
      return ok({});
    }
    const t = byPane(env, pane);
    if (!t) return err(`pane ${pane} not found`, "pane_not_found");
    const closed = closeTerminal(env, t);
    return closed.error ? err(errText(closed), errKind(closed)) : ok({ closed: t.address });
  }
  return err(`hc backend: herdr pane ${verb} has no hc equivalent`, "unsupported");
}

function workspaceVerb(env, verb, rest) {
  const { flags, pos } = parseFlags(rest, ["no-focus"]);
  if (verb === "create") {
    const workspace = newId("hw");
    const pane = newId("hp");
    writePending(env, pane, { cwd: flags.cwd, env: envObject(flags.env), workspace, label: flags.label || "", parent: null });
    return ok({ workspace: { workspace_id: workspace, label: flags.label || "" }, root_pane: { pane_id: pane } });
  }
  if (verb === "close") {
    const workspace = pos[0];
    if (!workspace) return err("need a workspace id", "invalid");
    const terminals = list(env, { orka_ws: workspace }, true);
    if (!terminals) return err("hc did not answer terminal.list", "unavailable");
    const failed = terminals.map((t) => closeTerminal(env, t)).filter((r) => r.error);
    if (existsSync(pendingDir(env))) {
      for (const f of readdirSync(pendingDir(env)).filter((f) => f.endsWith(".json"))) {
        if (readPending(env, f.slice(0, -5))?.workspace === workspace) dropPending(env, f.slice(0, -5));
      }
    }
    return failed.length ? err(`workspace ${workspace}: ${failed.length} terminal(s) not closed: ${errText(failed[0])}`) : ok({ closed: terminals.map((t) => t.address) });
  }
  return err(`hc backend: herdr workspace ${verb} has no hc equivalent`, "unsupported");
}

export function hcCall(args, { env = process.env } = {}) {
  const [noun, verb, ...rest] = args;
  if (noun === "agent" && verb === "start") return startAgent(env, args);
  if (noun === "agent") return agentVerb(env, verb, rest);
  if (noun === "pane") return paneVerb(env, verb, rest);
  if (noun === "workspace") return workspaceVerb(env, verb, rest);
  return err(`hc backend: herdr ${args.slice(0, 2).join(" ")} has no hc equivalent`, "unsupported");
}
