import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findTaggedBrowsers, isBrowserProcess, selectReap } from "../lib/browsers.mjs";

function fakeProc(entries) {
  const root = mkdtempSync(join(tmpdir(), "orka-proc-"));
  for (const [pid, cmd, env] of entries) {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), "cmdline"), cmd.split(" ").join("\0") + "\0");
    writeFileSync(join(root, String(pid), "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
  }
  return root;
}

test("isBrowserProcess matches browsers, not shells or orka", () => {
  assert.ok(isBrowserProcess("/home/u/.cache/ms-playwright/chromium-1187/chrome-linux/chrome --headless --user-data-dir=/tmp/x"));
  assert.ok(isBrowserProcess("/opt/google/chrome/chrome --type=renderer"));
  assert.ok(isBrowserProcess("node /usr/lib/node_modules/chrome-devtools-mcp/build/index.js"));
  assert.ok(isBrowserProcess("/usr/bin/agent-browser --session orka-abc-w1 open"));
  assert.ok(isBrowserProcess("/x/headless_shell --remote-debugging-port=0"));
  assert.ok(!isBrowserProcess("bash -c agent-browser close"));
  assert.ok(!isBrowserProcess("node /home/u/projects/orka/bin/orka.mjs reap x"));
  assert.ok(!isBrowserProcess("node server.js --port 5173"));
  assert.ok(!isBrowserProcess(""));
});

test("only tagged processes are found, and live jobs are never reaped", () => {
  const root = fakeProc([
    [101, "/c/chrome --headless", { ORKA_JOB: "done1", ORKA_WORKER: "w1" }],
    [102, "/c/chrome --type=renderer", { ORKA_JOB: "done1", ORKA_WORKER: "w2" }],
    [103, "/c/chrome --headless", { ORKA_JOB: "live1", ORKA_WORKER: "stills-b" }],
    [104, "/c/chrome --headless", { HOME: "/h" }],
    [105, "node vite --port 1", { ORKA_JOB: "done1" }],
    [106, "/c/chrome", { ORKA_JOB: "other-repo-job" }],
  ]);
  const procs = findTaggedBrowsers({ procRoot: root, selfPid: 1 });
  assert.deepEqual(procs.map((p) => p.pid).sort(), [101, 102, 103, 106]);
  assert.deepEqual(selectReap(procs, { jobId: "done1", worker: "w1" }).map((p) => p.pid), [101]);
  assert.deepEqual(selectReap(procs, { jobId: "done1" }).map((p) => p.pid).sort(), [101, 102]);
  assert.deepEqual(selectReap(procs, { finishedJobIds: ["done1"] }).map((p) => p.pid).sort(), [101, 102]);
  assert.deepEqual(selectReap(procs, {}).map((p) => p.pid), []);
});
