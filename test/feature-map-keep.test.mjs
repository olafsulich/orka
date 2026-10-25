import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KEEP_MAX, entryFields, findEntry, keepFromResult, keepItems, mergeKeep, parseMap, pruneStale, renderMap } from "../lib/featuremap.mjs";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// The two map shapes in use (motion-lab: preamble, code spans, "Prove (...)" labels;
// diagram-framework: short head, an entry without Reach), no Keep in mind field.
const MOTION = `# Feature map

Cross-job memory for orka verifiers. Read it first; on a pass, update the entries you touched.

## Static gate: lint (oxlint)
- Reach: \`npm run lint\` (runs \`scripts/static.sh lint\`)
- Drive: run from the worktree root; no browser, no render
- Prove: exit code 0 on current code
- Last verified: 2026-10-23 at commit \`7f730bd\` (verifier round 1, job 20261023132211627-oxc-lint-format)

## Renames: check:render and lint:motion
- Reach: \`npm run check:render -- <clip>\`
- Drive: NOT executed by the verifier (light-job rule: no renders)
- Prove (next verifier with render rights): \`check:render\` renders twice and exits 0
- Last verified: not executed; definition checked by reading \`package.json\` at \`7f730bd\`
`;
const DIAGRAM = `# Features

## orka-inside clip (stills)
- Reach: \`npm run stills -- orka-inside --at <t> [--skin light]\`
- Drive: \`npm run stills -- orka-inside --check\` (determinism)
- Prove: open the PNGs
- Last verified: 2026-10-23 at 2772c22 (r4 clarity, round 1).

## Studio verify file (orca.verify.json)
- Needs a studio server on port 5199. Fails with ERR_CONNECTION_REFUSED when nothing listens.
- Last verified: not proven (server absent) at 2772c22.`;

test("an old-format map parses unchanged: round-trip is byte for byte, fields read, Keep in mind empty", () => {
  for (const text of [MOTION, DIAGRAM, readFileSync(join(import.meta.dirname, "..", "examples", "orka.features.md"), "utf8")]) {
    assert.equal(renderMap(parseMap(text)), text);
    assert.equal(pruneStale(text, "20261025000000000-x").text, text, "no Stale line, nothing to do");
    assert.equal(mergeKeep(text, []).text, text);
  }
  const m = parseMap(MOTION);
  assert.deepEqual(m.entries.map((e) => e.name), ["Static gate: lint (oxlint)", "Renames: check:render and lint:motion"]);
  const f = entryFields(m.entries[0]);
  assert.equal(f.reach, "`npm run lint` (runs `scripts/static.sh lint`)");
  assert.match(f["last verified"], /7f730bd/);
  assert.deepEqual(f["keep in mind"], []);
  assert.equal(entryFields(parseMap(DIAGRAM).entries[1]).reach, undefined, "a missing field is fine");
});

