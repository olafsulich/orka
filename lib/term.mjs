// The terminal backend orka starts and drives its panes through (docs/backends.md):
//   hc     herdr-core, the runtime the Herdr desktop app shows (the default);
//   herdr  the herdr TUI server, deprecated: ORKA_BACKEND=herdr, and jobs that started on it.
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
//   status            Claude Code and Pi (1.1.0 and later) report idle/working/done/blocked to hc
//                     themselves (OSC 7501, the Program Status Protocol). Older Pi reports nothing,
//                     so orka refuses it on hc.
//   the Herdr app     the app shows a terminal only when it carries herdr.space/herdr.tab labels. Each
//                     job gets its own space and each agent its own tab (ids derived from the job and
//                     pane); the app names new ones "<folder>" and "1, 2, ...", so orka then writes
//                     readable names into the app's layout document (see hcSpaces below).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env as brandEnv, NAME } from "./brand.mjs";

export const BACKENDS = ["hc", "herdr"];

// Pi reports its state with OSC 7501 since 1.1.0. PI_PROGRAM_STATUS=1 makes it report without
// waiting for the terminal's answer to its support query.
export const PI_MIN_VERSION = "1.1.0";

// "1.4.0" from `pi --version`, or "" when pi is missing or says something else.
export function piVersion(env = process.env) {
  const r = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 15000, env });
  return /(\d+\.\d+\.\d+)/.exec(`${r.stdout || ""}${r.stderr || ""}`)?.[1] || "";
}

