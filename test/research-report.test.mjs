import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = readFileSync(join(import.meta.dirname, "..", "bin", "orca.mjs"), "utf8");
const fn = (name) => {
  const start = src.indexOf(`function ${name}(`);
  return src.slice(start, src.indexOf("\n}\n", start));
};

test("RESEARCH_REPORT is one shared constant with the labelled-claims format", () => {
  assert.equal(src.split("const RESEARCH_REPORT =").length - 1, 1);
  const block = src.slice(src.indexOf("const RESEARCH_REPORT ="), src.indexOf("function workerPrompt("));
  assert.match(block, /Lead with the answer/);
  assert.match(block, /Observed or Guessed/);
  assert.match(block, /Verified: <cmd> -> <real output line>/);
  assert.match(block, /Verified: none/);
  assert.match(block, /Cut narration\. Stay compact/);
  assert.doesNotMatch(block, /\d+ lines|characters|chars|1200/i);
});

test("orchestratorPrompt references the block; workerPrompt does not", () => {
  assert.match(fn("orchestratorPrompt"), /\$\{RESEARCH_REPORT\}/);
  assert.doesNotMatch(fn("workerPrompt"), /RESEARCH_REPORT|Observed or Guessed/);
  assert.equal(src.split("Observed or Guessed").length - 1, 1);
});
