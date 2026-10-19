import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync as rmScratch } from "node:fs";
import test from "node:test";

const ORCA = join(import.meta.dirname, "..", "bin", "orca.mjs");

// herdr stub: `agent start <name>` records the name; `agent get <name>` finds recorded names.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orca-naming-"));
  process.on("exit", () => rmScratch(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const run = join(base, "run");
  for (const d of [repo, bin, home, run]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  const agents = join(base, "agents");
  writeFileSync(log, "");
  writeFileSync(agents, "");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
echo "herdr $*" >> "${log}"
if [ "$1 $2" = "agent list" ]; then
  printf '{"result":{"agents":['; sep=""; for n in $(cat "${base}/others" 2>/dev/null); do printf '%s{"name":"%s"}' "$sep" "$n"; sep=","; done; echo ']}}'; exit 0
fi
if [ "$1 $2" = "agent start" ]; then
  if [ -e "${base}/start-fails" ]; then echo '{"error":{"message":"boom"}}'; exit 1; fi
  if grep -qx "$3" "${base}/hidden" 2>/dev/null; then echo '{"error":{"message":"agent name '"$3"' is already used; candidates: x"}}'; exit 1; fi
  echo "$3" >> "${agents}"; echo '{"result":{"pane":{"pane_id":"p-new"}}}'; exit 0; fi
if [ "$1 $2" = "agent get" ]; then
  if grep -qx "$3" "${agents}"; then if [ -e "${base}/prompted-$3" ]; then echo '{"result":{"agent":{"agent_status":"working","interactive_ready":true}}}'; else echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true}}}'; fi; else echo '{"error":{"message":"not found"}}'; exit 1; fi
  exit 0
fi
if [ "$1 $2" = "agent prompt" ]; then touch "${base}/prompted-$3"; fi
if [ "$1 $2" = "pane split" ]; then echo '{"result":{"pane":{"pane_id":"p-split"}}}'; exit 0; fi
echo '{}'
`,
  );
  writeFileSync(join(bin, "agent-browser"), `#!/bin/sh\necho '{}'\n`);
  chmodSync(join(bin, "herdr"), 0o755);
  chmodSync(join(bin, "agent-browser"), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: run, AGENT_BROWSER_SOCKET_DIR: "", ORCA_NO_WATCH: "1" };
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", repo], { encoding: "utf8", env: { ...process.env, ...env } });
  orca(["init"]);
  return { repo, orca, log, agents, base, env };
}

function makeJob(t) {
  const id = t.orca(["new", "--kind", "pi", "--title", "n", "--goal", "g"]).stdout.trim();
  const path = join(t.repo, ".orca", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-1", agent: "orch", worktree: join(t.repo, "wt") });
  writeFileSync(path, JSON.stringify(job));
  const results = join(t.repo, ".orca", "jobs", id, "results");
  mkdirSync(results, { recursive: true });
  return { id, results, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

const worker = (t, id, name, role = "builder") => t.orca(["worker", "--job", id, "--name", name, "--role", role, "--task", "t"]);

test("a second verifier round starts while the first verifier pane is still open", () => {
  const t = scratch();
  const j = makeJob(t);
  const one = worker(t, j.id, "verifier", "verifier");
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /worker verifier pane=.*round=1/);
  writeFileSync(join(j.results, "verifier.json"), JSON.stringify({ round: 1, verdict: "fail", failures: ["npm test"] }));
  const two = worker(t, j.id, "verifier", "verifier");
  assert.equal(two.status, 0, two.stderr);
  assert.match(two.stdout, /name verifier was taken, using verifier-2/);
  assert.match(two.stdout, /worker verifier-2 .*round=2/);
  const three = worker(t, j.id, "verifier", "verifier");
  assert.match(three.stdout, /worker verifier-3 .*round=3/);
  const job = j.read();
  assert.deepEqual(job.workers.map((w) => w.name), ["verifier", "verifier-2", "verifier-3"]);
  assert.ok(!/^herdr pane close/m.test(readFileSync(t.log, "utf8")));
});

test("a stale round-1 result is archived and never read as the round-2 verdict", () => {
  const t = scratch();
  const j = makeJob(t);
  assert.equal(worker(t, j.id, "verifier", "verifier").status, 0);
  // Round 1 fails; its result has no "round" field, so only archiving protects round 2.
  writeFileSync(join(j.results, "verifier.json"), JSON.stringify({ verdict: "fail", failures: ["npm test"] }));
  assert.equal(worker(t, j.id, "verifier", "verifier").status, 0);
  assert.ok(existsSync(join(j.results, "verifier.round-1.json")));
  assert.ok(!existsSync(join(j.results, "verifier.json")));
  t.orca(["status", j.id]);
  const job = j.read();
  assert.equal(job.verifier.rounds, 2);
  assert.equal(job.verifier.verdict, null);
  // Round 2 writes its own result and it is picked up.
  writeFileSync(join(j.results, "verifier.json"), JSON.stringify({ round: 2, verdict: "pass", failures: [] }));
  t.orca(["status", j.id]);
  assert.equal(j.read().verifier.verdict, "pass");
});

test("the verifier prompt points at results/verifier.json and forbids closing panes", () => {
  const t = scratch();
  const j = makeJob(t);
  worker(t, j.id, "verifier", "verifier");
  worker(t, j.id, "verifier", "verifier");
  const log = readFileSync(t.log, "utf8");
  const at = log.indexOf("herdr agent prompt verifier-2");
  assert.ok(at >= 0);
  const prompt = log.slice(at);
  assert.match(prompt, /results\/verifier\.json/);
  assert.doesNotMatch(prompt, /verifier-2\.json/);
  assert.match(prompt, /Never close panes/);
});

test("builder name collisions auto-suffix without closing anything", () => {
  const t = scratch();
  const j = makeJob(t);
  assert.match(worker(t, j.id, "api").stdout, /worker api pane/);
  const b = worker(t, j.id, "api");
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /name api was taken, using api-2/);
  assert.match(b.stdout, /worker api-2 pane/);
  assert.match(worker(t, j.id, "api").stdout, /worker api-3 pane/);
  assert.ok(!/^herdr pane close/m.test(readFileSync(t.log, "utf8")));
});

test("a name held by an existing herdr agent outside the job is suffixed too", () => {
  const t = scratch();
  const j = makeJob(t);
  writeFileSync(t.agents, "web\n");
  assert.match(worker(t, j.id, "web").stdout, /worker web-2 pane/);
});

test("builders cannot take verifier or verifier-N", () => {
  const t = scratch();
  const j = makeJob(t);
  for (const name of ["verifier", "verifier-2"]) {
    const r = worker(t, j.id, name);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /reserved/);
  }
});

