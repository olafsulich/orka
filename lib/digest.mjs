// Pure capped snapshot of a job. No herdr, no network, no process spawn, no filesystem.
// The CLI stats and reads, then passes already-clipped snippets in `files`.

export const DIGEST_MAX = 2400;
export const GOAL_MAX = 240;
export const WORKTREE_MAX = 120;
export const SUMMARY_MAX = 400;
export const NOTE_MAX = 160;
export const WORKER_MAX = 8;
export const EVIDENCE_MAX = 200;
export const DECISION_ROWS = 3;
export const DECISION_ROW_MAX = 160;
export const BLOCKING_MAX = 3;
export const STEER_MAX = 200;
export const CONTRACT_MAX = 500;
export const FILE_READ_MAX = 4096;
export const VERIFIER_JSON_MAX = 64 * 1024;

const ELLIPSIS = "\u2026";

export const CONTRACT = [
  "Contract: shared worktree.",
  "Do not implement.",
  "Do not push.",
  "Do not create a branch or worktree.",
  "Do not close panes.",
  "orka done sends the finish webhook.",
  "Do not run orka webhook or orka stop.",
  "A follow-up round must call orka done again.",
  "The verifier stays a fresh worker.",
  "Do not read the job JSON or verify.log into the turn.",
].join(" ");

if (CONTRACT.length > CONTRACT_MAX) {
  throw new Error(`digest contract is ${CONTRACT.length} characters; cap is ${CONTRACT_MAX}`);
}

// stateDir: .orka, or .orca in a repo from before the rename (the CLI passes it in files.stateDir).
export function capSuffix(id, stateDir = ".orka") {
  return `${ELLIPSIS} capped; full records stay in ${stateDir}/jobs/${id}/`;
}

export function steerText(digest, message) {
  return `${digest}\n\nOwner steer:\n${message}`;
}

function clipGoal(goal) {
  const raw = String(goal ?? "");
  const slice = raw.slice(0, 2000).replace(/\s+/g, " ").trim();
  if (!slice) return "goal: none";
  const moreBeyondSlice = raw.length > 2000;
  const mark = slice.search(/[.!?](?:\s|$)/);
  let sentence = mark === -1 ? slice : slice.slice(0, mark + 1);
  let cut = mark === -1 ? moreBeyondSlice || raw.trim().length > sentence.length : mark + 1 < slice.length || moreBeyondSlice;
  if (sentence.length > GOAL_MAX) {
    sentence = sentence.slice(0, GOAL_MAX);
    cut = true;
  }
  if (cut && !sentence.endsWith(ELLIPSIS)) sentence += ELLIPSIS;
  return `goal: ${sentence}`;
}

function capDisplay(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  if (max <= 1) return ELLIPSIS.slice(0, max);
  return s.slice(0, max - 1) + ELLIPSIS;
}

function summaryLine(job, files) {
  const has = files && Object.prototype.hasOwnProperty.call(files, "summary");
  const raw = has ? files.summary : job?.summary;
  const text = raw == null ? "" : String(raw).slice(0, SUMMARY_MAX).replace(/[\r\n]+/g, " ").trim();
  if (!text) return "summary: none";
  return `summary: ${text}`;
}

function noteLabel(files, name) {
  const notes = files?.notes;
  if (!notes || !Object.prototype.hasOwnProperty.call(notes, name) || notes[name] == null) return "note missing";
  const raw = String(notes[name]);
  return `note: ${raw.slice(0, NOTE_MAX).replace(/[\r\n]+/g, " ")}`;
}

function workerLines(job, files) {
  const workers = Array.isArray(job?.workers) ? job.workers.filter((w) => w && w.name != null && String(w.name) !== "") : [];
  if (!workers.length) return ["workers: none"];
  const lines = ["workers:"];
  for (const worker of workers.slice(0, WORKER_MAX)) {
    const name = String(worker.name).replace(/[\r\n]+/g, " ").slice(0, 40);
    const role = worker.role === "verifier" ? " role=verifier" : "";
    let ok = files?.ok?.[worker.name] === true ? "ok=true" : "ok not true";
    if (worker.role === "verifier") {
      // results/verifier.json carries `verdict`, not `ok`.
      const verdict = files?.verifier?.verdict ?? job?.verifier?.verdict;
      ok = verdict === "pass" || verdict === "fail" ? `verdict=${verdict}` : "verdict=none";
    }
    // name and role only. Never job.workers[].task.
    if (worker.handedOffTo) {
      const pct = Number.isFinite(worker.handoffPct) ? ` at ${Math.round(worker.handoffPct * 100)}%` : "";
      lines.push(`- ${name}${role} handed off${pct} to ${String(worker.handedOffTo).slice(0, 40)}, pane open`);
      continue;
    }
    lines.push(`- ${name}${role} ${ok} ${noteLabel(files, worker.name)}`);
  }
  const extra = workers.length - WORKER_MAX;
  if (extra > 0) lines.push(`${extra} more workers in notes/`);
  return lines;
}

