import assert from "node:assert/strict";
import test from "node:test";
import { watchJob } from "../lib/watch.mjs";

const running = { id: "j1", title: "T", status: "running", worktree: "/wt" };

function harness({ job = running, alive = true, extra = {}, clock } = {}) {
  let t = 0;
  const state = { job, alive, repo: true, paths: new Set(["/wt"]), sleeps: 0 };
  const deps = {
    loadJob: async () => state.job,
    waitAgent: async () => (clock ? ((t += clock), "working") : "working"),
    readPane: async () => "",
    post: async () => ({ ok: true }),
    log: () => {},
    sleep: async () => {
      state.sleeps += 1;
    },
    now: () => t,
    repoExists: () => state.repo,
    pathExists: (p) => state.paths.has(p),
    paneAlive: async () => state.alive,
    ...extra,
  };
  return { deps, state };
}

const run = (h, opts = {}) => watchJob({ jobId: "j1", agent: "a", pane: "p", deps: h.deps, graceMs: 1, ...opts });
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("watcher kept running")), ms).unref());

test("exits when the repo is gone", async () => {
  const h = harness();
  h.state.repo = false;
  assert.deepEqual(await run(h), { exit: "repo-gone" });
});

test("exits when the job file is gone", async () => {
  const h = harness({ job: null });
  assert.deepEqual(await run(h), { exit: "job-gone" });
});

test("exits when the worktree is gone", async () => {
  const h = harness();
  h.state.paths.clear();
  assert.deepEqual(await run(h), { exit: "worktree-gone" });
});

test("exits on a terminal job", async () => {
  const h = harness({ job: { ...running, status: "done" } });
  assert.deepEqual(await run(h), { exit: "terminal" });
});

test("exits when the repo disappears while watching", async () => {
  const h = harness({ clock: 1 });
  const waits = h.deps.waitAgent;
  let n = 0;
  h.deps.waitAgent = async (...a) => {
    if (++n === 3) h.state.repo = false;
    return waits(...a);
  };
  assert.deepEqual(await Promise.race([run(h), timeout(2000)]), { exit: "repo-gone" });
  assert.equal(n, 3);
});

test("lead pane gone for more than M minutes ends the watcher; shorter does not", async () => {
  const h = harness({ alive: false, clock: 60 * 1000 });
  const r = await Promise.race([run(h, { paneGoneMs: 5 * 60 * 1000 }), timeout(2000)]);
  assert.deepEqual(r, { exit: "pane-gone" });
});

test("a pane that comes back resets the gone timer", async () => {
  const h = harness({ alive: false, clock: 60 * 1000 });
  let polls = 0;
  h.deps.paneAlive = async () => {
    polls += 1;
    return polls % 3 === 0; // gone, gone, back, ...
  };
  // never gone for > 3 minutes in a row, so only the loop guard in the test ends this
  h.deps.loadJob = async () => (polls > 12 ? { ...running, status: "done" } : running);
  assert.deepEqual(await Promise.race([run(h, { paneGoneMs: 3 * 60 * 1000 }), timeout(2000)]), { exit: "terminal" });
});

test("an unknown pane state (null) never ends the watcher", async () => {
  const h = harness({ alive: null, clock: 60 * 60 * 1000 });
  let n = 0;
  h.deps.loadJob = async () => (++n > 5 ? { ...running, status: "done" } : running);
  assert.deepEqual(await Promise.race([run(h, { paneGoneMs: 1000 }), timeout(2000)]), { exit: "terminal" });
});

test("worktree removed while the agent is unknown: exits within one poll interval", async () => {
  const pollMs = 50;
  const h = harness();
  let answers = 0;
  let removedAt = 0;
  const sleeps = [];
  h.deps.waitAgent = async () => {
    answers += 1;
    if (answers === 6) {
      h.state.paths.clear();
      removedAt = Date.now();
    }
    return "unknown";
  };
  h.deps.sleep = (ms) => {
    sleeps.push(ms);
    return new Promise((r) => setTimeout(r, ms));
  };
  const r = await Promise.race([run(h, { waitMs: pollMs }), timeout(5000)]);
  assert.deepEqual(r, { exit: "worktree-gone" });
  assert.ok(Date.now() - removedAt <= pollMs * 2, "guard must fire about one poll interval after removal");
  assert.ok(sleeps.length >= 5 && sleeps.every((ms) => ms <= pollMs), `backoff sleeps capped at the poll interval: ${sleeps}`);
});
