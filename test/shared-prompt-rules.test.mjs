import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as brand from "../lib/brand.mjs";

const src = readFileSync(join(import.meta.dirname, "..", "bin", "orka.mjs"), "utf8");
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
  assert.ok(orch.indexOf("SUMMARY_FROM_DIFF(job)") < orch.indexOf("Before orka done, run orka digest"));
  assert.doesNotMatch(fn("workerPrompt"), /SUMMARY_FROM_DIFF/);
  assert.doesNotMatch(fn("verifierPrompt"), /SUMMARY_FROM_DIFF/);
});

test("orchestrator summary line follows the diff rule and a job without baseCommit renders no undefined", () => {
  assert.doesNotMatch(fn("orchestratorPrompt"), /what you already know/);
  assert.match(fn("orchestratorPrompt"), /set the summary field\. Do not load the job JSON into the turn to copy fields/);
  const line = src.split("\n").find((l) => l.startsWith("const SUMMARY_FROM_DIFF"));
  const render = (job) => new Function("job", "brand", `return (${line.slice(line.indexOf("=") + 1).replace(/;\s*$/, "")})(job);`)(job, brand);
  assert.doesNotMatch(render({ id: "j0" }), /undefined/);
  const noBase = render({ id: "j1", branch: "orka/j1-x" });
  assert.match(noBase, /git diff \$\(git merge-base orka\/j1-x main\)/);
  assert.doesNotMatch(noBase, /<branch>|undefined/);
  // A record without a branch predates orka, so it is on orca/<id>.
  assert.match(render({ id: "j2" }), /git diff \$\(git merge-base orca\/j2 main\)/);
  assert.match(render({ baseCommit: "abc123" }), /git diff abc123 \(--stat plus a skim\)/);
});
