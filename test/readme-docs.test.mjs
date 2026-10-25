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

test("README sections: install, quickstart, how it works, commands", () => {
  const h2 = lines.filter((l) => l.startsWith("## "));
  assert.deepEqual(h2, ["## Install", "## Quickstart", "## How it works", "## Commands and config"]);
});

test("How it works: eight numbered steps, each with its diagram and a docs link", () => {
  const steps = readme.split(/^### /m).slice(1);
  assert.equal(steps.length, 8);
  steps.forEach((step, i) => {
    assert.ok(step.startsWith(`${i + 1}. `), `step ${i + 1} heading: ${step.split("\n")[0]}`);
    assert.match(step, new RegExp(`!\\[[^\\]]+\\]\\(docs/img/readme/${i + 1}-[a-z]+\\.png\\)`), `step ${i + 1} has no diagram`);
    assert.match(step, /^Docs: \[[a-z-]+\.md\]\(docs\//m, `step ${i + 1} has no docs link`);
  });
});

test("every README diagram has its source", () => {
  for (const [, png] of readme.matchAll(/\(docs\/img\/readme\/([\w-]+)\.png\)/g)) {
    assert.ok(existsSync(join(root, "docs/img/readme/src", png, "index.html")), `no source for ${png}`);
  }
});

test("README footer credits limen and pstack", () => {
  assert.match(readme, /Inspired by \[limen\]\(https:\/\/github\.com\/overment\/limen\) and \[pstack\]\(https:\/\/github\.com\/cursor\/plugins\/tree\/main\/pstack\)/);
});

test("README relative links and images resolve", () => {
  const targets = [...readme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const relative = targets.filter((t) => !/^[a-z]+:/i.test(t) && !t.startsWith("#"));
  assert.ok(relative.length > 0);
  for (const t of relative) {
    const file = t.split("#")[0];
    assert.ok(existsSync(join(root, file)), `missing ${t}`);
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
