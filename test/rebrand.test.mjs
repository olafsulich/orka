// orca -> orka rebrand: the orca alias and everything an older orca wrote keep working.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as brand from "../lib/brand.mjs";
import { scanBrowsers } from "../lib/browsers.mjs";
import { expandPortVars } from "../lib/ports.mjs";
import { listWatchers } from "../lib/watch.mjs";

const root = join(import.meta.dirname, "..");
const ORKA = join(root, "bin", "orka.mjs");
const ORCA = join(root, "bin", "orca.mjs");
const sha8 = (id) => createHash("sha1").update(id).digest("hex").slice(0, 8);

function scratch(prefix = "orka-rebrand-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // herdr and agent-browser are stubs: no real panes or browsers.
  for (const name of ["herdr", "agent-browser"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\necho '{}'\n");
    chmodSync(join(bin, name), 0o755);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off" };
  const run = (script, args, extra = {}) => spawnSync(process.execPath, [script, ...args, "--cwd", repo], { encoding: "utf8", env: { ...env, ...extra } });
  return { base, repo, orka: (args, extra) => run(ORKA, args, extra), orca: (args, extra) => run(ORCA, args, extra) };
}

// A repo as orca left it: .orca/config.json and a job record on branch orca/<id> with its worktree.
function legacyRepo(t, { id = "20261001000000000-old-job", status = "done", branch = true } = {}) {
  const dir = join(t.repo, ".orca");
  for (const d of ["jobs", "worktrees", "secrets"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, repo: t.repo, jobs: ".orca/jobs", worktrees: ".orca/worktrees", secrets: ".orca/secrets" }));
  const worktree = join(dir, "worktrees", id);
  execFileSync("git", ["worktree", "add", "-q", "-b", `orca/${id}`, worktree, "HEAD"], { cwd: t.repo });
  const job = { v: 1, id, title: "old", goal: "g", kind: "pi", status, repo: t.repo, worktree, workers: [], browserSessions: [`orca-${sha8(id)}-w1`], keep: false, steers: [], created: "2026-10-01T00:00:00.000Z", finished: "2026-10-01T01:00:00.000Z" };
  if (branch) job.branch = `orca/${id}`;
  writeFileSync(join(dir, "jobs", `${id}.json`), JSON.stringify(job, null, 2));
  return { id, path: join(dir, "jobs", `${id}.json`), worktree };
}

test("package.json: orka is the bin, orca stays as an alias", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "orka");
  assert.deepEqual(pkg.bin, { orka: "./bin/orka.mjs", orca: "./bin/orca.mjs" });
});

