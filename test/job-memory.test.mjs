import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryCheck } from "../lib/doctor.mjs";
import { finishedHint, jobMemory, jobMemoryText } from "../lib/guard.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// A fake /proc: pid -> { env, pss, rss } (kB), plus meminfo.
function fakeProc(root, procs, availableMb = 4096) {
  writeFileSync(join(root, "meminfo"), `MemAvailable: ${availableMb * 1024} kB\n`);
  for (const [pid, p] of Object.entries(procs)) {
    mkdirSync(join(root, pid), { recursive: true });
    writeFileSync(join(root, pid, "environ"), Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join("\0"));
    writeFileSync(join(root, pid, "cmdline"), "node\0x.mjs");
    writeFileSync(join(root, pid, "status"), `Name:\tnode\nPPid:\t1\n${p.rss != null ? `VmRSS:\t${p.rss} kB\n` : ""}`);
    if (p.pss != null) writeFileSync(join(root, pid, "smaps_rollup"), `Rss:  ${p.pss * 2} kB\nPss:  ${p.pss} kB\n`);
  }
}

test("jobMemory sums PSS per job and worker, falls back to VmRSS, ignores untagged processes", () => {
  const root = mkdtempSync(join(tmpdir(), "orka-jobmem-"));
  fakeProc(root, {
    10: { env: { ORKA_JOB: "a", ORKA_WORKER: "w1" }, pss: 600 * 1024 },
    11: { env: { ORKA_JOB: "a", ORKA_WORKER: "w1" }, pss: 200 * 1024 },
    12: { env: { ORKA_JOB: "a", ORKA_WORKER: "orchestrator" }, pss: 300 * 1024 },
    13: { env: { ORCA_JOB: "b" }, rss: 100 * 1024 },
    14: { env: { HOME: "/x" }, pss: 9 * 1024 * 1024 },
  });
  const usage = jobMemory(root);
  assert.deepEqual(usage, [
    { job: "a", kb: 1100 * 1024, procs: 3, workers: [{ name: "w1", kb: 800 * 1024 }, { name: "orchestrator", kb: 300 * 1024 }] },
    { job: "b", kb: 100 * 1024, procs: 1, workers: [{ name: "other", kb: 100 * 1024 }] },
  ]);
  const statusOf = (id) => ({ a: "done" })[id] || "";
  assert.equal(jobMemoryText(usage, { statusOf }), "a [done] 1.1G (w1 800M, orchestrator 300M), b 100M (other 100M)");
  assert.equal(jobMemoryText(usage, { limit: 1 }), "a 1.1G (w1 800M, orchestrator 300M)");
  assert.match(finishedHint(usage, statusOf), /^finished jobs still hold 1\.1G \(a \[done\] 1\.1G\); timeout 120 orka cleanup --dry-run --older-than 0s/);
  assert.equal(finishedHint(usage, (id) => (id === "a" ? "running" : "")), "", "running jobs and other repos' jobs are not finished");
  assert.deepEqual(jobMemory(join(root, "nope")), []);
  rmSync(root, { recursive: true, force: true });
});

test("doctor memoryCheck puts the finished-jobs hint in the fix", () => {
  assert.equal(memoryCheck(500, 1024, "finished jobs still hold 1G").fix, "finished jobs still hold 1G");
  assert.match(memoryCheck(500, 1024).fix, /close idle panes of finished jobs/);
  assert.equal(memoryCheck(2000, 1024, "x").status, "ok");
});

test("status shows job memory and doctor names the finished job that holds it", () => {
  const base = mkdtempSync(join(tmpdir(), "orka-jobmem-cli-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const proc = join(base, "proc");
  for (const d of [repo, bin, proc, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  for (const n of ["herdr", "agent-browser"]) {
    writeFileSync(join(bin, n), "#!/bin/sh\necho '{}'\n");
    chmodSync(join(bin, n), 0o755);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), ORKA_NO_WATCH: "1", ORKA_PROC_ROOT: proc };
  const orka = (args) => spawnSync("timeout", ["60", process.execPath, ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "m", "--goal", "g"]).stdout.trim();
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), status: "done" }));
  fakeProc(proc, {
    20: { env: { ORKA_JOB: id, ORKA_WORKER: "w1" }, pss: 700 * 1024 },
    21: { env: { ORKA_JOB: id, ORKA_WORKER: "verifier" }, pss: 500 * 1024 },
    22: { env: { ORKA_JOB: "other-repo-job" }, pss: 50 * 1024 },
  }, 300);
  const all = orka(["status"]).stdout;
  assert.match(all, new RegExp(`job memory: ${id} \\[done\\] 1\\.2G \\(w1 700M, verifier 500M\\), other-repo-job 50M \\(other 50M\\)`));
  const one = orka(["status", id]).stdout;
  assert.match(one, new RegExp(`  job memory: ${id} \\[done\\] 1\\.2G`));
  assert.doesNotMatch(one, /other-repo-job/);
  const doc = orka(["doctor"]).stdout;
  assert.match(doc, /warn  memory: 300 MB available, under 1024 MB\n {10}fix: finished jobs still hold 1\.2G \(\S+ \[done\] 1\.2G\)/);
});
