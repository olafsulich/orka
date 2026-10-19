# Feature map

Cross-job memory for orca verifiers. Read it first; on a pass, update the entries you touched.
An entry is only trusted when its commit equals HEAD. If it is older, re-prove it.

## Dashboard page
- Reach: `npm run dev -- --port $ORCA_PORT`, then open `http://127.0.0.1:$ORCA_PORT/`
- Drive: click "New item", type a title, press Enter
- Prove: `{"text":"#list li:last-child","includes":"<title>"}` in orca.verify.json
- Last verified: 2026-10-19 at commit `e2ef32e`

## CLI export command
- Reach: `node bin/cli.mjs export --out /tmp/out.json`
- Drive: run the command with a populated data dir
- Prove: exit code 0 and `/tmp/out.json` parses as JSON with a non-empty `items` array
- Last verified: 2026-10-19 at commit `e2ef32e`