export function piReportsStatus(version) {
  const [a, b, c] = String(version).split(".").map(Number);
  const [x, y, z] = PI_MIN_VERSION.split(".").map(Number);
  if (![a, b, c].every(Number.isFinite)) return false;
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

export function piTooOld(version, id = "<id>") {
  return `pi ${version || "(not found)"} reports no status to herdr-core; a pi job on hc needs pi ${PI_MIN_VERSION} or later, which reports idle/working/done/blocked itself (OSC 7501). Update it (npm i -g @earendil-works/pi-coding-agent@latest), or run this job on the deprecated herdr backend: ORKA_BACKEND=herdr orka run ${id}.`;
}

let current = null;

// ORKA_BACKEND (or ORCA_BACKEND): hc when unset. herdr is the deprecated fallback.
export function defaultBackend(source = process.env) {
  return String(brandEnv("BACKEND", source) || "hc").trim().toLowerCase();
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

// herdr-core's socket: <XDG_RUNTIME_DIR or /run/user/<uid>>/herdr-core/<HC_SESSION or default>.sock.
export function hcSocket(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  return join(runtime, "herdr-core", `${env.HC_SESSION || "default"}.sock`);
}

// Whether herdr-core serve is up, read-only: its socket is there. Never asks hc itself, because
// any hc command (even `hc server status`) starts a core when none runs.
export function hcReachable(env = process.env) {
  return existsSync(hcSocket(env));
}

export function hcUnreachable(env = process.env) {
  return `herdr-core is not running (no socket at ${hcSocket(env)}). Start it (open the Herdr app, or hc server start), or run this job on the deprecated herdr backend: ORKA_BACKEND=herdr orka run <id>.`;
}

// One JSON-RPC request through `hc connect`: { result } or { error: { message, data: { kind } } }.
// Refused while no core runs: orka never starts one by accident.
export function rpc(method, params, { timeoutMs = 30000, env = process.env } = {}) {
  if (!hcReachable(env)) return { error: { message: hcUnreachable(env), data: { kind: "unavailable" } } };
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

// An hc pane starts with the core's environment, not the caller's. ORKA_PANE_ENV=NAME,NAME names caller
// variables to copy in (NODE_EXTRA_CA_CERTS for a webhook behind a private CA, say); it travels along,
// so panes started from a pane pass the same ones.
function passedEnv(env) {
  const list = String(brandEnv("PANE_ENV", env) || "");
  const names = list.split(",").map((n) => n.trim()).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const out = {};
  for (const name of names) if (env[name] != null) out[name] = env[name];
  return names.length ? { ...out, ORKA_PANE_ENV: list } : out;
}

// ---- the Herdr app: one space per job, one tab per agent ----
// The app (herdr-app) adopts any live terminal labelled herdr.space=<id> (+ herdr.tab=<id>): an id it
// does not know becomes a new space or tab, unnamed. It keeps its layout in the core's "herdr-app"
// document ({ spaces: [{ id, name, folder, tabs: [{ id, name, root }] }] }) and writes the `where`
// label itself from it, so orka never sets `where`. Names: once the app has adopted a terminal, orka
// sets the name of its space and tab in that document, only where the name is still empty (a name
// someone gave stays), through doc.set's version check, which the app treats like another screen's
// edit. The wanted names ride along as labels (orka_space_name, orka_tab_name), so any later launch
// names tabs an earlier one could not (the app was closed, or slow to adopt).
// ORKA_HC_SPACES=off keeps jobs out of the app (no herdr.* labels).
const LAYOUT_DOC = "herdr-app";
const hex32 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export function appShows(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(brandEnv("HC_SPACES", env) || "").trim());
}

// "20261029214905714-fix-duplicated-paragraph" -> "fix-duplicated-paragraph"
export const jobSlug = (job) => String(job).replace(/^[0-9]{8,}-/, "") || String(job);

// The labels that put an agent's terminal in the app: its job's space, a tab of its own.
export function appLabels({ job, workspace, pane, role }) {
  const key = job || workspace;
  if (!key || !pane) return {};
  return {
    "herdr.space": `sp${hex32(`${NAME}:space:${key}`)}`,
    "herdr.tab": `tb${hex32(`${NAME}:tab:${key}:${pane}`)}`,
    orka_space_name: `${NAME} ${jobSlug(key)}`.slice(0, 64),
    orka_tab_name: String(role || "agent").slice(0, 64),
  };
}

// The document with names filled in for these terminals' spaces and tabs, where the app has them and
// they are unnamed; null when nothing changes. Everything else is passed through as it is.
export function nameLayout(doc, terminals) {
  if (!doc || !Array.isArray(doc.spaces)) return null;
  let changed = false;
  for (const t of terminals) {
    const l = t.labels || {};
    const space = doc.spaces.find((s) => s && s.id === l["herdr.space"]);
    if (!space) continue;
    if (!space.name && l.orka_space_name) {
      space.name = l.orka_space_name;
      changed = true;
    }
    const tab = (space.tabs || []).find((c) => c && c.id === l["herdr.tab"]);
    if (tab && !tab.name && l.orka_tab_name) {
      tab.name = l.orka_tab_name;
      changed = true;
    }
  }
  return changed ? doc : null;
}

// Whether the app has placed this terminal yet: its tab is in the document.
const placed = (doc, t) => (doc?.spaces || []).some((s) => s?.id === t.labels?.["herdr.space"] && (s.tabs || []).some((c) => c?.id === t.labels?.["herdr.tab"]));

// Best effort, never fails a launch. `fresh` (just started) is waited for until the app has placed it,
// at most ORKA_HC_NAME_WAIT_MS (5 s); with no layout document (no app has ever drawn this machine) there
// is no wait. Every live orka terminal with wanted names is named along with it.
function nameInApp(env, fresh) {
  const waitMs = Number(brandEnv("HC_NAME_WAIT_MS", env) ?? 5000);
  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 5000);
  for (let attempt = 0; attempt < 50; attempt++) {
    const got = rpc("doc.get", { name: LAYOUT_DOC }, { env, timeoutMs: 5000 });
    if (got.error || !got.result?.value) return { named: false, why: got.error ? errText(got) : "no layout document" };
    const { value, version } = got.result;
    if (fresh && !placed(value, fresh) && Date.now() < deadline) {
      sleepMs(POLL_MS);
      continue;
    }
    const ours = (list(env) || []).filter((t) => t.labels?.["herdr.space"] && t.labels?.orka_space_name);
    const doc = nameLayout(value, ours);
    if (!doc) return { named: false, why: fresh && !placed(value, fresh) ? "not placed by the app yet" : "nothing to name" };
    const set = rpc("doc.set", { name: LAYOUT_DOC, version, value: doc }, { env, timeoutMs: 5000 });
    if (!set.error) return { named: true };
    if (errKind(set) !== "conflict") return { named: false, why: errText(set) };
  }
  return { named: false, why: "layout kept changing" };
}

const capital = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function startAgent(env, args) {
  const { flags, pos, rest } = parseFlags(args.slice(2));
  const name = pos[0];
  const pane = flags.pane;
  if (flags.kind !== "claude" && flags.kind !== "pi") return err(`the hc backend runs claude and pi agents; ${flags.kind} is not supported`, "unsupported_kind");
  const spec = readPending(env, pane);
  if (!spec) return err(`pane ${pane} is not a pane orka opened on hc (no agent can start in it)`, "pane_not_found");
  const taken = byAgent(env, name);
  if (taken) return err(`agent name ${name} already used (terminal ${taken.address}, status=${capital(statusOf(getTerminal(env, taken.address) || taken))})`, "agent_name_taken");
  const parent = spec.parent ? byPane(env, spec.parent) : null;
  const labels = { orka_agent: name, orka_pane: pane, ...(spec.workspace ? { orka_ws: spec.workspace } : {}) };
  const jobId = spec.env?.ORKA_JOB || spec.env?.ORCA_JOB;
  if (jobId) labels.orka_job = String(jobId).slice(0, 64);
  const shown = appShows(env) ? appLabels({ job: labels.orka_job, workspace: spec.workspace, pane, role: spec.env?.ORKA_WORKER || spec.env?.ORCA_WORKER || name }) : {};
  Object.assign(labels, shown);
  const params = {
    argv: [flags.kind, ...rest],
    cwd: spec.cwd,
    env: { ...passedEnv(env), ...(spec.env || {}), ...(flags.kind === "pi" ? { PI_PROGRAM_STATUS: "1" } : {}) },
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
    if (t && (status === "idle" || status === "done")) {
      if (shown["herdr.space"]) nameInApp(env, t);
      return ok({ agent: agentView(t) });
    }
    if (status === "blocked") return err(`agent ${name} not ready in ${address}: status=Blocked`, "agent_not_ready");
    if (t?.state === "finished") return err(`agent ${name} exited in ${address} (${t.reason || "exited"}, code ${t.exit_code ?? "?"})`, "agent_exited");
    if (Date.now() >= deadline) return err(`agent ${name} not ready in ${address} after ${flags.timeout || 30000} ms (status ${status})`, "agent_not_ready");
    sleepMs(POLL_MS);
  }
}

function agentVerb(env, verb, rest) {
  if (verb === "list") {
    const live = list(env);
    return live ? ok({ agents: live.map(agentView) }) : err(hcReachable(env) ? "hc did not answer terminal.list" : hcUnreachable(env), "unavailable");
  }
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
