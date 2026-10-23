import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as inbox from "../lib/inbox.mjs";
import { excerpt, readResult, wakeText } from "../lib/wake.mjs";
import { piExtension } from "../lib/handoff-hook.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");
const HOOK = join(import.meta.dirname, "..", "lib", "handoff-hook.mjs");

test("inbox: enqueue, pending oldest first, one claim wins, release puts it back, counts", () => {
  const d = mkdtempSync(join(tmpdir(), "orka-inbox-"));
  inbox.enqueue(d, "orchestrator", { from: "olaf", message: "one", text: "T1" }, new Date(1000));
  inbox.enqueue(d, "orchestrator", { from: "olaf", message: "two", text: "T2" }, new Date(2000));
  inbox.enqueue(d, "builder", { from: "orchestrator", message: "b", text: "B" }, new Date(3000));
  assert.deepEqual(inbox.pending(d, "orchestrator").map((e) => e.message), ["one", "two"]);
  assert.deepEqual(inbox.pendingCounts(d), { orchestrator: 2, builder: 1 });
  const got = inbox.claim(d, "orchestrator", "test");
  assert.equal(got.length, 2);
  assert.deepEqual(inbox.claim(d, "orchestrator", "test"), [], "nothing left to claim twice");
  assert.match(inbox.deliveryText(got), /^orka inbox 1\/2 \(olaf, .*\):\nT1\n\norka inbox 2\/2/);
  const done = JSON.parse(readFileSync(join(inbox.deliveredDir(d, "orchestrator"), got[0].file), "utf8"));
  assert.deepEqual([done.via, Boolean(done.deliveredAt)], ["test", true]);
  inbox.release(d, "orchestrator", got.slice(1));
  assert.deepEqual(inbox.pendingCounts(d), { orchestrator: 1, builder: 1 });
  assert.equal(inbox.deliveryText(inbox.pending(d, "builder")), "B");
  rmSync(d, { recursive: true, force: true });
});

test("wake text is bounded: 15 lines, 1200 characters, commits up to 10 or none, full text stays on disk", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const cut = excerpt(long, "/r.json");
  assert.equal(cut.split("\n").length, 16);
  assert.match(cut, /line 14\n\.\.\. \(full text in \/r\.json\)$/);
  assert.ok(excerpt("x".repeat(5000), "/r").length < 1250);
  assert.equal(excerpt("short", "/r"), "short");
  assert.deepEqual(readResult(JSON.stringify({ worker: "b", ok: true, result: "did it" })), { state: "ok", text: "did it" });
  assert.deepEqual(readResult(JSON.stringify({ verdict: "fail", failures: [{}, {}], summary: "two broke" })), { state: "verdict fail, 2 blocking failure(s)", text: "two broke" });
  const text = wakeText({ jobId: "j1", worker: "builder", role: "builder", state: "ok", text: "did it", path: "/r.json", commits: Array.from({ length: 14 }, (_, i) => `c${i}`), undelivered: 2 });
  assert.match(text, /^orka wake: worker builder finished \(ok\)\.\nCommits:\nc0\n/);
  assert.doesNotMatch(text, /c10/);
  assert.match(text, /Full result: \/r\.json\. Undelivered steers in the inbox: 2\.\nRun orka digest j1/);
  assert.match(wakeText({ jobId: "j", worker: "v", role: "verifier", state: "verdict pass", text: "", path: "/v", commits: [] }), /^orka wake: verifier v finished \(verdict pass\)\.\nCommits: none\nResult:\n\(empty\)/);
});

// Fake herdr with per-agent state: status-<name> (default idle), prompts-<name>, pane-<name>.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-wake-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const st = join(base, "state");
  for (const d of [repo, bin, join(base, "home"), join(base, "run"), st]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
S="${st}"
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[]}}';;
  "agent prompt") printf '%s\\n-----\\n' "$4" >> "$S/prompts-$3"; [ -e "$S/stay-$3" ] || echo working > "$S/status-$3"; echo '{"result":{}}';;
  "agent get")
    [ -e "$S/pane-$3" ] || { echo '{"error":{"message":"not found"}}'; exit 1; }
    echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$(cat "$S/status-$3" 2>/dev/null || echo idle)\\",\\"interactive_ready\\":true,\\"pane_id\\":\\"$(cat "$S/pane-$3")\\"}}}";;
  "pane read") printf '╭────╮\\n│ ❯ │\\n╰────╯\\n';;
  *) echo '{}';;
