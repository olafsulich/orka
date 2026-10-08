import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:https";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const ORCA = join(root, "bin", "orca.mjs");

function orca(repo, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ORCA, ...args, "--cwd", repo], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

function git(repo, args) {
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

async function scratch() {
  const repo = mkdtempSync(join(tmpdir(), "orca-finish-"));
  git(repo, ["init", "-q"]);
  const init = await orca(repo, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  const created = await orca(repo, ["new", "--kind", "pi", "--title", "wake", "--goal", "test the wake"]);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.trim();
  return { repo, id, jobPath: join(repo, ".orca", "jobs", `${id}.json`), recordPath: join(repo, ".orca", "jobs", `${id}.finish.json`) };
}

function writeEnv(repo, url, key = "test-key", mode = 0o600) {
  const path = join(repo, ".orca", "secrets", "finish-webhook.env");
  writeFileSync(path, `WEBHOOK_URL=${url}\nWEBHOOK_KEY=${key}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

function job(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listen(hits) {
  const dir = mkdtempSync(join(tmpdir(), "orca-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", join(dir, "key.pem"),
    "-out", join(dir, "cert.pem"),
    "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
  ], { stdio: "ignore" });
  const server = createServer(
    { cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) },
    (req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        hits.push({ url: req.url, headers: req.headers, body });
        const status = req.url.endsWith("/fail") ? 500 : 204;
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end("SECRET-BODY");
      });
    },
  );
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      dir,
      close() {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    }));
  });
}

test("help and prompts no longer say the wake is unwired", async () => {
  const help = await orca(root, ["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /finish-webhook\.env/);
  assert.match(help.stdout, /does not run herdr-finish-watch/);
  assert.doesNotMatch(help.stdout, /not wired/);
  const src = readFileSync(ORCA, "utf8");
  assert.match(src, /Finish wake is automatic from the orca CLI/);
  assert.match(src, /markTerminal\(repo, job, "stopped"/);
  assert.match(src, /markTerminal\(repo, job, "failed"/);
  assert.doesNotMatch(src, /Do not POST a finish webhook/);
  assert.doesNotMatch(src, /herdr-finish-watch\.env/);
  const example = readFileSync(join(root, "examples", "finish-webhook.env"), "utf8");
  assert.match(example, /^WEBHOOK_URL=https:\/\/example\.invalid\//m);
  assert.match(example, /^WEBHOOK_KEY=REPLACE_ME$/m);
  assert.doesNotMatch(example, /api2\.cursor\.sh/);
});

test("missing file and process env do not send", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  try {
    const stopped = await orca(box.repo, ["stop", box.id, "enough"], {
      WEBHOOK_URL: `https://127.0.0.1:${receiver.port}/from-env`,
      WEBHOOK_KEY: "from-env",
    });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /finish webhook: off/);
    assert.equal(job(box.jobPath).status, "stopped");
    assert.equal(existsSync(box.recordPath), false);
    assert.equal(hits.length, 0);
    const manual = await orca(box.repo, ["webhook", box.id]);
    assert.notEqual(manual.status, 0);
    assert.match(manual.stderr, /missing/);
    assert.equal(hits.length, 0);
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("stop posts once and a failed send does not flip status", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  try {
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/secret-path`);
    const preview = await orca(box.repo, ["stop", box.id, "--dry-run"], tls);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /queued -> stopped/);
    assert.match(preview.stdout, /"status":"stopped"/);
    assert.match(preview.stdout, /send: would POST/);
    assert.doesNotMatch(preview.stdout, /secret-path|test-key/);
    assert.equal(job(box.jobPath).status, "queued");
    assert.equal(hits.length, 0);

    const stopped = await orca(box.repo, ["stop", box.id, "done watching"], tls);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /finish webhook: accepted \(HTTP 204\)/);
    assert.doesNotMatch(`${stopped.stdout}\n${stopped.stderr}`, /SECRET-BODY|test-key|secret-path/);
    assert.equal(job(box.jobPath).status, "stopped");
    assert.equal(job(box.jobPath).stopReason, "done watching");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].headers.authorization, "Bearer test-key");
    assert.equal(hits[0].headers["x-automation-key"], "test-key");
    assert.deepEqual(JSON.parse(hits[0].body), { job: box.id, status: "stopped", branch: `orca/${box.id}` });
    const record = JSON.parse(readFileSync(box.recordPath, "utf8"));
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0].outcome, "accepted");
    assert.equal(record.attempts[0].http, 204);
    assert.doesNotMatch(JSON.stringify(record), /test-key|secret-path/);

    const again = await orca(box.repo, ["stop", box.id], tls);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already stopped/);
    assert.equal(hits.length, 1);

    const status = await orca(box.repo, ["status", box.id], tls);
    assert.match(status.stdout, /finish webhook: accepted HTTP 204 attempt 1/);
    const dry = await orca(box.repo, ["webhook", box.id, "--dry-run"], tls);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /send: no \(last attempt accepted\)/);
    assert.doesNotMatch(dry.stdout, /secret-path|test-key/);
    assert.equal(hits.length, 1);

    const dup = await orca(box.repo, ["webhook", box.id], tls);
    assert.equal(dup.status, 0, dup.stderr);
    assert.match(dup.stdout, /last attempt is accepted/);
    assert.equal(hits.length, 1);

    const forced = await orca(box.repo, ["webhook", box.id, "--force"], tls);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /accepted \(HTTP 204\)/);
    assert.equal(hits.length, 2);
    assert.equal(JSON.parse(readFileSync(box.recordPath, "utf8")).attempts.length, 2);
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("bad config is recorded and does not send or flip status", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  const boxes = [await scratch(), await scratch(), await scratch()];
  try {
    writeEnv(boxes[0].repo, `http://127.0.0.1:${receiver.port}/plain`);
    const http = await orca(boxes[0].repo, ["stop", boxes[0].id], tls);
    assert.equal(http.status, 0, http.stderr);
    assert.equal(job(boxes[0].jobPath).status, "stopped");
    assert.match(http.stdout, /finish webhook: failed: WEBHOOK_URL must be https/);
    assert.equal(JSON.parse(readFileSync(boxes[0].recordPath, "utf8")).attempts[0].outcome, "failed");

    writeEnv(boxes[1].repo, `https://127.0.0.1:${receiver.port}/loose`, "test-key", 0o644);
    const loose = await orca(boxes[1].repo, ["stop", boxes[1].id], tls);
    assert.equal(loose.status, 0, loose.stderr);
    assert.equal(job(boxes[1].jobPath).status, "stopped");
    assert.match(loose.stdout, /mode 600/);
    assert.equal(hits.length, 0);

    const outside = join(tmpdir(), `orca-outside-${process.pid}.env`);
    writeFileSync(outside, `WEBHOOK_URL=https://127.0.0.1:${receiver.port}/escaped\nWEBHOOK_KEY=test-key\n`, { mode: 0o600 });
    chmodSync(outside, 0o600);
    symlinkSync(outside, join(boxes[2].repo, ".orca", "secrets", "finish-webhook.env"));
    const escaped = await orca(boxes[2].repo, ["stop", boxes[2].id], tls);
    assert.equal(escaped.status, 0, escaped.stderr);
    assert.equal(job(boxes[2].jobPath).status, "stopped");
    assert.match(escaped.stdout, /must stay inside \.orca/);
    assert.equal(hits.filter((hit) => hit.url === "/escaped").length, 0);
    assert.equal(hits.length, 0);
  } finally {
    receiver.close();
    for (const box of boxes) rmSync(box.repo, { recursive: true, force: true });
    rmSync(join(tmpdir(), `orca-outside-${process.pid}.env`), { force: true });
  }
});

