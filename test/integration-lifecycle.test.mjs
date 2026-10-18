import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:https";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");
const TLS = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };

function orca(box, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ORCA, ...args, "--cwd", box.repo], { env: { ...process.env, ...box.env, ...TLS } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

// herdr is a PATH stub: logs every call, answers agent get / pane read from files in the box.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-int-"));
  process.on("exit", () => rmScratch(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "herdr",
    `case "$1 $2" in
  "agent start") touch "${base}/started-$3";;
  "agent get") case "$3" in w*) [ -e "${base}/started-$3" ] || { echo '{"error":{"message":"not found"}}'; exit 1; };; esac; if [ -e "${base}/prompted-$3" ] || [ -e "${base}/agent-status" ]; then echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$(cat "${base}/agent-status" 2>/dev/null || echo working)\\",\\"interactive_ready\\":true}}}"; else echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true}}}'; fi;;
  "agent wait") sleep 1;;
  "pane read") cat "${base}/pane-text" 2>/dev/null;;
  "agent prompt") printf '%s' "$4" > "${base}/last-prompt"; touch "${base}/prompted-$3";;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-new"}}}';;
  *) echo '{}';;
esac`,
  );
  stub("agent-browser", `case "$*" in *"session list"*) echo '{"success":true,"data":{"sessions":[]}}';; esac`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORCA_NO_WATCH: "1" };
  execFileSync(process.execPath, [ORCA, "init", "--cwd", repo], { env: { ...process.env, ...env } });
  return { base, repo, env, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean), set: (f, v) => writeFileSync(join(base, f), v) };
}

async function newJob(box, title = "int") {
  const created = await orca(box, ["new", "--kind", "pi", "--title", title, "--goal", "g"]);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.trim();
  return { id, path: join(box.repo, ".orca", "jobs", `${id}.json`), record: join(box.repo, ".orca", "jobs", `${id}.finish.json`) };
}

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const patch = (path, extra) => writeFileSync(path, JSON.stringify({ ...read(path), ...extra }, null, 2));

function listen(hits) {
  const dir = mkdtempSync(join(tmpdir(), "orca-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const server = createServer({ cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close() {
          server.close();
          rmSync(dir, { recursive: true, force: true });
        },
      }),
    ),
  );
}

