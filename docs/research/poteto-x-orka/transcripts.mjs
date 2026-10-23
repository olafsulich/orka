// Per-session stats for Orka job panes (orchestrator / worker / verifier) from Claude Code transcripts.
// Usage: node transcripts.mjs > sessions.json
// Snapshot used in docs/research/poteto-x-orka.md: 2026-10-22, 839 sessions. ENV_PROBE is a proxy, not a classifier.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root = '/home/olaf/.claude/projects';
const ENV_PROBE = /\b(which|command -v|type -a)\s|\s--version\b|\s-version\b|echo \$PATH|ls (-\S+ )*(~|\/home\/olaf)\/bin|\bnpm (ci|install|i)\b|ln -s\S* \S*node_modules|ls (-\S+ )*\S*node_modules|PATH=\S*bin|free -[mgh]|df -h|nproc/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

async function scan(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let role = null, first = null, turns = new Set(), tools = 0, probes = 0, toolsBeforeEdit = null, probeSamples = [];
  let firstTs = null, lastTs = null, userCorrections = 0;
  for await (const line of rl) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.timestamp) { firstTs ??= m.timestamp; lastTs = m.timestamp; }
    const msg = m.message;
    if (!msg) continue;
    if (m.type === 'user' && !first) {
      const c = msg.content; const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(x => x.text || '').join(' ') : '');
      if (t.trim()) {
        first = t.slice(0, 200);
        role = /You are the verifier/.test(t) ? 'verifier' : /You are a worker/.test(t) ? 'worker' : /You are the orchestrator/.test(t) ? 'orchestrator' : 'other';
      }
    } else if (m.type === 'user' && first && !m.isSidechain) {
      const c = msg.content; const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '');
      if (t.trim()) userCorrections++;
    }
    if (m.type === 'assistant' && Array.isArray(msg.content)) {
      if (msg.id) turns.add(msg.id);
      for (const b of msg.content) {
        if (b.type !== 'tool_use') continue;
        tools++;
        if (EDIT_TOOLS.has(b.name) && toolsBeforeEdit === null) toolsBeforeEdit = tools - 1;
        const cmd = b.name === 'Bash' ? String(b.input?.command || '') : '';
        if (cmd && ENV_PROBE.test(cmd)) { probes++; if (probeSamples.length < 3) probeSamples.push(cmd.slice(0, 120)); }
      }
    }
  }
  return { role, turns: turns.size, tools, probes, toolsBeforeEdit, userMsgs: userCorrections, mins: firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 60000 : null, probeSamples };
}

const out = [];
for (const d of fs.readdirSync(root)) {
  const mm = d.match(/^-home-olaf-projects-(.+?)--orca-worktrees-(\d{17})-/);
  if (!mm) continue;
  for (const f of fs.readdirSync(path.join(root, d))) {
    if (!f.endsWith('.jsonl')) continue;
    const s = await scan(path.join(root, d, f));
    if (!s.role) continue;
    out.push({ project: mm[1], job: mm[2], session: f, ...s });
  }
}
console.log(JSON.stringify(out));
