// Aggregate Orka job records across projects. Usage: node jobs.mjs > jobs.json
// Snapshot used in docs/research/poteto-x-orka.md: 2026-10-22, 125 job records.
import fs from 'node:fs';
import path from 'node:path';

const projects = ['diagram-framework', 'motion-craft', 'motion-lab', 'orca', 'thumb-lab', 'vault-audit'];
const rows = [];
for (const p of projects) {
  const d = `/home/olaf/projects/${p}/.orca/jobs`;
  for (const f of fs.readdirSync(d)) {
    if (!/^\d+-[^.]+\.json$/.test(f)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(d, f)));
    const dir = path.join(d, j.id);
    const roles = {};
    for (const w of j.workers || []) roles[w.role || 'builder'] = (roles[w.role || 'builder'] || 0) + 1;
    let decisions = [];
    try {
      decisions = fs.readFileSync(path.join(dir, 'decisions.tsv'), 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'));
    } catch {}
    const v = j.verifier || {};
    const failing = (v.history || []).flatMap(h => (h.failing || []).map(x => typeof x === 'string' ? x : x.check || x.name || JSON.stringify(x)));
    const dur = j.started && j.finished ? (Date.parse(j.finished) - Date.parse(j.started)) / 60000 : null;
    rows.push({
      project: p, id: j.id, title: j.title, status: j.status, stopReason: j.stopReason,
      playbook: j.playbook || null, jobType: j.jobType || null,
      goalLen: (j.goal || '').length, goalIsBrief: /briefs\//.test(j.goal || ''),
      workers: (j.workers || []).length, roles,
      builderTaskLens: (j.workers || []).filter(w => w.role !== 'verifier').map(w => (w.task || '').length),
      structuredBrief: (j.workers || []).some(w => /^GOAL:/m.test(w.task || '') && /ACCEPTANCE:/m.test(w.task || '')),
      steers: (j.steers || []).length, steerTexts: (j.steers || []).map(s => typeof s === 'string' ? s : s.text || s.message || JSON.stringify(s)),
      followUp: !!j.followUp, round: j.round || 1, finishRounds: (j.finishRounds || []).length,
      vRounds: v.rounds || 0, verdict: v.verdict || null, history: (v.history || []).map(h => h.verdict),
      failing, stall: v.stall || null, strategyChanges: (v.strategyChanges || []).length, stale: v.stale || false,
      verify: j.verify ? j.verify.status : null,
      durMin: dur, decisions: decisions.length, decisionPhases: decisions.map(r => r[1]),
      split: decisions.filter(r => r[1] === 'split').map(r => r[2] + ' || ' + r[3]),
      models: [j.orchestratorModel, j.workerModel, j.verifierModel].join('/'),
    });
  }
}
console.log(JSON.stringify(rows, null, 1));
