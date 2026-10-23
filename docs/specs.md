# Specs

A spec is a committed file in the **target repo**: `specs/<feature>/spec.md`. It says what the feature is, why it matters, its limits and when it is done. Unlike a brief in `.orka/briefs/` (gitignored), a spec has history and lives next to the code it describes.

## Make one

```bash
orka spec init dark-mode          # writes specs/dark-mode/spec.md in this checkout
$EDITOR specs/dark-mode/spec.md   # fill What, Why, Limits, Done when
git add specs/dark-mode/spec.md && git commit -m "Spec: dark mode"
orka new --spec specs/dark-mode   # the folder or the spec.md path
```

Template:

```markdown
# <feature>

Stage: idea          # idea | spec | building | shipped | parked
Kind: feature        # feature | bugfix | trivial
Created: <date>

## What
## Why
## Limits
## Done when
```

orka never writes a spec on its own. `spec init` only scaffolds the file; committing it is up to you.

## What `orka new --spec` does

- Refuses a spec that is not committed at HEAD (the job worktree is checked out from HEAD, so an uncommitted spec would not be there), or whose What or Done when section is empty. Template comments do not count as text.
- Title: `--title`, else the spec's `# ` heading.
- Goal (the intake): the What, Why, Limits and Done when sections, plus a line naming the spec and its commit. `--goal`, if given, is put before it.
- Stores `job.spec = {path, feature, commit}`. `orka status <id>` prints `spec: <path> @<sha8>`.

## Where the spec goes

- **Orchestrator:** the goal above, plus a pointer: the spec is in the worktree, orka pastes it into briefs, and every Done when line goes into the verifier `--task`.
- **Workers and verifier:** a `SPEC (<path>, ...)` block with the full spec text, read from the job worktree (so it is the job branch copy), capped at 6000 characters with a pointer to the file.
