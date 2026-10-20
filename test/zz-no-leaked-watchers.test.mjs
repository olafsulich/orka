import assert from "node:assert/strict";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import test from "node:test";

// Runs last by name (node --test orders files alphabetically). Other test files run in
// parallel processes, so this only asserts about watchers that outlive their own test file:
// a watcher (orka.mjs, or the orca.mjs alias) still alive whose cwd is a /tmp/orka-* or /tmp/orca-* scratch dir is a leak.
function tmpWatchers() {
  const found = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!args.some((a) => /or[ck]a\.mjs$/.test(a)) || !args.includes("watch")) continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      const flag = args[args.indexOf("--cwd") + 1] || "";
      if (/^\/tmp\/or[ck]a-/.test(cwd) || /^\/tmp\/or[ck]a-/.test(flag)) found.push(`${pid} ${cwd}`);
    } catch {
      // process exited or not ours
    }
  }
  return found;
}

test("no orka watch process with a /tmp/orka-* (or /tmp/orca-*) cwd survives the suite", async () => {
  // Watchers started by sibling files that are still running get a moment to be torn down.
  const deadline = Date.now() + 5000;
  let leaked = tmpWatchers();
  while (leaked.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    leaked = tmpWatchers();
  }
  assert.deepEqual(leaked, []);
});
