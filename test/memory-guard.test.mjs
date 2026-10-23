import { execFileSync, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enqueue, guardLimits, guardVerdict, liveQueue, memAvailableMb, orkaPaneCount } from "../lib/guard.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

test("guardLimits: defaults, config, env override, off", () => {
  const none = () => undefined;
  assert.deepEqual(guardLimits({}, none), { off: false, minAvailableMb: 1024, maxPanes: 20, waitMs: 480000, pollMs: 15000 });
  const cfg = { minAvailableMb: 2048, maxPanes: 6, wait: "2m", poll: "5s" };
  assert.deepEqual(guardLimits(cfg, none), { off: false, minAvailableMb: 2048, maxPanes: 6, waitMs: 120000, pollMs: 5000 });
  const env = { MIN_MEM_MB: "999999", GUARD_WAIT: "1s" };
  const got = guardLimits(cfg, (k) => env[k]);
  assert.equal(got.minAvailableMb, 999999);
  assert.equal(got.waitMs, 1000);
  assert.equal(guardLimits({ enabled: false }, none).off, true);
  assert.equal(guardLimits({}, (k) => (k === "MEMORY_GUARD" ? "off" : undefined)).off, true);
});

test("guardVerdict: memory and panes; an unknown reading never blocks", () => {
  const limits = { minAvailableMb: 1024, maxPanes: 4 };
  assert.deepEqual(guardVerdict({ availableMb: 2000, panes: 3 }, limits), { ok: true, reasons: [] });
  assert.match(guardVerdict({ availableMb: 500, panes: 3 }, limits).reasons[0], /MemAvailable 500MB < 1024MB/);
  assert.match(guardVerdict({ availableMb: 2000, panes: 4 }, limits).reasons[0], /4 live panes >= 4/);
  assert.equal(guardVerdict({ availableMb: null, panes: null }, limits).ok, true);
});

test("memAvailableMb reads meminfo; the queue is oldest first and drops dead waiters", () => {
  const dir = mkdtempSync(join(tmpdir(), "orka-guard-"));
  writeFileSync(join(dir, "meminfo"), "MemTotal: 8000000 kB\nMemAvailable:    2097152 kB\n");
  assert.equal(memAvailableMb(dir), 2048);
  assert.equal(memAvailableMb(join(dir, "nope")), null);
  const q = join(dir, "queue");
  const a = enqueue(q, { job: "j", name: "a", pid: 11 });
  enqueue(q, { job: "j", name: "dead", pid: 12 });
  const live = liveQueue(q, (pid) => pid === 11);
  assert.deepEqual(live.map((e) => e.name), ["a"]);
  assert.equal(live[0].file, a);
  assert.equal(liveQueue(q, () => true).length, 1, "the dead waiter's file is gone");
  rmSync(dir, { recursive: true, force: true });
});

// A fake /proc: pid -> { ppid, cmdline, env }.
function fakeProcs(root, procs) {
  for (const [pid, p] of Object.entries(procs)) {
    mkdirSync(join(root, pid), { recursive: true });
    writeFileSync(join(root, pid, "status"), `Name:\tx\nPPid:\t${p.ppid}\n`);
    writeFileSync(join(root, pid, "cmdline"), p.cmdline.split(" ").join("\0"));
    writeFileSync(join(root, pid, "environ"), Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join("\0"));
  }
}

test("orkaPaneCount counts only ORKA_JOB-tagged pane shells, once per pane", () => {
  const dir = mkdtempSync(join(tmpdir(), "orka-guard-proc-"));
  fakeProcs(dir, {
    10: { ppid: 1, cmdline: "/home/x/.local/bin/herdr server" },
    11: { ppid: 10, cmdline: "/bin/bash", env: { ORKA_JOB: "j1" } },
    12: { ppid: 11, cmdline: "claude --model opus", env: { ORKA_JOB: "j1" } },
    13: { ppid: 10, cmdline: "/bin/bash", env: { ORCA_JOB: "old", ORCA_WORKER: "w" } },
    14: { ppid: 10, cmdline: "/bin/bash", env: { HOME: "/home/x" } },
    15: { ppid: 14, cmdline: "claude", env: { HOME: "/home/x" } },
    16: { ppid: 1, cmdline: "agent-browser-chrome", env: { ORKA_JOB: "j1" } },
  });
  assert.equal(orkaPaneCount(dir), 2, "two tagged panes; Olaf's own pane and a detached tagged browser do not count");
  assert.equal(orkaPaneCount(join(dir, "nope")), null);
  rmSync(dir, { recursive: true, force: true });
});

