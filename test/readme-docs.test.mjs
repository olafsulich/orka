import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const lines = readme.split("\n");

test("README stays short outside tables", () => {
  const prose = lines.filter((l) => !l.startsWith("|"));
  assert.ok(prose.length <= 120, `README has ${prose.length} non-table lines`);
});

test("README has exactly the two main sections", () => {
  const h2 = lines.filter((l) => l.startsWith("## "));
  assert.deepEqual(h2, ["## How orka works", "## What you can use"]);
});

test("README relative links and images resolve", () => {
  const targets = [...readme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const relative = targets.filter((t) => !/^[a-z]+:/i.test(t) && !t.startsWith("#"));
  assert.ok(relative.length > 0);
  for (const t of relative) {
    const file = t.split("#")[0];
    assert.ok(existsSync(join(root, file)), `missing ${t}`);
  }
  for (const png of ["orca-how-it-works.png", "orca-loop.png", "orca-context-injection.png"]) {
    assert.ok(readme.includes(`docs/${png}`), `README does not reference ${png}`);
  }
});

test("README has no task table or backlog", () => {
  assert.ok(!/\|\s*\[?\d{2}\]?\s*\(?[^|]*\.md/.test(readme), "task row found");
  assert.ok(!/^#+\s*(backlog|roadmap|tasks)\b/im.test(readme));
  assert.ok(!/\|\s*(todo|done)\s*\|/i.test(readme));
});

test("moved sections exist as docs files", () => {
  for (const f of ["verify", "verifier", "webhooks", "cleanup", "follow-up", "ports", "needs-input", "models", "layout", "commands", "diagrams"]) {
    assert.ok(existsSync(join(root, "docs", `${f}.md`)), `docs/${f}.md missing`);
  }
});
