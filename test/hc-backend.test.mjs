import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as term from "../lib/term.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// A fake hc: `hc connect` answers one JSON-RPC request from a state file. Terminals start with the
// status FAKE_HC_START (idle by default; blocked shows Claude's trust dialog), a send makes them
// working. Every request is logged as a JSON line.
const FAKE_HC = `#!/usr/bin/env node
const fs = require("node:fs");
const stateFile = process.env.FAKE_HC_STATE;
const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { next: 1, terminals: [] });
if (process.argv[2] !== "connect") { console.error("fake hc: only connect"); process.exit(2); }
const req = JSON.parse(fs.readFileSync(0, "utf8").trim().split("\\n")[0]);
fs.appendFileSync(process.env.FAKE_HC_LOG, JSON.stringify({ method: req.method, params: req.params }) + "\\n");
const s = load();
const p = req.params || {};
const find = (t) => s.terminals.find((x) => x.address === t) || s.terminals.find((x) => x.state === "live" && x.name === t);
const reply = (result) => { fs.writeFileSync(stateFile, JSON.stringify(s)); console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result })); };
const fail = (kind, message) => { console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message, data: { kind } } })); };
const matches = (t) => (p.all || t.state === "live") && Object.entries(p.labels || {}).every(([k, v]) => t.labels[k] === v);
switch (req.method) {
  case "terminal.run": {
    if (p.name && s.terminals.some((t) => t.state === "live" && t.name === p.name)) { fail("name_taken", "name taken"); break; }
    const start = process.env.FAKE_HC_START || "idle";
    const t = { address: "t" + s.next++, name: p.name || null, argv: p.argv, cwd: p.cwd, env: p.env, labels: p.labels || {}, parent: p.parent || null, state: "live", reported: true, status: { app: "claude-code", state: start }, screen: start === "blocked" ? "Quick safety check: Is this a project you created or one you trust?" : "❯ " };
    s.terminals.push(t);
    reply(t);
    break;
  }
  case "terminal.list": reply({ terminals: s.terminals.filter(matches), hidden_finished: 0, machines: [] }); break;
  case "terminal.get": { const t = find(p.terminal); t ? reply(t) : fail("not_found", "no terminal"); break; }
  case "terminal.send": { const t = find(p.terminal); if (!t) { fail("not_found", "no terminal"); break; } t.screen += "\\n❯ " + p.text; t.status = { app: "claude-code", state: "working" }; reply({ started: true, status: "idle", turn: 0 }); break; }
  case "terminal.keys": { const t = find(p.terminal); t ? reply({ turn: 0, status: t.status?.state }) : fail("not_found", "no terminal"); break; }
  case "terminal.read": { const t = find(p.terminal); t ? reply({ text: t.screen, complete: true, how: "screen" }) : fail("not_found", "no terminal"); break; }
  case "terminal.label": { const t = find(p.terminal); if (!t) { fail("not_found", "no terminal"); break; } Object.assign(t.labels, p.labels); reply(t); break; }
  case "terminal.kill": { const t = find(p.terminal); if (!t) { fail("not_found", "no terminal"); break; } t.state = "finished"; t.status = null; t.reason = "killed"; reply(t); break; }
  case "terminal.rm": { const t = find(p.terminal); if (!t) { fail("not_found", "no terminal"); break; } if (t.state === "live") { fail("live", "still live"); break; } s.terminals = s.terminals.filter((x) => x !== t); reply({ removed: t.address }); break; }
  default: fail("invalid_params", "unknown method " + req.method);
}
`;

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-hc-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, "bin");
  const run = join(base, "run");
  const repo = join(base, "repo");
  for (const d of [bin, run, repo, join(base, "home")]) mkdirSync(d, { recursive: true });
  const state = join(base, "hc-state.json");
  const log = join(base, "hc.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "hc"), FAKE_HC);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet', 'haiku' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  // Any herdr call is a bug on the hc backend: this herdr only records that it was called.
  writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "herdr $*" >> "${base}/herdr.log"\necho '{"error":{"message":"herdr called"}}'\nexit 1\n`);
  for (const n of ["hc", "claude", "agent-browser", "herdr"]) chmodSync(join(bin, n), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: run, XDG_CONFIG_HOME: join(base, "config"), FAKE_HC_STATE: state, FAKE_HC_LOG: log, ORKA_HC_POLL_MS: "20", AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_READY_WAIT_MS: "3000", ORKA_PROMPT_WAIT_MS: "3000", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  delete env.ORKA_JOB;
  delete env.ORCA_JOB;
  delete env.ORKA_BACKEND;
  const terminals = () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).terminals : []);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const herdrCalls = () => (existsSync(join(base, "herdr.log")) ? readFileSync(join(base, "herdr.log"), "utf8") : "");
  const hc = (args) => term.hcCall(args, { env });
  return { base, bin, run, repo, env, state, terminals, calls, herdrCalls, hc };
}

test("ORKA_BACKEND picks the backend; herdr is the default", () => {
  assert.equal(term.defaultBackend({}), "herdr");
  assert.equal(term.defaultBackend({ ORKA_BACKEND: "hc" }), "hc");
  assert.equal(term.defaultBackend({ ORCA_BACKEND: "HC" }), "hc");
});

test("hc: a workspace pane is pending until an agent starts in it, then a labelled claude terminal", () => {
  const t = scratch();
  const ws = t.hc(["workspace", "create", "--cwd", "/w", "--label", "orka j1", "--no-focus", "--env", "PATH=/x:/y", "--env", "ORKA_JOB=j1"]);
  assert.equal(ws.code, 0);
  const pane = ws.json.result.root_pane.pane_id;
  const workspace = ws.json.result.workspace.workspace_id;
  assert.match(pane, /^hp-/);
  assert.equal(t.terminals().length, 0, "no terminal before agent start");
  assert.equal(t.hc(["pane", "get", pane]).code, 0, "a pending pane exists");
  const started = t.hc(["agent", "start", "jj1", "--kind", "claude", "--pane", pane, "--timeout", "2000", "--", "--model", "opus", "--session-id", "s1"]);
  assert.equal(started.code, 0, started.text);
  const [lead] = t.terminals();
  assert.deepEqual(lead.argv, ["claude", "--model", "opus", "--session-id", "s1"]);
  assert.equal(lead.cwd, "/w");
  assert.equal(lead.env.PATH, "/x:/y");
  assert.equal(lead.env.ORKA_JOB, "j1");
  assert.equal(lead.name, "jj1");
  assert.deepEqual(lead.labels, { orka_agent: "jj1", orka_pane: pane, orka_ws: workspace, orka_job: "j1" });
  const run = t.calls().find((c) => c.method === "terminal.run").params;
  assert.equal(run.no_notify, true);
  assert.equal(run.no_parent, true);
  const got = t.hc(["agent", "get", "jj1"]).json.result.agent;
  assert.equal(got.agent_status, "idle");
  assert.equal(got.interactive_ready, true);
  assert.equal(got.pane_id, pane);
  assert.equal(got.terminal_id, lead.address);
  assert.equal(readdirSync(join(t.run, "orka-hc")).length, 0, "the pending file is gone once the agent runs");
});

test("hc: a split pane's agent runs as a child of the lead terminal, outliving it", () => {
  const t = scratch();
  const pane = t.hc(["workspace", "create", "--cwd", "/w"]).json.result.root_pane.pane_id;
  t.hc(["agent", "start", "lead", "--kind", "claude", "--pane", pane, "--timeout", "2000"]);
  const split = t.hc(["pane", "split", "--pane", pane, "--direction", "right", "--cwd", "/w", "--no-focus", "--env", "ORKA_WORKER=builder"]);
  const child = split.json.result.pane.pane_id;
  assert.equal(t.hc(["agent", "start", "builder", "--kind", "claude", "--pane", child, "--timeout", "2000"]).code, 0);
  const [lead, builder] = t.terminals();
  assert.equal(builder.parent, lead.address);
  assert.equal(builder.labels.orka_ws, lead.labels.orka_ws);
  const run = t.calls().filter((c) => c.method === "terminal.run")[1].params;
  assert.equal(run.outlive_parent, true);
  assert.equal(run.no_notify, true);
});

test("hc: prompt, keys, read, rename and close go to the agent's terminal", () => {
  const t = scratch();
  const pane = t.hc(["workspace", "create", "--cwd", "/w"]).json.result.root_pane.pane_id;
  t.hc(["agent", "start", "a1", "--kind", "claude", "--pane", pane, "--timeout", "2000"]);
  assert.equal(t.hc(["agent", "prompt", "a1", "do the thing"]).code, 0);
  assert.equal(t.hc(["agent", "get", "a1"]).json.result.agent.agent_status, "working");
  assert.equal(t.hc(["agent", "send-keys", "a1", "Enter"]).code, 0);
  assert.deepEqual(t.calls().find((c) => c.method === "terminal.keys").params.keys, ["enter"]);
  assert.match(t.hc(["pane", "read", pane, "--source", "recent"]).text, /do the thing/);
  assert.equal(t.hc(["agent", "rename", "a1", "a1-old"]).code, 0);
  assert.equal(t.hc(["agent", "get", "a1"]).code, 1, "the old name is free after a rename");
  assert.equal(t.hc(["agent", "get", "a1-old"]).json.result.agent.pane_id, pane);
  assert.equal(t.hc(["pane", "close", pane]).code, 0);
  assert.equal(t.terminals().length, 0, "closed means killed and removed");
});

test("hc: workspace close ends only that workspace's terminals", () => {
  const t = scratch();
  writeFileSync(t.state, JSON.stringify({ next: 9, terminals: [{ address: "t1", name: null, argv: ["/bin/bash"], labels: { "herdr.space": "sp1" }, state: "live", status: null, screen: "" }] }));
  const ws = t.hc(["workspace", "create", "--cwd", "/w"]).json.result;
  t.hc(["agent", "start", "a1", "--kind", "claude", "--pane", ws.root_pane.pane_id, "--timeout", "2000"]);
  const other = t.hc(["workspace", "create", "--cwd", "/w"]).json.result;
  t.hc(["agent", "start", "b1", "--kind", "claude", "--pane", other.root_pane.pane_id, "--timeout", "2000"]);
  assert.equal(t.hc(["workspace", "close", ws.workspace.workspace_id]).code, 0);
  assert.deepEqual(t.terminals().map((x) => x.address), ["t1", "t10"]);
});

test("hc: a name in use, a blocked start and a pi agent all fail with a reason", () => {
  const t = scratch();
  const p1 = t.hc(["workspace", "create", "--cwd", "/w"]).json.result.root_pane.pane_id;
  t.hc(["agent", "start", "a1", "--kind", "claude", "--pane", p1, "--timeout", "2000"]);
  const p2 = t.hc(["workspace", "create", "--cwd", "/w"]).json.result.root_pane.pane_id;
  assert.match(t.hc(["agent", "start", "a1", "--kind", "claude", "--pane", p2, "--timeout", "2000"]).text, /already used/);
  assert.match(t.hc(["agent", "start", "p1", "--kind", "pi", "--pane", p2]).text, /claude agents only/);
  const blocked = term.hcCall(["agent", "start", "a2", "--kind", "claude", "--pane", p2, "--timeout", "2000"], { env: { ...t.env, FAKE_HC_START: "blocked" } });
  assert.equal(blocked.code, 1);
  assert.match(blocked.text, /status=Blocked/);
  assert.match(t.hc(["agent", "start", "a3", "--kind", "claude", "--pane", "hp-nothere", "--timeout", "2000"]).text, /not a pane orka opened/);
});

test("orka run and orka worker on ORKA_BACKEND=hc: no herdr call, job.backend kept, worker under the lead", () => {
  const t = scratch();
  const g = (...args) => execFileSync("git", args, { cwd: t.repo, encoding: "utf8", env: t.env });
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "init");
  const orka = (args, env = {}) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", t.repo], { encoding: "utf8", env: { ...t.env, ...env } });
  orka(["init"]);
  const id = orka(["new", "--title", "hc", "--goal", "g", "--no-gate"]).stdout.trim();
  const ran = orka(["run", id], { ORKA_BACKEND: "hc" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, / backend=hc terminal=t1/);
  const job = JSON.parse(readFileSync(join(t.repo, ".orka", "jobs", `${id}.json`), "utf8"));
  assert.equal(job.backend, "hc");
  assert.match(job.pane, /^hp-/);
  assert.match(job.workspace, /^hw-/);
  // Without ORKA_BACKEND: the job's own backend is used.
  const worker = orka(["worker", "--job", id, "--name", "builder", "--task", "write the file please, all of it"]);
  assert.equal(worker.status, 0, worker.stderr);
  const [lead, builder] = t.terminals();
  assert.equal(lead.labels.orka_job, id);
  assert.equal(builder.labels.orka_agent, "builder");
  assert.equal(builder.parent, lead.address);
  assert.equal(builder.env.ORKA_WORKER, "builder");
  assert.equal(builder.status.state, "working", "the worker prompt was delivered");
  // orka stop frees the worker's terminal and keeps the orchestrator's.
  const stopped = orka(["stop", id, "test over"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(t.terminals().map((x) => x.labels.orka_agent), ["j" + id.replace(/[^a-z0-9]/g, "")].map((n) => n.slice(0, 32)));
  assert.equal(t.herdrCalls(), "");
});

test("orka run refuses a pi job on the hc backend before it makes anything", () => {
  const t = scratch();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: t.repo, env: t.env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: t.repo, env: t.env });
  const orka = (args, env = {}) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", t.repo], { encoding: "utf8", env: { ...t.env, ...env } });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "p", "--goal", "g"]).stdout.trim();
  const ran = orka(["run", id], { ORKA_BACKEND: "hc" });
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /claude agents only/);
  assert.equal(t.terminals().length, 0);
});
