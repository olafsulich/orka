import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");
const DIALOG = `Accessing workspace:\\n\\n /tmp/x/.orka/worktrees/j\\n\\n Quick safety check: Is this a project you created or one you trust? (Like your own code)\\n\\n ❯ No, exit\\n   Yes, I trust this folder\\n\\n Enter to confirm · Esc to cancel`;

// herdr stub. Knobs (files in the box): start-ok (agent start succeeds), dialog (pane read shows the
// trust dialog), blocked (agent start says "already used ... status=Blocked").
function scratch(knobs = {}) {
  const base = mkdtempSync(join(tmpdir(), "orka-trust-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries(knobs)) if (v) writeFileSync(join(base, k), "");
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"p-root"}}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  "pane read") if [ -e "${base}/dialog" ]; then printf '${DIALOG}\\n'; else printf 'ready\\n'; fi;;
  "agent start")
    if [ -e "${base}/start-ok" ]; then echo '{"result":{}}'; exit 0; fi
    if [ -e "${base}/blocked" ]; then echo '{"error":{"message":"agent name $3 is already used; candidates: pane_id=p-root status=Blocked"}}'; exit 1; fi
    echo '{"error":{"code":"agent_not_ready","message":"agent_not_ready"}}'; exit 1;;
  "agent get") case "$3" in builder*) echo '{"error":{"message":"not found"}}'; exit 1;; esac; echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true}}}';;
  *) echo '{"result":{}}';;
esac
`);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "  --model <model>   Model alias (e.g. 'sonnet', 'haiku' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_BACKEND: "herdr", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_READY_WAIT_MS: "1000", ORKA_PROMPT_WAIT_MS: "500" };
  delete env.ORKA_JOB;
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const set = (k, on = true) => (on ? writeFileSync(join(base, k), "") : rmSync(join(base, k), { force: true }));
  return { base, repo, orka, calls, set };
}

test("orka run in a repo Claude has not trusted fails at once with the repo path and the manual fix, no retry, no 'already used'", () => {
  const t = scratch({ dialog: true });
  const id = t.orka(["new", "--title", "t", "--goal", "g", "--no-gate"]).stdout.trim();
  const r = t.orka(["run", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the orchestrator did not start: Claude Code is waiting on its folder-trust dialog in pane p-root\./);
  assert.match(r.stderr, new RegExp(`Claude has not trusted ${t.repo} yet`));
  assert.match(r.stderr, new RegExp(`One-time fix, by hand: cd ${t.repo} && claude, choose "Yes, I trust this folder", then /exit`));
  assert.match(r.stderr, /orka does not accept the dialog for you/);
  assert.doesNotMatch(r.stderr, /already used/);
  assert.equal(t.calls().filter((c) => c.startsWith("herdr agent start")).length, 1, "no second start into the dialog");
  assert.ok(!t.calls().some((c) => /send-keys/.test(c)), "the dialog is never answered");
  const job = JSON.parse(readFileSync(join(t.repo, ".orka", "jobs", `${id}.json`), "utf8"));
  assert.equal(job.status, "failed");
  assert.match(job.stopReason, /folder-trust dialog/);
});

test("a start herdr reports as fine but whose pane shows the dialog fails fast too", () => {
  const t = scratch({ dialog: true, "start-ok": true });
  const id = t.orka(["new", "--title", "t", "--goal", "g", "--no-gate"]).stdout.trim();
  const r = t.orka(["run", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /folder-trust dialog in pane p-root/);
  assert.ok(!t.calls().some((c) => c.startsWith("herdr agent prompt")), "no prompt sent into the dialog");
});

test("orka worker: the trust dialog in the new pane is named, and that pane is closed", () => {
  const t = scratch({ "start-ok": true });
  const id = t.orka(["new", "--title", "t", "--goal", "g", "--no-gate"]).stdout.trim();
  const path = join(t.repo, ".orka", "jobs", `${id}.json`);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-root", agent: "orch", worktree: t.repo, workerModel: "haiku" });
  writeFileSync(path, JSON.stringify(job));
  t.set("dialog");
  const r = t.orka(["worker", "--job", id, "--name", "builder", "--task", "SCOPE: a ACCEPTANCE: b"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /worker builder did not start: Claude Code is waiting on its folder-trust dialog in pane p-split/);
  assert.ok(t.calls().includes("herdr pane close p-split"));
});

test("'already used ... status=Blocked' without a visible dialog is explained, not left as a name clash", () => {
  const t = scratch({ blocked: true });
  const id = t.orka(["new", "--title", "t", "--goal", "g", "--no-gate"]).stdout.trim();
  const r = t.orka(["run", id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already used/);
  assert.match(r.stderr, /The agent under that name is blocked on a dialog in its pane, not a name clash/);
});

test("a pi job never reads the pane for Claude's dialog", () => {
  const t = scratch({ dialog: true, "start-ok": true });
  const id = t.orka(["new", "--kind", "pi", "--title", "t", "--goal", "g", "--no-gate"]).stdout.trim();
  const r = t.orka(["run", id]);
  assert.doesNotMatch(r.stderr, /folder-trust/);
  assert.ok(!t.calls().some((c) => c.startsWith("herdr pane read p-root --source recent")), "no trust probe for pi");
});
