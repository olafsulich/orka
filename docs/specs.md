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

## Lessons

`orka done` on a spec'd job appends what the job learned to a `## Lessons` section at the end of the spec, and commits only that file on the job branch (`Spec lessons: <feature> (job <id>)`). It merges with the rest of the branch, so lessons reach main only when you merge. It never writes on main: it writes in the job worktree only, and only while that worktree is on the job's own branch; otherwise it prints `lessons: skipped (...)`.

Sources, one line each, capped at 180 characters:

| kind | from |
| --- | --- |
| `rejected` | `orka strategy` rows (the premise dropped and what replaced it), and decisions.tsv rows whose decision or why says rejected, reverted, abandoned, dropped or ruled out |
| `steer` | delivered `orka steer` messages |
| `check` | verifier checks that failed in a round, with the first evidence line: "failed in round N before passing" or "still failing at the end" |
| `flaky` | checks the verifier showed failing on the base commit too (pre-existing warnings) |
| `gave-up` | the `--give-up` reason |

Line shape: `- <date> <kind>: <text> (job <id>)`, plus ` xN` when N jobs hit the same lesson.

Kept compact at append time (no nightly pass):

- **Dedupe:** the same kind and text (case and punctuation ignored) is not added twice. A follow-up round of the same job adds only new lessons; another job hitting it bumps ` xN` and the date.
- **Cap:** at most 20 lesson lines. Over that, the lines with the lowest count, oldest first, fold into one `compressed: N older lessons folded` line. The full text stays in the git history of the spec.
- The spec is excluded from the job's patch id, so the lessons commit never makes a verifier pass stale.
- `orka done --dry-run` prints `lessons: would update ...` and writes nothing. `orka status <id>` shows the counts and the commit; decisions.tsv gets a `lessons` row.
