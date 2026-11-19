// 生成「分类目录.md」：分类 → 二级序号 + 月份 + 账号简称 + 会话标题
// 用法：node catalog.cjs <workspaceDir>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const wsRoot = process.argv[2];
if (!wsRoot) { console.error('usage: catalog.cjs <workspaceDir>'); process.exit(2); }
const rawDir = path.join(wsRoot, 'history', '_raw');
if (!fs.existsSync(rawDir)) process.exit(0);

const MAPPING = (() => { try { return JSON.parse(fs.readFileSync(path.join(rawDir, '分类映射.json'), 'utf8')); } catch (e) { return {}; } })();
const PREFIX_MAP = (() => { try { return JSON.parse(fs.readFileSync(path.join(rawDir, 'account-prefixes.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
const CATS = [
  ['01 工作与项目', /工作|项目|任务|会议|计划|汇报|排期|需求|客户|合同|申请/i],
  ['02 学习与研究', /学习|研究|论文|文献|考试|课程|实验|数据|分析|综述/i],
  ['03 技术与工具', /技术|代码|程序|软件|插件|安装|教程|工具|命令|AI|模型|系统/i],
  ['04 写作与表达', /写作|文章|文案|故事|剧本|改写|总结|报告|简历|翻译/i],
  ['05 生活与日常', /生活|健康|旅行|美食|购物|家庭|情感|运动|理财|养宠/i],
  ['06 其他', /./],
];

const cleanSummaryText = (s) => String(s || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/[#*_>`]+/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const clipSummary = (s, n) => {
  const t = String(s || '').trim();
  if (!t) return '';
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/[，。；、：\s]+$/, '') + '…';
};
const firstSentence = (s) => {
  const t = cleanSummaryText(s);
  const m = t.match(/^(.{1,60}?)([。！？!?]|$)/);
  return m ? m[1] : t.slice(0, 60);
};
const buildSummary = (title, msgs) => {
  const list = Array.isArray(msgs) ? msgs : [];
  const isUser = (m) => String(m.role || '').toUpperCase() === 'USER';
  const users = list.filter(isUser).map((m) => cleanSummaryText(m.text)).filter((t) => t && t.length > 3);
  const assistants = list.filter((m) => !isUser(m)).map((m) => cleanSummaryText(m.text)).filter(Boolean);
  const q1 = users[0] || '';
  const q2 = users.find((t, i) => i > 0 && t.slice(0, 12) !== q1.slice(0, 12)) || '';
  const a1 = assistants.length ? firstSentence(assistants.find((t) => t.length > 12) || assistants[0]).replace(/^(以下是|好的|你好|您好)[，,：:\s]*/u, '') : '';
  let summary = '';
  if (q1) summary += '用户先问' + clipSummary(q1, 36);
  if (q2) summary += '，随后追问' + clipSummary(q2, 22);
  if (a1) summary += '；助手给出' + clipSummary(a1, 26);
  if (!summary) summary = '该会话暂无可用文字摘要';
  while ([...summary].length < 50) summary += '；更多细节与附件请点击会话位置查看';
  if ([...summary].length > 100) summary = [...summary].slice(0, 99).join('') + '…';
  return summary;
};
const files = fs.readdirSync(rawDir).filter((f) => /^conversations\..+\.json$/.test(f));
const rows = [];
for (const f of files) {
  const p = path.join(rawDir, f);
  if (!fs.existsSync(p)) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('skip corrupt dataset:', f); continue; }
  if (!Array.isArray(d.conversations)) { console.error('skip invalid dataset:', f); continue; }
  const prefix = PREFIX_MAP[f] || (f === 'conversations.full.json' ? '账号' : f.replace(/^conversations\./, '').replace(/\.json$/, ''));
  for (const c of d.conversations) {
    const t = typeof c.updated_at === 'number' ? c.updated_at * 1000 : Date.parse(String(c.updated_at || '')) || Date.now();
    const dt = new Date(t);
    const month = dt.getFullYear() + ' 年 ' + (dt.getMonth() + 1) + ' 月';
    const firstUser = (c.messages || []).find((m) => m.role === 'user');
    const hay = (c.title || '') + ' ' + String((firstUser && firstUser.text) || '').slice(0, 400);
    let cat = MAPPING[c.title];
    if (!cat) { cat = CATS[CATS.length - 1][0]; for (const [name, re] of CATS) { if (re.test(hay)) { cat = name; break; } } }
    const summary = buildSummary(c.title, c.messages);
    rows.push({ cat, month, prefix, title: c.title, t, summary, id: c.id || '', sig: crypto.createHash('sha1').update(JSON.stringify(c.messages || [])).digest('hex') });
  }
}

const catNames = [...new Set([...Object.values(MAPPING), ...CATS.map(([name]) => name)])].sort((a, b) => String(a).localeCompare(String(b), 'zh'));
const byCat = new Map(catNames.map((name) => [name, []]));
for (const r of rows) byCat.get(r.cat).push(r);

// 每类目标 5–9 条：超过 9 条时均分为「（续）」子类，保证记忆负担
for (const name of [...byCat.keys()]) {
  const list = byCat.get(name);
  if (list.length > 9) {
    const half = Math.ceil(list.length / 2);
    byCat.set(name, list.slice(0, half));
    byCat.set(name + '（续）', list.slice(half));
  }
}
const finalNames = [...byCat.keys()].filter((n) => byCat.get(n).length).sort((a, b) => String(a).localeCompare(String(b), 'zh'));

const locDir = path.join(rawDir, '会话位置');
fs.mkdirSync(locDir, { recursive: true });
const locOf = new Map();
for (const r of rows) {
  const safeTitle = String(r.title).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 54);
  const fname = safeTitle + '-' + String(r.month).replace(/\s+/g, '') + '-' + String(r.id || '').slice(0, 8) + '.md';
  const fp = path.join(locDir, fname);
  const catName = r.cat;
  const cleanFullTitle = String(r.title).replace(/[\r\n]+/g, ' ');
  const cleanSummary = String(r.summary).replace(/[\r\n]+/g, ' ');
  fs.writeFileSync(fp, '# ' + cleanFullTitle + '\n\n- 账号：' + r.prefix + '\n- 月份：' + r.month + '\n- 分类：' + catName + '\n- 时间：' + new Date(r.t).toISOString() + '\n- 摘要：' + cleanSummary + '\n\n## 位置\n\n会话内容见对应月份工作区；分类仅用于本目录（不单独建工作区）。\n', 'utf8');
  locOf.set(r, '会话位置/' + encodeURIComponent(fname));
}
let md = '# 分类目录\n\n> 每条：序号 · 月份 · 账号 · 会话标题（点击打开会话位置）\n\n';
for (const name of finalNames) {
  const list = byCat.get(name);
  if (!list.length) continue;
  list.sort((a, b) => a.t - b.t);
  md += '## ' + name + '（' + list.length + '）\n\n';
  list.forEach((r, i) => {
    const no = name.slice(0, 2) + '-' + String(i + 1).padStart(2, '0');
    const cleanTitle = String(r.title).replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '_');
    const title = cleanTitle.length > 30 ? cleanTitle.slice(0, 30) + '…' : cleanTitle;
    const link = locOf.get(r) || '';
    md += '- ' + no + ' · ' + r.month + ' · ' + r.prefix + ' · [' + title + '](' + link + ')\n  - 摘要：' + r.summary + '\n';
  });
  md += '\n';
}
// 同名不同内容：保留全部，并给出可复查入口（同名文件不再互相覆盖）
const byTitle = new Map();
for (const r of rows) {
  if (!byTitle.has(r.title)) byTitle.set(r.title, []);
  byTitle.get(r.title).push(r);
}
const dupGroups = [];
for (const [title, list] of byTitle) {
  if (new Set(list.map((r) => r.sig)).size > 1) dupGroups.push([title, list]);
}
let dupText = '# 同名不同内容\n\n> 同名但内容不完全一致的会话全部保留；点标题打开各自会话位置。\n\n';
for (const [title, list] of dupGroups) {
  dupText += '## ' + title + '（' + list.length + ' 个版本）\n\n';
  for (const r of list) {
    dupText += '- ' + r.month + ' · ' + r.prefix + ' · [' + title + '](' + (locOf.get(r) || '') + ')\n  - 摘要：' + r.summary + '\n';
  }
  dupText += '\n';
}
if (dupGroups.length) {
  fs.writeFileSync(path.join(rawDir, '同名不同内容.md'), dupText, 'utf8');
  md = md.replace('> 每条：序号 · 月份 · 账号 · 会话标题（点击打开会话位置）\n\n', '> 每条：序号 · 月份 · 账号 · 会话标题（点击打开会话位置）\n> 同名不同内容保留 ' + dupGroups.length + ' 组，见 同名不同内容.md\n\n');
}
const out = path.join(rawDir, '分类目录.md');
fs.writeFileSync(out, md, 'utf8');
console.log('catalog written:', out, '| sessions:', rows.length);
