import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LESSONS_MAX_LINES, collectLessons, mergeLessons } from "../lib/spec.mjs";
import { SAMPLE, specScratch } from "./spec-scratch.mjs";

// A spec'd job, run with the fake herdr so its worktree and branch are real, then given a decision
// log, a steer and two verifier rounds (round 1 failed "toggle", round 2 passed with a pre-existing warning).
function spedJob() {
  const t = specScratch("orka-lessons-");
  t.writeSpec("dark-mode", SAMPLE);
  const id = t.orka(["new", "--spec", "specs/dark-mode"]).stdout.trim();
  assert.equal(t.orka(["run", id]).status, 0);
  t.orka(["strategy", id, "--premise", "css only is enough", "toggle the class from js"]);
  t.orka(["log", id, "routing", "rejected a full header rewrite", "too broad for the spec", "-", "-"]);
  t.orka(["log", id, "split", "two builders", "files differ", "-", "-"]);
  const job = t.read(id);
  job.steers = [{ at: "2026-10-23T10:00:00Z", message: "keep the toggle 24px" }, { at: "x", message: "never delivered", delivery: "failed" }];
  job.verifier = { ...job.verifier, rounds: 2, verdict: null, history: [{ round: 1, verdict: "fail", failing: ["toggle"], warnings: [] }] };
  t.write(id, job);
  const results = join(t.repo, ".orka", "jobs", id, "results");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "verifier.round-1.json"), JSON.stringify({ round: 1, verdict: "fail", failures: [{ check: "toggle", evidence: "html has no data-theme after click" }] }));
  writeFileSync(join(results, "verifier.json"), JSON.stringify({ round: 2, verdict: "pass", failures: [], warnings: [{ check: "lint", evidence: "old warning", base: "abc", proof: "fails on base" }] }));
  const branchSpec = () => t.g("-C", job.worktree, "show", `${job.branch}:specs/dark-mode/spec.md`);
  return { ...t, id, job, branchSpec };
}

