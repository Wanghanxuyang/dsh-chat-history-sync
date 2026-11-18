'use strict';
// 会话健康检查：首 surface、seq 连续、标题/事件引用范围
const fs = require('fs');
const path = require('path');
const z = require('zlib');
const H = process.env.USERPROFILE || process.env.HOME;
const store = JSON.parse(fs.readFileSync(path.join(H, '.dsh', 'storages', 'workspace.json'), 'utf8'));
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const surface = (e) => e.surfaceOp !== undefined || ['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(e.type);
let total = 0, bad = 0;
for (const w of Object.values(store.tables.workspaces)) {
  for (const sid of w.sessionIds || []) {
    const p = path.join(H, '.dsh', 'sessions', '--' + w.path.replace(/[\\/:]+/g, '-') + '--', sid, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(p)) continue;
    total += 1;
    const b = fs.readFileSync(p); const offs = []; let i = 0;
    while ((i = b.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
    const ev = [];
    for (let k = 0; k < offs.length; k += 1) {
      const t = z.zstdDecompressSync(b.subarray(offs[k], offs[k + 1] || b.length)).toString('utf8');
      for (const line of t.split('\n').filter(Boolean)) { try { ev.push(JSON.parse(line)); } catch (e) { ev.push({ type: 'PARSE_ERROR' }); } }
    }
    const errs = [];
    const first = ev.find(surface);
    if (!first || first.type !== 'system/message') errs.push('first surface is not system/message');
    const seqs = ev.filter((e) => e.type !== 'session' && typeof e.seq === 'number').map((e) => e.seq);
    for (let n = 0; n < seqs.length; n += 1) if (seqs[n] !== n) { errs.push('seq gap at ' + n + ' got ' + seqs[n]); break; }
    for (const e of ev) {
      if (Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.some((s) => s >= e.seq)) errs.push('sourceEventSeqs out of range at ' + e.seq);
      if (e.type === 'session-log-deepseek/delivery-accepted' && e.data && e.data.throughSeq >= e.seq) errs.push('throughSeq out of range at ' + e.seq);
    }
    if (errs.length) { bad += 1; console.log('BAD', sid, errs.slice(0, 2)); }
  }
}
console.log(`sessions=${total} bad=${bad}`);
process.exitCode = bad ? 1 : 0;
