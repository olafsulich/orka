# Feature map

`orka.features.md` at the worktree root (an existing `orca.features.md` is still read) is cross-job memory: per feature, how to reach it, drive it and prove it works, when it was last proven, and what to keep in mind. It is committed with the job. See `examples/orka.features.md`.

## Entry format

```
## Dashboard page
- Reach: `npm run dev -- --port $ORKA_PORT`, then open `http://127.0.0.1:$ORKA_PORT/`
- Drive: click "New item", type a title, press Enter
- Prove: `{"text":"#list li:last-child","includes":"<title>"}` in orka.verify.json
- Last verified: 2026-10-19 at commit `e2ef32e`
- Keep in mind:
  - the dev server needs `npm run build:css` once after a fresh clone
- Stale: reach fails on HEAD and on base; marked by <job id>; jobs since: none
```

- One `## <feature>` heading per entry. Labels are `- Label:` lines (`- **Label:**` works too).
- **Keep in mind** holds constraints the code does not show: an order that matters, a slow or flaky step, a required env var or service. It is a list of sub-bullets (an inline `- Keep in mind: x` is read as one item). It is optional.
- **Stale** is optional and only present while the entry's Reach step is broken.
- A map without these fields (the format before them) is read unchanged. orka rewrites only the entries it changes, line by line, and leaves every other line byte for byte.

## Who writes what

| Who | Reads | Writes |
| --- | --- | --- |
| Orchestrator | points workers at the map in CONTEXT | commits it with the job |
| Builder | the entries for what it touches (worker prompt) | never the map; may return `keepInMind` in `results/<name>.json` |
| Verifier | the whole map before its checks | Reach, Drive, Prove, Last verified on a pass; adds `- Stale:`; keeps Keep in mind lines |
| orka | | merges `keepInMind`, carries and drops Stale entries |

## keepInMind from builders

A builder's result may carry one of:

```json
{"worker":"builder","ok":true,"result":"...","keepInMind":["run npm ci before the tests"]}
{"keepInMind":{"Dashboard page":["the dev server needs npm run build:css once"]}}
{"keepInMind":[{"feature":"Dashboard page","note":"..."}]}
```

When the builder's turn has ended with that result written (the same moment as its [finish wake](workers.md)), orka merges it into the map, once per result file:

- A plain string goes to the `General` entry. A feature is matched by heading, ignoring case and backticks. A feature with no entry gets a new one holding only Keep in mind.
- Notes are deduped ignoring case, whitespace and a trailing period, then appended after the existing ones.
- At most 5 lines per entry: the newest 5 are kept. Each line is capped at 300 characters.
- With no map yet, orka creates `orka.features.md`.
- The wake to the orchestrator ends with `feature map: N keep-in-mind line(s) merged into <features>`, and decisions.tsv gets a `feature-map` row.

## Stale entries

When an entry's Reach step fails on HEAD and also on the base commit, the verifier does not delete the entry: it adds `- Stale: marked by <job id>`. At every verifier result orka does the following:

- normalises the line to `- Stale: reach fails on HEAD and on base; marked by <A>; jobs since: <B>, ...` (a line without a job id counts as marked by the current job);
- adds the current job to `jobs since`, unless it is the marking job;
- drops the entry once 2 jobs after the marking one have seen it stale. git keeps the history.

A verifier that finds a Stale entry's Reach working again proves it and removes the Stale line. A pass by gate alone (no verifier pane) does not count as a job here.