esac
`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_PROMPT_POLL_MS: "10", ORKA_PROMPT_WAIT_MS: "300", ORKA_READY_WAIT_MS: "1500" };
  delete env.ORKA_JOB;
  delete env.ORCA_JOB;
  const orka = (args, extra = {}) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...env, ...extra } });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "w", "--goal", "g", "--no-gate"]).stdout.trim();
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  const dir = join(repo, ".orka", "jobs", id);
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const patch = (fn) => {
    const j = read();
    fn(j);
    writeFileSync(path, JSON.stringify(j));
  };
  const agent = (name, pane, status = "idle") => {
    writeFileSync(join(st, `pane-${name}`), pane);
    writeFileSync(join(st, `status-${name}`), status);
  };
  const status = (name, s) => writeFileSync(join(st, `status-${name}`), s);
  const prompts = (name) => (existsSync(join(st, `prompts-${name}`)) ? readFileSync(join(st, `prompts-${name}`), "utf8") : "").split("-----\n").filter((p) => p.trim());
  mkdirSync(join(dir, "results"), { recursive: true });
  patch((j) => Object.assign(j, { status: "running", pane: "p-orch", agent: "orch", sessionId: "lead-1", worktree: join(repo, "wt") }));
  agent("orch", "p-orch");
  const result = (name, body) => {
    const p = join(dir, "results", `${name}.json`);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };
  const addWorker = (name, extra = {}) => {
    patch((j) => j.workers.push({ name, pane: `p-${name}`, kind: "pi", sessionId: `s-${name}`, startedAt: new Date().toISOString(), result: join(dir, "results", `${name}.json`), ...extra }));
    agent(name, `p-${name}`);
  };
  patch((j) => (j.workers = []));
  const decisions = () => (existsSync(join(dir, "decisions.tsv")) ? readFileSync(join(dir, "decisions.tsv"), "utf8") : "");
  return { base, repo, id, dir, path, read, patch, agent, status, prompts, result, addWorker, orka, decisions, stay: (n) => writeFileSync(join(st, `stay-${n}`), "") };
}

test("one wake per result: sent when the worker's turn ends, never twice, again for a rewritten result", () => {
  const t = scratch();
  t.addWorker("builder");
  t.status("builder", "working");
  const p = t.result("builder", { worker: "builder", ok: true, result: "added the toggle\nand a test" });
  assert.match(t.orka(["wake", t.id]).stdout, /wake builder: waiting: builder is working/);
  assert.equal(t.prompts("orch").length, 0, "no wake while the worker's turn runs");
  t.status("builder", "done");
  assert.match(t.orka(["wake", t.id]).stdout, /wake builder: wake sent/);
  const got = t.prompts("orch");
  assert.equal(got.length, 1);
  assert.match(got[0], /^orka wake: worker builder finished \(ok\)\.\n/);
  assert.match(got[0], /Result:\nadded the toggle\nand a test\nFull result: .*builder\.json\.\nRun orka digest/);
  t.status("orch", "idle");
  assert.equal(t.orka(["wake", t.id]).stdout.trim(), "nothing to wake or deliver");
  assert.equal(t.prompts("orch").length, 1, "exactly one wake per result file");
  assert.match(t.decisions(), /\twake\twake orchestrator: builder finished\tok\t.*\tdelivered to orch \(p-orch\)/);
  writeFileSync(p, JSON.stringify({ worker: "builder", ok: true, result: "round two" }));
  utimesSync(p, new Date(), new Date(Date.now() + 5000));
  t.orka(["wake", t.id]);
  assert.equal(t.prompts("orch").length, 2);
});

test("a wake is held while the orchestrator hands off, then goes to the successor's pane; a working lead gets it queued", () => {
  const t = scratch();
  t.addWorker("builder");
  t.result("builder", { worker: "builder", ok: true, result: "done" });
  t.patch((j) => (j.lead = { handoff: { state: "writing", n: 1 } }));
  assert.match(t.orka(["wake", t.id]).stdout, /held: the orchestrator is handing off/);
  assert.equal(t.prompts("orch").length, 0);
  // The successor took over the name in a new pane.
  t.patch((j) => Object.assign(j, { pane: "p-orch-2", sessionId: "lead-2", lead: { handoffs: [{ n: 1 }] } }));
  t.agent("orch", "p-orch-2", "working");
  t.stay("orch");
  assert.match(t.orka(["wake", t.id]).stdout, /wake builder: wake queued mid-turn/);
  assert.equal(t.prompts("orch").length, 1);
  assert.match(t.decisions(), /\twake\twake orchestrator: builder finished\tok\t.*\tqueued mid-turn for orch \(p-orch-2\)/);
  assert.equal(t.read().wakes[Object.keys(t.read().wakes)[0]].pane, "p-orch-2");
});

test("worker and verifier prompts no longer ping the orchestrator; the orchestrator is told about wakes", () => {
  const src = readFileSync(ORKA, "utf8");
  assert.doesNotMatch(src, /herdr agent prompt \$\{job\.agent\} "<the one-line note>"/);
  assert.match(src, /Do not message the orchestrator\. When your turn ends with the result file written, orka sends it a short wake/);
  assert.match(src, /orka sends you one short "orka wake: worker <name> finished" message/);
});

test("a steer to a working orchestrator waits in the inbox; digest and status count it; the Claude hook delivers it", () => {
  const t = scratch();
  t.status("orch", "working");
  const r = t.orka(["steer", t.id, "use a CSS variable"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /steer for orchestrator queued in the inbox \(orch is working\)/);
  assert.equal(t.prompts("orch").length, 0);
  assert.match(t.orka(["digest", t.id]).stdout, /steer inbox: 1 undelivered \(orchestrator 1\)/);
  assert.match(t.orka(["status", t.id]).stdout, /steer inbox: orchestrator 1 undelivered/);
  assert.equal(t.read().steers.at(-1).delivery, "inbox");
  const cfg = join(t.repo, ".orka", "config.json");
  const hook = (session) => spawnSync(process.execPath, [HOOK, "claude", t.path, t.dir, cfg], { input: JSON.stringify({ session_id: session, transcript_path: "" }), encoding: "utf8" });
  assert.equal(hook("someone-else").stdout, "", "another pane's hook does not take it");
  const out = JSON.parse(hook("lead-1").stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Owner steer:\nuse a CSS variable$/);
  assert.equal(hook("lead-1").stdout, "", "delivered once");
  assert.doesNotMatch(t.orka(["digest", t.id]).stdout, /steer inbox/);
  const delivered = readdirSync(join(t.dir, "steer", "delivered", "orchestrator"));
  assert.equal(JSON.parse(readFileSync(join(t.dir, "steer", "delivered", "orchestrator", delivered[0]), "utf8")).via, "claude hook");
});

test("idle fallback: the watcher pass delivers a queued steer once the target is idle", () => {
  const t = scratch();
  t.status("orch", "working");
  t.orka(["steer", t.id, "stop after the next commit"]);
  assert.match(t.orka(["wake", t.id]).stdout, /steer orchestrator: left for its hook: working/);
  t.status("orch", "idle");
  assert.match(t.orka(["wake", t.id]).stdout, /steer orchestrator: delivered by the watcher/);
  const got = t.prompts("orch");
  assert.equal(got.length, 1);
  assert.match(got[0], /Owner steer:\nstop after the next commit/);
  assert.match(t.decisions(), /\tsteer\tinbox delivered to orchestrator\t1 message\(s\), agent idle\t/);
});

test("--to <worker>: the worker's inbox, by the Pi hook between tool calls; a retired pane never gets it", async () => {
  const t = scratch();
  t.addWorker("builder-h1", { retired: { by: "builder" }, sessionId: "s-old" });
  t.addWorker("builder", { sessionId: "s-new" });
  t.status("builder", "working");
  const r = t.orka(["steer", t.id, "--to", "builder", "skip the docs"], { ORKA_JOB: t.id });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /steer for builder queued in the inbox/);
  assert.equal(t.read().steers.at(-1).from, "orchestrator");
  const sent = [];
  const handlers = {};
  piExtension({ jobFile: t.path, jobDir: t.dir, configFile: join(t.repo, ".orka", "config.json") })({ on: (n, f) => (handlers[n] = f), sendMessage: (m, o) => sent.push({ m, o }) });
  const ctx = (session) => ({ getContextUsage: () => ({ tokens: 10, contextWindow: 500000 }), model: { contextWindow: 500000 }, sessionManager: { getSessionId: () => session } });
  await handlers.tool_result({}, ctx("s-old"));
  assert.equal(sent.length, 0, "the retired pane's session gets nothing");
  await handlers.tool_result({}, ctx("s-new"));
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].m.customType, sent[0].o.deliverAs], ["orka-inbox", "steer"]);
  assert.match(sent[0].m.content, /^orka inbox: a message for you from the orchestrator:\nskip the docs$/);
  assert.match(t.orka(["steer", t.id, "--to", "nobody", "x"]).stderr, /no live worker named nobody/);
  t.status("builder", "idle");
  assert.match(t.orka(["steer", t.id, "--to", "builder", "now commit"]).stdout, /steered .* \(builder\)/);
  assert.match(t.prompts("builder").at(-1), /now commit/);
});
