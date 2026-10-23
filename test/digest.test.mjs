import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";
import {
  BLOCKING_MAX,
  CONTRACT,
  CONTRACT_MAX,
  DIGEST_MAX,
  EVIDENCE_MAX,
  FILE_READ_MAX,
  GOAL_MAX,
  NOTE_MAX,
  STEER_MAX,
  SUMMARY_MAX,
  VERIFIER_JSON_MAX,
  WORKER_MAX,
  WORKTREE_MAX,
  renderDigest,
  steerText,
} from "../lib/digest.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");
const ELLIPSIS = "\u2026";

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-digest-"));
  process.on("exit", () => rmScratch(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const run = join(base, "run");
  for (const d of [repo, bin, home, run]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  const prompt = join(base, "last-prompt");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
echo "$1 $2" >> "${log}"
if [ "$1 $2" = "agent prompt" ]; then
  printf '%s' "$4" > "${prompt}"; touch "${prompt}.working"
fi
# idle and ready, except working once right after a prompt
if [ -e "${prompt}.working" ] && [ "$1 $2" = "agent get" ]; then rm -f "${prompt}.working"; echo '{"result":{"agent":{"agent_status":"working","pane_id":"p-1"}}}'
else echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true,"pane_id":"p-1"}}}'; fi
`,
  );
  writeFileSync(
    join(bin, "agent-browser"),
    `#!/bin/sh
echo "agent-browser $*" >> "${log}"
echo '{}'
`,
  );
  chmodSync(join(bin, "herdr"), 0o755);
  chmodSync(join(bin, "agent-browser"), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_RUNTIME_DIR: run,
    AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off",
    ORKA_PROMPT_WAIT_MS: "1500",
    ORKA_PROMPT_POLL_MS: "100",
  };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orka(["init"]);
  return { base, repo, orka, log, prompt };
}

function makeJob(t, extra = {}) {
  const created = t.orka(["new", "--kind", "pi", "--title", "digest", "--goal", "g"]);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") }, extra);
  writeFileSync(path, JSON.stringify(job, null, 2) + "\n");
  const dir = join(t.repo, ".orka", "jobs", id);
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, "results"), { recursive: true });
  return { id, path, dir, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

function filesOf(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const st = statSync(path);
      const rel = path.slice(root.length);
      if (st.isDirectory()) {
        out.push(`${rel}/`);
        walk(path);
      } else out.push(`${rel} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

test("exported caps match the brief", () => {
  assert.equal(DIGEST_MAX, 2400);
  assert.equal(GOAL_MAX, 240);
  assert.equal(WORKTREE_MAX, 120);
  assert.equal(SUMMARY_MAX, 400);
  assert.equal(NOTE_MAX, 160);
  assert.equal(WORKER_MAX, 8);
  assert.equal(EVIDENCE_MAX, 200);
  assert.equal(BLOCKING_MAX, 3);
  assert.equal(STEER_MAX, 200);
  assert.equal(CONTRACT_MAX, 500);
  assert.equal(FILE_READ_MAX, 4096);
  assert.equal(VERIFIER_JSON_MAX, 64 * 1024);
  assert.ok(CONTRACT.length < 500, CONTRACT.length);
  assert.match(CONTRACT, /shared worktree/);
  assert.match(CONTRACT, /Do not implement/);
  assert.match(CONTRACT, /Do not push/);
  assert.match(CONTRACT, /Do not create a branch or worktree/);
  assert.match(CONTRACT, /Do not close panes/);
  assert.match(CONTRACT, /orka done sends the finish webhook/);
  assert.match(CONTRACT, /Do not run orka webhook or orka stop/);
  assert.match(CONTRACT, /follow-up round must call orka done again/);
  assert.match(CONTRACT, /verifier stays a fresh worker/);
  assert.match(CONTRACT, /Do not read the job JSON or verify\.log/);
});

test("steerText is digest, a blank line, Owner steer, message last", () => {
  const digest = "Orka digest for abc (capped snapshot, not the job file).";
  const message = "look here";
  const text = steerText(digest, message);
  assert.equal(text, `${digest}\n\nOwner steer:\n${message}`);
  assert.ok(text.endsWith(message));
  assert.equal(text.slice(text.lastIndexOf("Owner steer:\n")), `Owner steer:\n${message}`);
});