test("orchestrator, worker and verifier prompts all say never to close panes", () => {
  const src = readFileSync(ORCA, "utf8");
  assert.equal((src.match(/Never close panes \(yours or anyone's/g) || []).length, 1);
  assert.equal((src.match(/NEVER_CLOSE_PANES,/g) || []).length, 3);
});

test("a name used by an agent in another workspace is skipped", () => {
  const t = scratch();
  const j = makeJob(t);
  writeFileSync(join(t.base, "others"), "verifier\napi\n");
  const v = worker(t, j.id, "verifier", "verifier");
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /worker verifier-2 .*round=1/);
  assert.match(worker(t, j.id, "api").stdout, /worker api-2 pane/);
});

test("herdr reporting 'already used' at start makes orca pick the next suffix and retry", () => {
  const t = scratch();
  const j = makeJob(t);
  writeFileSync(join(t.base, "hidden"), "api\napi-2\n");
  const r = worker(t, j.id, "api");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worker api-3 pane/);
  assert.equal(j.read().workers[0].name, "api-3");
});

test("a failed start closes only the pane orca just split", () => {
  const t = scratch();
  const j = makeJob(t);
  writeFileSync(join(t.base, "start-fails"), "");
  const r = worker(t, j.id, "api");
  assert.notEqual(r.status, 0);
  const closes = readFileSync(t.log, "utf8").split("\n").filter((l) => l.startsWith("herdr pane close"));
  assert.deepEqual(closes, ["herdr pane close p-split"]);
  // with --pane the pane is the caller's: never closed
  writeFileSync(t.log, "");
  const own = t.orca(["worker", "--job", j.id, "--name", "api", "--task", "t", "--pane", "w9:p9"]);
  assert.notEqual(own.status, 0);
  assert.ok(!readFileSync(t.log, "utf8").includes("pane close"));
  assert.deepEqual(j.read().workers || [], []);
});

test("claude model aliases are cached, and an unknown alias refreshes the cache", () => {
  const t = scratch();
  const counter = join(t.base, "claude-calls");
  writeFileSync(counter, "");
  writeFileSync(
    join(t.base, "bin", "claude"),
    `#!/bin/sh
echo x >> "${counter}"
echo "Options:"
echo "  --model <model>   Model alias (e.g. 'sonnet' or 'opus') or full name."
echo "  -h, --help        help"
`,
  );
  chmodSync(join(t.base, "bin", "claude"), 0o755);
  const cache = join(t.repo, ".orca", "cache", "claude-models.json");
  const orca = (args) => spawnSync(process.execPath, [ORCA, ...args, "--cwd", t.repo], { encoding: "utf8", env: { ...process.env, ...t.env, XDG_CACHE_HOME: join(t.base, "xdg") } });
  const calls = () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
  const mk = (model) => orca(["new", "--kind", "claude", "--title", "m", "--goal", "g", "--worker-model", model]);
  assert.equal(mk("sonnet").status, 0);
  const first = calls();
  assert.ok(first >= 1);
  assert.ok(existsSync(cache));
  assert.ok(!existsSync(join(t.base, "xdg")) && !existsSync(join(t.base, "home", ".cache")), "no home or XDG cache");
  assert.equal(mk("opus").status, 0);
  assert.equal(calls(), first, "cached aliases avoid another claude --help");
  const bad = mk("nope");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown model alias/);
  assert.equal(calls(), first + 1, "an unknown alias re-reads claude --help once");
});

// herdr stub for promptWithRetry: statuses come from a script, pane text from a file.
function promptBox({ statuses, pane, afterEnter }) {
  const t = scratch();
  const j = makeJob(t);
  const dir = join(t.base, "ps");
  mkdirSync(dir);
  writeFileSync(join(dir, "statuses"), statuses.join("\n") + "\n");
  writeFileSync(join(dir, "pane"), pane);
  writeFileSync(
    join(t.base, "bin", "herdr"),
    `#!/bin/sh
echo "herdr $*" >> "${t.log}"
case "$1 $2" in
  "agent start") echo '{"result":{}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  "agent list") echo '{"result":{"agents":[]}}';;
  "agent get")
    if [ "$3" = "api" ] && [ ! -e "${dir}/started" ]; then
      # First get is the free-name check (not found); then the fresh agent is idle and ready for its prompt.
      if [ ! -e "${dir}/seen" ]; then touch "${dir}/seen"; echo '{"error":{"code":"agent_not_found","message":"no"}}'; exit 1; fi
      echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true,"pane_id":"p-split"}}}'; exit 0
    fi
    s=$(head -n1 "${dir}/statuses"); [ -n "$s" ] || s=working
    n=$(wc -l < "${dir}/statuses"); [ "$n" -gt 1 ] && tail -n +2 "${dir}/statuses" > "${dir}/s2" && mv "${dir}/s2" "${dir}/statuses"
    echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$s\\",\\"pane_id\\":\\"p-split\\"}}}";;
  "agent prompt") touch "${dir}/started"; echo '{"result":{}}';;
  "agent send-keys") ${afterEnter ? `printf 'working\\n' > "${dir}/statuses"` : ":"};;
  "pane read") cat "${dir}/pane";;
  *) echo '{}';;
esac
`,
  );
  const run = (extra = {}) => spawnSync(process.execPath, [ORCA, "worker", "--job", j.id, "--name", "api", "--task", "do the thing in a long enough line", "--cwd", t.repo], { encoding: "utf8", env: { ...process.env, ...t.env, ORCA_PROMPT_WAIT_MS: "6000", ORCA_PROMPT_POLL_MS: "200", ...extra } });
  const count = (what) => readFileSync(t.log, "utf8").split("\n").filter((l) => l.startsWith(what)).length;
  return { run, count };
}

test("a swallowed Enter (pasted text left in the input) is answered with send-keys Enter, not a second paste", () => {
  const b = promptBox({ statuses: ["idle"], pane: "output\n\u276f [Pasted text #1 +86 lines]\n", afterEnter: true });
  const r = b.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(b.count("herdr agent send-keys api Enter") >= 1);
  assert.equal(b.count("herdr agent prompt api"), 1);
});

test("unknown statuses followed by working never duplicate the prompt or press Enter", () => {
  const b = promptBox({ statuses: ["unknown", "unknown", "working"], pane: "\u276f \n" });
  const r = b.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(b.count("herdr agent prompt api"), 1);
  assert.equal(b.count("herdr agent send-keys"), 0);
});

test("an idle agent with an empty input box that never saw the prompt is re-prompted, then reported as failed", () => {
  const b = promptBox({ statuses: ["idle"], pane: "\u276f \n" });
  const r = b.run({ ORCA_PROMPT_WAIT_MS: "800", ORCA_PROMPT_BACKOFF_MS: "50" });
  assert.notEqual(r.status, 0, "idle is never delivered");
  assert.match(r.stderr, /did not start/);
  assert.equal(b.count("herdr agent prompt api"), 3);
  assert.equal(b.count("herdr agent send-keys"), 0);
});
