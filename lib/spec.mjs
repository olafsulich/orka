// Committed feature specs in the target repo: specs/<feature>/spec.md holds what,
// why, limits and done criteria. orka new --spec builds the job intake from it, and
// every worker and verifier brief gets the spec text pasted in.

export const SPEC_DIR = "specs";
export const SPEC_FILE = "spec.md";
// Prompt cap for the pasted spec; the full file is always in the worktree.
export const SPEC_PROMPT_MAX = 8000;
export const REQUIRED = ["what", "done when"];
const SECTIONS = ["What", "Why", "Limits", "Done when"];

export function assertFeature(feature) {
  const name = String(feature ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) fail(`feature name must match [a-z0-9][a-z0-9-]{0,63}, got "${name}"`);
  return name;
}

function fail(msg) {
  const err = new Error(msg);
  err.orka = true;
  throw err;
}

export const specRelPath = (feature) => `${SPEC_DIR}/${feature}/${SPEC_FILE}`;

export function specTemplate(feature, date = new Date().toISOString().slice(0, 10)) {
  return `# ${feature}

Stage: idea
Kind: feature
Created: ${date}

## What
<!-- What the feature does, in a few lines. -->

## Why
<!-- Why it matters now, and for whom. -->

## Limits
<!-- Out of scope, constraints, files not to touch. -->

## Done when
<!-- One checkable criterion per line; the verifier checks each one. -->
`;
}

const stripComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, "");

// { title, stage, kind, sections: { "<lowercase heading>": body } }. Bodies have comments removed and are trimmed.
export function parseSpec(text) {
  const out = { title: "", stage: "", kind: "", sections: {} };
  let current = null;
  const lines = stripComments(text).split(/\r?\n/);
  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      current = h2[1].toLowerCase();
      out.sections[current] = "";
      continue;
    }
    if (h1 && !out.title && current === null) {
      out.title = h1[1];
      continue;
    }
    if (current === null) {
      const field = /^(Stage|Kind):\s*(.+?)\s*$/i.exec(line);
      if (field) out[field[1].toLowerCase()] = field[2].toLowerCase();
      continue;
    }
    out.sections[current] += `${line}\n`;
  }
  for (const key of Object.keys(out.sections)) out.sections[key] = out.sections[key].trim();
  return out;
}

export function missingSections(spec) {
  return REQUIRED.filter((key) => !spec.sections[key]);
}

// The job goal (intake) built from the spec. Only the four core sections; the rest stays in the pasted spec.
export function specIntake(spec, relPath, commit) {
  const lines = [`Build the feature specified in ${relPath}${commit ? ` (committed at ${commit.slice(0, 8)})` : ""}. The spec is the source of truth; orka pastes it into every worker and verifier brief.`];
  for (const name of SECTIONS) {
    const body = spec.sections[name.toLowerCase()];
    if (!body) continue;
    lines.push("", `${name}:`, body);
  }
  return lines.join("\n");
}

// The block pasted into worker and verifier briefs.
export function specBlock(text, relPath) {
  const body = String(text).trim();
  const capped = body.length > SPEC_PROMPT_MAX ? `${body.slice(0, SPEC_PROMPT_MAX)}\n[spec cut at ${SPEC_PROMPT_MAX} characters; read the rest in ${relPath}]` : body;
  return [`SPEC (${relPath}, the source of truth for this job; every "Done when" line is an acceptance criterion):`, capped].join("\n");
}

// Lessons: on orka done, a spec'd job appends what it learned to "## Lessons" in its spec (on the job
// branch only). One line per lesson, deduped by kind + text, compressed when over the cap.
export const LESSONS_HEADING = "## Lessons";
export const LESSONS_MAX_LINES = 20;
export const LESSON_MAX = 180;
const LESSON_RE = /^- (\d{4}-\d\d-\d\d) ([a-z][a-z-]*): (.*?)(?: \(job ([^)]+)\))?(?: x(\d+))?\s*$/;
const REJECT_RE = /\b(reject(ed)?|revert(ed)?|abandon(ed)?|dropped|ruled out)\b/i;

