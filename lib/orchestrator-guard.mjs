// Orchestrator write guard: the lead pane only communicates, delegates and tracks, so product edits
// are refused there. Claude Code runs this file as a PreToolUse hook
// (node lib/orchestrator-guard.mjs claude <job dir> <worktree>, hook JSON on stdin); exit 2 blocks the
// tool and feeds stderr to the model. Pi loads piGuardExtension() and blocks on tool_call.
// Every refusal is a row in <job dir>/decisions.tsv (same shape as the autonomy refusals).
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CLAUDE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PI_TOOLS = new Set(["edit", "write"]);
const DECISION_HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";
const WHY = "orchestrator pane may only communicate, delegate and track; product edits go to a worker";

const tsvCell = (value) => String(value ?? "").replace(/\r\n|\r|\n/g, "\\n").replace(/\t/g, "\\t");

// realpath of the nearest existing ancestor, with the missing tail re-appended.
function realish(path) {
  let head = path;
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return path;
      tail.push(head.slice(up.length).replace(/^[\\/]+/, ""));
      head = up;
    }
  }
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function refusalReason(tool, path) {
  return `orka: the orchestrator pane may not ${tool} product files (${path}). Start or steer a worker instead (orka worker / orka steer) and let it make the edit.`;
}

function targetOf(input) {
  const v = input?.file_path ?? input?.notebook_path ?? input?.path;
  return typeof v === "string" && v ? v : "";
}

// The decision for one Claude Code tool call. { ok: true } or { ok: false, path, reason }.
export function checkToolCall({ tool, input, cwd, worktree }) {
  if (!CLAUDE_TOOLS.has(tool)) return { ok: true };
  const raw = targetOf(input);
  if (!raw || !worktree) return { ok: true };
  const path = realish(resolve(cwd || worktree, raw));
  if (!inside(realish(resolve(worktree)), path)) return { ok: true };
  return { ok: false, path, reason: refusalReason(tool, path) };
}

export function logRefusal(jobDir, tool, path) {
  const file = join(jobDir, "decisions.tsv");
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, DECISION_HEADER);
  const cells = [new Date().toISOString(), "guard", `refused ${tool}`, WHY, path, "refused"];
  appendFileSync(file, `${cells.map(tsvCell).join("\t")}\n`);
}

// Pi: a factory for the per-job extension. tool_call carries { toolName, input: { path } }.
export function piGuardExtension({ jobDir, worktree }) {
  return function orkaGuard(pi) {
    pi.on("tool_call", (event, ctx) => {
      try {
        if (!PI_TOOLS.has(event?.toolName)) return undefined;
        const raw = targetOf(event.input);
        if (!raw) return undefined;
        const path = realish(resolve(ctx?.cwd || worktree, raw));
        if (!inside(realish(resolve(worktree)), path)) return undefined;
        logRefusal(jobDir, event.toolName, path);
        return { block: true, reason: refusalReason(event.toolName, path) };
      } catch {
        return undefined;
      }
    });
  };
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv) {
  const [kind, jobDir, worktree] = argv;
  if (kind !== "claude" || !jobDir || !worktree) return 0;
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  if (!input || typeof input !== "object") return 0;
  const got = checkToolCall({ tool: input.tool_name, input: input.tool_input, cwd: input.cwd, worktree });
  if (got.ok) return 0;
  try {
    logRefusal(resolve(jobDir), input.tool_name, got.path);
  } catch {
    // the refusal still stands when the log cannot be written
  }
  process.stderr.write(`${got.reason}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(0));
}
