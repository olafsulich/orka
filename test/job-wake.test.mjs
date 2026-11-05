import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");
const KEY = "wake-test-key";

// One HTTPS receiver: the URL path says which bot's file a POST came from.
function listen() {
  const dir = mkdtempSync(join(tmpdir(), "orka-wake-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const tls = { cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) };
  rmSync(dir, { recursive: true, force: true });
  const hits = [];
  const server = createServer(tls, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hits.push({ url: req.url, key: req.headers["x-automation-key"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(req.url.endsWith("/fail") ? 500 : 204);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ hits, url: `https://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function box() {
  const base = mkdtempSync(join(tmpdir(), "orka-wake-"));
  const repo = join(base, "repo");
  const home = join(base, "home");
  const bin = join(base, "bin");
  for (const dir of [repo, join(home, ".config"), bin]) mkdirSync(dir, { recursive: true });
  // Answers every herdr verb; the orchestrator is always blocked on a question.
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
case "$1 $2" in
  "agent get") echo '{"result":{"agent":{"agent_status":"blocked"}}}' ;;
  "pane read") echo '{"result":{"read":{"text":"Ship it?"}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`);
  chmodSync(join(bin, "herdr"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_RUNTIME_DIR: join(base, "run"),
    XDG_CONFIG_HOME: join(base, "config"),
    ORKA_BACKEND: "herdr",
    ORKA_NO_WATCH: "1",
    ORKA_MEMORY_GUARD: "off",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_NO_WARNINGS: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const orka = (args, extra = {}) => spawnAsync([ORKA, ...args, "--cwd", repo], { ...env, ...extra }, repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, env });
  const t = {
    base, repo, home, bin, env, orka,
    jobPath: (id) => join(repo, ".orka", "jobs", `${id}.json`),
    recordPath: (id) => join(repo, ".orka", "jobs", `${id}.finish.json`),
    job: (id) => JSON.parse(readFileSync(t.jobPath(id), "utf8")),
    record: (id) => JSON.parse(readFileSync(t.recordPath(id), "utf8")),
    botFile: (name) => join(home, ".config", `${name}-finish-wake.env`),
    writeEnv: (path, url, mode = 0o600) => {
      writeFileSync(path, `WEBHOOK_URL=${url}\nWEBHOOK_KEY=${KEY}\n`, { mode });
      chmodSync(path, mode);
      return path;
    },
    repoFile: (url) => t.writeEnv(join(repo, ".orka", "secrets", "finish-webhook.env"), url),
    create: async (args = [], extra = {}) => {
      const made = await orka(["new", "--kind", "pi", "--title", "wake", "--goal", "test the wake", ...args], extra);
      assert.equal(made.status, 0, made.stderr);
      return made.stdout.trim();
    },
    jobCount: () => spawnSync("sh", ["-c", `ls ${join(repo, ".orka", "jobs")}/*.json 2>/dev/null | wc -l`], { encoding: "utf8" }).stdout.trim(),
    done: () => rmSync(base, { recursive: true, force: true }),
  };
  return t;
}

function spawnAsync(argv, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

async function setup() {
  const receiver = await listen();
  const t = box();
  const init = await t.orka(["init"]);
  assert.equal(init.status, 0, init.stderr);
  // The shared repo file, as in the bug: it belongs to another bot.
  t.repoFile(`${receiver.url}/engineer`);
  t.writeEnv(t.botFile("orka"), `${receiver.url}/orka`);
  return { t, receiver, close: () => { receiver.close(); t.done(); } };
}

function assertNoSecrets(text) {
  assert.doesNotMatch(text, new RegExp(KEY));
  assert.doesNotMatch(text, /https:\/\/127\.0\.0\.1:\d+\/(orka|engineer|file)/);
}

test("--wake sends the finish POST to that bot, records it, and shows it in status and digest", async () => {
  const { t, receiver, close } = await setup();
  try {
    const id = await t.create(["--wake", "orka"]);
    assert.equal(t.job(id).wake, "orka");
    const stopped = await t.orka(["stop", id, "enough"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /finish webhook: accepted \(HTTP 204\)/);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/orka"]);
    assert.equal(receiver.hits[0].key, KEY);
    const last = t.record(id).attempts.at(-1);
    assert.equal(last.wake, "orka");
    assert.equal(last.wakeFile, t.botFile("orka"));
    assert.equal(last.http, 204);
    assertNoSecrets(readFileSync(t.recordPath(id), "utf8"));
    assertNoSecrets(readFileSync(t.jobPath(id), "utf8"));
    const status = await t.orka(["status", id]);
    assert.match(status.stdout, /^ {2}wake: orka$/m);
    assertNoSecrets(status.stdout);
    const digest = await t.orka(["digest", id]);
    assert.match(digest.stdout, /^wake: orka$/m);
    assertNoSecrets(digest.stdout);
  } finally {
    close();
  }
});

test("ORKA_WAKE at new is stored; --wake beats it; at send time the env is not read", async () => {
  const { t, receiver, close } = await setup();
  try {
    t.writeEnv(t.botFile("other"), `${receiver.url}/other`);
    const fromEnv = await t.create(["--title", "from env"], { ORKA_WAKE: "orka" });
    assert.equal(t.job(fromEnv).wake, "orka");
    // The env at stop time differs; the job keeps what it stored.
    assert.equal((await t.orka(["stop", fromEnv, "x"], { ORKA_WAKE: "other" })).status, 0);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/orka"]);

    const flagWins = await t.create(["--title", "flag wins", "--wake", "other"], { ORKA_WAKE: "orka" });
    assert.equal(t.job(flagWins).wake, "other");

    const fileWins = await t.create(["--title", "file wins", "--wake-file", t.botFile("other")], { ORKA_WAKE: "orka" });
    assert.equal(t.job(fileWins).wake, undefined);
    assert.equal(t.job(fileWins).wakeFile, t.botFile("other"));

    // A job with no wake stays on the repo file whatever the env says at send time.
    receiver.hits.length = 0;
    const plain = await t.create(["--title", "plain"]);
    assert.equal((await t.orka(["stop", plain, "x"], { ORKA_WAKE: "orka" })).status, 0);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/engineer"]);
    const last = t.record(plain).attempts.at(-1);
    assert.equal(last.wake, undefined);
    assert.equal(last.wakeFile, join(t.repo, ".orka", "secrets", "finish-webhook.env"));
    assert.match((await t.orka(["status", plain])).stdout, /^ {2}wake: repo default$/m);
    assert.doesNotMatch((await t.orka(["digest", plain])).stdout, /^wake/m);

    // An empty ORKA_WAKE means unset.
    const blank = await t.create(["--title", "blank"], { ORKA_WAKE: " " });
    assert.equal(t.job(blank).wake, undefined);
  } finally {
    close();
  }
});

test("--wake-file stores an absolute path, sends there, and status and digest show it", async () => {
  const { t, receiver, close } = await setup();
  try {
    t.writeEnv(join(t.base, "own.env"), `${receiver.url}/file`);
    const made = await spawnAsync([ORKA, "new", "--kind", "pi", "--title", "by file", "--goal", "g", "--wake-file", "../own.env", "--cwd", t.repo], t.env, t.repo);
    assert.equal(made.status, 0, made.stderr);
    const id = made.stdout.trim();
    const file = join(t.base, "own.env");
    assert.equal(t.job(id).wakeFile, file);
    assert.match((await t.orka(["status", id])).stdout, new RegExp(`^ {2}wake-file: ${file}$`, "m"));
    assert.ok((await t.orka(["digest", id])).stdout.includes(`wake-file: ${file}`));
    assert.equal((await t.orka(["stop", id, "x"])).status, 0);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/file"]);
    const last = t.record(id).attempts.at(-1);
    assert.equal(last.wakeFile, file);
    assert.equal(last.http, 204);
    assert.equal(last.wake, undefined);
  } finally {
    close();
  }
});

test("orka new refuses a wake it could not use and creates no job", async () => {
  const { t, receiver, close } = await setup();
  try {
    const before = t.jobCount();
    const refused = async (args, env, pattern) => {
      const made = await t.orka(["new", "--kind", "pi", "--title", "refused", "--goal", "g", ...args], env);
      assert.notEqual(made.status, 0, `${args} ${JSON.stringify(env)} was accepted`);
      assert.match(made.stderr, pattern);
      assertNoSecrets(made.stderr);
      assert.equal(existsSync(t.jobPath("refused")), false);
      assert.equal(t.jobCount(), before);
    };
    await refused(["--wake", "nobody"], {}, /--wake: wake nobody: missing .*nobody-finish-wake\.env\nno job created/);
    await refused([], { ORKA_WAKE: "nobody" }, /ORKA_WAKE: wake nobody: missing/);
    await refused(["--wake-file", join(t.base, "nope.env")], {}, /--wake-file: wake-file .*nope\.env: missing/);
    await refused(["--wake", "../engineer"], {}, /must match/);
    await refused(["--wake", "Orka"], {}, /must match/);
    await refused([], { ORKA_WAKE: "a/b" }, /must match/);
    await refused(["--wake", "orka", "--wake-file", t.botFile("orka")], {}, /not both/);
    t.writeEnv(t.botFile("loose"), `${receiver.url}/loose`, 0o644);
    await refused(["--wake", "loose"], {}, /must be mode 600/);
    writeFileSync(t.botFile("empty"), "WEBHOOK_URL=\n", { mode: 0o600 });
    await refused(["--wake", "empty"], {}, /needs WEBHOOK_URL and WEBHOOK_KEY/);
    if (process.getuid() !== 0) {
      t.writeEnv(t.botFile("locked"), `${receiver.url}/locked`, 0o000);
      await refused(["--wake", "locked"], {}, /cannot read/);
    }
  } finally {
    close();
  }
});

test("a wake file gone at send time is recorded, sends nothing, and never falls back to the repo file", async () => {
  const { t, receiver, close } = await setup();
  try {
    const id = await t.create(["--wake", "orka"]);
    unlinkSync(t.botFile("orka"));
    const preview = await t.orka(["stop", id, "--dry-run"]);
    assert.match(preview.stdout, /config: invalid: wake orka: missing/);
    assert.match(preview.stdout, /send: no \(invalid config\)/);
    const stopped = await t.orka(["stop", id, "enough"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /finish webhook: failed: wake orka: missing/);
    assert.equal(t.job(id).status, "stopped");
    assert.equal(receiver.hits.length, 0);
    const last = t.record(id).attempts.at(-1);
    assert.equal(last.outcome, "failed");
    assert.equal(last.wake, "orka");
    assert.equal(last.wakeFile, t.botFile("orka"));
    assert.equal(last.http, null);
    assert.match(last.detail, /missing/);
    assert.match((await t.orka(["status", id])).stdout, /finish webhook: failed attempt 1 \(wake orka: missing/);
    // Put the file back: orka webhook retries to the same bot.
    t.writeEnv(t.botFile("orka"), `${receiver.url}/orka`);
    const retry = await t.orka(["webhook", id]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/orka"]);
    assert.equal(t.record(id).attempts.length, 2);
  } finally {
    close();
  }
});

test("a job edited to a bad wake name fails at send time and reads nothing outside ~/.config", async () => {
  const { t, receiver, close } = await setup();
  try {
    const id = await t.create();
    writeFileSync(t.jobPath(id), JSON.stringify({ ...t.job(id), wake: "../../secret" }));
    assert.equal((await t.orka(["stop", id, "x"])).status, 0);
    assert.equal(receiver.hits.length, 0);
    const last = t.record(id).attempts.at(-1);
    assert.match(last.detail, /must match/);
    assert.equal(last.wakeFile, undefined);
  } finally {
    close();
  }
});

test("the dry-run names the wake, not the URL path or the key", async () => {
  const { t, close } = await setup();
  try {
    const id = await t.create(["--wake", "orka"]);
    const preview = await t.orka(["webhook", id, "--dry-run"]);
    assert.match(preview.stdout, /config: https:\/\/127\.0\.0\.1:\d+ \(wake orka\)/);
    assertNoSecrets(preview.stdout);
  } finally {
    close();
  }
});

test("orka review notifies the job's wake, and reports a missing file instead of using the repo file", async () => {
  const { t, receiver, close } = await setup();
  try {
    const id = await t.create(["--wake", "orka"]);
    const running = (extra = {}) => writeFileSync(t.jobPath(id), JSON.stringify({ ...t.job(id), status: "running", ...extra }));
    running();
    mkdirSync(join(t.repo, ".orka", "jobs", id), { recursive: true });
    writeFileSync(join(t.repo, ".orka", "jobs", id, "summary.txt"), "shipped\n");
    const sent = await t.orka(["review", id]);
    assert.equal(sent.status, 0, sent.stderr);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/orka"]);
    assert.equal(receiver.hits[0].body.kind, "review");

    receiver.hits.length = 0;
    unlinkSync(t.botFile("orka"));
    running();
    const failed = await t.orka(["review", id]);
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(failed.stdout, /notification: invalid config: wake orka: missing/);
    assert.equal(receiver.hits.length, 0);
    assert.match(t.job(id).review.notified, /wake orka: missing/);
  } finally {
    close();
  }
});

test("orka propose notifies the job's wake", async () => {
  const { t, receiver, close } = await setup();
  try {
    const id = await t.create(["--wake", "orka"]);
    writeFileSync(t.jobPath(id), JSON.stringify({ ...t.job(id), status: "running", gate: { on: true, state: "planning" } }));
    mkdirSync(join(t.repo, ".orka", "jobs", id), { recursive: true });
    writeFileSync(join(t.repo, ".orka", "jobs", id, "approach.md"), "The plan.\n");
    const sent = await t.orka(["propose", id]);
    assert.equal(sent.status, 0, sent.stderr);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/orka"]);
    assert.equal(receiver.hits[0].body.kind, "awaiting-direction");
  } finally {
    close();
  }
});

// The real watcher against a herdr that always reports blocked.
async function watchUntil(t, id, done) {
  const child = spawn(process.execPath, [ORKA, "watch", id, "--cwd", t.repo], { env: t.env, cwd: t.repo, stdio: "ignore" });
  const closed = new Promise((resolve) => child.on("close", resolve));
  try {
    const deadline = Date.now() + 15000;
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(done(), "the watcher did not get there in 15s");
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}

test("needs-input goes to the job's wake, not the repo file", async () => {
  const { t, receiver, close } = await setup();
  try {
    const id = await t.create(["--wake", "orka"]);
    writeFileSync(t.jobPath(id), JSON.stringify({ ...t.job(id), status: "running", agent: "lead", pane: "p1" }));
    const dry = await t.orka(["watch", id, "--dry-run"]);
    assert.match(dry.stdout, /to https:\/\/127\.0\.0\.1:\d+$/m);
    await watchUntil(t, id, () => receiver.hits.length > 0);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/orka"]);
    assert.equal(receiver.hits[0].body.kind, "needs-input");
    assert.equal(receiver.hits[0].body.job, id);
    // The finish wake must still go out afterwards: needs-input leaves no claim on the finish record.
    assert.equal(existsSync(t.recordPath(id)), false);
  } finally {
    close();
  }
});

test("needs-input with its wake file gone records the failure, sends nothing, and leaves the finish POST free", async () => {
  const { t, receiver, close } = await setup();
  try {
    const id = await t.create(["--wake", "orka"]);
    writeFileSync(t.jobPath(id), JSON.stringify({ ...t.job(id), status: "running", agent: "lead", pane: "p1" }));
    unlinkSync(t.botFile("orka"));
    const decisions = join(t.repo, ".orka", "jobs", id, "decisions.tsv");
    const logged = () => existsSync(decisions) && readFileSync(decisions, "utf8").includes("needs-input");
    await watchUntil(t, id, logged);
    const row = readFileSync(decisions, "utf8");
    assert.match(row, /needs-input blocked not sent/);
    assert.match(row, /wake orka: missing/);
    assertNoSecrets(row);
    assert.equal(receiver.hits.length, 0);
    assert.match((await t.orka(["digest", id])).stdout, /needs-input blocked not sent/);
    t.writeEnv(t.botFile("orka"), `${receiver.url}/orka`);
    const stopped = await t.orka(["stop", id, "x"]);
    assert.match(stopped.stdout, /finish webhook: accepted/);
    assert.deepEqual(receiver.hits.map((h) => h.url), ["/orka"]);
  } finally {
    close();
  }
});

test("orka chain alerts follow ORKA_WAKE and never fall back to the repo file", async () => {
  const { t, receiver, close } = await setup();
  try {
    mkdirSync(join(t.repo, "tasks"));
    writeFileSync(join(t.repo, "tasks", "01-thing.md"), "# 01 thing\n");
    writeFileSync(join(t.repo, ".orka", "chain-queue"), "01\n");
    const chain = await t.orka(["chain", "--signoff", "each"], { ORKA_WAKE: "nobody", ORKA_CHAIN_POLL_MS: "50", ORKA_CHAIN_MIN_MEM_MB: "0", ORKA_CHAIN_MAX_LOAD: "100000" });
    assert.match(chain.stderr, /orka new failed/);
    assert.match(chain.stderr, /no webhook \(wake nobody: missing/);
    assert.equal(receiver.hits.length, 0);
  } finally {
    close();
  }
});
