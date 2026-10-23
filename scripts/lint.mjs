#!/usr/bin/env node
// Lint: every .mjs file parses (node --check), and no file has trailing whitespace or a tab indent.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const files = ["bin", "lib", "test", "scripts"].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".mjs")).map((f) => join(d, f)));
const problems = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", join(root, f)], { encoding: "utf8" });
  if (r.status !== 0) problems.push(`${f}: ${r.stderr.trim().split("\n").slice(0, 3).join(" ")}`);
  readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => {
    if (/[ \t]+$/.test(line)) problems.push(`${f}:${i + 1}: trailing whitespace`);
    if (/^\t/.test(line)) problems.push(`${f}:${i + 1}: tab indent`);
  });
}
for (const p of problems) console.error(p);
console.log(`lint: ${files.length} files, ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
