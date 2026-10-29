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
// working. Every request is logged as a JSON line. With FAKE_HC_APP=1 a Herdr app is "open": it keeps
// the herdr-app layout document and places a terminal labelled herdr.space there, unnamed.
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
    const l = t.labels;
    if (process.env.FAKE_HC_APP && l["herdr.space"]) {
      s.doc = s.doc || { version: 0, value: { spaces: [] } };
      let sp = s.doc.value.spaces.find((x) => x.id === l["herdr.space"]);
      if (!sp) s.doc.value.spaces.push((sp = { id: l["herdr.space"], name: "", folder: t.cwd, tabs: [], extra: "kept" }));
      sp.tabs.push({ id: l["herdr.tab"], name: "", root: { type: "row", children: [{ type: "block", content: { terminal: t.address } }] } });
      s.doc.version++;
    }
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
  case "doc.get": reply(s.doc ? s.doc : { value: null, version: 0 }); break;
  case "doc.set": {
    const cur = s.doc ? s.doc.version : 0;
    if (p.version !== cur) { fail("conflict", "version moved"); break; }
    s.doc = { version: cur + 1, value: p.value };
    reply({ version: s.doc.version });
    break;
  }
  default: fail("invalid_params", "unknown method " + req.method);
}
`;

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-hc-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, "bin");
  const run = join(base, "run");
  const repo = join(base, "repo");
  for (const d of [bin, run, repo, join(base, "home"), join(run, "herdr-core")]) mkdirSync(d, { recursive: true });
  // What orka checks before it talks to hc: the core's socket (here a plain file; the fake hc needs no socket).
  writeFileSync(join(run, "herdr-core", "default.sock"), "");
  const state = join(base, "hc-state.json");
  const log = join(base, "hc.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "hc"), FAKE_HC);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet', 'haiku' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  // Any herdr call is a bug on the hc backend: this herdr only records that it was called.
  writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "herdr $*" >> "${base}/herdr.log"\necho '{"error":{"message":"herdr called"}}'\nexit 1\n`);
  // pi --version answers FAKE_PI_VERSION (1.4.0 unless a test says otherwise).
  writeFileSync(join(bin, "pi"), `#!/bin/sh\necho "\${FAKE_PI_VERSION:-1.4.0}"\n`);
  for (const n of ["hc", "claude", "agent-browser", "herdr", "pi"]) chmodSync(join(bin, n), 0o755);
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

test("ORKA_BACKEND picks the backend; hc is the default", () => {
  assert.equal(term.defaultBackend({}), "hc");
  assert.equal(term.defaultBackend({ ORKA_BACKEND: "herdr" }), "herdr");
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
  const { "herdr.space": space, "herdr.tab": tab, orka_space_name, orka_tab_name, ...orka } = lead.labels;
  assert.deepEqual(orka, { orka_agent: "jj1", orka_pane: pane, orka_ws: workspace, orka_job: "j1" });
  assert.match(space, /^sp[0-9a-f]{32}$/);
  assert.match(tab, /^tb[0-9a-f]{32}$/);
  assert.deepEqual([orka_space_name, orka_tab_name], ["orka j1", "jj1"]);
  assert.equal(t.calls().filter((c) => c.method === "doc.set").length, 0, "no app, no layout write");
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
  assert.match(t.hc(["agent", "start", "x1", "--kind", "codex", "--pane", p2]).text, /not supported/);
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

test("hc: a pi agent runs pi with PI_PROGRAM_STATUS=1 and is read like claude", () => {
  const t = scratch();
  const pane = t.hc(["workspace", "create", "--cwd", "/w", "--env", "ORKA_JOB=j9"]).json.result.root_pane.pane_id;
  const started = t.hc(["agent", "start", "jj9", "--kind", "pi", "--pane", pane, "--timeout", "2000", "--", "--session-id", "s9"]);
  assert.equal(started.code, 0, started.text);
  const [lead] = t.terminals();
  assert.deepEqual(lead.argv, ["pi", "--session-id", "s9"]);
  assert.equal(lead.env.PI_PROGRAM_STATUS, "1");
  assert.equal(lead.env.ORKA_JOB, "j9");
  assert.equal(t.hc(["agent", "get", "jj9"]).json.result.agent.agent_status, "idle");
});

test("orka run and orka worker run a pi job on hc when pi reports status (1.1.0+)", () => {
  const t = scratch();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: t.repo, env: t.env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: t.repo, env: t.env });
  const orka = (args, env = {}) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", t.repo], { encoding: "utf8", env: { ...t.env, ...env } });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "p", "--goal", "g", "--no-gate"]).stdout.trim();
  const ran = orka(["run", id]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /backend=hc terminal=t1/);
  const worker = orka(["worker", "--job", id, "--name", "builder", "--task", "write the file please, all of it"]);
  assert.equal(worker.status, 0, worker.stderr);
  const [lead, builder] = t.terminals();
  assert.equal(lead.argv[0], "pi");
  assert.equal(builder.argv[0], "pi");
  assert.ok(builder.argv.includes("-e"), "orka's pi handoff extension is loaded");
  assert.equal(builder.parent, lead.address);
  assert.equal(builder.env.PI_PROGRAM_STATUS, "1");
  assert.equal(builder.status.state, "working", "the worker prompt was delivered");
  assert.equal(t.herdrCalls(), "");
});

