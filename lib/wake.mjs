// Harness-sent finish wake (Limen's completion wake): when a worker's or the verifier's turn has
// ended and its result file exists, orka itself prompts the current orchestrator pane with a short,
// bounded message. The full result stays on disk. One wake per result file: the key is the worker
// name plus the file's mtime and size, so a rewritten result (a new round) wakes again.
import { statSync } from "node:fs";

export const RESULT_LINES = 15;
export const RESULT_CHARS = 1200;
export const COMMIT_LINES = 10;

export function wakeKey(name, path) {
  try {
    const st = statSync(path);
    return st.size ? `${name}|${Math.round(st.mtimeMs)}|${st.size}` : null;
  } catch {
    return null;
  }
}

// First 15 lines, then 1200 characters; clipped text says where the rest is.
export function excerpt(text, path) {
  const raw = String(text ?? "").trim();
  let out = raw.split("\n").slice(0, RESULT_LINES).join("\n");
  if (out.length > RESULT_CHARS) out = out.slice(0, RESULT_CHARS);
  return out.length < raw.length ? `${out}\n... (full text in ${path})` : out;
}

// What the result file says, as { state, text }. A builder writes {"ok","result"}, the verifier
// {"verdict","summary","failures"}. Anything else is shown raw.
export function readResult(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { state: "unreadable result", text: String(raw ?? "") };
  }
  if (data && typeof data === "object" && "verdict" in data) {
    const failures = Array.isArray(data.failures) ? data.failures.length : 0;
    return { state: `verdict ${data.verdict}${failures ? `, ${failures} blocking failure(s)` : ""}`, text: String(data.summary ?? "") };
  }
  if (data && typeof data === "object" && "ok" in data) return { state: data.ok === true ? "ok" : "not ok", text: String(data.result ?? "") };
  return { state: "result written", text: JSON.stringify(data) };
}

export function wakeText({ jobId, worker, role, state, text, path, commits, undelivered }) {
  const commitLines = commits == null ? [] : commits.length ? [`Commits:`, ...commits.slice(0, COMMIT_LINES)] : [`Commits: none`];
  return [
    `orka wake: ${role === "verifier" ? "verifier" : "worker"} ${worker} finished (${state}).`,
    ...commitLines,
    `Result:`,
    excerpt(text, path) || "(empty)",
    `Full result: ${path}${undelivered ? `. Undelivered steers in the inbox: ${undelivered}` : ""}.`,
    `Run orka digest ${jobId} before you route or start the next step.`,
  ].join("\n");
}
