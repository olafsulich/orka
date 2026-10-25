// Feature map (orka.features.md, docs/feature-map.md): one "## <feature>" entry per feature with
// "- Reach:", "- Drive:", "- Prove:", "- Last verified:" and, optional, "- Keep in mind:" (sub-bullets)
// and "- Stale:". The verifier writes the entries; orka itself only merges the builders' keepInMind
// lines and carries or drops Stale entries. Edits are line based: an entry orka does not change is
// written back byte for byte, so maps in the old format (no Keep in mind) round-trip unchanged.

export const KEEP_MAX = 5;
export const KEEP_CHARS = 300;
export const STALE_JOBS = 2;
export const GENERAL = "General";
export const STALE_REASON = "reach fails on HEAD and on base";

const HEADING = /^##\s+(.*?)\s*$/;
const FIELD = /^[-*]\s+(?:\*\*)?([A-Za-z][A-Za-z ]*?)(?:\*\*)?:(?:\*\*)?\s*(.*)$/;
const SUB = /^\s+[-*]\s+(.*)$/;
const JOB_ID = /\b\d{17}-[a-z0-9-]+/g;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const keyOf = (s) => clean(s).toLowerCase().replace(/[.;]+$/, "");
const nameKey = (s) => keyOf(String(s ?? "").replace(/`/g, ""));

// { head: lines before the first entry, entries: [{ name, lines }] } where lines include the heading.
export function parseMap(text) {
  const head = [];
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    const h = line.match(HEADING);
    if (h) entries.push({ name: h[1], lines: [line] });
    else if (entries.length) entries.at(-1).lines.push(line);
    else head.push(line);
  }
  return { head, entries };
}

export const renderMap = (map) => [...map.head, ...map.entries.flatMap((e) => e.lines)].join("\n");

export const findEntry = (map, name) => map.entries.find((e) => nameKey(e.name) === nameKey(name));

// The line range [start, end) of one field: its "- Label:" line plus the indented sub-bullets after it.
function fieldRange(entry, label) {
  const at = entry.lines.findIndex((l) => keyOf(l.match(FIELD)?.[1]) === label);
  if (at < 0) return null;
  let end = at + 1;
  while (end < entry.lines.length && SUB.test(entry.lines[end])) end++;
  return [at, end];
}

// Each field of an entry as { label: text }; Keep in mind as a list.
export function entryFields(entry) {
  const out = {};
  for (const line of entry.lines) {
    const f = line.match(FIELD);
    if (f) out[keyOf(f[1])] = f[2].trim();
  }
  out["keep in mind"] = keepItems(entry);
  return out;
}

export function keepItems(entry) {
  const r = fieldRange(entry, "keep in mind");
  if (!r) return [];
  const [at, end] = r;
  const inline = clean(entry.lines[at].match(FIELD)[2]);
  const subs = entry.lines.slice(at + 1, end).map((l) => clean(l.match(SUB)[1]));
  return [...(inline ? [inline] : []), ...subs].filter(Boolean);
}

// Where a new field line goes: after the entry's last field block, before trailing blank lines.
function fieldEnd(entry) {
  let end = 1;
  entry.lines.forEach((l, i) => {
    if (i && (FIELD.test(l) || SUB.test(l))) end = i + 1;
  });
  return end;
}

function setKeep(entry, items) {
  const block = [`- Keep in mind:`, ...items.map((i) => `  - ${i}`)];
  const r = fieldRange(entry, "keep in mind");
  if (r) entry.lines.splice(r[0], r[1] - r[0], ...block);
  else entry.lines.splice(fieldEnd(entry), 0, ...block);
}

function addEntry(map, name) {
  const last = map.entries.at(-1)?.lines || map.head;
  while (last.length && last.at(-1) === "") last.pop();
  if (last.length) last.push("");
  const entry = { name, lines: [`## ${name}`, ""] };
  map.entries.push(entry);
  return entry;
}

// A result's "keepInMind" as [{ feature, note }]: ["…"] (feature General), [{ feature, note }],
// or { "<feature>": ["…"] | "…" }. Anything else is ignored.
export function keepFromResult(value) {
  const out = [];
  const push = (feature, note) => {
    const n = clean(note).slice(0, KEEP_CHARS);
    if (n) out.push({ feature: clean(feature) || GENERAL, note: n });
  };
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string") push(GENERAL, v);
      else if (v && typeof v === "object") push(v.feature, v.note ?? v.text);
    }
  } else if (value && typeof value === "object") {
    for (const [feature, notes] of Object.entries(value)) for (const n of [].concat(notes)) if (typeof n === "string") push(feature, n);
  }
  return out;
}

// Merges notes into their entries: existing first, then new ones in order, deduped case- and
// whitespace-insensitively, capped at the KEEP_MAX newest. A missing feature gets a new entry.
// { text, added: [{ feature, note }], created: [names] }; text is unchanged when nothing was added.
export function mergeKeep(text, notes) {
  const map = parseMap(text);
  let added = [];
  const created = [];
  for (const { feature, note } of notes) {
    let entry = findEntry(map, feature);
    const items = entry ? keepItems(entry) : [];
    if (items.some((i) => keyOf(i) === keyOf(note))) continue;
    if (!entry) {
      entry = addEntry(map, feature);
      created.push(feature);
    }
    setKeep(entry, [...items, note].slice(-KEEP_MAX));
    added.push({ feature: entry.name, note });
  }
  // A note pushed out again by a later one in the same merge was never kept.
  added = added.filter((a) => keepItems(findEntry(map, a.feature)).includes(a.note));
  return { text: added.length ? renderMap(map) : String(text ?? ""), added, created };
}

// Run once per job at its verifier result. A "- Stale:" entry names the job that marked it (the
// first job id on the line; the current job when there is none) and the jobs since. This job is
// added to the jobs since; an entry stale for STALE_JOBS jobs after the marking one is dropped.
// { text, carried: [names], dropped: [names] }.
export function pruneStale(text, jobId) {
  const map = parseMap(text);
  const carried = [];
  const dropped = [];
  map.entries = map.entries.filter((entry) => {
    const r = fieldRange(entry, "stale");
    if (!r) return true;
    const ids = [...new Set(entry.lines[r[0]].match(FIELD)[2].match(JOB_ID) || [])];
    const marker = ids[0] || jobId;
    const since = ids.slice(1);
    if (jobId !== marker && !since.includes(jobId)) since.push(jobId);
    if (since.length >= STALE_JOBS) {
      dropped.push(entry.name);
      return false;
    }
    const line = `- Stale: ${STALE_REASON}; marked by ${marker}; jobs since: ${since.join(", ") || "none"}`;
    if (entry.lines[r[0]] !== line) {
      entry.lines[r[0]] = line;
      carried.push(entry.name);
    }
    return true;
  });
  return { text: carried.length || dropped.length ? renderMap(map) : String(text ?? ""), carried, dropped };
}
