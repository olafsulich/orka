// orka doctor (docs/doctor.md): the environment a job needs, checked and reported with the fix for
// each problem. Read-only: it never installs a system package and never uses sudo. The only change
// it makes is behind --fix and repo-local (relinking node_modules, in orka.mjs).
// Every probe comes in through `probe`, so tests run on a fake host.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIN_NODE_MAJOR = 22;
export const MIN_FREE_DISK_MB = 2048;
export const WARN_DISK_USED = 0.9;

// [name, commands (any one found is enough), how to get it, required]
export const CLIS = [
  ["git", ["git"], "sudo apt install git", true],
  ["hc", ["hc"], "install herdr-core from https://herdr.dev/download/ (orka starts every pane through it)", false],
  ["herdr", ["herdr"], "install herdr only for the deprecated ORKA_BACKEND=herdr and jobs started on it", false],
  ["claude", ["claude"], "install Claude Code (npm i -g @anthropic-ai/claude-code)", true],
  ["rg", ["rg"], "sudo apt install ripgrep", true],
  ["jq", ["jq"], "sudo apt install jq", true],
  ["file", ["file"], "sudo apt install file", true],
  ["ImageMagick", ["magick", "identify"], "sudo apt install imagemagick", true],
  ["agent-browser", ["agent-browser"], "npm i -g agent-browser (only for browser checks)", false],
  ["pi", ["pi"], "npm i -g @earendil-works/pi-coding-agent (only for --kind pi jobs)", false],
];

const ok = (name, detail) => ({ name, status: "ok", detail });
const bad = (name, detail, fix, status = "fail") => ({ name, status, detail, fix });

export function cliChecks(probe) {
  return CLIS.map(([name, cmds, fix, required]) => {
    const found = cmds.map((c) => [c, probe.which(c)]).find(([, path]) => path);
    if (found) return ok(name, found[1]);
    return bad(name, `${cmds.join(" or ")} not on PATH`, `${fix}. orka does not install it`, required ? "fail" : "warn");
  });
}

export function nodeCheck(probe) {
  const v = probe.nodeVersion();
  const major = Number(/^v?(\d+)/.exec(v || "")?.[1]);
  if (!major) return bad("node", "node not on PATH", `install node >= ${MIN_NODE_MAJOR} (nvm install ${MIN_NODE_MAJOR})`);
  return major >= MIN_NODE_MAJOR ? ok("node", v) : bad("node", `${v} is older than ${MIN_NODE_MAJOR}`, `nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`);
}

// plan: deps.planDeps(main, worktree) for a job worktree, or null for the main checkout only.
export function depsCheck({ repo, worktree, plan, jobId }) {
  if (!existsSync(join(repo, "package.json"))) return ok("node_modules", "no package.json");
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) || {};
  } catch {
    pkg = {};
  }
  if (![pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((d) => d && Object.keys(d).length)) return ok("node_modules", "no dependencies in package.json");
  if (!worktree) {
    return existsSync(join(repo, "node_modules")) ? ok("node_modules", `${repo}/node_modules present`) : bad("node_modules", `${repo} has no node_modules`, `run the repo's install in ${repo} (npm ci)`, "warn");
  }
  const todo = (plan || []).filter((p) => p.action !== "ok");
  if (!todo.length) return ok("node_modules", "linked to the main checkout (or a real install)");
  return bad("node_modules", todo.map((p) => `${p.dir}: ${p.action} (${p.reason})`).join("; "), todo.some((p) => p.action === "install") ? `run ${todo.find((p) => p.install)?.install?.join(" ") || "the install"} in ${worktree}` : `orka doctor --job ${jobId} --fix (relinks to the main checkout)`);
}

// ports: [{ port, user }] where user is a process line or "" when free.
export function portChecks(ports) {
  if (!ports) return [];
  return ports.map(({ port, user }) => (user ? bad(`port ${port}`, `in use: ${user}`, `stop that process if it is a stale server from a finished job (orka cleanup finds those inside job worktrees), or let the job pick another of its ports`, "warn") : ok(`port ${port}`, "free")));
}

export function diskCheck(stat) {
  if (!stat) return bad("disk", "could not read", "check df -h", "warn");
  const freeMb = Math.floor(stat.freeBytes / 1048576);
  const used = stat.totalBytes ? 1 - stat.freeBytes / stat.totalBytes : 0;
  const detail = `${freeMb} MB free (${Math.round(used * 100)}% used)`;
  if (freeMb < MIN_FREE_DISK_MB) return bad("disk", detail, "free space: timeout 120 orka cleanup --dry-run lists done-job worktrees and their sizes");
  if (used > WARN_DISK_USED) return bad("disk", detail, "timeout 120 orka cleanup --dry-run lists what can go", "warn");
  return ok("disk", detail);
}

