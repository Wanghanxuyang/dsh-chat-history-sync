// 会话导出：把网页端数据集导出为 Markdown + JSON（每会话一份），防锁定
// 用法：node export.cjs <workspaceDir>
const fs = require('fs');
const path = require('path');
const wsRoot = process.argv[2];
if (!wsRoot) { console.error('usage: export.cjs <workspaceDir>'); process.exit(2); }
const rawDir = path.join(wsRoot, 'history', '_raw');
const outDir = path.join(rawDir, '导出');
const PREFIX_MAP = (() => { try { return JSON.parse(fs.readFileSync(path.join(rawDir, 'account-prefixes.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(rawDir).filter((f) => /^conversations\..+\.json$/.test(f));
let total = 0;
for (const f of files) {
  const p = path.join(rawDir, f);
  if (!fs.existsSync(p)) continue;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const prefix = PREFIX_MAP[f] || (f === 'conversations.full.json' ? '账号' : f.replace(/^conversations\./, '').replace(/\.json$/, ''));
  const accDir = path.join(outDir, prefix);
  fs.mkdirSync(accDir, { recursive: true });
  for (const c of d.conversations) {
    const safeTitle = String(c.title || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '未命名';
    // JSON 导出
    fs.writeFileSync(path.join(accDir, safeTitle + '.json'), JSON.stringify(c, null, 2), 'utf8');
    // Markdown 导出
    let md = '# ' + c.title + '\n\n';
    md += '> 账号：' + prefix + ' · 更新：' + (c.updated_at || '') + '\n\n';
    for (const m of c.messages || []) {
      const who = String(m.role || '').toUpperCase() === 'USER' ? '🙂 用户' : '🤖 助手';
      md += '## ' + who + '\n\n';
      if (m.thinking) md += '<details><summary>思考</summary>\n\n' + m.thinking + '\n\n</details>\n\n';
      if (m.text) md += m.text + '\n\n';
      if (m.files && m.files.length) md += '**附件**：' + m.files.map((x) => x.name).join('、') + '\n\n';
    }
    fs.writeFileSync(path.join(accDir, safeTitle + '.md'), md, 'utf8');
    total += 1;
  }
}
console.log('exported conversations:', total, '->', outDir);
