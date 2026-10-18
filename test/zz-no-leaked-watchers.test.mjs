import assert from "node:assert/strict";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import test from "node:test";

// Runs last by name (node --test orders files alphabetically). Other test files run in
// parallel processes, so this only asserts about watchers that outlive their own test file:
// a watcher still alive whose cwd is a /tmp/orca-* scratch dir is a leak.
function tmpWatchers() {
  const found = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!args.some((a) => a.endsWith("orca.mjs")) || !args.includes("watch")) continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      const flag = args[args.indexOf("--cwd") + 1] || "";
      if (/^\/tmp\/orca-/.test(cwd) || /^\/tmp\/orca-/.test(flag)) found.push(`${pid} ${cwd}`);
    } catch {
      // process exited or not ours
    }
  }
  return found;
}

test("no orca watch process with a /tmp/orca-* cwd survives the suite", async () => {
  // Watchers started by sibling files that are still running get a moment to be torn down.
  const deadline = Date.now() + 5000;
  let leaked = tmpWatchers();
  while (leaked.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    leaked = tmpWatchers();
  }
  assert.deepEqual(leaked, []);
});