// hint: guard.finishedHint, naming the finished jobs that still hold memory ("" when none).
export function memoryCheck(availableMb, minMb, hint = "") {
  if (availableMb == null) return bad("memory", "MemAvailable unknown", "check free -m", "warn");
  return availableMb >= minMb ? ok("memory", `${availableMb} MB available`) : bad("memory", `${availableMb} MB available, under ${minMb} MB`, hint || "wait for workers to finish, or close idle panes of finished jobs (timeout 120 orka cleanup)", "warn");
}

export function swapCheck(swapMb) {
  if (swapMb == null) return ok("swap", "unknown (no meminfo)");
  if (swapMb > 0) return ok("swap", `${swapMb} MB`);
  return bad("swap", "no swap: when memory runs out, the kernel's OOM killer ends processes (a pane, Chrome, a build) instead of the host slowing down", "a 2-4 GB swapfile or zram, set up by hand (needs sudo; orka never does it)", "warn");
}

export const WARN_TMPFS_MB = 1024;

// tmp: { path, fstype, usedBytes } of the temp folder's filesystem. A tmpfs holds its files in RAM.
export function tmpfsCheck(tmp) {
  if (!tmp?.fstype) return ok("tmp", "filesystem unknown");
  const usedMb = Math.round((tmp.usedBytes || 0) / 1048576);
  if (tmp.fstype !== "tmpfs") return ok("tmp", `${tmp.path} on ${tmp.fstype}`);
  const detail = `${tmp.path} is a tmpfs (RAM) with ${usedMb} MB in use`;
  if (usedMb <= WARN_TMPFS_MB) return ok("tmp", detail);
  return bad("tmp", detail, "timeout 120 orka cleanup --dry-run lists the Claude scratch folders of finished jobs it would remove; other files there are yours to judge", "warn");
}

// Claude Code keeps folder trust per project path in ~/.claude.json (projects[<path>].hasTrustDialogAccepted);
// a job worktree is trusted through its repo root. Claude offers no supported way to pre-trust from the
// command line, so orka only reports it.
export function trustCheck({ repo, claudeJson }) {
  let data = null;
  try {
    data = JSON.parse(readFileSync(claudeJson, "utf8"));
  } catch {
    return bad("claude trust", `${claudeJson} not readable`, `run claude once in ${repo} and choose "Yes, I trust this folder"`, "warn");
  }
  if (data?.projects?.[repo]?.hasTrustDialogAccepted === true) return ok("claude trust", `${repo} trusted`);
  return bad("claude trust", `${repo} is not trusted by Claude Code: every claude pane would stop on the folder-trust dialog`, `once, by hand: cd ${repo} && claude, choose "Yes, I trust this folder", then /exit. orka never accepts the dialog for you`);
}

// herdr-core serve, which every hc pane runs under. Read-only: the socket file and the process, never an
// hc command (any of them, even hc server status, starts a core when none runs).
export function hcServeCheck({ socket, socketExists, serving }) {
  if (socketExists && serving) return ok("herdr-core", `serve running, socket ${socket}`);
  const why = !serving ? "no herdr-core serve process" : `no socket at ${socket}`;
  return bad("herdr-core", `${why}: orka run on the hc default would refuse to start`, "open the Herdr app on this host or run hc server start; orka never starts it (ORKA_BACKEND=herdr uses the deprecated herdr instead)", "warn");
}

// Pi on hc: only Pi that reports OSC 7501 status (1.1.0+) can be watched there.
export function piStatusCheck(version, min, reports) {
  if (reports(version)) return ok("pi status", `pi ${version} reports its state to herdr-core (OSC 7501)`);
  return bad("pi status", `pi ${version || "(version unknown)"} reports no state to herdr-core: pi jobs on hc are refused`, `update pi to ${min} or later (npm i -g @earendil-works/pi-coding-agent@latest); ORKA_BACKEND=herdr runs pi jobs on the deprecated herdr meanwhile`, "warn");
}

export function chromeCheck(orphans) {
  if (!orphans.length) return ok("chrome", "no orphan agent-browser Chrome");
  return bad("chrome", `${orphans.length} orphan agent-browser Chrome root(s) with no running job (pids ${orphans.slice(0, 5).join(", ")})`, "timeout 120 orka cleanup", "warn");
}

export function summary(checks) {
  const failed = checks.filter((c) => c.status === "fail").map((c) => c.name);
  const warnings = checks.filter((c) => c.status === "warn").map((c) => c.name);
  return { ok: !failed.length, failed, warnings };
}

export function render(checks) {
  const tag = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const lines = checks.map((c) => `  ${tag[c.status]}  ${c.name}: ${c.detail}${c.fix ? `\n          fix: ${c.fix}` : ""}`);
  const s = summary(checks);
  lines.push(s.ok ? `doctor: ok${s.warnings.length ? ` (${s.warnings.length} warning(s): ${s.warnings.join(", ")})` : ""}` : `doctor: ${s.failed.length} failed: ${s.failed.join(", ")}${s.warnings.length ? `; warnings: ${s.warnings.join(", ")}` : ""}`);
  return lines.join("\n");
}
