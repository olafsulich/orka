import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = readFileSync(join(import.meta.dirname, "..", "bin", "orca.mjs"), "utf8");
const fn = (name) => {
  const start = src.indexOf(`function ${name}(`);
  return src.slice(start, src.indexOf("\n}\n", start));
};
const count = (text, needle) => text.split(needle).length - 1;

test("each shared rule literal exists once in the source", () => {
  assert.equal(count(src, "Reversible work never waits on a human. Irreversible actions (push, delete outside the worktree, external sends, purchases) stop and ask."), 1);
  assert.equal(count(src, "Never close panes (yours or anyone's, no herdr pane close)"), 1);
  assert.equal(count(src, "write summary.txt from the diff, not from the workers' claims"), 1);
});

test("reversible rule comes through portPromptLines, used by all three prompts", () => {
  assert.equal(count(fn("portPromptLines"), "REVERSIBLE_RULE"), 1);
  for (const name of ["workerPrompt", "verifierPrompt", "orchestratorPrompt"]) {
    assert.equal(count(fn(name), "...portPromptLines(job)"), 1, name);
    assert.equal(count(fn(name), "REVERSIBLE_RULE"), 0, name);
  }
});

test("never-close-panes constant is used once in each of the three prompts", () => {
  for (const name of ["workerPrompt", "verifierPrompt", "orchestratorPrompt"]) {
    assert.equal(count(fn(name), "NEVER_CLOSE_PANES"), 1, name);
  }
});

test("only the orchestrator gets the diff-based summary rule, before the digest line", () => {
  const orch = fn("orchestratorPrompt");
  assert.equal(count(orch, "SUMMARY_FROM_DIFF(job)"), 1);
  assert.ok(orch.indexOf("SUMMARY_FROM_DIFF(job)") < orch.indexOf("Before orca done, run orca digest"));
  assert.match(src, /git diff \$\{job\.baseCommit\} \(--stat plus a skim\)/);
  assert.doesNotMatch(fn("workerPrompt"), /SUMMARY_FROM_DIFF/);
  assert.doesNotMatch(fn("verifierPrompt"), /SUMMARY_FROM_DIFF/);
});