test("the orca alias behaves like orka: same stdout and exit code, one deprecation line on stderr only", () => {
  const t = scratch();
  assert.equal(t.orka(["init"]).status, 0);
  const id = t.orka(["new", "--kind", "pi", "--title", "a", "--goal", "g"]).stdout.trim();
  for (const args of [["help"], ["status"], ["status", id], ["digest", id]]) {
    const a = t.orka(args);
    const b = t.orca(args);
    assert.equal(b.status, a.status, args.join(" "));
    // The host lines read live MemAvailable and the memory of other jobs on the host, which move between the two runs.
    const host = (out) => out.replace(/memory [0-9]+MB available/, "memory NMB available").replace(/^job memory: .*$/m, "job memory: N");
    assert.equal(host(b.stdout), host(a.stdout), args.join(" "));
    assert.equal(b.stderr, `orca is deprecated; use orka (same commands)\n${a.stderr}`, args.join(" "));
    assert.doesNotMatch(b.stdout, /orca is deprecated; use orka/);
  }
  const bad = t.orca(["nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command nope/);
});

test("a fresh repo gets .orka/, orka/<id> branches and orka- names", () => {
  const t = scratch();
  assert.match(t.orka(["init"]).stdout, /gitignored \.orka\//);
  assert.ok(existsSync(join(t.repo, ".orka", "config.json")));
  assert.equal(existsSync(join(t.repo, ".orca")), false);
  assert.match(readFileSync(join(t.repo, ".gitignore"), "utf8"), /^\.orka\/$/m);
  const id = t.orka(["new", "--kind", "pi", "--title", "fresh", "--goal", "g"]).stdout.trim();
  const job = JSON.parse(readFileSync(join(t.repo, ".orka", "jobs", `${id}.json`), "utf8"));
  assert.equal(job.branch, `orka/${id}`);
  const dry = t.orka(["run", id, "--dry-run"]).stdout;
  assert.match(dry, new RegExp(`--label orka-${id.slice(0, 35)}`));
  assert.match(dry, new RegExp(`worktree: ${join(t.repo, ".orka", "worktrees", id).replace(/[.]/g, "\\.")}`));
  assert.equal(brand.sessionPrefix(job), `orka-${sha8(id)}`);
});

test(".orca/ is used when .orka/ is absent: old jobs read, new jobs land there, nothing moved", () => {
  const t = scratch();
  const old = legacyRepo(t);
  const status = t.orka(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(old.id));
  assert.match(t.orka(["status", old.id]).stdout, new RegExp(`branch: orca/${old.id}`));
  assert.match(t.orka(["init"]).stdout, new RegExp(`^already initialized ${t.repo}\n(gitignored \\.orca/)?`));
  const id = t.orka(["new", "--kind", "pi", "--title", "next", "--goal", "g"]).stdout.trim();
  assert.ok(existsSync(join(t.repo, ".orca", "jobs", `${id}.json`)));
  assert.equal(existsSync(join(t.repo, ".orka")), false, ".orka/ must not appear next to a live .orca/");
  assert.equal(JSON.parse(readFileSync(join(t.repo, ".orca", "jobs", `${id}.json`), "utf8")).branch, `orka/${id}`);
});

test(".orka/ wins when both exist", () => {
  const t = scratch();
  legacyRepo(t);
  assert.equal(t.orka(["init"]).status, 0);
  mkdirSync(join(t.repo, ".orka"));
  assert.equal(t.orka(["init"]).status, 0);
  const id = t.orka(["new", "--kind", "pi", "--title", "both", "--goal", "g"]).stdout.trim();
  assert.ok(existsSync(join(t.repo, ".orka", "jobs", `${id}.json`)));
  assert.equal(existsSync(join(t.repo, ".orca", "jobs", `${id}.json`)), false);
  assert.equal(brand.stateDirName(t.repo), ".orka");
});

test("orca/<id> branches, worktrees and orca- sessions of old jobs are still found", () => {
  const t = scratch();
  const old = legacyRepo(t, { status: "running", branch: false });
  const job = JSON.parse(readFileSync(old.path, "utf8"));
  assert.equal(brand.jobBranch(job), `orca/${old.id}`);
  assert.equal(brand.sessionPrefix(job), `orca-${sha8(old.id)}`);
  // No baseCommit on the record: verify --base finds it through the orca/<id> branch.
  writeFileSync(join(old.worktree, "orca.verify.json"), JSON.stringify({ steps: [["open", "http://127.0.0.1:1/"]] }));
  const base = t.orka(["verify", old.id, "--base", "--dry-run"]);
  assert.equal(base.status, 0, base.stderr);
  assert.match(base.stdout, new RegExp(`checks: ${old.worktree}/orca\\.verify\\.json`));
  const stop = t.orka(["stop", old.id, "--dry-run"]);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, new RegExp(`would close browser orca-${sha8(old.id)}-w1`));
});

test("orka.verify.json / orka.features.md win over the orca names, which are still read", () => {
  const dir = mkdtempSync(join(tmpdir(), "orka-files-"));
  try {
    assert.equal(brand.fileName(dir, "verify.json"), "orka.verify.json");
    writeFileSync(join(dir, "orca.verify.json"), "{}");
    writeFileSync(join(dir, "orca.features.md"), "");
    assert.equal(brand.fileName(dir, "verify.json"), "orca.verify.json");
    assert.equal(brand.fileName(dir, "features.md"), "orca.features.md");
    writeFileSync(join(dir, "orka.verify.json"), "{}");
    assert.equal(brand.fileName(dir, "verify.json"), "orka.verify.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env vars: both names are exported, either is read, ORKA_ wins", () => {
  assert.deepEqual(brand.envPair("JOB", "j1"), { ORKA_JOB: "j1", ORCA_JOB: "j1" });
  assert.equal(brand.env("JOB", { ORCA_JOB: "old" }), "old");
  assert.equal(brand.env("JOB", { ORKA_JOB: "new", ORCA_JOB: "old" }), "new");
  const job = { port: 20000, ports: [20000, 20001] };
  assert.equal(expandPortVars("${ORCA_PORT} ${ORKA_PORT} ${ORCA_PORT_2} ${ORKA_PORT_2}", job), "20000 20000 20001 20001");
  const src = readFileSync(ORKA, "utf8");
  assert.match(src, /function jobEnvArgs[\s\S]*?brand\.envPair\("JOB", job\.id\)[\s\S]*?brand\.envPair\("WORKER", worker\)/);
});

test("browser tags: a Chrome tagged only ORCA_JOB or only ORKA_JOB is attributed to its job", () => {
  const proc = mkdtempSync(join(tmpdir(), "orka-proc-"));
  try {
    const mk = (pid, env) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "cmdline"), ["/opt/chrome/chrome", "--headless"].join("\0"));
      writeFileSync(join(proc, String(pid), "environ"), env.join("\0"));
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (chrome) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100`);
    };
    mk(101, ["ORCA_JOB=old-job", "ORCA_WORKER=w1"]);
    mk(102, ["ORKA_JOB=new-job", "ORKA_WORKER=w2", "ORCA_JOB=new-job", "ORCA_WORKER=w2"]);
    const byPid = Object.fromEntries(scanBrowsers({ procRoot: proc, selfPid: 0 }).map((p) => [p.pid, p]));
    assert.equal(byPid[101].job, "old-job");
    assert.equal(byPid[101].worker, "w1");
    assert.equal(byPid[102].job, "new-job");
    assert.equal(byPid[102].worker, "w2");
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});

test("watchers of both script names are recognised; ORCA_FAKE_WATCHERS is still read", () => {
  assert.ok(brand.isCliScript("/x/bin/orka.mjs"));
  assert.ok(brand.isCliScript("/x/bin/orca.mjs"));
  assert.ok(!brand.isCliScript("/x/bin/other.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "orka-watchers-"));
  const file = join(dir, "w.json");
  writeFileSync(file, JSON.stringify([{ pid: 9, jobId: "j", cwd: "/r" }]));
  const before = { ORKA: process.env.ORKA_FAKE_WATCHERS, ORCA: process.env.ORCA_FAKE_WATCHERS };
  try {
    delete process.env.ORKA_FAKE_WATCHERS;
    process.env.ORCA_FAKE_WATCHERS = file;
    assert.deepEqual(listWatchers(), [{ pid: 9, jobId: "j", cwd: "/r" }]);
  } finally {
    if (before.ORCA === undefined) delete process.env.ORCA_FAKE_WATCHERS;
    else process.env.ORCA_FAKE_WATCHERS = before.ORCA;
    if (before.ORKA !== undefined) process.env.ORKA_FAKE_WATCHERS = before.ORKA;
    rmSync(dir, { recursive: true, force: true });
  }
});

function listen(hits) {
  const dir = mkdtempSync(join(tmpdir(), "orka-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  // The server needs only the bytes: the folder goes now, so a run killed mid-test leaves nothing in tmp.
  const tls = { cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) };
  rmSync(dir, { recursive: true, force: true });
  const server = createServer(tls, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() })));
}

function orkaAsync(t, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ORKA, ...args, "--cwd", t.repo], { env: { ...process.env, ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("finish webhook is byte-for-byte the orca payload: same fields, order, headers; .orca/secrets still read", async () => {
  const hits = [];
  const receiver = await listen(hits);
  try {
    const t = scratch();
    const old = legacyRepo(t, { status: "running" });
    const env = join(t.repo, ".orca", "secrets", "finish-webhook.env");
    writeFileSync(env, `WEBHOOK_URL=https://127.0.0.1:${receiver.port}/hook\nWEBHOOK_KEY=k-123\n`, { mode: 0o600 });
    chmodSync(env, 0o600);
    const r = await orkaAsync(t, ["stop", old.id, "enough"], { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hits.length, 1);
    const [hit] = hits;
    assert.equal(hit.method, "POST");
    assert.equal(hit.url, "/hook");
    // Snapshot: the same bytes orca sent. branch keeps the job's own value (orca/<id> here).
    assert.equal(hit.body, `{"job":"${old.id}","status":"stopped","branch":"orca/${old.id}"}`);
    assert.equal(hit.headers["content-type"], "application/json");
    assert.equal(hit.headers.authorization, "Bearer k-123");
    assert.equal(hit.headers["x-automation-key"], "k-123");
    assert.ok(existsSync(join(t.repo, ".orca", "jobs", `${old.id}.finish.json`)));
    // A new job differs only in the branch value it was created with.
    const id = t.orka(["new", "--kind", "pi", "--title", "n", "--goal", "g"]).stdout.trim();
    const dry = t.orka(["webhook", id, "--dry-run"]);
    assert.match(dry.stdout, new RegExp(`payload: \\{"job":"${id}","status":"queued","branch":"orka/${id}","playbook":"feature"\\}`));
  } finally {
    receiver.close();
  }
});
