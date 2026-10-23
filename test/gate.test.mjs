import { execFile, execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");
const execFileAsync = promisify(execFile);

// Fake herdr (logs its arguments; a new agent is idle and ready, then working once prompted) and a real git repo.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-gate-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "workspace create") rm -f "${base}/prompted" "${base}"/seen-*; echo '{"result":{"root_pane":{"pane_id":"p-root"}}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  "agent list") echo '{"result":{"agents":[]}}';;
  "agent get")
    if [ ! -e "${base}/prompted" ]; then
      if [ ! -e "${base}/seen-$3" ]; then touch "${base}/seen-$3"; echo '{"error":{"code":"agent_not_found","message":"no"}}'; exit 1; fi
      if [ -e "${base}/done-$3" ]; then echo '{"result":{"agent":{"agent_status":"done","interactive_ready":true,"pane_id":"p-split"}}}'; exit 0; fi
      echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true,"pane_id":"p-split"}}}'; exit 0
    fi
    echo '{"result":{"agent":{"agent_status":"working","pane_id":"p-split"}}}';;
  "agent prompt") touch "${base}/prompted"; echo '{"result":{}}';;
  *) echo '{"result":{}}';;
esac
`,
  );
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet', 'haiku' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_READY_WAIT_MS: "3000", ORKA_PROMPT_WAIT_MS: "3000" };
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  const orkaAsync = async (args, extra = {}) => {
    try {
      const r = await execFileAsync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...env, ...extra } });
      return { status: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      return { status: err.code ?? 1, stdout: err.stdout || "", stderr: err.stderr || "" };
    }
  };
  orka(["init"]);
  const jobFile = (id) => join(repo, ".orka", "jobs", `${id}.json`);
  const read = (id) => JSON.parse(readFileSync(jobFile(id), "utf8"));
  const dir = (id) => join(repo, ".orka", "jobs", id);
  const fresh = () => {
    writeFileSync(log, "");
    for (const f of readdirSync(base)) if (f === "prompted" || f.startsWith("seen-")) rmSync(join(base, f));
  };
  // The orchestrator agent exists and is idle and ready (for approve and steer).
  const ready = (agent) => {
    fresh();
    writeFileSync(join(base, `seen-${agent}`), "");
  };
  // Its turn ended and nobody looked: herdr reports done, not idle (what a real paused orchestrator shows).
  const turnDone = (agent) => {
    ready(agent);
    writeFileSync(join(base, `done-${agent}`), "");
  };
  const started = (...extra) => {
    const id = orka(["new", "--title", "dark mode", "--goal", "Add a dark mode toggle.", ...extra]).stdout.trim();
    const r = orka(["run", id]);
    assert.equal(r.status, 0, r.stderr);
    return id;
  };
  const writeApproach = (id, text = "What: a toggle\nHow: a data-theme attribute\nFiles: header.js\nRisks: flash on load") => {
    mkdirSync(dir(id), { recursive: true });
    writeFileSync(join(dir(id), "approach.md"), text);
  };
  const decisions = (id) => (existsSync(join(dir(id), "decisions.tsv")) ? readFileSync(join(dir(id), "decisions.tsv"), "utf8") : "");
  return { base, repo, orka, orkaAsync, read, dir, fresh, ready, turnDone, started, writeApproach, decisions, calls: () => readFileSync(log, "utf8") };
}

function listen(hits) {
  const dir = mkdtempSync(join(tmpdir(), "orka-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const server = createServer({ cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => (server.close(), rmSync(dir, { recursive: true, force: true })) })));
}

test("the gate is on for a new feature and off for --no-gate, other playbooks and fixes the intake names", () => {
  const t = scratch();
  const gate = (...args) => t.read(t.orka(["new", ...args]).stdout.trim()).gate;
  assert.deepEqual(gate("--title", "dark mode", "--goal", "Add a toggle."), { on: true, reason: "new feature", state: "planning" });
  assert.deepEqual(gate("--title", "dark mode 2", "--goal", "Add a toggle.", "--no-gate"), { on: false, reason: "--no-gate" });
  assert.deepEqual(gate("--title", "crash", "--goal", "g", "--playbook", "bug-fix"), { on: false, reason: "playbook bug-fix" });
  assert.equal(gate("--title", "Fix the header overflow", "--goal", "g").on, false);
  assert.equal(gate("--title", "typo in readme", "--goal", "g").on, false);
  assert.deepEqual(gate("--title", "small", "--goal", "Rename a label.\nKind: trivial"), { on: false, reason: "intake: Kind: trivial" });
  assert.match(t.orka(["status", t.orka(["new", "--title", "x", "--goal", "g", "--no-gate"]).stdout.trim()]).stdout, /gate: off \(--no-gate\)/);
});

test("the orchestrator is told to plan, write approach.md and orka propose; an ungated job is not", () => {
  const t = scratch();
  const id = t.started();
  assert.match(t.calls(), /DIRECTION GATE \(on: this is a new feature\)/);
  assert.match(t.calls(), new RegExp(`Write ${t.dir(id)}/approach\\.md, a few lines: What \\(the outcome\\), How \\(the approach\\), Files \\(what will change\\), Risks`));
  assert.match(t.calls(), new RegExp(`Run orka propose ${id}\\.`));
  t.fresh();
  t.started("--no-gate");
  assert.doesNotMatch(t.calls(), /DIRECTION GATE/);
});

test("before approval only research workers start; builders and the verifier are refused", () => {
  const t = scratch();
  const id = t.started();
  t.fresh();
  const b = t.orka(["worker", "--job", id, "--name", "builder", "--task", "GOAL: x\nSCOPE: a\nACCEPTANCE: b"]);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /direction gate: job .* has no approved approach yet; only research workers/);
  const v = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", "t"]);
  assert.match(v.stderr, /direction gate/);
  const r = t.orka(["worker", "--job", id, "--name", "research-css", "--task", "find the theme code"]);
  assert.equal(r.status, 0, r.stderr);
});

test("propose pauses the job, notifies once with the approach, and done is refused while it waits", async () => {
  const t = scratch();
  const id = t.started();
  assert.match(t.orka(["propose", id]).stderr, /no approach\.md/);
  t.writeApproach(id);
  const hits = [];
  const receiver = await listen(hits);
  try {
    const secrets = join(t.repo, ".orka", "secrets");
    writeFileSync(join(secrets, "finish-webhook.env"), `WEBHOOK_URL=https://127.0.0.1:${receiver.port}/gate\nWEBHOOK_KEY=k\n`, { mode: 0o600 });
    const r = await t.orkaAsync(["propose", id], { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /awaiting-direction \(proposal 1\); notification: accepted \(HTTP 204\)/);
  } finally {
    receiver.close();
  }
  assert.equal(hits.length, 1);
  const body = JSON.parse(hits[0].body);
  assert.equal(body.kind, "awaiting-direction");
  assert.equal(body.status, "awaiting-direction");
  assert.equal(body.job, id);
  assert.match(body.approach, /^What: a toggle\nHow: a data-theme attribute/);
  assert.match(body.question, new RegExp(`orka approve ${id}`));
  const job = t.read(id);
  assert.equal(job.status, "awaiting-direction");
  assert.equal(job.gate.state, "awaiting");
  const status = t.orka(["status", id]).stdout;
  assert.match(status, /gate: awaiting direction since .* \(proposal 1\)/);
  assert.match(status, /\n    What: a toggle\n/);
  assert.match(t.orka(["propose", id]).stderr, /already awaiting direction/);
  const done = t.orka(["done", id]);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /waiting at the direction gate/);
  assert.match(t.orka(["worker", "--job", id, "--name", "research-2", "--task", "x"]).stderr, /waits at the direction gate/);
  assert.match(t.decisions(id), /\tgate\tproposal 1: awaiting direction\t/);
});

