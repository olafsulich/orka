import assert from "node:assert/strict";
import test from "node:test";
import { episodeKey, extractQuestion, needsInputPayload, watchJob } from "../lib/watch.mjs";

const PANE = [
  "\x1b[2m● Bash(lsof -i :5199)\x1b[0m",
  "  ⎿  node 4242",
  "",
  "╭──────────────────────────────────────────────╮",
  "│ \x1b[1mPort 5199 is held by another job's server. Kill it?\x1b[0m │",
  "│                                              │",
  "│ \x1b[36m❯ 1. Yes\x1b[0m                                     │",
  "│   2. No                                      │",
  "╰──────────────────────────────────────────────╯",
  "",
  "────────────────────────────────────────────────",
  "",
].join("\n");

test("payload shape is exact", () => {
  const p = needsInputPayload({ job: { id: "j1", title: "T" }, status: "blocked", paneText: PANE, pane: "p1" });
  assert.deepEqual(Object.keys(p), ["kind", "job", "title", "status", "question", "pane"]);
  assert.equal(p.kind, "needs-input");
  assert.equal(p.status, "blocked");
  assert.equal(p.pane, "p1");
});

test("extractQuestion keeps question and options, drops ANSI and boxes", () => {
  const q = extractQuestion(PANE);
  assert.ok(q.includes("Port 5199 is held by another job's server. Kill it?"));
  assert.ok(q.includes("❯ 1. Yes"));
  assert.ok(q.includes("2. No"));
  assert.ok(!q.includes("\x1b"));
  assert.ok(!q.includes("lsof"));
  assert.equal(extractQuestion("x".repeat(50) + "END", 10).length, 10);
  assert.ok(extractQuestion("x".repeat(50) + "END", 10).endsWith("END"));
});

test("episodeKey is short and stable", () => {
  assert.equal(episodeKey("blocked", "a"), episodeKey("blocked", "a"));
  assert.notEqual(episodeKey("blocked", "a"), episodeKey("idle", "a"));
  assert.equal(episodeKey("blocked", "a").length, 16);
});

function harness({ statuses, panes = [PANE], jobs }) {
  const posts = [];
  let ji = 0;
  let pi = 0;
  const deps = {
    loadJob: async () => jobs[Math.min(ji++, jobs.length - 1)],
    waitAgent: async () => statuses.shift() ?? "unknown",
    readPane: async () => panes[Math.min(pi++, panes.length - 1)],
    post: async (p) => (posts.push(p), { ok: true }),
    log: () => {},
    now: () => 0,
  };
  return { deps, posts };
}
const running = { id: "j1", title: "T", status: "running" };
const done = { id: "j1", title: "T", status: "done" };
const run = (h) => watchJob({ jobId: "j1", agent: "a", pane: "p", deps: h.deps, graceMs: 1 });

test("fires once per blocked episode, again after working with a new question", async () => {
  const h = harness({
    statuses: ["blocked", "blocked", "working", "blocked", "unknown", "unknown", "unknown"],
    panes: [PANE, PANE.replace("Kill it?", "Wipe it?")],
    jobs: [running],
  });
  const r = await run(h);
  assert.equal(r.exit, "agent-gone");
  assert.equal(h.posts.length, 2);
  assert.ok(h.posts[1].question.includes("Wipe it?"));
});

test("idle without done fires once", async () => {
  const h = harness({ statuses: ["idle", "idle", "idle", "unknown", "unknown", "unknown"], panes: ["all done?\n1. a"], jobs: [running] });
  await run(h);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].status, "idle");
});

test("idle then resume does not post", async () => {
  const h = harness({ statuses: ["idle", "working", "unknown", "unknown", "unknown"], jobs: [running] });
  await run(h);
  assert.equal(h.posts.length, 0);
});

test("exits when job becomes done", async () => {
  const h = harness({ statuses: ["blocked", "working", "blocked"], jobs: [running, running, running, done] });
  const r = await run(h);
  assert.equal(r.exit, "terminal");
  assert.equal(h.posts.length, 1);
});

test("never posts for a terminal job", async () => {
  const h = harness({ statuses: ["blocked"], jobs: [done] });
  const r = await run(h);
  assert.equal(r.exit, "terminal");
  assert.equal(h.posts.length, 0);
});
