// Shared dependency dirs for job worktrees. A new worktree symlinks heavy dep
// dirs (node_modules) to the repo's main checkout instead of installing its own.
// When its lockfile differs from main's, it gets a real install instead. A link
// that went missing or broken is repaired the next time orka sets the worktree up.
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

// dir: the dep dir; manifest: its presence marks a project that uses it; locks: in
// priority order, each with the install command for a worktree of its own.
export const DEP_DIRS = [
  {
    dir: "node_modules",
    manifest: "package.json",
    locks: [
      { file: "pnpm-lock.yaml", install: ["pnpm", "install", "--frozen-lockfile"] },
      { file: "yarn.lock", install: ["yarn", "install", "--frozen-lockfile"] },
      { file: "bun.lock", install: ["bun", "install", "--frozen-lockfile"] },
      { file: "bun.lockb", install: ["bun", "install", "--frozen-lockfile"] },
      { file: "package-lock.json", install: ["npm", "ci"] },
      { file: "npm-shrinkwrap.json", install: ["npm", "ci"] },
    ],
    fallback: ["npm", "install"],
  },
];

function read(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function isRealDir(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

// "missing", "real" (a directory of its own), "link" (resolves to target) or "broken".
export function linkState(path, target) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "missing";
  }
  if (!st.isSymbolicLink()) return "real";
  try {
    if (resolve(readlinkSync(path)) !== resolve(target)) return "broken";
    return statSync(path).isDirectory() ? "link" : "broken";
  } catch {
    return "broken";
  }
}

// Same lockfiles (byte for byte) in both checkouts; with no lockfile, the same manifest.
export function sameLock(main, wt, spec) {
  const present = spec.locks.filter((l) => existsSync(join(main, l.file)) || existsSync(join(wt, l.file)));
  const files = present.length ? present.map((l) => l.file) : [spec.manifest];
  return files.every((f) => {
    const a = read(join(main, f));
    const b = read(join(wt, f));
    return a !== null && b !== null && a.equals(b);
  });
}

export function installCommand(wt, spec) {
  return spec.locks.find((l) => existsSync(join(wt, l.file)))?.install || spec.fallback;
}

// What to do for each dep dir of a worktree: [{ dir, action, reason, install? }].
// action: "link", "relink" (replace a missing/broken/stale link), "install"
// (lockfile differs from main's, or the link is broken and main has none), "ok".
// A worktree dir of its own ("real") is never touched.
export function planDeps(main, wt, specs = DEP_DIRS) {
  const out = [];
  for (const spec of specs) {
    if (!existsSync(join(wt, spec.manifest))) continue;
    const path = join(wt, spec.dir);
    const target = join(main, spec.dir);
    const state = linkState(path, target);
    if (state === "real") continue;
    const mainHas = isRealDir(target);
    const same = sameLock(main, wt, spec);
    if (mainHas && same) {
      if (state === "link") out.push({ dir: spec.dir, action: "ok", reason: "linked to main" });
      else out.push({ dir: spec.dir, action: state === "missing" ? "link" : "relink", reason: state === "missing" ? "lockfile matches main" : "link was broken" });
    } else if (mainHas || state !== "missing") {
      // Lockfile differs from main's, or a link points at nothing: the worktree needs its own install.
      const reason = mainHas ? "lockfile differs from main" : "link was broken and main has none";
      out.push({ dir: spec.dir, action: "install", reason, install: installCommand(wt, spec) });
    }
  }
  return out;
}

// Applies a plan. run(cmd, cwd) performs an install and returns { ok, detail }.
export function applyDeps(main, wt, plan, { run, log = () => {} }) {
  const done = [];
  for (const step of plan) {
    const path = join(wt, step.dir);
    const target = join(main, step.dir);
    if (step.action === "ok") continue;
    if (linkState(path, target) !== "missing" && linkState(path, target) !== "real") rmSync(path, { force: true });
    if (step.action === "link" || step.action === "relink") {
      symlinkSync(target, path, "dir");
      log(`deps: linked ${step.dir} -> ${target} (${step.reason})`);
      done.push({ dir: step.dir, action: step.action });
      continue;
    }
    log(`deps: ${step.reason}; running ${step.install.join(" ")} in the worktree`);
    const got = run(step.install, wt);
    log(got.ok ? `deps: installed ${step.dir}` : `deps: install failed (${got.detail}); the worktree has no ${step.dir}`);
    done.push({ dir: step.dir, action: "install", ok: got.ok });
  }
  return done;
}

// Names orka may have linked, for removal and git status filtering.
export const linkNames = (specs = DEP_DIRS) => specs.map((s) => s.dir);

// Removes the dep links (never a real dir) so git worktree remove never follows one.
export function unlinkLinks(wt, specs = DEP_DIRS) {
  for (const name of linkNames(specs)) {
    const path = join(wt, name);
    try {
      if (lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
    } catch {
      // not there
    }
  }
}

// True for a `git status --porcelain` line that is only one of orka's dep links.
export function isLinkStatusLine(wt, line, specs = DEP_DIRS) {
  const m = /^\?\? (.+)$/.exec(String(line));
  if (!m) return false;
  const name = m[1].replace(/\/$/, "");
  if (!linkNames(specs).includes(name)) return false;
  try {
    return lstatSync(join(wt, name)).isSymbolicLink();
  } catch {
    return false;
  }
}
