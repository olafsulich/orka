#!/usr/bin/env node
// Deprecated alias: orca was renamed orka. Same CLI and stdout; one note on stderr only,
// so scripts that parse stdout keep working. Kept as a file because ~/bin/orca links here
// and process matching (pgrep "orca[.]mjs watch") may still name it.
process.stderr.write("orca is deprecated; use orka (same commands)\n");
await import("./orka.mjs");
