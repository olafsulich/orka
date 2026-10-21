# Design: context handling and collaborative jobs

Status: proposal, 2026-10-21. No code changed. Line refs are `bin/orka.mjs` and `lib/*.mjs` at `b49d0a0`.

Four topics: (1) AGENTS.md instead of CLAUDE.md, (2) a ~50% context cap with handoff to a fresh agent, (3) what to take from Limen, (4) one task split across several workers.

## 1. AGENTS.md instead of CLAUDE.md

### Verdict

**The claim is right, with one condition.** Claude Code reads `AGENTS.md` natively since v2.1.277, but by default **only when there is no `CLAUDE.md` in the working directory or any parent**.

- Docs, https://code.claude.com/docs/en/memory#agents-md: "Claude Code can read `AGENTS.md` as your project instructions, so a repository already set up for other coding agents works without adding a `CLAUDE.md`, an import, or a setting." and "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working directory or above it."
- CHANGELOG 2.1.277: "Added AGENTS.md support: in a project with no CLAUDE.md, Claude Code reads AGENTS.md instead; change it under "Project instructions" in `/config`".
- What blocks it: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` in cwd or above. `~/.claude/CLAUDE.md` does not block it. The "Project instructions" setting has `claude-md`, `claude-md-or-agents-md` (default), `claude-md-and-agents-md`, `managed-only`; it is honoured only in user, `--settings` or managed settings, not project settings. An `@AGENTS.md` import or a symlink still works and is never read twice.
- Local proof: `claude --version` → `2.1.306`; the binary `~/.local/share/claude/versions/2.1.306` contains `claude-md-or-agents-md` (8×) and the log line `no CLAUDE.md found; AGENTS.md loaded` (2×).
- **Pi** (`@earendil-works/pi-coding-agent` 0.87.0, installed) reads one file per directory, first match of `["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]` (`dist/core/resource-loader.js:33`), walking up from cwd, plus `~/.pi/agent/AGENTS.md`. Pi does not expand `@file` imports.

So with both files present, **Claude reads CLAUDE.md and Pi reads AGENTS.md**. That split is the only real hazard.

### Current state

- orka never names either file: `grep -n "CLAUDE.md\|AGENTS.md" bin/orka.mjs lib/*.mjs` is empty. All rules reach agents through the first `herdr agent prompt` (`orchestratorPrompt` `bin/orka.mjs:1572`, `workerPrompt` `:1158`). `startArgs` passes only `--model` (`bin/orka.mjs:927-931`).
- The orka repo has neither file.
- Target repos on this VPS: `diagram-framework`, `mega-press` have AGENTS.md only; `mega-dev`, `jk-skills` have AGENTS.md plus a CLAUDE.md that imports it (`@AGENTS.md`; mega-dev also imports `@BRAIN.md @.pi/APPEND_SYSTEM.md`, which Pi will not see); `motion-lab`, `motion-craft`, `thumb-lab`, `vault-audit` have neither.
- Job worktrees live **inside** the target repo, at `<repo>/.orka/worktrees/<id>` (`worktreePath`, `bin/orka.mjs:406`). Both agents walk up from cwd, so a pane sees the worktree's committed copy *and* the primary checkout's copy (possibly newer or uncommitted). Whether Claude dedupes two identical AGENTS.md files at different paths is **unknown**; not tested.

### Proposal

- **orka itself:** add `AGENTS.md` (what orka is, the test command, file layout, "never close panes", no push). No `CLAUDE.md`. Native read covers Claude ≥2.1.277; Pi reads it too.
- **Target repos: orka writes nothing into them.** It checks and warns at `orka run` and `orka run --dry-run`:
  - AGENTS.md only → fine for both. Warn if `claude --version` < 2.1.277.
  - CLAUDE.md only → fine for both (Pi falls back to CLAUDE.md). Warn only if CLAUDE.md uses `@imports`, since Pi will not follow them.
  - Both, and CLAUDE.md does not import AGENTS.md (and is not a symlink to it) → warn: "Claude and Pi workers will read different rules. Make CLAUDE.md a one-line `@AGENTS.md`."
  - Neither → nothing.
- **Recommended setup for Olaf's repos:** AGENTS.md is the one source. Either no CLAUDE.md, or a CLAUDE.md that is exactly `@AGENTS.md` (needed only where a CLAUDE.md must exist for other tools, or for `InstructionsLoaded` hooks, which do not fire for the native read).
- Do not set "Project instructions" to `claude-md-and-agents-md` globally: with a both-files repo it loads two diverging files into every Claude pane.

### Open questions

1. Is a `orka run` warning enough, or should orka refuse to start a mixed Claude/Pi job when the two files diverge?
2. The worktree-inside-repo double read: test it (one job, compare `/context` or the session's loaded-files log), then decide whether orka should pass `--settings` with `claudeMdExcludes` for the primary checkout. Needs a measurement first.

### Follow-up tasks

| file | scope | size |
|------|-------|------|
| `tasks/16-orka-agents-md.md` | Write `AGENTS.md` for the orka repo. | S |
| `tasks/17-context-file-check.md` | `orka run` / dry-run detect the four cases above and warn; Claude version check; tests with fixture repos. | S |
| `tasks/18-worktree-double-read.md` | Measure whether a pane in `.orka/worktrees/<id>` loads the primary checkout's AGENTS.md too; write the result into this doc. | S |
