import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseSpec, specBlock, specIntake, specTemplate, SPEC_PROMPT_MAX } from "../lib/spec.mjs";
import { SAMPLE, specScratch } from "./spec-scratch.mjs";

test("spec init scaffolds specs/<feature>/spec.md and refuses to overwrite", () => {
  const t = specScratch();
  const r = t.orka(["spec", "init", "dark-mode"]);
  assert.equal(r.status, 0, r.stderr);
  const path = join(t.repo, "specs", "dark-mode", "spec.md");
  assert.ok(existsSync(path));
  const text = readFileSync(path, "utf8");
  for (const h of ["## What", "## Why", "## Limits", "## Done when"]) assert.ok(text.includes(h), h);
  assert.match(r.stdout, /orka new --spec specs\/dark-mode\/spec\.md/);
  const again = t.orka(["spec", "init", "dark-mode"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);
  assert.notEqual(t.orka(["spec", "init", "Bad Name"]).status, 0);
});

test("parseSpec reads title, stage, kind and sections, ignoring template comments", () => {
  const p = parseSpec(SAMPLE);
  assert.equal(p.title, "Dark mode");
  assert.equal(p.stage, "spec");
  assert.equal(p.kind, "feature");
  assert.match(p.sections["done when"], /survives a reload/);
  assert.deepEqual(Object.keys(parseSpec(specTemplate("x")).sections).filter((k) => parseSpec(specTemplate("x")).sections[k]), []);
});

test("specIntake and specBlock carry the spec; the block is capped", () => {
  const intake = specIntake(parseSpec(SAMPLE), "specs/dark-mode/spec.md", "abcdef1234567890");
  assert.match(intake, /specs\/dark-mode\/spec\.md \(committed at abcdef12\)/);
  assert.match(intake, /Done when:\n- The toggle/);
  const block = specBlock("x".repeat(SPEC_PROMPT_MAX + 50), "specs/a/spec.md");
  assert.match(block, /spec cut at/);
  assert.ok(block.length < SPEC_PROMPT_MAX + 300);
});

test("new --spec builds title and goal from a committed spec and records it on the job", () => {
  const t = specScratch();
  t.writeSpec("dark-mode", SAMPLE);
  const r = t.orka(["new", "--spec", "specs/dark-mode"]);
  assert.equal(r.status, 0, r.stderr);
  const job = t.read(r.stdout.trim());
  assert.equal(job.title, "Dark mode");
  assert.equal(job.spec.path, "specs/dark-mode/spec.md");
  assert.equal(job.spec.feature, "dark-mode");
  assert.equal(job.spec.commit, t.g("rev-parse", "HEAD"));
  assert.match(job.goal, /What:\nA toggle in the header/);
  assert.match(job.goal, /Done when:\n- The toggle flips/);
  assert.match(t.orka(["status", job.id]).stdout, /spec: specs\/dark-mode\/spec\.md @[0-9a-f]{8}/);
  const extra = t.orka(["new", "--spec", "specs/dark-mode/spec.md", "--title", "dm2", "--goal", "Only the header part."]);
  assert.equal(extra.status, 0, extra.stderr);
  assert.match(t.read(extra.stdout.trim()).goal, /^Only the header part\.\n\nBuild the feature specified/);
});

test("new --spec refuses an uncommitted, missing, outside or empty spec", () => {
  const t = specScratch();
  t.writeSpec("draft", SAMPLE, false);
  let r = t.orka(["new", "--spec", "specs/draft"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exists but is not committed/);
  r = t.orka(["new", "--spec", "specs/nope"]);
  assert.match(r.stderr, /not found at HEAD/);
  r = t.orka(["new", "--spec", "../elsewhere/spec.md"]);
  assert.match(r.stderr, /inside the repo/);
  t.writeSpec("empty", specTemplate("empty"));
  r = t.orka(["new", "--spec", "specs/empty"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"## What" or "## Done when"/);
});

test("the spec is pasted into the worker and verifier briefs; the orchestrator gets a pointer", () => {
  const t = specScratch();
  t.writeSpec("dark-mode", SAMPLE);
  const id = t.orka(["new", "--spec", "specs/dark-mode"]).stdout.trim();
  const run = t.orka(["run", id]);
  assert.equal(run.status, 0, run.stderr);
  const lead = t.calls();
  assert.match(lead, /This job has a spec: specs\/dark-mode\/spec\.md/);
  const job = t.read(id);
  // The worktree is real (git worktree add), so the spec there is the job branch copy.
  writeFileSync(join(job.worktree, "specs", "dark-mode", "spec.md"), `${SAMPLE}\n## Lessons\n- 2026-10-23 steer: keep the toggle small (job x)\n`);
  t.fresh();
  const w = t.orka(["worker", "--job", id, "--name", "builder", "--task", "GOAL: toggle\nSCOPE: header.js\nACCEPTANCE: flips"]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(t.calls(), /SPEC \(specs\/dark-mode\/spec\.md, the source of truth[^\n]*\n# Dark mode/);
  assert.match(t.calls(), /keep the toggle small/);
  t.fresh();
  const v = t.orka(["worker", "--job", id, "--name", "verifier", "--role", "verifier", "--task", "flips; survives reload"]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(t.calls(), /SPEC \(specs\/dark-mode\/spec\.md[^\n]*\n# Dark mode[\s\S]*The choice survives a reload/);
});

test("a job without a spec gets no SPEC block", () => {
  const t = specScratch();
  const id = t.orka(["new", "--title", "plain", "--goal", "do it"]).stdout.trim();
  assert.equal(t.orka(["run", id]).status, 0);
  assert.doesNotMatch(t.calls(), /This job has a spec/);
  t.fresh();
  t.orka(["worker", "--job", id, "--name", "builder", "--task", "GOAL: x\nSCOPE: a\nACCEPTANCE: b"]);
  assert.doesNotMatch(t.calls(), /SPEC \(/);
});