test("orka done appends lessons to the spec and commits it on the job branch, not main", () => {
  const t = spedJob();
  const mainBefore = t.g("rev-parse", "main");
  const r = t.orka(["done", t.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lessons: 5 added, 0 seen again in specs\/dark-mode\/spec\.md, committed [0-9a-f]+ on orka\//);
  const spec = t.branchSpec();
  assert.match(spec, /## Lessons\n\n- \d{4}-\d\d-\d\d rejected: premise "css only is enough"; changed to: toggle the class from js \(job /);
  assert.match(spec, /rejected: rejected a full header rewrite \(too broad for the spec\)/);
  assert.match(spec, /steer: keep the toggle 24px/);
  assert.doesNotMatch(spec, /never delivered|two builders/);
  assert.match(spec, /check: toggle failed in round 1 before passing: html has no data-theme after click/);
  assert.match(spec, /flaky: lint fails on the base commit too/);
  assert.equal(t.g("rev-parse", "main"), mainBefore, "main must not move");
  assert.doesNotMatch(t.g("show", "main:specs/dark-mode/spec.md"), /## Lessons/);
  assert.match(t.g("-C", t.job.worktree, "log", "-1", "--format=%s"), /^Spec lessons: dark-mode \(job /);
  assert.deepEqual(t.g("-C", t.job.worktree, "show", "--name-only", "--format=", "HEAD").split("\n"), ["specs/dark-mode/spec.md"]);
  const job = t.read(t.id);
  assert.equal(job.status, "done");
  assert.equal(job.lessons.added, 5);
  assert.match(t.orka(["status", t.id]).stdout, /lessons: 5 added, 0 seen again \(commit [0-9a-f]+\)/);
  assert.match(readFileSync(join(t.repo, ".orka", "jobs", t.id, "decisions.tsv"), "utf8"), /\tlessons\t5 added/);
});

test("a follow-up round's done adds only new lessons and is not refused as stale by the lessons commit", () => {
  const t = spedJob();
  assert.equal(t.orka(["done", t.id]).status, 0);
  t.ready(t.read(t.id).agent);
  const steer = t.orka(["steer", t.id, "make the icon a moon"]);
  assert.equal(steer.status, 0, steer.stderr);
  const again = t.orka(["done", t.id]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /^done /m);
  assert.match(again.stdout, /lessons: 1 added, 0 seen again/);
  const spec = t.branchSpec();
  assert.equal(spec.match(/steer: keep the toggle 24px/g).length, 1);
  assert.match(spec, /steer: make the icon a moon/);
  t.ready(t.read(t.id).agent);
  assert.equal(t.orka(["steer", t.id, "nothing new"]).status, 0);
  const job = t.read(t.id);
  job.steers = job.steers.slice(0, -1);
  t.write(t.id, job);
  assert.match(t.orka(["done", t.id]).stdout, /lessons: \d+ already in specs\/dark-mode\/spec\.md/);
});

test("done --dry-run previews lessons and writes nothing", () => {
  const t = spedJob();
  const r = t.orka(["done", t.id, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lessons: would update specs\/dark-mode\/spec\.md on orka\/[^:]+: 5 added/);
  assert.doesNotMatch(t.branchSpec(), /## Lessons/);
});

test("lessons are skipped when the worktree is not on the job branch", () => {
  const t = spedJob();
  t.g("-C", t.job.worktree, "checkout", "-q", "--detach");
  const r = t.orka(["done", t.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lessons: skipped \(worktree is on HEAD, not orka\//);
  assert.doesNotMatch(readFileSync(join(t.job.worktree, "specs", "dark-mode", "spec.md"), "utf8"), /## Lessons/);
});

test("a job without a spec prints no lessons line", () => {
  const t = specScratch("orka-lessons-");
  const id = t.orka(["new", "--title", "plain", "--goal", "g"]).stdout.trim();
  t.orka(["run", id]);
  t.orka(["strategy", id, "something"]);
  const r = t.orka(["done", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /lessons:/);
});

test("mergeLessons dedupes, counts repeats from other jobs, and folds lines over the cap", () => {
  const spec = "# F\n\n## What\nx\n\n## Done when\n- y\n";
  const one = mergeLessons(spec, [{ kind: "steer", text: "Keep it small." }], { date: "2026-10-01", jobId: "a" });
  assert.equal(one.added, 1);
  assert.equal(mergeLessons(one.text, [{ kind: "steer", text: "keep it small" }], { date: "2026-10-02", jobId: "a" }).added, 0);
  const two = mergeLessons(one.text, [{ kind: "steer", text: "keep it  small!" }], { date: "2026-10-02", jobId: "b" });
  assert.equal(two.bumped, 1);
  assert.match(two.text, /- 2026-10-02 steer: Keep it small\. \(job b\) x2/);
  let text = two.text;
  for (let i = 0; i < LESSONS_MAX_LINES + 5; i++) text = mergeLessons(text, [{ kind: "check", text: `check-${i} failed` }], { date: `2026-10-${String(3 + (i % 20)).padStart(2, "0")}`, jobId: `j${i}` }).text;
  const lines = text.split("## Lessons")[1].split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, LESSONS_MAX_LINES);
  assert.match(lines[0], /compressed: \d+ older lessons folded; full text in the git history/);
  assert.ok(text.includes("steer: Keep it small. (job b) x2"), "the repeated lesson survives compression");
  assert.ok(text.includes(`check-${LESSONS_MAX_LINES + 4} failed`), "the newest lesson survives");
  assert.match(text, /^# F\n\n## What\nx\n\n## Done when\n- y\n\n## Lessons\n/);
});

test("mergeLessons keeps sections after Lessons in place", () => {
  const spec = "# F\n\n## Lessons\n\n- 2026-10-01 steer: a (job x)\n\n## Commits\n- abc\n";
  const r = mergeLessons(spec, [{ kind: "steer", text: "b" }], { date: "2026-10-02", jobId: "y" });
  assert.match(r.text, /- 2026-10-01 steer: a \(job x\)\n- 2026-10-02 steer: b \(job y\)\n\n## Commits\n- abc\n$/);
});

test("collectLessons reads a give-up reason and a check still failing at the end", () => {
  const job = { verifier: { history: [{ round: 1, failing: ["build"] }], stopReason: "needs a secret" } };
  const got = collectLessons({ job, rows: [] });
  assert.deepEqual(got.map((l) => l.kind), ["check", "gave-up"]);
  assert.match(got[0].text, /build still failing at the end/);
});