test("orka run refuses a pi job on hc when pi is older than 1.1.0, before it makes anything", () => {
  const t = scratch();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: t.repo, env: t.env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: t.repo, env: t.env });
  const orka = (args, env = {}) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", t.repo], { encoding: "utf8", env: { ...t.env, ...env } });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "p", "--goal", "g"]).stdout.trim();
  const ran = orka(["run", id], { FAKE_PI_VERSION: "0.87.0" });
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /pi 0\.87\.0 reports no status to herdr-core/);
  assert.match(ran.stderr, /1\.1\.0 or later/);
  assert.match(ran.stderr, new RegExp(`ORKA_BACKEND=herdr orka run ${id}`));
  assert.equal(t.terminals().length, 0);
  assert.deepEqual(t.calls(), []);
});

test("piReportsStatus: 1.1.0 and later", () => {
  assert.equal(term.piReportsStatus("1.1.0"), true);
  assert.equal(term.piReportsStatus("1.4.0"), true);
  assert.equal(term.piReportsStatus("2.0.0"), true);
  assert.equal(term.piReportsStatus("1.0.4"), false);
  assert.equal(term.piReportsStatus("0.87.0"), false);
  assert.equal(term.piReportsStatus(""), false);
});

test("orka run on the hc default fails fast when herdr-core is not running, and never asks hc", () => {
  const t = scratch();
  rmSync(join(t.run, "herdr-core", "default.sock"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: t.repo, env: t.env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: t.repo, env: t.env });
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", t.repo], { encoding: "utf8", env: t.env });
  orka(["init"]);
  const id = orka(["new", "--title", "hc", "--goal", "g", "--no-gate"]).stdout.trim();
  const ran = orka(["run", id]);
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /herdr-core is not running/);
  assert.match(ran.stderr, new RegExp(`ORKA_BACKEND=herdr orka run ${id}`));
  assert.deepEqual(t.calls(), [], "no hc call at all");
  assert.equal(t.hc(["agent", "list"]).code, 1, "rpc refuses without a socket");
  assert.deepEqual(t.calls(), []);
});