function webhook(box, port) {
  const path = join(box.repo, ".orca", "secrets", "finish-webhook.env");
  writeFileSync(path, `WEBHOOK_URL=https://127.0.0.1:${port}/hook\nWEBHOOK_KEY=k\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("finish closes browsers and worker panes but not the workspace or orchestrator pane", async () => {
  const box = scratch();
  const job = await newJob(box);
  patch(job.path, { status: "running", workspace: "w-1", pane: "p-lead", agent: "lead", workers: [{ name: "w1", pane: "p-w1" }] });
  const done = await orca(box, ["done", job.id]);
  assert.equal(done.status, 0, done.stderr);
  const calls = box.calls();
  assert.ok(calls.includes("herdr pane close p-w1"));
  assert.ok(!calls.some((c) => c.startsWith("herdr workspace close")));
  assert.ok(!calls.includes("herdr pane close p-lead"));
  assert.equal(read(job.path).workspaceClosed, undefined);
});

test("done twice (follow-up round) sends the webhook twice, marked followUp on the second", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = scratch();
  try {
    webhook(box, receiver.port);
    const job = await newJob(box);
    patch(job.path, { status: "running", workspace: "w-1", pane: "p-lead", agent: "lead" });
    assert.equal((await orca(box, ["done", job.id])).status, 0);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], { job: job.id, status: "done", branch: `orca/${job.id}` });
    // done again without a steer is still a no-op
    assert.match((await orca(box, ["done", job.id])).stdout, /already done/);
    assert.equal(hits.length, 1);

    const steered = await orca(box, ["steer", job.id, "one more thing"]);
    assert.equal(steered.status, 0, steered.stderr);
    assert.match(steered.stdout, /follow-up round 2/);
    const mid = read(job.path);
    assert.equal(mid.status, "running");
    assert.equal(mid.round, 2);
    assert.ok(mid.steered);
    const lastPrompt = readFileSync(join(box.base, "last-prompt"), "utf8");
    assert.ok(lastPrompt.startsWith(`Orca digest for ${job.id}`), lastPrompt.slice(0, 120));
    assert.match(lastPrompt, /Owner steer:/);
    assert.ok(lastPrompt.endsWith("one more thing"), lastPrompt.slice(-80));
    assert.equal(mid.steers.at(-1).message, "one more thing");

    const again = await orca(box, ["done", job.id]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /finish webhook: accepted/);
    assert.equal(hits.length, 2);
    assert.deepEqual(hits[1], { job: job.id, status: "done", branch: `orca/${job.id}`, round: 2, followUp: true });
    const record = read(job.record);
    assert.deepEqual(record.rounds.map((r) => [r.round, r.followUp]), [[1, false], [2, true]]);
    assert.deepEqual(record.attempts.map((a) => a.round), [1, 2]);
    assert.equal(read(job.path).finishRounds.length, 2);
    assert.match((await orca(box, ["done", job.id])).stdout, /already done/);
    assert.equal(hits.length, 2);
  } finally {
    receiver.close();
  }
});

test("steer refuses a finished job whose orchestrator pane is gone", async () => {
  const box = scratch();
  const job = await newJob(box);
  patch(job.path, { status: "done", workspace: "w-1", pane: "p-lead", agent: "lead", workspaceClosed: new Date().toISOString() });
  const r = await orca(box, ["steer", job.id, "hi"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pane is gone/);
  assert.equal(read(job.path).status, "done");
});

test("needs-input payload is posted through orca's sender, and the watcher exits when the job is done", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = scratch();
  try {
    webhook(box, receiver.port);
    const job = await newJob(box, "ask");
    patch(job.path, { status: "running", pane: "p-lead", agent: "lead" });
    box.set("agent-status", "blocked");
    box.set("pane-text", "Some output\n\nStop the stale server on port 3000?\n❯ 1. Yes\n  2. No\n");
    const child = spawn(process.execPath, [ORCA, "watch", job.id, "--cwd", box.repo], { env: { ...process.env, ...box.env, ...TLS } });
    const exited = new Promise((resolve) => child.on("close", resolve));
    try {
      assert.ok(await until(() => hits.length > 0), "needs-input was not posted");
      assert.equal(hits[0].kind, "needs-input");
      assert.equal(hits[0].job, job.id);
      assert.equal(hits[0].title, "ask");
      assert.equal(hits[0].status, "blocked");
      assert.equal(hits[0].pane, "p-lead");
      assert.match(hits[0].question, /Stop the stale server on port 3000\?/);
      // deduped: the same episode is not posted again
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(hits.length, 1);
      patch(job.path, { status: "done" });
      await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("watcher did not exit")), 15000))]);
    } finally {
      child.kill("SIGKILL");
    }
    assert.equal(existsSync(job.record), false, "needs-input must not touch the finish record");
  } finally {
    receiver.close();
  }
});

test("watch with no webhook configured logs and skips", async () => {
  const box = scratch();
  const job = await newJob(box);
  patch(job.path, { status: "running", pane: "p-lead", agent: "lead" });
  const dry = await orca(box, ["watch", job.id, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /no webhook configured: log and skip/);
  box.set("agent-status", "blocked");
  box.set("pane-text", "Need a decision?\n");
  const child = spawn(process.execPath, [ORCA, "watch", job.id, "--cwd", box.repo], { env: { ...process.env, ...box.env } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  try {
    assert.ok(await until(() => /needs-input not sent/.test(out)), out);
  } finally {
    child.kill("SIGKILL");
  }
});

test("ports are stored on new, unique across jobs, shown in status and expanded in the checks file", async () => {
  const box = scratch();
  const a = await newJob(box, "a");
  const b = await newJob(box, "b");
  const ja = read(a.path);
  const jb = read(b.path);
  assert.ok(Number.isInteger(ja.port) && Number.isInteger(jb.port));
  assert.equal(ja.ports.length, 4);
  assert.equal(ja.ports[0], ja.port);
  assert.ok(!ja.ports.some((p) => jb.ports.includes(p)), "jobs share a port");
  const status = await orca(box, ["status", a.id]);
  assert.match(status.stdout, new RegExp(`port: ${ja.port}`));

  const wt = join(box.base, "wt");
  mkdirSync(wt);
  writeFileSync(join(wt, "orca.verify.json"), JSON.stringify({ steps: [["open", "http://127.0.0.1:${ORCA_PORT}/"], { visible: "h1" }] }));
  patch(a.path, { worktree: wt });
  const dry = await orca(box, ["verify", a.id, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`open http://127.0.0.1:${ja.port}/`));
});

test("an older job without a port still works", async () => {
  const box = scratch();
  const job = await newJob(box);
  const old = read(job.path);
  delete old.port;
  delete old.ports;
  writeFileSync(job.path, JSON.stringify(old));
  const status = await orca(box, ["status", job.id]);
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /port:/);
  const dry = await orca(box, ["run", job.id, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /port: [0-9]+/);
});

test("worker and orchestrator prompts state the job port and the decide-yourself rule", async () => {
  const box = scratch();
  const job = await newJob(box);
  patch(job.path, { status: "running", worktree: box.repo, pane: "p-lead", agent: "lead", workspace: "w-1" });
  const port = read(job.path).port;
  const w = await orca(box, ["worker", "--job", job.id, "--name", "w1", "--task", "do x"]);
  assert.equal(w.status, 0, w.stderr);
  const prompt = readFileSync(join(box.base, "last-prompt"), "utf8");
  assert.match(prompt, new RegExp(`Your job port: ${port}|Your job ports: ${port}`));
  assert.match(prompt, /\$ORCA_PORT/);
  assert.match(prompt, /safe recommended option/);
  assert.match(prompt, /genuine human decision or a secret/);
  assert.ok(box.calls().some((c) => c.startsWith("herdr pane split") && c.includes(`ORCA_PORT=${port}`)));
  const src = readFileSync(ORCA, "utf8");
  assert.equal((src.match(/\.\.\.portPromptLines\(job\)/g) || []).length, 3);
});