test("approve resumes the orchestrator and unlocks builders", () => {
  const t = scratch();
  const id = t.started();
  t.writeApproach(id);
  assert.equal(t.orka(["propose", id]).status, 0);
  t.ready(t.read(id).agent);
  const r = t.orka(["approve", id, "keep it under 30 lines"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /approved .*; the orchestrator builds now/);
  assert.match(t.calls(), /herdr agent prompt j\w+ Direction approved by Olaf: keep it under 30 lines\nBuild it now, following .*approach\.md/);
  const job = t.read(id);
  assert.equal(job.status, "running");
  assert.equal(job.gate.state, "approved");
  assert.equal(job.gate.note, "keep it under 30 lines");
  assert.match(t.orka(["status", id]).stdout, /gate: approved /);
  t.fresh();
  const b = t.orka(["worker", "--job", id, "--name", "builder", "--task", "GOAL: x\nSCOPE: a\nACCEPTANCE: b"]);
  assert.equal(b.status, 0, b.stderr);
  assert.match(t.decisions(id), /\tgate\tapproved\tkeep it under 30 lines\t/);
  assert.match(t.orka(["propose", id]).stderr, /already approved/);
});

test("approve and the gate steer reach an orchestrator herdr reports as done (turn ended, not idle)", () => {
  const t = scratch();
  const id = t.started();
  t.writeApproach(id);
  t.orka(["propose", id]);
  t.turnDone(t.read(id).agent);
  const s = t.orka(["steer", id, "smaller"]);
  assert.equal(s.status, 0, s.stderr);
  t.orka(["propose", id]);
  t.turnDone(t.read(id).agent);
  const a = t.orka(["approve", id]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(t.read(id).gate.state, "approved");
});

test("approve refuses a job that is not waiting at the gate", () => {
  const t = scratch();
  const id = t.started();
  const r = t.orka(["approve", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /orka approve resumes a job waiting at the direction gate; .* is running/);
  const ungated = t.orka(["new", "--title", "u", "--goal", "g", "--no-gate"]).stdout.trim();
  assert.match(t.orka(["approve", ungated]).stderr, /is queued \(gate off: --no-gate\)/);
});

test("steer at the gate asks for a revised plan and the job proposes again", () => {
  const t = scratch();
  const id = t.started();
  t.writeApproach(id);
  t.orka(["propose", id]);
  t.ready(t.read(id).agent);
  const s = t.orka(["steer", id, "use a CSS variable, not a class"]);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /direction gate: revising the approach/);
  assert.match(t.calls(), /Direction gate: Olaf asks you to revise the approach, not to build yet\.\nuse a CSS variable, not a class\nUpdate .*approach\.md, run orka propose/);
  let job = t.read(id);
  assert.equal(job.status, "running");
  assert.equal(job.gate.state, "revising");
  assert.match(t.orka(["worker", "--job", id, "--name", "builder", "--task", "GOAL: x\nSCOPE: a\nACCEPTANCE: b"]).stderr, /direction gate/);
  t.writeApproach(id, "What: a toggle\nHow: a CSS variable\nFiles: theme.css\nRisks: none");
  assert.match(t.orka(["propose", id]).stdout, /proposal 2/);
  job = t.read(id);
  assert.equal(job.gate.proposals, 2);
  assert.match(job.gate.approach, /CSS variable/);
});

test("stop works on a job waiting at the gate", () => {
  const t = scratch();
  const id = t.started();
  t.writeApproach(id);
  t.orka(["propose", id]);
  t.ready(t.read(id).agent);
  const r = t.orka(["stop", id, "not now"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.read(id).status, "stopped");
});