test("webhook retries a rejected POST and records the attempt", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  try {
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/fail`);
    const stopped = await orca(box.repo, ["stop", box.id], tls);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(job(box.jobPath).status, "stopped");
    assert.match(stopped.stdout, /finish webhook: failed: HTTP 500/);
    assert.equal(hits.length, 1);

    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/ok`);
    const retried = await orca(box.repo, ["webhook", box.id], tls);
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /accepted \(HTTP 204\)/);
    assert.equal(job(box.jobPath).status, "stopped");
    const record = JSON.parse(readFileSync(box.recordPath, "utf8"));
    assert.deepEqual(record.attempts.map((item) => item.outcome), ["failed", "accepted"]);
    assert.equal(hits.length, 2);
    assert.equal(hits[1].url, "/ok");
    assert.deepEqual(JSON.parse(hits[1].body), { job: box.id, status: "stopped", branch: `orca/${box.id}` });
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("a job already marked done can POST that status", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  try {
    const current = job(box.jobPath);
    current.status = "done";
    writeFileSync(box.jobPath, JSON.stringify(current, null, 2) + "\n");
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/done`);
    const sent = await orca(box.repo, ["webhook", box.id], tls);
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(job(box.jobPath).status, "done");
    assert.deepEqual(JSON.parse(hits[0].body), { job: box.id, status: "done", branch: `orca/${box.id}` });
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("a run that never starts does not mark failed or post", async () => {
  const box = await scratch();
  try {
    writeEnv(box.repo, "https://example.invalid/should-not-send");
    const ran = await orca(box.repo, ["run", box.id]);
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /no commits/);
    assert.equal(job(box.jobPath).status, "queued");
    assert.equal(existsSync(box.recordPath), false);
    const dry = await orca(box.repo, ["run", box.id, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /finish webhook: posts \{job, status, branch\}/);
  } finally {
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("unknown acceptance is not retried unless forced", async () => {
  const box = await scratch();
  try {
    writeEnv(box.repo, "https://127.0.0.1:9/closed");
    const stopped = await orca(box.repo, ["stop", box.id]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(job(box.jobPath).status, "stopped");
    assert.match(stopped.stdout, /finish webhook: unknown: request failed; acceptance unknown/);
    const refused = await orca(box.repo, ["webhook", box.id]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /last attempt is unknown/);
    assert.equal(JSON.parse(readFileSync(box.recordPath, "utf8")).attempts.length, 1);
  } finally {
    rmSync(box.repo, { recursive: true, force: true });
  }
});

async function piJob(args = []) {
  const repo = mkdtempSync(join(tmpdir(), "orca-pi-"));
  git(repo, ["init", "-q"]);
  assert.equal((await orca(repo, ["init"])).status, 0);
  const created = await orca(repo, ["new", "--kind", "pi", "--title", "pi", "--goal", "do the thing", ...args]);
  assert.equal(created.status, 0, created.stderr);
  return { repo, id: created.stdout.trim() };
}

test("pi run dry-run starts an orchestrator that spawns pi workers", async () => {
  const { repo, id } = await piJob();
  const out = await orca(repo, ["run", id, "--dry-run"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /role: orchestrator \(pi\)/);
  assert.match(out.stdout, /worker: orca worker --job/);
  assert.doesNotMatch(out.stdout, /single worker|--model/);
});

test("pi worker dry-run opens a pi pane and refuses --model", async () => {
  const { repo, id } = await piJob();
  const ok = await orca(repo, ["worker", "--job", id, "--name", "w1", "--task", "x", "--dry-run"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /kind=pi/);
  assert.match(ok.stdout, /pane: pi$/m);
  assert.doesNotMatch(ok.stdout, /claude --model/);
  const bad = await orca(repo, ["worker", "--job", id, "--name", "w1", "--task", "x", "--model", "sonnet", "--dry-run"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /only for kind claude/);
});

test("pi still refuses orchestrator and worker model flags", async () => {
  const { repo, id } = await piJob();
  const run = await orca(repo, ["run", id, "--dry-run", "--worker-model", "sonnet"]);
  assert.notEqual(run.status, 0);
  const made = await orca(repo, ["new", "--kind", "pi", "--title", "t", "--goal", "g", "--orchestrator-model", "opus"]);
  assert.notEqual(made.status, 0);
});

function setStatus(box, status) {
  const current = job(box.jobPath);
  current.status = status;
  writeFileSync(box.jobPath, JSON.stringify(current, null, 2) + "\n");
}

test("done on a running job marks done and posts once", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  try {
    setStatus(box, "running");
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/done`);
    const out = await orca(box.repo, ["done", box.id], tls);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`done ${box.id}: completed`));
    assert.equal(job(box.jobPath).status, "done");
    assert.equal(existsSync(box.recordPath), true);
    assert.equal(hits.length, 1);
    assert.deepEqual(JSON.parse(hits[0].body), { job: box.id, status: "done", branch: `orca/${box.id}` });
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("done on a queued job refuses and does not post", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  try {
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/done`);
    const out = await orca(box.repo, ["done", box.id], tls);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /is queued, not running; nothing finished/);
    assert.equal(job(box.jobPath).status, "queued");
    assert.equal(existsSync(box.recordPath), false);
    assert.equal(hits.length, 0);
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("done --dry-run on a running job changes nothing", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  try {
    setStatus(box, "running");
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/done`);
    const out = await orca(box.repo, ["done", box.id, "--dry-run"], tls);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /running -> done/);
    assert.equal(job(box.jobPath).status, "running");
    assert.equal(existsSync(box.recordPath), false);
    assert.equal(hits.length, 0);
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("a second done on a done job is a no-op", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  try {
    setStatus(box, "running");
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/done`);
    const first = await orca(box.repo, ["done", box.id], tls);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(hits.length, 1);
    const again = await orca(box.repo, ["done", box.id], tls);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already done/);
    assert.equal(hits.length, 1);
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});

test("finish webhook fires and job is done even when every herdr call fails (worker pane closed)", async () => {
  const hits = [];
  const receiver = await listen(hits);
  const box = await scratch();
  try {
    writeEnv(box.repo, `https://127.0.0.1:${receiver.port}/x`);
    const bin = join(box.repo, ".stubbin");
    mkdirSync(bin);
    writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho '{"error":{"message":"pane not found"}}'\nexit 1\n`);
    chmodSync(join(bin, "herdr"), 0o755);
    const data = job(box.jobPath);
    Object.assign(data, { status: "running", workspace: "w-1", pane: "p-lead", agent: "lead", workers: [{ name: "w1", pane: "p-gone" }] });
    writeFileSync(box.jobPath, JSON.stringify(data));
    const done = await orca(box.repo, ["done", box.id], { NODE_TLS_REJECT_UNAUTHORIZED: "0", PATH: `${bin}:${process.env.PATH}` });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /finish webhook: accepted/);
    assert.equal(job(box.jobPath).status, "done");
    assert.equal(hits.length, 1);
    assert.equal(JSON.parse(hits[0].body).status, "done");
  } finally {
    receiver.close();
    rmSync(box.repo, { recursive: true, force: true });
  }
});
