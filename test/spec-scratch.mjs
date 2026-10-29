// Shared scratch for spec, lessons, autonomy and gate tests (no tests in this file).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORKA = join(import.meta.dirname, "..", "bin", "orka.mjs");

// herdr and claude are stubs on PATH. herdr logs its arguments and reports a working agent once prompted.
export function specScratch(prefix = "orka-spec-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  for (const d of [repo, bin, join(base, "home"), join(base, "run")]) mkdirSync(d, { recursive: true });
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "herdr"),
    `#!/bin/sh
printf 'herdr %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "workspace create") rm -f "${base}/prompted" "${base}"/seen-*; echo '{"result":{"root_pane":{"pane_id":"p-root"}}}';;
  "pane split") echo '{"result":{"pane":{"pane_id":"p-split"}}}';;
  "agent list") echo '{"result":{"agents":[]}}';;
  "agent get")
    if [ ! -e "${base}/prompted" ]; then
      if [ ! -e "${base}/seen-$3" ]; then touch "${base}/seen-$3"; echo '{"error":{"code":"agent_not_found","message":"no"}}'; exit 1; fi
      echo '{"result":{"agent":{"agent_status":"idle","interactive_ready":true,"pane_id":"p-split"}}}'; exit 0
    fi
    echo '{"result":{"agent":{"agent_status":"working","pane_id":"p-split"}}}';;
  "agent prompt") touch "${base}/prompted"; echo '{"result":{}}';;
  *) echo '{"result":{}}';;
esac
`,
  );
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "Options:"\necho "  --model <model>   Model alias (e.g. 'sonnet', 'haiku' or 'opus') or full name."\n`);
  writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\necho '{}'\n");
  for (const n of ["herdr", "claude", "agent-browser"]) chmodSync(join(bin, n), 0o755);
  const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...gitEnv } }).trim();
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "init");
  const env = { ...process.env, ...gitEnv, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), XDG_RUNTIME_DIR: join(base, "run"), XDG_CONFIG_HOME: join(base, "home", ".config"), AGENT_BROWSER_SOCKET_DIR: "", ORKA_BACKEND: "herdr", ORKA_NO_WATCH: "1", ORKA_MEMORY_GUARD: "off", ORKA_READY_WAIT_MS: "3000", ORKA_PROMPT_WAIT_MS: "3000" };
  const orka = (args, opts = {}) => spawnSync(process.execPath, [ORKA, ...args, "--cwd", opts.cwd || repo], { encoding: "utf8", env: { ...env, ...(opts.env || {}) }, input: opts.input });
  orka(["init"]);
  g("add", ".gitignore");
  g("commit", "-q", "-m", "ignore .orka");
  const jobFile = (id) => join(repo, ".orka", "jobs", `${id}.json`);
  const read = (id) => JSON.parse(readFileSync(jobFile(id), "utf8"));
  const write = (id, job) => writeFileSync(jobFile(id), JSON.stringify(job));
  const writeSpec = (feature, body, commit = true) => {
    const path = join(repo, "specs", feature, "spec.md");
    mkdirSync(join(repo, "specs", feature), { recursive: true });
    writeFileSync(path, body);
    if (commit) {
      g("add", path);
      g("commit", "-q", "-m", `spec ${feature}`);
    }
    return path;
  };
  // Next herdr agent is new again: names are free, then idle and ready, then working once prompted.
  const fresh = () => {
    writeFileSync(log, "");
    for (const f of readdirSync(base)) if (f === "prompted" || f.startsWith("seen-")) rmSync(join(base, f));
  };
  // An agent that already exists and is idle and ready (for steer, approve).
  const ready = (agent) => {
    fresh();
    writeFileSync(join(base, `seen-${agent}`), "");
  };
  return { base, repo, bin, log, env, g, orka, fresh, ready, jobFile, read, write, writeSpec, calls: () => readFileSync(log, "utf8") };
}

export const SAMPLE = `# Dark mode

Stage: spec
Kind: feature

## What
A toggle in the header switches the theme.

## Why
Night editing hurts the eyes.

## Limits
No new dependencies.

## Done when
- The toggle flips data-theme on <html>.
- The choice survives a reload.
`;
