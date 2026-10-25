import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workerGateSummary } from "../lib/digest.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// A real repo with a linked job worktree and a herdr stub that logs every call (prompts included).
function scratch({ pkg = { scripts: { lint: "node -e 0", test: "node -e 0" } }, config } = {}) {
  const base = mkdtempSync(join(tmpdir(), "orka-worker-gates-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
echo "herdr $*" >> "${log}"
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
  const g = (args, cwd = repo) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  g(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_PROMPT_POLL_MS: "50" };
  const orka = (args) => spawnSync("timeout", ["120", process.execPath, ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  if (config) writeFileSync(join(repo, ".orka", "config.json"), JSON.stringify(config));
  const id = orka(["new", "--kind", "pi", "--title", "g", "--goal", "g", "--no-gate"]).stdout.trim();
  const wt = join(repo, ".orka", "worktrees", id);
  g(["worktree", "add", "-q", "-b", `orka/${id}`, wt, "HEAD"]);
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...read(), status: "running", pane: "p-1", agent: "orch", worktree: wt, baseCommit: g(["rev-parse", "HEAD"]) }));
  const worker = (name, task = "GOAL: x\nSCOPE: a.txt\nACCEPTANCE: a.txt exists", extra = []) => orka(["worker", "--job", id, "--name", name, "--task", task, ...extra]);
  // The prompt text herdr was given for one agent (everything from its "agent prompt" call to the next herdr call).
  const prompt = (name) => {
    const text = readFileSync(log, "utf8");
    const at = text.indexOf(`herdr agent prompt ${name} `);
    if (at === -1) return null;
    const end = text.indexOf("\nherdr ", at + 1);
    return text.slice(at, end === -1 ? undefined : end);
  };
  const results = join(repo, ".orka", "jobs", id, "results");
  return { repo, wt, id, orka, worker, prompt, results };
}

test("a builder brief gets a GATES block with the detected commands under the gate timeout", () => {
  const t = scratch({ config: { gateTimeout: "30s" } });
  const r = t.worker("alpha");
  assert.equal(r.status, 0, r.stderr);
  const p = t.prompt("alpha");
  assert.ok(p, "alpha was prompted");
  assert.match(p, /GATES \(package\.json scripts: lint, test\)/);
  assert.match(p, /one at a time in this order, never in parallel/);
  assert.match(p, /\n  timeout -k 5 30 sh -c 'npm run lint'\n  timeout -k 5 30 sh -c 'npm test'\n/);
  assert.match(p, /outside your SCOPE is not yours .*do not edit that file; report it/);
  assert.match(p, /"gates": \[\{"cmd":/);
  assert.ok(p.indexOf("GATES (") < p.indexOf("When finished, write"), "gates come before the result instructions");
});

test("config \"gates\" replaces detection in the brief; gates:false and no gates mean no block", () => {
  const listed = scratch({ config: { gates: ["make check", "npm run lint -- --max-warnings 0"] } });
  assert.equal(listed.worker("alpha").status, 0);
  assert.match(listed.prompt("alpha"), /\n  timeout -k 5 600 sh -c 'make check'\n  timeout -k 5 600 sh -c 'npm run lint -- --max-warnings 0'\n/);
  const off = scratch({ config: { gates: false } });
  assert.equal(off.worker("alpha").status, 0);
  assert.doesNotMatch(off.prompt("alpha"), /GATES|timeout -k/);
  const none = scratch({ pkg: { scripts: { build: "x" } } });
  assert.equal(none.worker("alpha").status, 0);
  assert.doesNotMatch(none.prompt("alpha"), /GATES|timeout -k/);
});

test("research workers and the verifier get no GATES block", () => {
  const t = scratch();
  assert.equal(t.worker("research-api", "GOAL: find out how x works\nREPORT: answer").status, 0);
  assert.doesNotMatch(t.prompt("research-api"), /GATES|timeout -k/);
  assert.equal(t.worker("scout", "GOAL: look\nRESEARCH REPORT FORMAT (for your result and note):\n- Lead with the answer.").status, 0);
  assert.doesNotMatch(t.prompt("scout"), /GATES \(/);
  const v = t.worker("verifier", "GOAL: check\nACCEPTANCE: it works", ["--role", "verifier"]);
  assert.equal(v.status, 0, v.stderr);
  assert.doesNotMatch(t.prompt("verifier"), /GATES \(|timeout -k/);
});

test("orka digest shows each builder's gates field in one line; a result without it is tolerated", () => {
  const t = scratch();
  for (const n of ["alpha", "beta", "gamma"]) assert.equal(t.worker(n).status, 0);
  mkdirSync(t.results, { recursive: true });
  writeFileSync(join(t.results, "alpha.json"), JSON.stringify({ worker: "alpha", ok: true, result: "done", gates: [{ cmd: "npm run lint", ok: true, ownFailures: [], otherFailures: [] }, { cmd: "npm test", ok: false, ownFailures: [], otherFailures: ["b.mjs"] }] }));
  writeFileSync(join(t.results, "beta.json"), JSON.stringify({ worker: "beta", ok: true, result: "done" }));
  writeFileSync(join(t.results, "gamma.json"), JSON.stringify({ worker: "gamma", ok: false, result: "red", gates: [{ cmd: "npm run lint", ok: false, ownFailures: ["g.mjs"], otherFailures: [] }] }));
  const d = t.orka(["digest", t.id]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /- alpha ok=true note missing\n  gates: npm run lint ok, npm test RED \(own 0, other 1\)\n/);
  assert.match(d.stdout, /- beta ok=true note missing\n- gamma/);
  assert.match(d.stdout, /- gamma ok not true note missing\n  gates: npm run lint RED \(own 1, other 0\); own gates red: not done, steer it back\n/);
});

test("workerGateSummary: missing or empty is null; counts work as well as lists", () => {
  assert.equal(workerGateSummary(undefined), null);
  assert.equal(workerGateSummary([]), null);
  assert.equal(workerGateSummary("x"), null);
  assert.equal(workerGateSummary([{ cmd: "npm test", ok: false, ownFailures: 2, otherFailures: 0 }]), "gates: npm test RED (own 2, other 0); own gates red: not done, steer it back");
});

test("the orchestrator prompt says builders self-check and own red gates are not done", () => {
  const src = readFileSync(ORKA, "utf8");
  const start = src.indexOf("function orchestratorPrompt(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /Builders run the repo's gates themselves/);
  assert.match(body, /reports its own gates red is not done: steer it back/);
});