const clip = (text, max = LESSON_MAX) => {
  const one = String(text ?? "").replace(/\\[nt]/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export const lessonKey = (kind, text) => `${kind}:${clip(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;

// Sources: decisions.tsv rows (strategy rows and rows that reject an approach), delivered steers,
// verifier history (checks that failed, pre-existing failures), and a give-up reason.
// rows: arrays of TSV cells [ts, phase, decision, why, evidence, result]. evidence: { <check>: "<first evidence>" }.
export function collectLessons({ job, rows = [], evidence = {} }) {
  const out = [];
  const add = (kind, text) => {
    const t = clip(text);
    if (t && !out.some((l) => lessonKey(l.kind, l.text) === lessonKey(kind, t))) out.push({ kind, text: t });
  };
  for (const [, phase, decision, why] of rows) {
    if (phase === "lessons" || phase === "autonomy" || phase === "gate") continue;
    if (phase === "strategy") {
      const m = /^premise: (.*?) \| change: (.*)$/.exec(decision || "");
      add("rejected", m ? `premise "${m[1]}"; changed to: ${m[2]}` : `approach before: ${decision}`);
    } else if (REJECT_RE.test(`${decision} ${why}`)) add("rejected", why ? `${decision} (${why})` : decision);
  }
  for (const steer of job.steers || []) if (steer?.message && steer.delivery !== "failed") add("steer", steer.message);
  const v = job.verifier || {};
  const history = Array.isArray(v.history) ? v.history : [];
  const finalFailing = new Set(history.at(-1)?.failing || []);
  const failedIn = new Map();
  const preexisting = new Set();
  for (const h of history) {
    for (const c of h.failing || []) failedIn.set(c, [...(failedIn.get(c) || []), h.round]);
    for (const c of h.warnings || []) preexisting.add(c);
  }
  for (const [check, rounds] of failedIn) {
    const ev = evidence[check] ? `: ${evidence[check]}` : "";
    if (finalFailing.has(check)) add("check", `${check} still failing at the end${ev}`);
    else add("check", `${check} failed in round${rounds.length > 1 ? "s" : ""} ${rounds.join(", ")} before passing${ev}`);
  }
  for (const check of preexisting) add("flaky", `${check} fails on the base commit too (pre-existing)`);
  if (v.stopReason) add("gave-up", v.stopReason);
  return out;
}

function parseLessonLine(line) {
  const m = LESSON_RE.exec(line);
  if (!m) return null;
  return { line, date: m[1], kind: m[2], text: m[3], job: m[4] || "", count: Number(m[5]) || 1 };
}

const renderLesson = (l) => `- ${l.date} ${l.kind}: ${l.text}${l.job ? ` (job ${l.job})` : ""}${l.count > 1 ? ` x${l.count}` : ""}`;

// Lines over the cap are folded into one "compressed" line (lowest recurrence and oldest go first);
// the dropped text stays in the git history of the spec.
function compress(entries, max, date) {
  const kept = entries.filter((e) => e.kind !== "compressed");
  const prior = entries.find((e) => e.kind === "compressed");
  let folded = prior ? Number(/^(\d+)/.exec(prior.text)?.[1]) || 0 : 0;
  const room = max - 1;
  if (kept.length + (prior ? 1 : 0) <= max) return { entries, compressed: 0 };
  const order = kept.map((e, i) => ({ e, i })).sort((a, b) => a.e.count - b.e.count || a.e.date.localeCompare(b.e.date) || a.i - b.i);
  const drop = new Set(order.slice(0, Math.max(0, kept.length - room)).map((x) => x.e));
  folded += drop.size;
  const line = { date, kind: "compressed", text: `${folded} older lesson${folded === 1 ? "" : "s"} folded; full text in the git history of this file`, job: "", count: 1 };
  return { entries: [line, ...kept.filter((e) => !drop.has(e))], compressed: drop.size };
}

// Returns { text, added, bumped, compressed }. A lesson already in the spec is skipped when this
// job wrote it, and counted again (xN) when another job hits it.
export function mergeLessons(specText, lessons, { date, jobId, max = LESSONS_MAX_LINES }) {
  const text = String(specText ?? "");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === LESSONS_HEADING);
  let end = lines.length;
  if (start >= 0) for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
  const section = start >= 0 ? lines.slice(start + 1, end) : [];
  const entries = section.map(parseLessonLine).filter(Boolean);
  const other = section.filter((l) => l.trim() && !parseLessonLine(l));
  let added = 0;
  let bumped = 0;
  for (const lesson of lessons) {
    const key = lessonKey(lesson.kind, lesson.text);
    const hit = entries.find((e) => lessonKey(e.kind, e.text) === key);
    if (hit) {
      if (hit.job === jobId) continue;
      hit.count += 1;
      hit.date = date;
      hit.job = jobId;
      bumped += 1;
      continue;
    }
    entries.push({ date, kind: lesson.kind, text: lesson.text, job: jobId, count: 1 });
    added += 1;
  }
  if (!added && !bumped) return { text, added, bumped, compressed: 0 };
  const packed = compress(entries, max, date);
  const body = [LESSONS_HEADING, "", ...other, ...packed.entries.map(renderLesson)];
  let next;
  if (start >= 0) {
    const after = lines.slice(end);
    next = [...lines.slice(0, start), ...body, ...(after.length ? ["", ...after] : [""])].join("\n");
  } else next = `${text.replace(/\s*$/, "")}\n\n${body.join("\n")}\n`;
  return { text: next.replace(/\n{3,}/g, "\n\n"), added, bumped, compressed: packed.compressed };
}