function blockingOf(parsed) {
  const list = parsed && Array.isArray(parsed.failures) ? parsed.failures : [];
  const out = [];
  for (const item of list) {
    if (out.length >= BLOCKING_MAX) break;
    if (typeof item === "string") {
      const check = item.trim().replace(/\s+/g, " ").slice(0, 80);
      if (!check) continue;
      out.push({ check, evidence: item.slice(0, EVIDENCE_MAX).replace(/[\r\n]+/g, " ") });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const check = String(item.check ?? item.name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (!check) continue;
    const evidence = String(item.evidence ?? "").slice(0, EVIDENCE_MAX).replace(/[\r\n]+/g, " ");
    out.push({ check, evidence });
  }
  return out;
}

function skippedSize(files) {
  const v = files?.verifierSkipped;
  if (v == null || v === false) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object") {
    const n = Number(v.bytes ?? v.size);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function verifierLines(job, files) {
  const v = job?.verifier && typeof job.verifier === "object" ? job.verifier : {};
  const skipped = skippedSize(files);
  const parsed = skipped == null && files?.verifier && typeof files.verifier === "object" ? files.verifier : null;
  const verdict = v.verdict ?? parsed?.verdict ?? "none";
  const rounds = v.rounds ?? parsed?.round ?? parsed?.rounds ?? 0;
  let line = `verifier: verdict=${verdict} rounds=${rounds}`;
  if (v.stall) {
    const checks = Array.isArray(v.stall.checks) ? v.stall.checks.map((c) => String(c).replace(/[\r\n]+/g, " ")) : [];
    line += ` stall=${checks.join(", ")}`;
  }
  const out = [line];
  if (skipped != null) {
    out.push(`results/verifier.json is ${skipped} bytes; not inlined`);
    return out;
  }
  for (const item of blockingOf(parsed)) out.push(`blocking: ${item.check}: ${item.evidence}`);
  if (parsed) out.push(`warnings: ${Array.isArray(parsed.warnings) ? parsed.warnings.length : 0}`);
  return out;
}

function lastSteerLine(job) {
  const steers = Array.isArray(job?.steers) ? job.steers : [];
  if (!steers.length) return "last steer: none";
  const last = steers[steers.length - 1];
  const raw = String(last?.message ?? "");
  const failed = last?.delivery === "failed" ? " DELIVERY FAILED: steer never started the agent; re-send it" : "";
  return `last steer: ${raw.slice(0, STEER_MAX).replace(/[\r\n]+/g, " ")} (${steers.length - 1} earlier)${failed}`;
}

function leadDeliveryLines(job) {
  if (job?.leadDelivery !== "failed") return [];
  const why = String(job.stopReason || "orchestrator prompt never started the agent").replace(/[\r\n]+/g, " ");
  return [`orchestrator: DELIVERY FAILED: ${capDisplay(why, EVIDENCE_MAX)}`];
}

function decisionLines(files) {
  const d = files?.decisions;
  if (!d || !Array.isArray(d.rows) || !d.rows.length) return [];
  const out = [`decisions: ${d.count} (last ${Math.min(d.rows.length, DECISION_ROWS)})`];
  for (const row of d.rows.slice(-DECISION_ROWS)) {
    const [ts = "", phase = "", decision = "", , , result = ""] = String(row).split("\t");
    const text = `${ts.slice(0, 16)} ${phase}: ${decision}${result ? ` -> ${result}` : ""}`.replace(/[\r\n]+/g, " ");
    out.push(`- ${capDisplay(text, DECISION_ROW_MAX)}`);
  }
  return out;
}

function applyCap(text, id, stateDir) {
  if (text.length <= DIGEST_MAX) return text;
  const suffix = capSuffix(id, stateDir);
  if (suffix.length >= DIGEST_MAX) return suffix.slice(suffix.length - DIGEST_MAX);
  return text.slice(0, DIGEST_MAX - suffix.length) + suffix;
}

export function renderDigest(job, files = {}) {
  const id = String(job?.id ?? "");
  const round = Number(job?.round);
  const lines = [
    `Orka digest for ${id} (capped snapshot, not the job file).`,
    `status: ${job?.status || "unknown"}`,
  ];
  if (Number.isInteger(round) && round > 1) lines.push(`round: ${round}`);
  // A job without a branch predates orka, so its branch is orca/<id>.
  lines.push(`branch: ${job?.branch || (id ? `orca/${id}` : "unknown")}`);
  if (job?.keep === true) lines.push("keep: true");
  lines.push(clipGoal(job?.goal));
  lines.push(`worktree: ${job?.worktree ? capDisplay(String(job.worktree), WORKTREE_MAX) : "(not created)"}`);
  lines.push(summaryLine(job, files));
  lines.push(...leadDeliveryLines(job));
  lines.push(...workerLines(job, files));
  lines.push(...verifierLines(job, files));
  lines.push(lastSteerLine(job));
  lines.push(...decisionLines(files));
  lines.push(CONTRACT);
  return applyCap(lines.join("\n"), id, files.stateDir);
}