test("renderDigest clips fields and hard-caps the assembled text", () => {
  const id = "job-1";
  const header = `Orka digest for ${id} (capped snapshot, not the job file).`;
  assert.ok(header.length >= 20);
  const short = renderDigest({ id, status: "running", round: 1, keep: false, goal: "Ship it." }, {});
  assert.ok(short.startsWith(header.replace("job-1", id)));
  assert.match(short, /goal: Ship it\./);
  assert.doesNotMatch(short, /goal: Ship it\.\u2026/);
  assert.doesNotMatch(short, /^round:/m);
  assert.doesNotMatch(short, /keep:/);
  assert.match(short, /summary: none/);
  assert.match(short, /workers: none/);
  assert.match(short, /last steer: none/);
  assert.ok(short.includes(CONTRACT));
  assert.ok(short.length <= DIGEST_MAX);

  const multi = renderDigest({ id, status: "running", goal: "Ship it. Then do more." }, {});
  assert.match(multi, /goal: Ship it\.\u2026/);
  assert.doesNotMatch(multi, /Then do more/);

  const longGoal = renderDigest({ id, status: "running", goal: "A".repeat(5000) }, {});
  assert.match(longGoal, new RegExp(`goal: ${"A".repeat(240)}\u2026`));
  assert.doesNotMatch(longGoal, new RegExp(`A{241}`));

  const round = renderDigest({ id, status: "running", round: 2, keep: true, goal: "g", branch: "orka/job-1" }, {});
  assert.match(round, /round: 2/);
  assert.match(round, /keep: true/);
  assert.match(round, /branch: orka\/job-1/);

  const path = `/tmp/${"p".repeat(200)}`;
  const wt = renderDigest({ id, status: "running", worktree: path }, {}).split("\n").find((l) => l.startsWith("worktree: "));
  assert.ok(wt.slice("worktree: ".length).length <= 120);

  const summary = renderDigest({ id, status: "running", summary: "from job" }, { summary: "from file" });
  assert.match(summary, /summary: from file/);
  assert.doesNotMatch(summary, /from job/);

  const task = "TASK_ONLY_9f3a";
  const workers = Array.from({ length: 10 }, (_, i) => ({ name: `worker-${i + 1}`, task, role: i === 0 ? "verifier" : "builder" }));
  const many = renderDigest({ id, status: "running", workers }, { notes: { "worker-1": null }, ok: { "worker-2": true } });
  for (let i = 1; i <= 8; i++) assert.match(many, new RegExp(`worker-${i}(?!\\d)`));
  assert.doesNotMatch(many, /worker-9/);
  assert.doesNotMatch(many, /worker-10/);
  assert.match(many, /2 more workers in notes\//);
  assert.match(many, /role=verifier/);
  assert.match(many, /note missing/);
  assert.match(many, /worker-2 ok=true/);
  assert.doesNotMatch(many, /TASK_ONLY_9f3a/);

  const sentinel = "EVIDENCE_SENTINEL_9f3a";
  const evidence = "e".repeat(200) + sentinel;
  const verified = renderDigest(
    { id, status: "running", verifier: { verdict: "fail", rounds: 2, stall: { checks: ["lint", "types"] } } },
    {
      verifier: {
        verdict: "fail",
        failures: [
          { check: "lint", evidence },
          { check: "types", evidence: "short" },
          { check: "ui", evidence: "u".repeat(50) },
          { check: "extra", evidence: "should-not-show-fourth" },
        ],
        warnings: [{ check: "old", evidence: "warning body should not show" }],
      },
    },
  );
  assert.match(verified, /verdict=fail/);
  assert.match(verified, /rounds=2/);
  assert.match(verified, /stall=lint, types/);
  assert.match(verified, new RegExp(`lint: ${"e".repeat(200)}`));
  assert.doesNotMatch(verified, /EVIDENCE_SENTINEL_9f3a/);
  assert.doesNotMatch(verified, /should-not-show-fourth/);
  assert.doesNotMatch(verified, /warning body should not show/);
  assert.match(verified, /warnings: 1/);

  const skipped = renderDigest(
    { id, status: "running", verifier: { verdict: "fail", rounds: 1 } },
    { verifierSkipped: 70000, verifier: { failures: [{ check: "x", evidence: "SECRET_EVIDENCE" }] } },
  );
  assert.match(skipped, /results\/verifier\.json is 70000 bytes; not inlined/);
  assert.doesNotMatch(skipped, /SECRET_EVIDENCE/);

  const steers = renderDigest(
    { id, status: "running", steers: [{ message: "one" }, { message: "two" }, { message: `${"S".repeat(250)}TAIL` }] },
    {},
  );
  assert.match(steers, new RegExp(`last steer: ${"S".repeat(200)}`));
  assert.doesNotMatch(steers, /TAIL/);
  assert.match(steers, /2 earlier/);

  const capped = renderDigest(
    { id, status: "running", goal: "g", verifier: { verdict: "fail", rounds: 4, stall: { checks: ["Q".repeat(8000)] } } },
    {},
  );
  const suffix = `${ELLIPSIS} capped; full records stay in .orka/jobs/${id}/`;
  assert.equal(capped.length, 2400);
  assert.ok(capped.endsWith(suffix));
  assert.ok(capped.startsWith(`Orka digest for ${id} (capped snapshot, not the job file).`));
  assert.ok(!capped.includes("Q".repeat(3000)));
});

test("orka digest stays within 2400 and drops log and evidence sentinels", () => {
  const t = scratch();
  const verdict = "needs-fix";
  const task = "TASK_PLANTED_ONLY_ON_JOB_9f3a";
  const j = makeJob(t, {
    goal: `${"G".repeat(8 * 1024)}GOAL_TAIL_SENTINEL_9f3a`,
    verifier: { rounds: 2, verdict, history: [] },
    workers: [{ name: "w1", pane: "p-w1", role: "builder", task }],
  });
  writeFileSync(join(j.dir, "summary.txt"), `SUM_HEAD_9f3a ${"s".repeat(5000)}SUM_TAIL_SENTINEL_9f3a`);
  writeFileSync(join(j.dir, "notes", "w1.txt"), `NOTE_HEAD_9f3a ${"n".repeat(20 * 1024)}NOTE_TAIL_SENTINEL_9f3a`);
  const log = Buffer.alloc(100 * 1024, "v");
  log.write("VERIFYLOG_SENTINEL_9f3a", 0, "utf8");
  writeFileSync(join(j.dir, "verify.log"), log);
  writeFileSync(
    join(j.dir, "results", "verifier.json"),
    JSON.stringify({
      verdict,
      failures: [{ check: "ship-check", evidence: `${"e".repeat(200)}EVIDENCE_SENTINEL_9f3a` }],
      warnings: [{ check: "old", evidence: "do not print this warning body" }],
    }),
  );
  const r = t.orka(["digest", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length <= 2400, String(r.stdout.length));
  assert.match(r.stdout, new RegExp(`Orka digest for ${j.id}`));
  assert.match(r.stdout, new RegExp(verdict));
  assert.match(r.stdout, /ship-check/);
  assert.match(r.stdout, /SUM_HEAD_9f3a/);
  assert.match(r.stdout, /NOTE_HEAD_9f3a/);
  for (const sentinel of [
    "GOAL_TAIL_SENTINEL_9f3a",
    "SUM_TAIL_SENTINEL_9f3a",
    "NOTE_TAIL_SENTINEL_9f3a",
    "VERIFYLOG_SENTINEL_9f3a",
    "EVIDENCE_SENTINEL_9f3a",
    "do not print this warning body",
    task,
  ]) {
    assert.equal(r.stdout.includes(sentinel), false, sentinel);
  }
});

test("verifier.json over 64KB is not inlined and does not throw", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 1, verdict: "fail", history: [] } });
  const bytes = 70 * 1024;
  const sentinel = "HUGE_VERIFIER_SENTINEL_9f3a";
  writeFileSync(join(j.dir, "results", "verifier.json"), sentinel + "x".repeat(bytes - sentinel.length));
  assert.ok(statSync(join(j.dir, "results", "verifier.json")).size > 64 * 1024);
  const r = t.orka(["digest", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`results/verifier.json is ${bytes} bytes; not inlined`));
  assert.doesNotMatch(r.stdout, /HUGE_VERIFIER_SENTINEL_9f3a/);
  assert.ok(r.stdout.length <= 2400);
});