test("keepInMind merge: per feature, deduped, capped at the newest 5, unknown feature gets an entry, other entries untouched", () => {
  const notes = keepFromResult({ "static gate: LINT (oxlint)": ["oxlint needs node 22", "  oxlint   needs Node 22. "], "Brand new": "watch the port" });
  assert.deepEqual(notes.map((n) => n.feature), ["static gate: LINT (oxlint)", "static gate: LINT (oxlint)", "Brand new"]);
  const got = mergeKeep(MOTION, notes);
  assert.deepEqual(got.added, [{ feature: "Static gate: lint (oxlint)", note: "oxlint needs node 22" }, { feature: "Brand new", note: "watch the port" }]);
  assert.deepEqual(got.created, ["Brand new"]);
  const m = parseMap(got.text);
  const lint = findEntry(m, "Static gate: lint (oxlint)");
  assert.deepEqual(lint.lines.slice(-4), ["- Last verified: 2026-10-23 at commit `7f730bd` (verifier round 1, job 20261023132211627-oxc-lint-format)", "- Keep in mind:", "  - oxlint needs node 22", ""]);
  assert.deepEqual(m.entries[1].lines, parseMap(MOTION).entries[1].lines.slice(0, -1).concat([""]), "the renames entry keeps its lines");
  assert.match(got.text, /\n\n## Brand new\n- Keep in mind:\n  - watch the port\n$/);
  assert.equal(mergeKeep(got.text, notes).text, got.text, "merging the same notes again changes nothing");

  let text = got.text;
  for (let i = 1; i <= 7; i++) text = mergeKeep(text, keepFromResult([{ feature: "Brand new", note: `n${i}` }])).text;
  assert.deepEqual(keepItems(findEntry(parseMap(text), "Brand new")), ["n3", "n4", "n5", "n6", "n7"]);
  assert.equal(keepItems(findEntry(parseMap(text), "Brand new")).length, KEEP_MAX);
  const plain = mergeKeep(DIAGRAM, keepFromResult(["no feature named", 7, null, ""]));
  assert.deepEqual(plain.added, [{ feature: "General", note: "no feature named" }]);
  assert.match(plain.text, /at 2772c22\.\n\n## General\n- Keep in mind:\n  - no feature named\n$/);
  assert.deepEqual(keepFromResult("not a list"), []);
});

test("an inline Keep in mind and bold labels are read and rewritten as one block", () => {
  const text = "# M\n\n## A\n- **Reach:** `x`\n- Keep in mind: first\n  - second\n\n## B\n- Reach: y\n";
  const m = parseMap(text);
  assert.equal(entryFields(m.entries[0]).reach, "`x`");
  assert.deepEqual(keepItems(m.entries[0]), ["first", "second"]);
  const got = mergeKeep(text, [{ feature: "a", note: "third" }]);
  assert.equal(got.text, "# M\n\n## A\n- **Reach:** `x`\n- Keep in mind:\n  - first\n  - second\n  - third\n\n## B\n- Reach: y\n");
});

test("stale: the marking job keeps it, one later job carries it, the second later job drops it", () => {
  const A = "20261025100000000-mark";
  const B = "20261025110000000-next";
  const C = "20261025120000000-third";
  const text = MOTION.replace("- Prove: exit code 0 on current code\n", `- Prove: exit code 0 on current code\n- Stale: marked by ${A}\n`);
  const a = pruneStale(text, A);
  assert.deepEqual([a.carried, a.dropped], [["Static gate: lint (oxlint)"], []]);
  assert.match(a.text, new RegExp(`- Stale: reach fails on HEAD and on base; marked by ${A}; jobs since: none\n`));
  assert.equal(pruneStale(a.text, A).text, a.text, "a second verifier round of the same job changes nothing");
  const b = pruneStale(a.text, B);
  assert.match(b.text, new RegExp(`marked by ${A}; jobs since: ${B}\n`));
  assert.equal(pruneStale(b.text, B).text, b.text);
  const c = pruneStale(b.text, C);
  assert.deepEqual([c.carried, c.dropped], [[], ["Static gate: lint (oxlint)"]]);
  assert.equal(c.text, MOTION.replace(/## Static gate[\s\S]*?\n\n(?=## Renames)/, ""), "the entry is gone, the rest is byte for byte");
  const bare = pruneStale(DIAGRAM.replace("- Prove: open the PNGs", "- Prove: open the PNGs\n- Stale: yes"), B);
  assert.match(bare.text, new RegExp(`marked by ${B}; jobs since: none`), "no job id on the line: this job marked it");
});

// Fake herdr: every agent idle with a pane, prompts recorded. One job with a worktree that holds the map.
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "orka-fmap-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const st = join(base, "state");
  for (const d of [repo, bin, join(base, "home"), join(base, "run"), st]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
S="${st}"
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[]}}';;
  "agent prompt") printf '%s\\n-----\\n' "$4" >> "$S/prompts-$3"; echo working > "$S/status-$3"; echo '{"result":{}}';;
  "agent get") echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$(cat "$S/status-$3" 2>/dev/null || echo idle)\\",\\"interactive_ready\\":true,\\"pane_id\\":\\"p-$3\\"}}}";;
  "pane read") printf '╭────╮\\n│ ❯ │\\n╰────╯\\n';;
  *) echo '{}';;
