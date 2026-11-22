import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

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
  "pane read") cat "$S/text-$3" 2>/dev/null || printf '╭────╮\\n│ ❯ │\\n╰────╯\\n';;
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
  const paneText = (pane, text) => writeFileSync(join(st, `text-${pane}`), text);
  const ago = (name, ms) => patch((j) => (j.wakeSeen = { ...(j.wakeSeen || {}), [name]: new Date(Date.now() - ms).toISOString() }));
  return { paneText, ago, base, repo, id, dir, path, read, patch, agent, status, prompts, result, addWorker, orka, decisions, stay: (n) => writeFileSync(join(st, `stay-${n}`), "") };
}

const live = (t) => t.orka(["wake", t.id, "--live"]).stdout.trim();
const lines = Array.from({ length: 30 }, (_, i) => `pane line ${i}`).join("\n") + "\n";

test("idle worker without a result: grace starts at first sight, then one wake with the pane tail, never twice", () => {
  const t = scratch();
  t.addWorker("builder");
  t.paneText("p-builder", lines);
  assert.match(t.orka(["wake", t.id]).stdout, /builder: ended without a result: grace 60s started/);
  assert.equal(t.prompts("orch").length, 0);
  assert.match(t.orka(["wake", t.id]).stdout, /within grace/, "within grace: no wake");
  assert.equal(t.prompts("orch").length, 0);
  t.ago("builder", 61000);
  assert.match(t.orka(["wake", t.id]).stdout, /ended-without-result wake sent/);
  const got = t.prompts("orch");
  assert.equal(got.length, 1);
  assert.match(got[0], /^orka wake: worker builder ended its turn without a result/);
  assert.match(got[0], /pane line 29/);
  assert.match(got[0], /pane line 15/);
  assert.doesNotMatch(got[0], /pane line 14\b/, "about 15 lines");
  const rec = t.read().wakes.endedWithoutResult.builder;
  assert.deepEqual([rec.worker, rec.mode, Boolean(rec.at)], ["builder", "now", true]);
  t.status("orch", "idle");
  assert.equal(t.orka(["wake", t.id]).stdout.trim(), "nothing to wake or deliver");
  assert.equal(t.prompts("orch").length, 1);
  assert.match(t.decisions(), /ended without a result/);
});

test("a worker that works again before the grace ends loses its clock; dry mode sends and writes nothing", () => {
  const t = scratch();
  t.addWorker("builder");
  t.orka(["wake", t.id]);
  assert.ok(t.read().wakeSeen.builder);
  t.status("builder", "working");
  t.orka(["wake", t.id]);
  assert.equal(t.read().wakeSeen?.builder, undefined);
  t.status("builder", "done");
  t.ago("builder", 120000);
  const dry = t.orka(["wake", t.id, "--dry-run"]);
  assert.match(dry.stdout, /ended-without-result wake sent/);
  assert.equal(t.prompts("orch").length, 0);
  assert.equal(t.read().wakes?.endedWithoutResult, undefined);
  t.status("orch", "working");
  assert.match(t.orka(["wake", t.id]).stdout, /queued mid-turn/);
  assert.equal(t.read().wakes.endedWithoutResult.builder.mode, "queue");
});

test("held while the orchestrator is blocked; a result file means the finished wake, not the ended one", () => {
  const t = scratch();
  t.addWorker("builder");
  t.status("orch", "blocked");
  t.orka(["wake", t.id]);
  t.ago("builder", 120000);
  assert.match(t.orka(["wake", t.id]).stdout, /held: orchestrator blocked/);
  assert.equal(t.read().wakes?.endedWithoutResult, undefined);

  const u = scratch();
  u.addWorker("builder");
  u.ago("builder", 120000);
  u.result("builder", { worker: "builder", ok: true, result: "done it" });
  assert.match(u.orka(["wake", u.id]).stdout, /wake builder: wake sent/);
  const got = u.prompts("orch");
  assert.equal(got.length, 1);
  assert.match(got[0], /^orka wake: worker builder finished/);
  assert.doesNotMatch(got[0], /ended its turn/);
  assert.equal(u.read().wakes.endedWithoutResult, undefined);
});

test("workersLive: true for working, blocked, an unwoken result, a pending ended-without-result; false once all woken", () => {
  const t = scratch();
  assert.equal(live(t), "workers live: false", "no workers");
  t.addWorker("builder");
  t.status("builder", "working");
  assert.equal(live(t), "workers live: true");
  t.status("builder", "blocked");
  assert.equal(live(t), "workers live: true");
  t.status("builder", "done");
  assert.equal(live(t), "workers live: true", "ended without a result, not yet woken");
  t.ago("builder", 120000);
  t.orka(["wake", t.id]);
  assert.equal(t.read().wakes.endedWithoutResult.builder.mode, "now");
  assert.equal(live(t), "workers live: false", "woken");

  const u = scratch();
  u.addWorker("builder");
  u.result("builder", { worker: "builder", ok: true, result: "x" });
  assert.equal(live(u), "workers live: true", "result not yet woken");
  u.orka(["wake", u.id]);
  assert.equal(u.prompts("orch").length, 1);
  assert.equal(live(u), "workers live: false");
  u.patch((j) => (j.workers[0].retired = { at: "x" }));
  u.status("builder", "working");
  assert.equal(live(u), "workers live: false", "retired workers do not count");
});