test("a job that started on herdr stays on herdr under the hc default", () => {
  const t = scratch();
  writeFileSync(join(t.bin, "herdr"), `#!/bin/sh\necho "herdr $*" >> "${t.base}/herdr.log"\necho '{"result":{}}'\n`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: t.repo, env: t.env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: t.repo, env: t.env });
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", t.repo], { encoding: "utf8", env: t.env });
  orka(["init"]);
  const id = orka(["new", "--title", "old", "--goal", "g", "--no-gate"]).stdout.trim();
  const file = join(t.repo, ".orka", "jobs", `${id}.json`);
  for (const backend of ["herdr", undefined]) {
    const job = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(job, { status: "running", agent: "jold", pane: "w1:p1", workspace: "w1", backend });
    if (!backend) delete job.backend;
    writeFileSync(file, JSON.stringify(job));
    writeFileSync(join(t.base, "herdr.log"), "");
    const stopped = orka(["stop", id, "--keep"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(t.herdrCalls(), /herdr agent send-keys jold ctrl\+c/, `backend ${backend}`);
    assert.deepEqual(t.calls(), [], `backend ${backend}: no hc call`);
  }
});

test("hc: ORKA_PANE_ENV copies the named caller variables into panes, and itself", () => {
  const t = scratch();
  const env = { ...t.env, ORKA_PANE_ENV: "NODE_EXTRA_CA_CERTS, NOT_SET,bad-name", NODE_EXTRA_CA_CERTS: "/c/ca.pem", OTHER: "no" };
  const pane = term.hcCall(["workspace", "create", "--cwd", "/w", "--env", "ORKA_JOB=j1"], { env }).json.result.root_pane.pane_id;
  assert.equal(term.hcCall(["agent", "start", "a1", "--kind", "claude", "--pane", pane, "--timeout", "2000"], { env }).code, 0);
  const [lead] = t.terminals();
  assert.equal(lead.env.NODE_EXTRA_CA_CERTS, "/c/ca.pem");
  assert.equal(lead.env.ORKA_PANE_ENV, "NODE_EXTRA_CA_CERTS, NOT_SET,bad-name");
  assert.equal(lead.env.OTHER, undefined);
  assert.equal("NOT_SET" in lead.env, false);
  assert.equal(lead.env.ORKA_JOB, "j1");
});

test("appLabels: one space per job, one tab per pane, readable names", () => {
  const lead = term.appLabels({ job: "20261029214905714-fix-duplicated-paragraph", workspace: "hw-1", pane: "hp-a", role: "orchestrator" });
  const docs = term.appLabels({ job: "20261029214905714-fix-duplicated-paragraph", workspace: "hw-1", pane: "hp-b", role: "docs" });
  const other = term.appLabels({ job: "20261029220000000-other", workspace: "hw-2", pane: "hp-a", role: "orchestrator" });
  assert.match(lead["herdr.space"], /^sp[0-9a-f]{32}$/);
  assert.equal(lead["herdr.space"], docs["herdr.space"], "a job's agents share its space");
  assert.notEqual(lead["herdr.tab"], docs["herdr.tab"], "each agent has its own tab");
  assert.notEqual(lead["herdr.space"], other["herdr.space"]);
  assert.notEqual(lead["herdr.tab"], other["herdr.tab"], "same pane id in another job is another tab");
  assert.equal(lead.orka_space_name, "orka fix-duplicated-paragraph");
  assert.deepEqual([lead.orka_tab_name, docs.orka_tab_name], ["orchestrator", "docs"]);
  assert.equal(term.appLabels({ workspace: "hw-1", pane: "hp-a" })["herdr.space"].length, 34, "no job: keyed by workspace");
  assert.deepEqual(term.appLabels({ pane: "hp-a" }), {}, "no job, no workspace: not shown");
  assert.equal(term.jobSlug("plain-id"), "plain-id");
});

test("nameLayout names only unnamed spaces and tabs of orka terminals, keeping the rest as it is", () => {
  const l = term.appLabels({ job: "20261029214905714-x", pane: "hp-a", role: "orchestrator" });
  const doc = { spaces: [
    { id: "spuser", name: "", tabs: [{ id: "tbuser", name: "" }] },
    { id: l["herdr.space"], name: "", folder: "/w", future: 1, tabs: [{ id: l["herdr.tab"], name: "", root: { x: 1 } }, { id: "tbother", name: "" }] },
  ] };
  const named = term.nameLayout(structuredClone(doc), [{ labels: l }, { labels: { "herdr.space": "spuser", "herdr.tab": "tbuser" } }]);
  assert.equal(named.spaces[0].name, "", "a space orka did not make is left alone");
  assert.equal(named.spaces[0].tabs[0].name, "");
  assert.equal(named.spaces[1].name, "orka x");
  assert.deepEqual(named.spaces[1].tabs, [{ id: l["herdr.tab"], name: "orchestrator", root: { x: 1 } }, { id: "tbother", name: "" }]);
  assert.equal(named.spaces[1].future, 1);
  doc.spaces[1].name = "mine";
  doc.spaces[1].tabs[0].name = "lead";
  assert.equal(term.nameLayout(doc, [{ labels: l }]), null, "names someone gave stay");
  assert.equal(term.nameLayout(null, [{ labels: l }]), null);
  assert.equal(term.nameLayout({ spaces: [] }, [{ labels: l }]), null, "not placed yet");
});

test("hc with the Herdr app open: a job is one named space, its orchestrator and worker named tabs", () => {
  const t = scratch();
  const env = { ...t.env, FAKE_HC_APP: "1", ORKA_HC_NAME_WAIT_MS: "500" };
  const hc = (args) => term.hcCall(args, { env });
  const job = "20261029214905714-fix-duplicated-paragraph";
  const pane = hc(["workspace", "create", "--cwd", "/w", "--env", `ORKA_JOB=${job}`, "--env", "ORKA_WORKER=orchestrator"]).json.result.root_pane.pane_id;
  assert.equal(hc(["agent", "start", "j1", "--kind", "claude", "--pane", pane, "--timeout", "2000"]).code, 0);
  const child = hc(["pane", "split", "--pane", pane, "--cwd", "/w", "--env", `ORKA_JOB=${job}`, "--env", "ORKA_WORKER=docs"]).json.result.pane.pane_id;
  assert.equal(hc(["agent", "start", "docs", "--kind", "claude", "--pane", child, "--timeout", "2000"]).code, 0);
  const [lead, docs] = t.terminals();
  assert.equal(lead.labels["herdr.space"], docs.labels["herdr.space"]);
  assert.equal(docs.parent, lead.address, "the app nests the worker under its orchestrator");
  const { spaces } = JSON.parse(readFileSync(t.state, "utf8")).doc.value;
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].name, "orka fix-duplicated-paragraph");
  assert.equal(spaces[0].extra, "kept", "fields orka does not know survive the write");
  assert.deepEqual(spaces[0].tabs.map((c) => c.name), ["orchestrator", "docs"]);
  assert.equal(t.calls().some((c) => c.method === "terminal.label" && "where" in (c.params.labels || {})), false, "the app writes where, not orka");
});

test("hc: ORKA_HC_SPACES=off keeps a job out of the Herdr app", () => {
  const t = scratch();
  const env = { ...t.env, FAKE_HC_APP: "1", ORKA_HC_SPACES: "off" };
  const pane = term.hcCall(["workspace", "create", "--cwd", "/w", "--env", "ORKA_JOB=j1"], { env }).json.result.root_pane.pane_id;
  assert.equal(term.hcCall(["agent", "start", "a1", "--kind", "claude", "--pane", pane, "--timeout", "2000"], { env }).code, 0);
  const [lead] = t.terminals();
  assert.equal(Object.keys(lead.labels).some((k) => k.startsWith("herdr.") || k.startsWith("orka_space")), false);
  assert.equal(t.calls().some((c) => c.method.startsWith("doc.")), false);
});