esac
`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_PROMPT_POLL_MS: "10", ORKA_PROMPT_WAIT_MS: "300", ORKA_READY_WAIT_MS: "1500" };
  delete env.ORKA_JOB;
  delete env.ORCA_JOB;
  const orka = (args) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", repo], { encoding: "utf8", env });
  orka(["init"]);
  const id = orka(["new", "--kind", "pi", "--title", "w", "--goal", "g", "--no-gate"]).stdout.trim();
  const path = join(repo, ".orka", "jobs", `${id}.json`);
  const dir = join(repo, ".orka", "jobs", id);
  const wt = join(base, "wt");
  mkdirSync(join(dir, "results"), { recursive: true });
  mkdirSync(wt);
  const job = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(job, { status: "running", pane: "p-orch", agent: "orch", sessionId: "lead-1", worktree: wt, workers: [] });
  const worker = (name, role, body) => {
    const result = join(dir, "results", `${name}.json`);
    writeFileSync(result, JSON.stringify(body));
    job.workers.push({ name, role, pane: `p-${name}`, kind: "pi", sessionId: `s-${name}`, startedAt: new Date().toISOString(), result });
    writeFileSync(path, JSON.stringify(job));
  };
  const prompts = () => (existsSync(join(st, "prompts-orch")) ? readFileSync(join(st, "prompts-orch"), "utf8") : "").split("-----\n").filter((p) => p.trim());
  return { id, dir, wt, orka, worker, prompts, map: join(wt, "orka.features.md"), read: () => JSON.parse(readFileSync(path, "utf8")) };
}

test("orka merges a builder's keepInMind into the map at its wake, once; the verifier result prunes stale entries", () => {
  const t = scratch();
  writeFileSync(t.map, DIAGRAM);
  t.worker("builder", "builder", { worker: "builder", ok: true, result: "did it", keepInMind: { "orka-inside clip (stills)": ["stills need fonts installed first"] } });
  const out = t.orka(["wake", t.id]);
  assert.equal(out.status, 0, out.stderr);
  const map = readFileSync(t.map, "utf8");
  assert.match(map, /at 2772c22 \(r4 clarity, round 1\)\.\n- Keep in mind:\n  - stills need fonts installed first\n\n## Studio verify file/);
  assert.match(t.prompts()[0], /\nfeature map: 1 keep-in-mind line\(s\) merged into orka-inside clip \(stills\)\n?$/);
  assert.match(readFileSync(join(t.dir, "decisions.tsv"), "utf8"), /\tfeature-map\tfeature map: 1 keep-in-mind line\(s\) merged/);
  t.orka(["wake", t.id]);
  assert.equal(readFileSync(t.map, "utf8"), map, "one merge per result file");

  writeFileSync(t.map, map.replace("- Prove: open the PNGs", "- Prove: open the PNGs\n- Stale: marked by 20261020000000000-old; jobs since: 20261021000000000-mid"));
  t.worker("verifier", "verifier", { verdict: "pass", summary: "ok", failures: [] });
  t.orka(["wake", t.id]);
  const pruned = readFileSync(t.map, "utf8");
  assert.doesNotMatch(pruned, /orka-inside clip/);
  assert.match(pruned, /^# Features\n\n## Studio verify file/);
  assert.match(t.prompts().at(-1), /feature map: dropped orka-inside clip \(stills\) \(stale for 2 jobs\)/);
});

test("no map and a builder with keepInMind: orka creates the map; no keepInMind: no map, no note", () => {
  const t = scratch();
  t.worker("quiet", "builder", { worker: "quiet", ok: true, result: "x" });
  t.orka(["wake", t.id]);
  assert.equal(existsSync(t.map), false);
  assert.doesNotMatch(t.prompts()[0], /feature map/);
  t.worker("builder", "builder", { worker: "builder", ok: true, result: "y", keepInMind: ["run npm ci before the tests"] });
  t.orka(["wake", t.id]);
  assert.equal(readFileSync(t.map, "utf8"), "# Feature map\n\n## General\n- Keep in mind:\n  - run npm ci before the tests\n");
});

test("prompts: builders read the map and may return keepInMind; the verifier keeps it and marks Stale", () => {
  const src = readFileSync(ORKA, "utf8");
  const body = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf("\n}\n", src.indexOf(`function ${name}(`)));
  const worker = body("workerPrompt");
  assert.match(worker, /records per feature how to reach, drive and prove it, and what to keep in mind\. Read the entries for what you touch\. Never edit it\./);
  assert.match(worker, /"keepInMind": \["<one line>"\]/);
  const verifier = body("verifierPrompt");
  assert.match(verifier, /keep the Keep in mind lines when you update an entry/);
  assert.match(verifier, /fails on HEAD and also on the base commit, do not delete it: add the line "- Stale: marked by \$\{job\.id\}"/);
});