// orka worker against a herdr stub; memory comes from a fake meminfo (ORKA_PROC_ROOT).
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-guard-cli-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const proc = join(base, "proc");
  for (const d of [repo, bin, proc, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
case "$1 $2" in
  "agent start") echo "$3" >> "${base}/agents"; echo '{"result":{}}';;
  "agent get") if ! grep -qx "$3" "${base}/agents" 2>/dev/null; then echo '{"error":{"message":"not found"}}'; exit 1; fi
    if [ -e "${base}/prompted-$3" ]; then echo '{"result":{"agent":{"agent_status":"working","interactive_ready":true}}}'; else echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true}}}'; fi;;
  "agent prompt") touch "${base}/prompted-$3"; echo '{"result":{}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  *) echo '{}';;
esac
`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const meminfo = (mb) => writeFileSync(join(proc, "meminfo"), `MemAvailable: ${mb * 1024} kB\n`);
  meminfo(4096);
  // One orka pane and one of Olaf's own panes: the guard counts 1.
  fakeProcs(proc, {
    10: { ppid: 1, cmdline: "herdr server" },
    11: { ppid: 10, cmdline: "bash", env: { ORKA_JOB: "j" } },
    12: { ppid: 10, cmdline: "bash" },
  });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_PROMPT_POLL_MS: "50", ORKA_PROC_ROOT: proc, ORKA_GUARD_POLL: "0.2s" };
  const orka = (args, extra = {}) => spawnSync("timeout", ["60", process.execPath, ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...env, ...extra } });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "g", "--goal", "g", "--no-gate"]).stdout.trim();
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(repo, "wt") });
  writeFileSync(path, JSON.stringify(job));
  const decisions = () => readFileSync(join(repo, ".orka", "jobs", id, "decisions.tsv"), "utf8");
  return { repo, id, orka, env, meminfo, decisions };
}

const TASK = "SCOPE: a ACCEPTANCE: b";

test("a worker start past the memory limit queues, then gives up and logs it", () => {
  const t = scratch();
  const r = t.orka(["worker", "--job", t.id, "--name", "w1", "--task", TASK], { ORKA_MIN_MEM_MB: "999999", ORKA_GUARD_WAIT: "1s" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /memory guard: MemAvailable 4096MB < 999999MB; builder w1 queued/);
  assert.match(r.stderr, /w1 not started after [0-9]+s/);
  const log = t.decisions();
  assert.match(log, /memory-guard\tqueued builder w1\tMemAvailable 4096MB < 999999MB\t.*\twaiting/);
  assert.match(log, /memory-guard\tdid not start builder w1 after [0-9]+s\t.*\tnot started/);
  assert.equal(t.orka(["worker", "--job", t.id, "--name", "w1", "--task", TASK]).status, 0, "room: starts at once");
});

test("a queued worker shows in status and starts once memory frees up", async () => {
  const t = scratch();
  t.meminfo(200);
  const child = spawn(process.execPath, [ORKA, "worker", "--job", t.id, "--name", "w1", "--task", TASK, "--cwd", t.repo], { env: { ...t.env, ORKA_GUARD_WAIT: "30s" } });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((res) => child.on("exit", res));
  for (let i = 0; i < 100 && !err.includes("queued"); i++) await new Promise((r) => setTimeout(r, 50));
  const status = t.orka(["status", t.id]).stdout;
  assert.match(status, /host: memory 200MB available, live panes 1, queue 1 \(guard: min 1024MB, max 20 panes\)/);
  assert.match(status, new RegExp(`queued: ${t.id} w1 \\(builder\\) since `));
  assert.match(t.orka(["status"]).stdout, /queue 1/);
  t.meminfo(4096);
  assert.equal(await exited, 0, err);
  assert.match(err, /memory guard: room again after [0-9]+s; starting w1/);
  assert.match(t.decisions(), /memory-guard\tstarted builder w1 after [0-9]+s\troom again\t.*\tstarted/);
  assert.match(t.orka(["status"]).stdout, /queue 0/);
});