test("more than 8 workers names eight and leaves the rest in notes/", () => {
  const t = scratch();
  const task = "TASK_PLANTED_ONLY_ON_JOB_9f3a";
  const workers = Array.from({ length: 10 }, (_, i) => ({
    name: `w${String(i + 1).padStart(2, "0")}`,
    pane: `p${i}`,
    role: i === 2 ? "verifier" : "builder",
    task,
  }));
  const j = makeJob(t, { workers });
  writeFileSync(join(j.dir, "results", "w01.json"), JSON.stringify({ ok: true, result: "fine" }));
  const r = t.orka(["digest", j.id]);
  assert.equal(r.status, 0, r.stderr);
  for (let i = 1; i <= 8; i++) assert.match(r.stdout, new RegExp(`w${String(i).padStart(2, "0")}`));
  assert.doesNotMatch(r.stdout, /w09/);
  assert.doesNotMatch(r.stdout, /w10/);
  assert.match(r.stdout, /2 more workers in notes\//);
  assert.match(r.stdout, /role=verifier/);
  assert.match(r.stdout, /w01 ok=true/);
  assert.match(r.stdout, /note missing/);
  assert.doesNotMatch(r.stdout, /TASK_PLANTED_ONLY_ON_JOB_9f3a/);
});

test("orka digest does not create or modify files, change status, or call herdr", () => {
  const t = scratch();
  const j = makeJob(t, { status: "running", workers: [{ name: "w1", pane: "p", task: "secret-task" }] });
  writeFileSync(join(j.dir, "notes", "w1.txt"), "noted");
  writeFileSync(join(j.dir, "verify.log"), "VERIFYLOG_SENTINEL_9f3a");
  const before = filesOf(t.repo);
  const jobBefore = readFileSync(j.path, "utf8");
  writeFileSync(t.log, "");
  const r = t.orka(["digest", j.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(t.log, "utf8"), "");
  assert.equal(readFileSync(j.path, "utf8"), jobBefore);
  assert.equal(j.read().status, "running");
  assert.equal(existsSync(join(t.base, "last-prompt")), false);
  assert.deepEqual(filesOf(t.repo), before);
  assert.doesNotMatch(r.stdout, /VERIFYLOG_SENTINEL_9f3a/);
  assert.doesNotMatch(r.stdout, /secret-task/);
});

test("steer stores only the human message and prompts digest plus Owner steer", () => {
  const t = scratch();
  const j = makeJob(t, { status: "running", agent: "orch" });
  const first = t.orka(["steer", j.id, "first human"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(j.read().steers.map((s) => s.message), ["first human"]);
  const second = t.orka(["steer", j.id, "second human"]);
  assert.equal(second.status, 0, second.stderr);
  const job = j.read();
  assert.deepEqual(job.steers.map((s) => s.message), ["first human", "second human"]);
  assert.equal(job.digest, undefined);
  assert.doesNotMatch(readFileSync(j.path, "utf8"), /Orka digest|Owner steer:/);
  const prompted = readFileSync(t.prompt, "utf8");
  assert.ok(prompted.startsWith(`Orka digest for ${j.id}`));
  assert.match(prompted, /Owner steer:/);
  assert.match(prompted, /last steer: first human/);
  assert.ok(prompted.endsWith("second human"));
  assert.equal(prompted.slice(prompted.lastIndexOf("Owner steer:\n")), "Owner steer:\nsecond human");
});

test("orka digest on a missing id exits 1", () => {
  const t = scratch();
  const r = t.orka(["digest", "missing-id-xyz"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no job missing-id-xyz/);
});

test("orka help mentions digest", () => {
  const t = scratch();
  const r = t.orka(["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /orka digest <id> \[--cwd <repo>\]/);
  assert.match(r.stdout, /capped snapshot/);
  assert.match(r.stdout, /does not change the job/);
});

test("a capped digest printed by the CLI ends with the suffix inside 2400", () => {
  const t = scratch();
  const j = makeJob(t, { verifier: { rounds: 1, verdict: "fail", stall: { checks: ["Q".repeat(8000)] }, history: [] } });
  const r = t.orka(["digest", j.id]);
  assert.equal(r.status, 0, r.stderr);
  const suffix = `${ELLIPSIS} capped; full records stay in .orka/jobs/${j.id}/`;
  assert.equal(r.stdout.length, 2400);
  assert.ok(r.stdout.endsWith(suffix));
  assert.ok(r.stdout.startsWith(`Orka digest for ${j.id} (capped snapshot, not the job file).`));
});

test("digest shows verdict=pass|fail for the verifier, never 'ok not true'", () => {
  const id = "20260101000000000-v";
  const job = { id, status: "running", workers: [{ name: "verifier", role: "verifier" }] };
  const pass = renderDigest(job, { notes: {}, ok: {}, verifier: { verdict: "pass" } });
  assert.match(pass, /- verifier role=verifier verdict=pass /);
  assert.doesNotMatch(pass, /ok not true/);
  const fail = renderDigest(job, { notes: {}, ok: {}, verifier: { verdict: "fail", failures: [] } });
  assert.match(fail, /verifier role=verifier verdict=fail /);
  assert.doesNotMatch(fail, /ok not true/);
  assert.match(renderDigest(job, { notes: {}, ok: {} }), /verifier role=verifier verdict=none /);
});
