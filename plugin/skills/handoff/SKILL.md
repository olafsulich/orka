---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. orka runs it when a pane reaches its context cap.
argument-hint: "<note path> role=<worker|orchestrator>"
---

<!-- Matt Pocock's handoff skill (github.com/mattpocock/skills, skills/productivity/handoff, MIT, (c) 2026 Matt Pocock), adapted for orka: the note path comes from orka, the sections are fixed per role, and the turn ends after the note. -->

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the note path given in the arguments (orka keeps it in the job folder, outside the worktree), not the current workspace. With no path, use the temporary directory of the OS (`$TMPDIR`, else `/tmp`).

Include a "Next commands" section naming the commands, checks or skills the next agent should run first.

Do not duplicate content already captured in other artifacts (task brief, specs, plans, commits, diffs, decisions.tsv, results/ and notes/ files). Reference them by path, SHA or command instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

At most ~200 words. Sections, in order, by the role in the arguments:

role=worker
- Changes: files touched, paths only.
- Checks run: only commands you actually ran, with pass/fail.
- Commits: SHA and one line each, or "none".
- Still running: servers, browser sessions, background processes, anything outside the worktree.
- Notes: decisions, dead ends, what not to redo.
- Remaining slice: what is left of your task, the next concrete step first.
- Next commands.

role=orchestrator
- Plan: how the goal was split, what is done, what is left.
- Workers: each worker name, the files or area it owns, and its state (working, done, handed off, waiting on you). Do not restart or close any of them.
- Verifier: rounds so far, last verdict, failing checks.
- Steers: messages from Olaf (orka steer) not fully handled yet, quoted short.
- Waiting on: what you were waiting for (worker notes, a verifier round, a human answer).
- Next steps: the next concrete action first.
- Next commands.

Then end your turn. Start no new work. Do not write a results file or notes line, do not prompt any agent, and do not close any pane: orka starts the fresh agent.
