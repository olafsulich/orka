// Orka was called orca. New state uses the orka names; everything an older orca
// wrote keeps working and is never moved: .orca/ state dirs, orca.verify.json and
// orca.features.md, orca/<id> branches, orca-<sha8> browser sessions, ORCA_* env
// vars and `orca.mjs watch` processes. Every place that names one of these goes
// through this file, so the fallback rules live once.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export const NAME = "orka";
export const LEGACY_NAME = "orca";
export const STATE_DIR = ".orka";
export const LEGACY_STATE_DIR = ".orca";

// .orka/ when it exists, else an existing .orca/ (live and old repos stay as they
// are), else .orka/ for the caller to create.
export function stateDirName(repo) {
  if (existsSync(join(repo, STATE_DIR))) return STATE_DIR;
  if (existsSync(join(repo, LEGACY_STATE_DIR))) return LEGACY_STATE_DIR;
  return STATE_DIR;
}

export function stateDir(repo) {
  return join(repo, stateDirName(repo));
}

// orka.<suffix> when it exists in dir, else an existing orca.<suffix>, else orka.<suffix>.
export function fileName(dir, suffix) {
  const name = `${NAME}.${suffix}`;
  const legacy = `${LEGACY_NAME}.${suffix}`;
  if (dir && !existsSync(join(dir, name)) && existsSync(join(dir, legacy))) return legacy;
  return name;
}

export const fileNames = (suffix) => [`${NAME}.${suffix}`, `${LEGACY_NAME}.${suffix}`];

// ORKA_<key> wins; ORCA_<key> is still read.
export function env(key, source = process.env) {
  return source[`ORKA_${key}`] ?? source[`ORCA_${key}`];
}

// Exported env vars carry both names, so old scripts and agents keep reading ORCA_*.
export function envPair(key, value) {
  return { [`ORKA_${key}`]: value, [`ORCA_${key}`]: value };
}

export function envOf(map) {
  return Object.assign({}, ...Object.entries(map).map(([k, v]) => envPair(k, v)));
}

export const branchFor = (id) => `${NAME}/${id}`;

// A job record without a branch predates orka, so its branch is orca/<id>.
export function jobBranch(job) {
  return job?.branch || `${LEGACY_NAME}/${job?.id}`;
}

// Jobs created by orca keep their orca- names (browser sessions) to the end.
export function isLegacyJob(job) {
  return jobBranch(job).startsWith(`${LEGACY_NAME}/`);
}

export const workspaceLabel = (id) => `${NAME}-${id}`.slice(0, 40);

export function sessionPrefix(job) {
  const name = isLegacyJob(job) ? LEGACY_NAME : NAME;
  return `${name}-${createHash("sha1").update(String(job.id)).digest("hex").slice(0, 8)}`;
}

// <prefix>-<worker> of either brand.
export const SESSION_RE = /^(or[ck]a-[0-9a-f]{8})-(.+)$/;

// The CLI script in a process argv: orka.mjs, or orca.mjs (the deprecated shim).
export const isCliScript = (arg) => /^or[ck]a\.mjs$/.test(basename(String(arg)));
export const CLI_COMMANDS = [NAME, LEGACY_NAME, `${NAME}.mjs`, `${LEGACY_NAME}.mjs`];
