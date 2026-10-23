// Steer inbox (Limen-style): orka steer writes one file per message into
// <job dir>/steer/inbox/<target>/, target "orchestrator" or a worker name. The pane's own hook
// (Claude PostToolUse, Pi tool_result) delivers pending files between tool calls; the watcher
// delivers them with herdr agent prompt when the agent is idle. A delivery first claims the file by
// renaming it into steer/delivered/<target>/, so two deliverers never send the same message.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const inboxDir = (jobDir, target) => join(jobDir, "steer", "inbox", target);
export const deliveredDir = (jobDir, target) => join(jobDir, "steer", "delivered", target);

let seq = 0;

// { at, from, message, text }: text is what the agent gets (message plus any context orka adds).
export function enqueue(jobDir, target, entry, now = new Date()) {
  const dir = inboxDir(jobDir, target);
  mkdirSync(dir, { recursive: true });
  const file = `${now.getTime()}-${process.pid}-${String(seq++).padStart(3, "0")}.json`;
  writeFileSync(join(dir, file), `${JSON.stringify({ at: now.toISOString(), target, ...entry })}\n`);
  return join(dir, file);
}

// Pending messages for one target, oldest first: [{ file, ...entry }].
export function pending(jobDir, target) {
  let names;
  try {
    names = readdirSync(inboxDir(jobDir, target)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      out.push({ file: f, ...JSON.parse(readFileSync(join(inboxDir(jobDir, target), f), "utf8")) });
    } catch {
      // a half-written file is picked up next time
    }
  }
  return out;
}

// { <target>: count } of undelivered messages.
export function pendingCounts(jobDir) {
  const out = {};
  let targets;
  try {
    targets = readdirSync(join(jobDir, "steer", "inbox"));
  } catch {
    return out;
  }
  for (const t of targets) {
    let n = 0;
    try {
      n = readdirSync(inboxDir(jobDir, t)).filter((f) => f.endsWith(".json")).length;
    } catch {
      n = 0;
    }
    if (n) out[t] = n;
  }
  return out;
}

export const pendingTotal = (jobDir) => Object.values(pendingCounts(jobDir)).reduce((a, b) => a + b, 0);

// Claims every pending message of a target for one delivery. Returns the claimed entries (those this
// process won the rename for), oldest first.
export function claim(jobDir, target, via, now = new Date()) {
  const out = [];
  for (const e of pending(jobDir, target)) {
    const to = join(deliveredDir(jobDir, target), e.file);
    mkdirSync(deliveredDir(jobDir, target), { recursive: true });
    try {
      renameSync(join(inboxDir(jobDir, target), e.file), to);
    } catch {
      continue; // another deliverer took it
    }
    const { file, ...entry } = e;
    writeFileSync(to, `${JSON.stringify({ ...entry, deliveredAt: now.toISOString(), via })}\n`);
    out.push(e);
  }
  return out;
}

// A delivery that failed after the claim: the messages go back to the inbox.
export function release(jobDir, target, entries) {
  for (const e of entries) {
    try {
      const { file, ...entry } = e;
      renameSync(join(deliveredDir(jobDir, target), file), join(inboxDir(jobDir, target), file));
      writeFileSync(join(inboxDir(jobDir, target), file), `${JSON.stringify(entry)}\n`);
    } catch {
      // gone: nothing to put back
    }
  }
}

// What the agent reads: every claimed message, oldest first.
export function deliveryText(entries) {
  if (entries.length === 1) return entries[0].text || entries[0].message;
  return entries.map((e, i) => `orka inbox ${i + 1}/${entries.length} (${e.from || "olaf"}, ${e.at}):\n${e.text || e.message}`).join("\n\n");
}
