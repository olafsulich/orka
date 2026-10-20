import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const src = readFileSync(join(root, "bin", "orka.mjs"), "utf8");
const start = src.indexOf("function verifierPrompt(");
const verifier = src.slice(start, src.indexOf("\n}\n", start));

test("verifier prompt reads the feature map first", () => {
  assert.match(verifier, /read \$\{featureMapFile\(job\.worktree\)\}/);
  assert.match(src, /const featureMapFile = \(dir\) => brand\.fileName\(dir, "features\.md"\)/);
  assert.ok(verifier.indexOf("read ${featureMapFile(job.worktree)}") < verifier.indexOf("Run these checks"));
});

test("verifier prompt updates touched entries on a pass", () => {
  assert.match(verifier, /On a pass, update the entries you touched/);
  assert.match(verifier, /last-verified date and HEAD commit/);
});

test("verifier prompt creates the map when missing", () => {
  assert.match(verifier, /is missing, that is fine: create it/);
});

test("verifier prompt has the staleness guard", () => {
  assert.match(verifier, /Staleness guard/);
  assert.match(verifier, /older than HEAD/);
  assert.match(verifier, /Every entry whose commit is older than HEAD/);
  assert.match(verifier, /re-proved by you before you rely on it or mark it verified, never trusted/);
  assert.match(verifier, /whether or not this job touched the feature/);
  assert.doesNotMatch(verifier, /could be touched by this job/);
});

test("sample map carries the per-feature fields", () => {
  const p = join(root, "examples", "orka.features.md");
  assert.ok(existsSync(p));
  const text = readFileSync(p, "utf8");
  for (const f of ["Reach:", "Drive:", "Prove:", "Last verified:", "commit"]) assert.ok(text.includes(f), f);
});
