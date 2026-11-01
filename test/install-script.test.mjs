import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "install.sh");
const ORKA = join(ROOT, "bin", "orka.mjs");
const ORCA = join(ROOT, "bin", "orca.mjs");
const SYS_PATH = "/usr/local/bin:/usr/bin:/bin";

// Runs the script with a temp HOME, from a cwd outside the repo; never touches the real ~/bin.
function run(home, { args = [], path = SYS_PATH, script = SCRIPT, env = {} } = {}) {
  const r = spawnSync("bash", [script, ...args], { cwd: home, encoding: "utf8", env: { HOME: home, PATH: path, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), "orka-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("fresh install links orka and the orca alias into $HOME/bin, then a second run is a no-op", (t) => {
  const home = scratch(t);
  const bin = join(home, "bin");
  const first = run(home);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readlinkSync(join(bin, "orka")), ORKA);
  assert.equal(readlinkSync(join(bin, "orca")), ORCA);
  assert.match(first.stdout, /linked: .*\/bin\/orka -> /);
  assert.match(first.stdout, /orka: .*\/bin\/orka -> .*\/bin\/orka\.mjs\n$/);
  assert.ok(lstatSync(ORKA).mode & 0o111, "orka.mjs is executable");

  const second = run(home);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^ok: .*\/bin\/orka -> /m);
  assert.match(second.stdout, /^ok: .*\/bin\/orca -> /m);
  assert.doesNotMatch(second.stdout, /linked:|replaced:/);
  assert.equal(readlinkSync(join(bin, "orka")), ORKA);
});

test("target dir comes from the first arg, else ORKA_BIN_DIR; works via a symlink to the script", (t) => {
  const home = scratch(t);
  const viaArg = join(home, "arg-bin");
  assert.equal(run(home, { args: [viaArg] }).status, 0);
  assert.equal(readlinkSync(join(viaArg, "orka")), ORKA);

  const viaEnv = join(home, "env-bin");
  const link = join(home, "install-link.sh");
  symlinkSync(SCRIPT, link);
  const r = run(home, { script: link, env: { ORKA_BIN_DIR: viaEnv } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(join(viaEnv, "orka")), ORKA);
  assert.equal(readlinkSync(join(viaEnv, "orca")), ORCA);
});

test("a link pointing elsewhere (or nowhere) is replaced", (t) => {
  const home = scratch(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync("/nonexistent/orka.mjs", join(bin, "orka"));
  symlinkSync(join(home, "old-orca.mjs"), join(bin, "orca"));
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /replaced: .*\/bin\/orka -> .* \(was -> \/nonexistent\/orka\.mjs\)/);
  assert.equal(readlinkSync(join(bin, "orka")), ORKA);
  assert.equal(readlinkSync(join(bin, "orca")), ORCA);
});

test("a regular file at the target is refused with a non-zero exit and left untouched", (t) => {
  const home = scratch(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "orca"), "#!/bin/sh\necho mine\n");
  const r = run(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\/bin\/orca exists and is not a symlink; refusing to overwrite/);
  assert.equal(readFileSync(join(bin, "orca"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.throws(() => lstatSync(join(bin, "orka")), /ENOENT/, "nothing is linked when one target is refused");
});

test("PATH warning on stderr only when the target dir is not on PATH", (t) => {
  const home = scratch(t);
  const bin = join(home, "bin");
  const off = run(home);
  assert.equal(off.status, 0);
  assert.match(off.stderr, /is not on PATH/);
  assert.match(off.stderr, /export PATH=".*\/bin:\$PATH"/);
  assert.doesNotMatch(off.stdout, /not on PATH/);

  const on = run(home, { path: `${bin}:${SYS_PATH}` });
  assert.equal(on.status, 0);
  assert.equal(on.stderr, "");
});
