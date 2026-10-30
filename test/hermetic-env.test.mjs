import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { leaked } from "../scripts/hermetic-env.mjs";

const ROOT = join(import.meta.dirname, "..");

// The env an orka job pane exports (guardEnvArgs, jobEnvArgs, portEnvArgs in bin/orka.mjs), with a
// guard hook that refuses like orka's does outside an orka repo.
function paneEnv(base) {
  const hooks = join(base, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho \"not an orka repo: $PWD\" >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks };
  for (const [k, v] of Object.entries({ JOB: "j-leak", WORKER: "verifier", PORT: "4310", PORTS: "4310,4311" })) Object.assign(env, { [`ORKA_${k}`]: v, [`ORCA_${k}`]: v });
  delete env.NODE_TEST_CONTEXT; // the inner run reports on its own, not to this runner
  return env;
}

// A test file that does what the suite does: commit in a scratch repo, and read the job tag.
function fixture(base) {
  const file = join(base, "leak.test.mjs");
  writeFileSync(
    file,
    `import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
test("scratch repo commit, no job tag", () => {
  const repo = ${JSON.stringify(join(base, "repo"))};
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo, stdio: "pipe" });
  assert.equal(process.env.ORKA_JOB, undefined);
  assert.equal(process.env.ORCA_JOB, undefined);
});
`,
  );
  return file;
}

test("npm test is hermetic: a job pane's GIT_CONFIG_* hooksPath and ORKA_* tags do not reach the tests", () => {
  const base = mkdtempSync(join(tmpdir(), "orka-testenv-"));
  try {
    const env = paneEnv(base);
    const file = fixture(base);
    // Without the preload the leak is real: the commit hits the guard hook.
    const bare = spawnSync(process.execPath, ["--test", file], { cwd: ROOT, env, encoding: "utf8" });
    assert.notEqual(bare.status, 0);
    assert.match(bare.stdout + bare.stderr, /not an orka repo/);
    // The package.json test script, run the same way, passes.
    const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.test.split(" ");
    assert.equal(script[0], "node");
    const r = spawnSync(process.execPath, [...script.slice(1), file], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("hermetic-env strips only repo-local git vars and orka tags", () => {
  for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_12", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "ORKA_JOB", "ORCA_PORTS"]) assert.ok(leaked(k), k);
  for (const k of ["GIT_EDITOR", "GIT_AUTHOR_NAME", "GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND", "PATH", "HOME", "PORT"]) assert.ok(!leaked(k), k);
});
