// 生成「分类目录.md」：分类 → 二级序号 + 月份 + 账号简称 + 会话标题
// 用法：node catalog.cjs <workspaceDir>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const wsRoot = process.argv[2];
if (!wsRoot) { console.error('usage: catalog.cjs <workspaceDir>'); process.exit(2); }
const rawDir = path.join(wsRoot, 'history', '_raw');

const MAPPING = (() => { try { return JSON.parse(fs.readFileSync(path.join(rawDir, '分类映射.json'), 'utf8')); } catch (e) { return {}; } })();
const PREFIX_MAP = (() => { try { return JSON.parse(fs.readFileSync(path.join(rawDir, 'account-prefixes.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
const CATS = [
  ['01 燃烧信号与数据分析', /振荡频率|时频|希尔伯特|horzcat|MATLAB|参数范围|程序输出|亮度|瞬时频率|ODE模拟/i],
  ['16 燃烧与流场研究', /燃烧|火焰|层流|预混|雾化|动力|三火焰|耦合振荡/i],
  ['02 燃烧设备与实验装置', /燃烧弹|加工计划|装置|喷嘴|发动机|台架|定容|材料筛选|实验台|操作规程|采购|传感器|电路/i],
  ['03 论文与投稿', /文献|综述|论文|CNF|cover|投稿|提纲|博论|评审|摘要|附信|开题|学术交流/i],
  ['04 申请与合同', /合同|申请|外派|联培|模板|风险认定|任务书|协议/i],
  ['05 报告与总结', /报告|总结|分工|说明|简历|预算|材料费|金额|经费|采购|明细|归类5项/i],
  ['06 八字命理（格局）', /八字命理|命理|格局|从儿格|五行|用神|命局|生时校正|六字|简批/i],
  ['07 合婚运势与占卜', /合婚|运势|对比|塔罗|占卜|紫微|流年|大运|命盘|算命|八字前六个|时柱/i],
  ['08 电池与传感器调研', /电池|着火|电瓶|传感器|元件|型号|搁板|参数规格/i],
  ['09 文本与数学', /去重|排序|字频|重复字|高频字|文本|字牌|归类|正则|统计|方程|数学|整数解|枚举|无解|条件矛盾|求解|算法/i],
  ['10 生活问答', /养鱼|快递|脑筋|闪退|Poster|印刷|自由职业|月入|展会|防晒|推文|照片/i],
  ['11 技术调研与其他', /插件|安装|教程|原理|概念|科普|工具|软件|命令|修复|AI|模型|评价/i],
  ['13 写作与内容创作', /小说|故事|写信|创作|文案|诗|剧本|传说|设定/i],
  ['14 自媒体与心理', /自媒体|公众号|抖音|小红书|带货|博主|画像|心理|亲密关系|分手|愧疚|拖延|治愈|情绪|内耗/i],
  ['17 学习与工作方法', /学习|复习|考试|工作|求职|论文写作方法|时间管理|文献阅读|组会/i],
  ['12 未归类会话', /./],
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
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
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
  const safeTitle = r.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 54);
  const fname = safeTitle + '-' + String(r.month).replace(/\s+/g, '') + '-' + String(r.id || '').slice(0, 8) + '.md';
  const fp = path.join(locDir, fname);
  const catName = r.cat;
  fs.writeFileSync(fp, '# ' + r.title + '\n\n- 账号：' + r.prefix + '\n- 月份：' + r.month + '\n- 分类：' + catName + '\n- 时间：' + new Date(r.t).toISOString() + '\n- 摘要：' + r.summary + '\n\n## 位置\n\n会话内容见对应月份工作区；分类仅用于本目录（不单独建工作区）。\n', 'utf8');
  locOf.set(r, '会话位置/' + fname.replace(/ /g, '%20'));
}
let md = '# 分类目录\n\n> 每条：序号 · 月份 · 账号 · 会话标题（点击打开会话位置）\n\n';
for (const name of finalNames) {
  const list = byCat.get(name);
  if (!list.length) continue;
  list.sort((a, b) => a.t - b.t);
  md += '## ' + name + '（' + list.length + '）\n\n';
  list.forEach((r, i) => {
    const no = name.slice(0, 2) + '-' + String(i + 1).padStart(2, '0');
    const title = r.title.length > 30 ? r.title.slice(0, 30) + '…' : r.title;
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
