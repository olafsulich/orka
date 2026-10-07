import assert from "node:assert/strict";
import test from "node:test";
import { HOUSEKEEPING_POPUPS, episodeKey, extractQuestion, matchHousekeeping, needsInputPayload, watchJob } from "../lib/watch.mjs";

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

const TEACH_POPUP = [
  "\x1b[2m● Bash(npm test)\x1b[0m",
  "",
  "╭──────────────────────────────────────────────────╮",
  "│ \x1b[1mTeach auto mode about your environment?\x1b[0m        │",
  "│                                                  │",
  "│ \x1b[36m❯ 1. Yes\x1b[0m                                       │",
  "│   2. Not now                                     │",
  "│   3. Don't show again                            │",
  "╰──────────────────────────────────────────────────╯",
].join("\n");

const SURVEY_POPUP = [
  "● Done. Tests pass.",
  "",
  "● How is Claude doing this session? (optional)",
  "  1: Bad    2: Fine   3: Good   0: Dismiss",
].join("\n");

const TASK_QUESTION = [
  "╭──────────────────────────────────────────────────╮",
  "│ Which database should we use?                    │",
  "│                                                  │",
  "│ ❯ 1. Postgres                                    │",
  "│   2. SQLite                                      │",
  "│   3. Other                                       │",
  "╰──────────────────────────────────────────────────╯",
].join("\n");

function housekeepingHarness(pane, statuses = ["blocked", "working", "unknown", "unknown", "unknown"]) {
  const h = harness({ statuses, panes: [pane], jobs: [running] });
  const sent = [];
  const logs = [];
  h.deps.sendKeys = async (agent, keys) => void sent.push({ agent, keys });
  h.deps.log = (l) => logs.push(l);
  return { ...h, sent, logs };
}

test("Teach auto mode popup is dismissed with Don't show again, no alert", async () => {
  const h = housekeepingHarness(TEACH_POPUP);
  await run(h);
  assert.deepEqual(h.sent, [{ agent: "a", keys: ["down", "down", "enter"] }]);
  assert.deepEqual(h.logs, ["housekeeping-dismissed j1 teach-auto-mode"]);
  assert.equal(h.posts.length, 0);
});

test("feedback survey popup is dismissed, no alert", async () => {
  const h = housekeepingHarness(SURVEY_POPUP, ["idle", "idle", "working", "unknown", "unknown", "unknown"]);
  await run(h);
  assert.deepEqual(h.sent, [{ agent: "a", keys: ["0"] }]);
  assert.deepEqual(h.logs, ["housekeeping-dismissed j1 session-feedback"]);
  assert.equal(h.posts.length, 0);
});

test("real task question alerts and sends no keys", async () => {
  const h = housekeepingHarness(TASK_QUESTION, ["blocked", "working", "unknown", "unknown", "unknown"]);
  await run(h);
  assert.equal(h.sent.length, 0);
  assert.equal(h.posts.length, 1);
  assert.ok(h.posts[0].question.includes("Which database should we use?"));
  assert.equal(matchHousekeeping(TASK_QUESTION), null);
});

test("a popup that will not go away alerts after repeated dismissals", async () => {
  const h = housekeepingHarness(TEACH_POPUP, ["blocked", "blocked", "blocked", "blocked", "unknown", "unknown", "unknown"]);
  await run(h);
  assert.equal(h.sent.length, 3);
  assert.equal(h.posts.length, 1);
});

test("HOUSEKEEPING_POPUPS entries have name, match and keys", () => {
  for (const p of HOUSEKEEPING_POPUPS) {
    assert.ok(p.name && p.match instanceof RegExp && p.keys.length > 0);
  }
});
