#!/usr/bin/env node
// Render the README step diagrams with diagram-framework: node scripts/readme-diagrams.mjs [<step> ...]
// Each docs/img/readme/src/<step>/index.html is copied into <framework>/clips/orka-readme-<step>/ for the run,
// rendered as one still at its last frame, and the PNG lands at docs/img/readme/<step>.png. The copy is removed after.
// One step at a time: every render starts and closes its own browser.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "docs/img/readme/src");
const framework = process.env.DIAGRAM_FRAMEWORK || join(homedir(), "projects/diagram-framework");
if (!existsSync(join(framework, "tools/stills.mjs"))) {
  console.error(`readme-diagrams: no diagram-framework at ${framework} (set DIAGRAM_FRAMEWORK)`);
  process.exit(1);
}
const steps = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(src).sort();
for (const step of steps) {
  const html = join(src, step, "index.html");
  if (!existsSync(html)) {
    console.error(`readme-diagrams: missing ${html}`);
    process.exit(1);
  }
  const duration = Number(/duration:\s*([\d.]+)/.exec(readFileSync(html, "utf8"))?.[1]);
  if (!duration) {
    console.error(`readme-diagrams: ${step} has no duration in Clip.create`);
    process.exit(1);
  }
  const name = `orka-readme-${step}`;
  const clipDir = join(framework, "clips", name);
  const outDir = join(framework, "out", name);
  const at = (duration - 0.05).toFixed(2);
  mkdirSync(clipDir, { recursive: true });
  copyFileSync(html, join(clipDir, "index.html"));
  try {
    const r = spawnSync(process.execPath, ["tools/stills.mjs", name, "--at", at], { cwd: framework, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`stills exited ${r.status}`);
    copyFileSync(join(outDir, `t-${at}.png`), join(root, "docs/img/readme", `${step}.png`));
    console.log(`readme-diagrams: docs/img/readme/${step}.png`);
  } finally {
    rmSync(clipDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}
