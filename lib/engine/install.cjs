'use strict';
/*
 * dsh-memory-sync · 纯增量安装器 v3
 * ---------------------------------------------------------------------------
 * 目标：把「每次全量重写 270 个会话」改成「按内容指纹只写变化的部分」。
 * 铁律：只增不减 / 零丢失；覆盖前备份 workspace.json 与会话文件；不碰 DSH 自建会话。
 *
 * 默认行为（无参数）：
 *   - 用 history/_raw/install-manifest.json 跳过未变化的会话副本（0 写入）
 *   - 变化的会话「原地换版」：沿用原 sessionId 重写日志 + projcache（先备份）
 *   - 分类变更导致工作区变化时「移动」会话（沿用 sessionId，旧目录整体搬走）
 *   - 数据集里已消失的会话：默认「保留 + 报告」，绝不自动删除（--allow-removals 才删）
 *   - 孤儿会话（文件在、store 不在、无 manifest 记录）：仅当内容匹配且无可见副本时收养
 *   - 任何旧文件解析失败：不覆盖、不删除，只报告
 *
 * 参数：
 *   --dry-run          纯计划，只读，不写任何文件
 *   --json             输出机器可读摘要（可与 --dry-run 同用）
 *   --verbose          打印逐条动作
 *   --force-full       忽略 manifest，全量重建（渲染逻辑改动后的应急 / 验收）
 *   --allow-removals   允许「备份后删除」确实从数据集中消失的会话（默认关闭）
 *   --no-adopt         不收养孤儿，只报告
 *   --revive           manifest 记录过、但 store 不再列出的会话重新纳入（默认不复活）
 *   --rotate-ids       重建时改用新 sessionId（老行为回退开关；会产生旧副本残留）
 *   --sandbox <dir>    端到端演练：<dir>/workspace 为工作区、<dir>/dsh 为 DSH home
 *   --report <file>     把 JSON 摘要写入文件（供测试 / 插件集成）
 *   --assume-dsh-stopped 跳过进程检查（仅在已用其它方式确认 DSH 完全退出时使用）
 */

const fs = require('fs');
const path = require('path');
const z = require('zlib');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');

// ===== 0. 参数与环境 =====
const BUILD_VERSION = 4;
const KEY_VERSION = 2;
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const optVal = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };

const DRY = has('--dry-run');
const AS_JSON = has('--json');
const VERBOSE = has('--verbose');
const FORCE_FULL = has('--force-full');
const ALLOW_REMOVALS = has('--allow-removals');
const NO_ADOPT = has('--no-adopt');
const REVIVE = has('--revive');
const ROTATE_IDS = has('--rotate-ids');
const KEEP_CATEGORIES = has('--keep-categories');
const SANDBOX = optVal('--sandbox');
const REPORT_FILE = optVal('--report');
const ASSUME_STOPPED = has('--assume-dsh-stopped');

const SANDBOX_ROOT = SANDBOX ? path.resolve(SANDBOX) : null;
const ROOT = SANDBOX_ROOT
  ? path.join(SANDBOX_ROOT, 'workspace')
  : (process.env.DSH_SYNC_WORKSPACE ? path.resolve(process.env.DSH_SYNC_WORKSPACE) : path.resolve(process.cwd()));
const DSH = SANDBOX_ROOT ? path.join(SANDBOX_ROOT, 'dsh') : (process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(process.env.USERPROFILE, '.dsh'));
const STORE = path.join(DSH, 'storages', 'workspace.json');
const CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');
const SESS = path.join(DSH, 'sessions');
const WS_ROOT = path.join(ROOT, 'history', 'ws');
const RAW = path.join(ROOT, 'history', '_raw');
const MANIFEST = path.join(RAW, 'install-manifest.json');
const AUDIT = path.join(RAW, 'install-audit.jsonl');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP_DIR = path.join(DSH, 'sessions-backup-' + TS);
const T0 = Date.now();

// ===== 1. 通用工具 =====
const safe = (s) => {
  let t = String(s || '').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  t = t.replace(/[. ]+$/, '');
  if (!t || t === '.' || t === '..') return '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(t)) t = '_' + t;
  return t.slice(0, 80);
};
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const slugify = (p) => '--' + p.replace(/[\\/:]+/g, '-') + '--';
const relPath = (from, to) => path.relative(from, to).replace(/\\/g, '/').replace(/ /g, '%20');
const normPath = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();
const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fmtDate = (v) => {
  if (!v) return '';
  const n = Number(v);
  return Number.isFinite(n) && n > 1e9 ? new Date(n * 1000).toISOString().slice(0, 10) : String(v);
};
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return fallback; }
}
function writeFileAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
const say = (s) => { if (!AS_JSON) console.log(s); };
const vlog = (s) => { if (!AS_JSON && VERBOSE) console.log(s); };
const actions = [];

// DSH 进程状态：'stopped' | 'running' | 'unknown'（无法确认时失败关闭，绝不静默放行）
function dshState() {
  if (SANDBOX || ASSUME_STOPPED) return 'stopped';
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
    });
    return /DeepSeek Harness\.exe/i.test(out) ? 'running' : 'stopped';
  } catch (e) {
    return 'unknown';
  }
}
function assertDshStopped() {
  const s = dshState();
  if (s === 'stopped') return;
  if (s === 'running') {
    console.error('ERROR: 检测到 DeepSeek Harness 仍在运行（含托盘）。请完全退出后重试。未做任何修改。');
  } else {
    console.error('ERROR: 无法确认 DeepSeek Harness 是否已退出（tasklist 不可用或被执行环境限制）。');
    console.error('       为避免覆盖运行中的 store / 会话文件，安装已中止，未做任何修改。');
    console.error('       请先完全关闭 DSH 后重试；或自行确认已退出后加 --assume-dsh-stopped。');
  }
  process.exit(1);
}

// ===== 2. 数据集（动态发现任意 conversations.<key>.json） =====
// account-prefixes.json 由插件按用户在设置里填的「简称」写入：{ "conversations.demo.json": "主号" }
// key 是数据集文件标识（稳定，用于 manifest），prefix 是标题里显示的简称（可改，改了会按内容重建）。
const PREFIX_MAP = readJson(path.join(RAW, 'account-prefixes.json'), {}) || {};
const ACCOUNTS = (() => {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(RAW); } catch (e) {}
  for (const f of files) {
    if (!/^conversations\..+\.json$/.test(f)) continue;
    const p = path.join(RAW, f);
    if (f === 'conversations.full.json') {
      const display = safe(PREFIX_MAP[f] || '账号') || '账号';
      out.push({ key: 'account', prefix: display, file: p, root: WS_ROOT });
      continue;
    }
    const key = f.replace(/^conversations\./, '').replace(/\.json$/, '');
    if (!key || key === 'full') continue;
    const display = safe(PREFIX_MAP[f] || key) || key;
    out.push({ key, prefix: display, file: p, root: path.join(ROOT, 'history', 'ws-' + safe(key)) });
  }
  out.sort((a, b) => (a.key === 'account' ? -1 : b.key === 'account' ? 1 : a.key.localeCompare(b.key)));
  return out;
})();
say('accounts: ' + ACCOUNTS.map((a) => a.prefix + '(' + a.key + ')').join(' / '));
const convs = [];
const datasets = {};
for (const acc of ACCOUNTS) {
  if (!fs.existsSync(acc.file)) { say('missing dataset ' + acc.file); continue; }
  const stt = fs.statSync(acc.file);
  let d;
  try { d = JSON.parse(fs.readFileSync(acc.file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { say('skip corrupt dataset ' + acc.file); continue; }
  if (!d || !Array.isArray(d.conversations)) { say('skip invalid dataset ' + acc.file); continue; }
  datasets[acc.key] = { file: acc.file, size: stt.size, mtimeMs: Math.round(stt.mtimeMs), convCount: d.conversations.length };
  for (const c of d.conversations) convs.push({ ...c, __prefix: acc.prefix, __key: acc.key, __root: acc.root, __convKey: acc.key + '|' + c.id });
}
say('loaded conversations: ' + convs.length);
const normUserText = (text) => String(text || '')
  .replace(/\n\n📎 [^\n]*$/, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80);
// per-conversation filtering happens inside extractDshOnlyTurns; no global dataset fingerprint set.


// ===== 3. 附件索引 =====
const fileIndex = new Map();
const convDirs = new Map();
for (const acc of ACCOUNTS) {
  if (!fs.existsSync(acc.root)) continue;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (!e.isDirectory()) continue;
      const kids = fs.readdirSync(p, { withFileTypes: true });
      const hasDirs = kids.some((k) => k.isDirectory());
      if (hasDirs) { walk(p); continue; }
      const files = kids.filter((k) => k.isFile());
      if (!files.length) continue;
      const key = acc.key + '|' + e.name;
      if (!convDirs.has(key) || !fs.readdirSync(convDirs.get(key)).length) convDirs.set(key, p);
      else {
        try { if (fs.statSync(p).mtimeMs > fs.statSync(convDirs.get(key)).mtimeMs) convDirs.set(key, p); } catch (e) {}
      }
      for (const f of files) {
        const fk = key + '|' + f.name;
        const existing = fileIndex.get(fk);
        try {
          if (!existing || fs.statSync(path.join(p, f.name)).mtimeMs > fs.statSync(existing).mtimeMs) fileIndex.set(fk, path.join(p, f.name));
        } catch (e) {}
      }
    }
  };
  walk(acc.root);
}
const convDirOf = (conv) => convDirs.get(conv.__key + '|' + (safe(conv.title) || '未命名')) || null;
const findFile = (conv, f) => {
  const dir = safe(conv.title) || '未命名';
  const convTag = sha256(String(conv.__key || '') + '|' + String(conv.id || '')).slice(0, 8);
  const id8 = String(f.id || '').replace(/^file-/, '').slice(0, 8);
  const hit = fileIndex.get(conv.__key + '|' + dir + '|' + convTag + '_' + id8 + '_' + safe(f.name))
    || fileIndex.get(conv.__key + '|' + dir + '|' + id8 + '_' + safe(f.name))
    || fileIndex.get(conv.__key + '|' + dir + '|' + safe(f.name));
  if (hit) return hit;
  let fallback = null;
  let matches = 0;
  for (const [k, v] of fileIndex) {
    if (k.startsWith(conv.__key + '|') && k.endsWith('|' + dir + '|' + safe(f.name))) {
      fallback = v;
      matches += 1;
      if (matches > 1) break;
    }
  }
  return matches === 1 ? fallback : null;
};

// ===== 4. 布局（月份 + 分类，与旧版一致） =====
const CATS = [
  { title: '01 工作与项目', slug: '01-work' },
  { title: '02 学习与研究', slug: '02-study' },
  { title: '03 技术与工具', slug: '03-tech' },
  { title: '04 写作与表达', slug: '04-writing' },
  { title: '05 生活与日常', slug: '05-life' },
  { title: '06 其他', slug: '06-misc' },
];
const RULES = [
  ['01-work', /工作|项目|任务|会议|计划|汇报|排期|需求|客户|合同|申请/i],
  ['02-study', /学习|研究|论文|文献|考试|课程|实验|数据|分析|综述/i],
  ['03-tech', /技术|代码|程序|软件|插件|安装|教程|工具|命令|AI|模型|系统/i],
  ['04-writing', /写作|文章|文案|故事|剧本|改写|总结|报告|简历|翻译/i],
  ['05-life', /生活|健康|旅行|美食|购物|家庭|情感|运动|理财|养宠/i],
];
const classify = (c) => {
  const firstUser = (c.messages || []).find((m) => m.role === 'user');
  const hay = (c.title || '') + ' ' + ((firstUser && firstUser.text) || '').slice(0, 400);
  for (const [slug, re] of RULES) if (re.test(hay)) return slug;
  return '06-misc';
};
const monthMap = new Map();
const catMap = new Map(CATS.map((c) => [c.slug, []]));
convs.forEach((c, i) => {
  const t = typeof c.updated_at === 'number' ? c.updated_at * 1000 : Date.parse(String(c.updated_at || '')) || Date.now();
  const d = new Date(t);
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  if (!monthMap.has(key)) monthMap.set(key, []);
  monthMap.get(key).push(i);
  catMap.get(classify(c)).push(i);
  c.__createdAt = t;
});
const MONTHS = [...monthMap.keys()].sort().reverse().map((k) => {
  const [y, m] = k.split('-');
  return { title: y + ' 年 ' + Number(m) + ' 月', slug: 'month-' + k, idx: monthMap.get(k) };
});
// 布局：DSH 工作区只保留月份；分类不再建工作区，只出现在同步报告/分类目录里。
// 旧版本建过的分类工作区（以及其中的会话副本）会在本次安装中「合并补聊 → 备份 → 退役」。
const RETIRE_CATEGORIES = !KEEP_CATEGORIES;
const PLAN = MONTHS.filter((c) => c.idx.length > 0);
say('dist(仅报告): ' + CATS.map((c) => c.slug + '=' + catMap.get(c.slug).length).join(' '));
say('months: ' + MONTHS.length + ' categories(report-only): ' + CATS.length + ' sessions: ' + convs.length);

// ===== 5. 渲染（与旧版逐字节一致） =====
function planSources(conv, target) {
  const dir = convDirOf(conv) || path.join(conv.__root, safe(conv.title) || '未命名');
  const srcTag = sha256(conv.__convKey).slice(0, 8);
  const groups = [];
  for (const m of conv.messages || []) for (const g of m.searches || []) groups.push(g);
  const files = [];
  const searchFiles = [];
  let agg = '# 参考来源 — ' + conv.title + '\n\n';
  let n = 0;
  for (const g of groups) {
    n += 1;
    let md = '# 第 ' + n + ' 次搜索（' + g.results.length + ' 条）\n\n';
    if (g.queries && g.queries.length) md += '检索：' + g.queries.join('；') + '\n\n';
    md += g.results.map((r, k) => {
      const meta = [r.site_name, fmtDate(r.published_at)].filter(Boolean).join(' · ');
      return (k + 1) + '. **' + (r.title || r.url) + '**' + (meta ? '\n   ' + meta : '') + '\n   <' + r.url + '>\n   ' + String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 200);
    }).join('\n\n');
    const f = path.join(dir, '参考来源-' + srcTag + '-' + n + '.md');
    files.push({ abs: f, name: '参考来源-' + srcTag + '-' + n + '.md', content: md + '\n' });
    searchFiles.push(relPath(target, f));
    agg += '## 第 ' + n + ' 次搜索（' + g.results.length + ' 条）\n\n' + g.results.map((r, k) => (k + 1) + '. [' + (r.title || r.url) + '](' + r.url + ')').join('\n') + '\n\n';
  }
  if (n) files.push({ abs: path.join(dir, '参考来源-' + srcTag + '.md'), name: '参考来源-' + srcTag + '.md', content: agg });
  const sources = n ? relPath(target, path.join(dir, '参考来源-' + srcTag + '.md')) : '';
  return { dir, files, searchFiles, sources };
}
function writeSources(conv, target) {
  const p = planSources(conv, target);
  fs.mkdirSync(p.dir, { recursive: true });
  for (const f of p.files) fs.writeFileSync(f.abs, f.content, 'utf8');
  conv.__searchFiles = p.searchFiles;
  conv.__sources = p.sources;
  conv.__si = 0;
  return p;
}

function ensureSystemHead(events) {
  const firstSurface = events.find((e) => e.surfaceOp !== undefined || ['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(e.type));
  if (firstSurface && firstSurface.type === 'system/message') return events;
  const tIdx = events.findIndex((e) => e.type === 'turn/start');
  if (tIdx < 0) return events;
  const turn = events[tIdx].data && events[tIdx].data.turn;
  let sIdx = -1;
  for (let j = tIdx + 1; j < events.length; j += 1) { if (events[j].type === 'step/start') { sIdx = j; break; } }
  if (sIdx < 0) return events;
  const step = { type: 'step/start', data: { turn, step: 1 } };
  const sys = {
    type: 'system/message', surfaceOp: 'append',
    data: { turn, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }], source: { kind: 'system-prompt' }, id: 'sys-' + randomUUID() } },
  };
  const out = [];
  for (let j = 0; j < events.length; j += 1) {
    if (j === tIdx + 1) { out.push(step, sys); if (j === sIdx) continue; }
    if (j === sIdx) continue;
    out.push(events[j]);
  }
  let seq = 0;
  return out.map((e) => (e.type === 'session' ? e : { ...e, seq: seq++ }));
}

function buildEvents(conv, cwd, baseTime) {
  const title = '[' + conv.__prefix + '] ' + (conv.title || '');
  const msgs = (conv.messages || []).map((m) => ({
    role: String(m.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant',
    text: m.text || '', thinking: m.thinking || '', stages: m.stages || [], steps: m.steps || [],
    tips: m.tips || [], files: m.files || [], search: m.search || null, tokens: m.tokens || 0,
    insertedAt: m.insertedAt || null,
  })).filter((m) => m.text || m.thinking || m.stages.length || m.files.length);
  if (!msgs.length) { msgs.push({ role: 'user', text: '（无内容）', stages: [], steps: [], tips: [], files: [], thinking: '', tokens: 0 }); }

  let seq = 0, clock = baseTime;
  const at = () => (clock += 10);
  const bump = (iso) => { const t = iso ? Date.parse(String(iso)) : NaN; if (Number.isFinite(t) && t > clock) clock = t; };
  const events = [{ type: 'session', version: 4, id: conv.__sessionId, createdAt: baseTime, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }];
  const push = (type, data, extra) => events.push({ type, seq: seq++, time: at(), data, ...(extra || {}) });
  push('permission/preset', { preset: 'workspace-write' });
  push('sandbox/mode', { mode: 'workspace-write' });
  push('approval/policy', { policy: 'ask' });
  push('session/end-seed', {});
  // DSH 续聊需要模型/预设状态（原生会话在 end-seed 后写入这两条）
  push('agent-preset/selected', { agentPreset: 'standard' });
  push('model/selection', { provider: 'deepseek-account', model: 'deepseek-flash' });
  let titleWritten = false, turn = 0, stepNo = 0, openTurn = false, pendingFiles = [];
  const turns = [];

  const closeTurn = () => { if (openTurn) { push('turn/end', { turn, reason: { kind: 'completed' } }); openTurn = false; } };
  const openTurnAt = (txt) => { turn += 1; stepNo = 0; openTurn = true; turns.push({ turn, seq, prompt: String(txt).slice(0, 100), response: '' }); push('turn/start', { turn }); };

  const emit = (m) => {
    stepNo += 1;
    push('step/start', { turn, step: stepNo });
    const content = [];
    const steps = m.steps || [];
    if (steps.length) {
      const total = steps.reduce((n, s) => n + (Number(s.secs) || 0), 0);
      const head = total > 0 ? '已思考（用时 ' + total.toFixed(1) + ' 秒，共 ' + steps.filter((s) => s.k === 'think').length + ' 段）' : '';
      const parts = steps.map((s) => {
        if (s.k === 'open') {
          const items = (s.items || []).map((x) => '- [' + x.title + '](' + x.url + ')').join('\n');
          return '📄 浏览 ' + (s.items || []).length + ' 个页面：\n' + items;
        }
        if (s.k === 'search') {
          const q = (s.queries || []).length ? '（检索：' + s.queries.join('；') + '）' : '';
          const sf = (conv.__searchFiles || [])[conv.__si || 0];
          if (conv.__searchFiles) conv.__si = (conv.__si || 0) + 1;
          return '🔍 搜索到 ' + s.count + ' 个网页' + q + (sf ? ' → [查看这 ' + s.count + ' 条](' + sf + ')' : '');
        }
        return s.text;
      }).filter(Boolean);
      content.push({ type: 'reasoning', text: [head, ...parts].filter(Boolean).join('\n\n') });
    } else if (m.thinking) {
      content.push({ type: 'reasoning', text: m.thinking });
    }
    const tips = (m.tips || []).map((t) => '> 💡 ' + t).join('\n');
    const allFiles = [...((pendingFiles || []).map((f) => ({ ...f, __by: 'user' }))), ...((m.files || []).map((f) => ({ ...f, __by: 'ai' })))];
    const fileLines = allFiles.map((f) => {
      const abs = findFile(conv, f);
      const base = f.name + (f.size ? ' (' + kb(f.size) + ')' : '');
      if (!abs) return '- ' + base + '（原件缺失）';
      const rel = path.relative(cwd, abs).replace(/\\/g, '/').replace(/ /g, '%20');
      if (f.is_image) {
        const thumb = abs.replace(/\.[^.\\/]+$/, '.thumb.webp');
        const tRel = fs.existsSync(thumb) ? path.relative(cwd, thumb).replace(/\\/g, '/').replace(/ /g, '%20') : rel;
        return '- [![' + base + '](' + tRel + ')](' + rel + ')\n  [' + base + '](' + rel + ')';
      }
      return '- [' + base + '](' + rel + ')';
    }).join('\n');
    const search = m.search;
    let srcLine = '';
    if (search && search.results && search.results.length) {
      const top = search.results.slice(0, 3).map((r, k) => (k + 1) + '. [' + (r.title || r.url) + '](' + r.url + ')').join('\n');
      const more = search.results.length > 3 ? '\n- …其余 ' + (search.results.length - 3) + ' 条见 [参考来源](' + (conv.__sources || '') + ')' : '';
      srcLine = '\n\n---\n**参考来源**\n' + top + more;
    }
    const body = [tips, fileLines ? (allFiles.some((f) => f.__by === 'user') ? '📎 用户上传（' + allFiles.filter((f) => f.__by === 'user').length + ' 个）：\n' + fileLines : '📎 附件（' + allFiles.length + ' 个）：\n' + fileLines) : '', m.text + srcLine].filter(Boolean).join('\n\n');
    content.push({ type: 'text', text: body });
    const tok = Number(m.tokens) || 0;
    push('assistant/message', { turn, step: stepNo, message: { role: 'assistant', content, source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' }, id: randomUUID() }, stream: [], usage: { inputTokens: 0, outputTokens: tok, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: tok } }, { surfaceOp: 'append' });
    if (allFiles.length) {
      const cardFiles = allFiles.map((f) => { const abs = findFile(conv, f); return abs ? { path: abs, description: f.name + (f.size ? '（' + kb(f.size) + '）' : '') } : null; }).filter(Boolean);
      if (cardFiles.length) push('deliverables/presented', { turn, callId: 'call_' + randomUUID().replace(/-/g, '').slice(0, 24), files: cardFiles });
    }
    push('step/end', { turn, step: stepNo });
    const cur = turns[turns.length - 1];
    if (cur && !cur.response) cur.response = String(m.text || '').slice(0, 100);
  };

  for (const m of msgs) {
    bump(m.insertedAt);
    if (m.role === 'user') {
      closeTurn();
      openTurnAt(m.text);
      push('user/message', { content: [{ type: 'text', text: m.text + ((m.files && m.files.length) ? '\n\n📎 ' + m.files.map((f) => f.name).join('、') : '') }], source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' }, role: 'user', id: randomUUID() }, { surfaceOp: 'append' });
      if (!titleWritten) { push('session/title', { title, messageSeqs: [events[events.length - 1].seq], source: { kind: 'fallback' } }); titleWritten = true; }
      pendingFiles = m.files || [];
    } else {
      if (!openTurn) openTurnAt('');
      emit(m);
      pendingFiles = [];
    }
  }
  closeTurn();
  if (!titleWritten) push('session/title', { title, messageSeqs: [], source: { kind: 'fallback' } });
  return { events, turns, lastSeq: seq - 1 };
}

function buildCache(conv, cwd, createdAt, lastSeq, turns, title) {
  const row = (ver, val) => ({ ver, seq: lastSeq, val });
  return { version: 7, record: { identity: { formatVersion: 4, createdAt, cwd, isSeeded: false, inheritedEventCount: 0 }, rows: {
    turnBoundary: row(2, { openTurnStartSeq: null, lastStepStartSeq: lastSeq - 1, lastStepBoundary: { kind: 'end', seq: lastSeq - 1 }, lastTurn: turns.length }),
    sandboxMode: row(1, 'workspace-write'),
    approvalState: row(1, { policy: 'ask', turnOpen: false }),
    sessionStats: row(1, { turns: turns.length, steps: turns.length, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, lastTurn: turns.length, openStep: null, pendingCalls: {} }),
    turnOutline: row(2, { turns, draft: '' }),
    title: row(1, title),
    agentPreset: row(1, 'standard'),
    workingDirectory: row(1, cwd),
    permissions: row(2, { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask', seeded: true }),
    sessionListMetadata: row(1, { blank: false, lastPromptAt: createdAt }),
    timeContext: row(3, { lastMessageTime: createdAt, lastInjectionTime: createdAt, lastTurnInjectionTime: null, browserTurn: turns.length, browserTimeZones: ['Asia/Shanghai'] }),
  } } };
}

// ===== 6. 指纹 =====
function renderInputs(conv, cwd) {
  return {
    prefix: conv.__prefix,
    title: conv.title || '',
    cwd,
    createdAt: conv.__createdAt,
    messages: (conv.messages || []).map((m) => ({
      role: String(m.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant',
      text: m.text || '', thinking: m.thinking || '', stages: m.stages || [], steps: m.steps || [],
      tips: m.tips || [], search: m.search || null, searches: m.searches || null,
      tokens: m.tokens || 0, insertedAt: m.insertedAt || null,
      files: (m.files || []).map((f) => {
        const abs = findFile(conv, f);
        return {
          name: f.name, size: f.size, is_image: !!f.is_image, id: f.id || '',
          abs: abs || null,
          rel: abs ? path.relative(cwd, abs).replace(/\\/g, '/') : null,
          thumb: abs && f.is_image ? fs.existsSync(abs.replace(/\.[^.\\/]+$/, '.thumb.webp')) : false,
        };
      }),
    })),
  };
}
function fingerprint(conv, cwd) {
  return 'sha256:' + sha256(stableStringify({ build: BUILD_VERSION, key: conv.__convKey, inputs: renderInputs(conv, cwd) }));
}

// ===== 7. 会话日志读写 =====
const sessionDirOf = (cwd, sid) => path.join(SESS, slugify(cwd), sid);
const sessionFileOf = (cwd, sid) => path.join(sessionDirOf(cwd, sid), 'session.v4.jsonl.zstd');
const cacheFileOf = (sid) => path.join(CACHE, sid + '.json');
const RUNTIME_RX = /^(Current runtime context|Time sampled while preparing)/;

function decodeFrames(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offs = []; let i = 0;
  while ((i = buf.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
  const events = [];
  for (let k = 0; k < offs.length; k += 1) {
    try { events.push(JSON.parse(z.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1] || buf.length)).toString('utf8').trim())); } catch (e) { /* 跳过坏帧 */ }
  }
  return events;
}
function readEvents(p) {
  try { return decodeFrames(fs.readFileSync(p)); } catch (e) { return []; }
}
function userTextsOf(events) {
  const out = [];
  for (const j of events) {
    if (!j || j.type !== 'user/message') continue;
    const text = ((j.data && j.data.content) || []).map((c) => c.text || '').join('\n');
    if (RUNTIME_RX.test(text)) continue;
    if (/^\s*📎/.test(text)) continue;
    out.push(text);
  }
  return out;
}
function readSummary(p) {
  try {
    const stt = fs.statSync(p);
    const events = decodeFrames(fs.readFileSync(p));
    const header = events.find((e) => e && e.type === 'session');
    const ti = events.find((e) => e && e.type === 'session/title');
    if (!header || !header.id) return null;
    return {
      sid: header.id, path: p, cwd: header.cwd || '', createdAt: header.createdAt || 0,
      title: (ti && ti.data && ti.data.title) || '', userTexts: userTextsOf(events),
      parsable: true, size: stt.size, mtimeMs: Math.round(stt.mtimeMs),
    };
  } catch (e) {
    return null;
  }
}
function quickVerify(p, sid, cwd) {
  try {
    const events = decodeFrames(fs.readFileSync(p));
    const header = events.find((e) => e && e.type === 'session');
    if (!header) return { ok: false, reason: 'no-header' };
    if (header.id !== sid) return { ok: false, reason: 'id-mismatch' };
    if (normPath(header.cwd) !== normPath(cwd)) return { ok: false, reason: 'cwd-mismatch' };
    if (!events.some((e) => e && e.type === 'session/title')) return { ok: false, reason: 'no-title' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'unreadable' }; }
}
function writeSessionLog(dir, events, mtimeMs) {
  fs.mkdirSync(dir, { recursive: true });
  const frames = events.map((e) => z.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  const dst = path.join(dir, 'session.v4.jsonl.zstd');
  const tmp = path.join(dir, '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  fs.writeFileSync(tmp, Buffer.concat(frames));
  fs.renameSync(tmp, dst);
  try { const t = new Date(mtimeMs); fs.utimesSync(dst, t, t); fs.utimesSync(dir, t, t); } catch (e) {}
  return fs.statSync(dst);
}
function writeCache(sid, cache, mtimeMs) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dst = cacheFileOf(sid);
  const tmp = dst + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, dst);
  try { const t = new Date(mtimeMs); fs.utimesSync(dst, t, t); } catch (e) {}
  return fs.statSync(dst);
}

// ===== 8. store / manifest =====
const EMPTY_STORE = () => ({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: null }, tables: { workspaces: {} } });
const storeExists = fs.existsSync(STORE);
const store = storeExists ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : EMPTY_STORE();
if (!store.tables) store.tables = { workspaces: {} };
if (!store.tables.workspaces) store.tables.workspaces = {};
if (!store.global) store.global = EMPTY_STORE().global;
const storeHash0 = storeExists ? sha256(fs.readFileSync(STORE)) : '';
const OWNS = (p) => {
  const n = normPath(p);
  const wsBase = normPath(path.join(ROOT, 'history', 'ws'));
  return n === wsBase || n.startsWith(wsBase + '/') || n.startsWith(wsBase + '-');
};
const ownedWsEntries = [];
const nonOwnedSnapshot = {};
for (const [id, w] of Object.entries(store.tables.workspaces)) {
  if (OWNS(w.path)) ownedWsEntries.push({ id, w });
  else nonOwnedSnapshot[id] = w;
}
const storeSidOf = new Map();
for (const { id, w } of ownedWsEntries) for (const sid of w.sessionIds || []) storeSidOf.set(sid, id);

let manifest = readJson(MANIFEST, null);
const manifestFresh = !!(manifest && manifest.version === 1 && manifest.copies && manifest.buildVersion === BUILD_VERSION && !FORCE_FULL);
if (!manifestFresh) {
  if (manifest && !FORCE_FULL && manifest.buildVersion !== BUILD_VERSION) say('[manifest] buildVersion 变化 → 本轮全量重建');
  manifest = { version: 1, buildVersion: BUILD_VERSION, copies: {}, workspaces: {} };
}
const manifestCopies = manifest.copies || {};
// 旧 manifest 第一段是显示前缀（白包/17），新代码是账号 key（account）；
// 旧键必须能命中，否则会把已导入会话当新会话重建成重复。
const legacyConvKeyOf = (conv) => conv.__prefix + '|' + conv.id;
const legacyManifestKeyOf = (conv, cwd) => legacyConvKeyOf(conv) + '|' + cwd;
const manifestKeyOf = (conv, cwd) => conv.__convKey + '|' + cwd;
// 上一轮写进会话里的「导入用户文本」：用于区分「数据集后来被改过的旧轮次」与「DSH 里补聊的轮次」
const prevConvUsers = manifest.convUsers || {};
const prevUsersOf = (conv) => prevConvUsers[conv.__convKey] || prevConvUsers[legacyConvKeyOf(conv)] || [];

// ===== 9. 规划 =====
const nOf = normPath;
const existingByPath = new Map();
const duplicateWs = [];
for (const { id, w } of ownedWsEntries) {
  const k = nOf(w.path);
  if (!existingByPath.has(k)) existingByPath.set(k, { id, w });
  else duplicateWs.push({ id, w });
}
const desiredWs = [];
for (const cat of PLAN) {
  const target = path.join(WS_ROOT, cat.slug);
  const ex = existingByPath.get(nOf(target));
  desiredWs.push({
    path: target, title: cat.title, id: ex ? ex.id : null,
    createdAt: ex ? ex.w.createdAt : nowIso(), updatedAt: ex ? ex.w.updatedAt : nowIso(),
    sessionIds: [], cat, existing: ex ? ex.w : null,
  });
}
const wsByNormPath = new Map(desiredWs.map((node) => [nOf(node.path), node]));
// 非月份、仍被 store 纳管的工作区（旧版分类工作区）→ 分析其会话，能配对到月份的合并后退役
const retireWsEntries = RETIRE_CATEGORIES
  ? ownedWsEntries.filter(({ id, w }) => !desiredWs.some((node) => node.id === id) && !desiredWs.some((node) => nOf(node.path) === nOf(w.path)))
  : [];
const claimed = new Set();
const copies = [];
const dsUserTextsOf = (conv) => (conv.messages || []).filter((m) => String(m.role || '').toUpperCase() === 'USER').map((m) => normUserText(m.text)).filter(Boolean);
const normTitleOf = (t) => String(t || '').replace(/^\[[^\]]+\] /, '');
const kindOfCwd = (cwd) => (/(^|\/)month-\d{4}-\d{2}$/.test(normPath(cwd)) ? 'month' : 'cat');

// 只在需要时构建一次索引
function needsIndex() {
  if (FORCE_FULL) return true;
  if (retireWsEntries.length) return true; // 退役分类会话需要读取标题/首轮用户文本做配对
  for (const cat of PLAN) for (const i of cat.idx) {
    const conv = convs[i];
    const cwd = path.join(WS_ROOT, cat.slug);
    if (!manifestCopies[manifestKeyOf(conv, cwd)] && !manifestCopies[legacyManifestKeyOf(conv, cwd)]) return true;
  }
  return false;
}
let INDEX = null;
if (needsIndex()) {
  INDEX = new Map();
  // 会话目录名 = slugify(工作区路径)；所有 history/ws-* 子目录共用前缀
  const idxPrefix = slugify(WS_ROOT).replace(/--$/, '-');
  let dirs = [];
  try { dirs = fs.readdirSync(SESS, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith(idxPrefix)); } catch (e) {}
  for (const d of dirs) {
    const slugDir = path.join(SESS, d.name);
    let kids = [];
    try { kids = fs.readdirSync(slugDir, { withFileTypes: true }); } catch (e) { continue; }
    for (const k of kids) {
      if (!k.isDirectory() || !k.name.startsWith('session-')) continue;
      const f = path.join(slugDir, k.name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const s = readSummary(f);
      if (s) INDEX.set(s.sid, s);
    }
  }
  say('[index] scanned ' + INDEX.size + ' existing session files');
} else {
  say('[index] skipped (manifest covers all copies)');
}

function sameAccount(conv, s) {
  const m = String(s.title || '').match(/^\[([^\]]+)\] /);
  if (m) return m[1] === conv.__prefix;
  return false;
}
function pickCandidate(conv, cwd, kind) {
  const dsTexts = dsUserTextsOf(conv);
  const normT = String(conv.title || '');
  const pool = [];
  for (const s of INDEX.values()) {
    if (claimed.has(s.sid) || !storeSidOf.has(s.sid)) continue;
    if (!sameAccount(conv, s)) continue;
    if (normTitleOf(s.title) !== normT) continue;
    const ut = s.userTexts.map(normUserText).filter(Boolean);
    let n = 0;
    while (n < dsTexts.length && n < ut.length && ut[n] === dsTexts[n]) n += 1;
    if (n !== dsTexts.length) continue;
    const sameCwd = nOf(s.cwd) === nOf(cwd);
    pool.push({ s, score: (sameCwd ? 1000 : 0) + (kindOfCwd(s.cwd) === kind ? 100 : 0) + n });
  }
  if (!pool.length) return null;
  pool.sort((a, b) => b.score - a.score || a.s.sid.localeCompare(b.s.sid));
  if (pool.length > 1 && pool[0].score === pool[1].score) {
    say('[warn] 同名同内容、无法唯一配对：' + conv.__prefix + ' / ' + conv.title);
    return null;
  }
  const p = pool[0].s;
  return { sid: p.sid, path: p.path, cwd: p.cwd, title: p.title, size: p.size, mtimeMs: p.mtimeMs };
}
function pickOrphan(conv, cwd) {
  const dsTexts = dsUserTextsOf(conv);
  const normT = String(conv.title || '');
  const out = [];
  for (const s of INDEX.values()) {
    if (claimed.has(s.sid) || storeSidOf.has(s.sid)) continue;
    if (!sameAccount(conv, s)) continue;
    if (normTitleOf(s.title) !== normT) continue;
    if (nOf(s.cwd) !== nOf(cwd)) continue;
    const ut = s.userTexts.map(normUserText).filter(Boolean);
    let n = 0;
    while (n < dsTexts.length && n < ut.length && ut[n] === dsTexts[n]) n += 1;
    if (n !== dsTexts.length) continue;
    out.push(s);
  }
  if (!out.length) return null;
  out.sort((a, b) => a.sid.localeCompare(b.sid));
  const s = out[0];
  return { sid: s.sid, path: s.path, cwd: s.cwd, title: s.title, size: s.size, mtimeMs: s.mtimeMs };
}

for (const cat of PLAN) {
  const node = wsByNormPath.get(nOf(path.join(WS_ROOT, cat.slug)));
  const kind = cat.slug.startsWith('month-') ? 'month' : 'cat';
  for (const i of cat.idx) {
    const conv = convs[i];
    const cwd = node.path;
    const fp = fingerprint(conv, cwd);
    const key = manifestKeyOf(conv, cwd);
    const legacyKey = legacyManifestKeyOf(conv, cwd);
    const title = '[' + conv.__prefix + '] ' + (conv.title || '');
    const copy = { conv, cwd, kind, fp, key, title, action: 'new', sid: null, src: null, merge: 0, reason: '', node, written: null, claimed: false };
    let mrec = manifestCopies[key] || manifestCopies[legacyKey] || null;
    if (mrec && !manifestCopies[key]) {
      manifestCopies[key] = mrec;
      delete manifestCopies[legacyKey];
    }
    const sidNew = 'session-' + randomUUID();

    if (mrec && mrec.fingerprint === fp) {
      const sid = mrec.sessionId;
      const listed = storeSidOf.has(sid);
      const file = sessionFileOf(cwd, sid);
      copy.sid = sid;
      copy.src = { sid, path: file, cwd };
      if (listed) {
        const cacheOk = fs.existsSync(cacheFileOf(sid));
        if (!fs.existsSync(file)) { copy.action = 'rebuild'; copy.reason = 'file-missing'; }
        else if (!cacheOk) { copy.action = 'skip'; copy.cacheMissing = true; }
        else {
          const stt = fs.statSync(file);
          if (stt.size === mrec.fileSize && Math.round(stt.mtimeMs) === mrec.fileMtimeMs) copy.action = 'skip';
          else {
            const q = quickVerify(file, sid, cwd);
            if (q.ok) { copy.action = 'skip-touched'; copy.stat = { size: stt.size, mtimeMs: Math.round(stt.mtimeMs) }; }
            else { copy.action = 'rebuild'; copy.reason = 'verify-' + q.reason; }
          }
        }
        copy.written = {
          size: copy.stat ? copy.stat.size : mrec.fileSize, mtimeMs: copy.stat ? copy.stat.mtimeMs : mrec.fileMtimeMs,
          cacheSize: mrec.cacheSize || 0, sourceDir: mrec.sourceDir || '', sourceFiles: mrec.sourceFiles || [],
          dshOnlyMerged: mrec.dshOnlyMerged || 0,
        };
        copy.claimed = true;
      } else if (REVIVE && fs.existsSync(file)) {
        copy.action = 'revive';
        copy.written = { size: fs.statSync(file).size, mtimeMs: Math.round(fs.statSync(file).mtimeMs), cacheSize: 0, sourceDir: mrec.sourceDir || '', sourceFiles: mrec.sourceFiles || [], dshOnlyMerged: 0 };
        copy.claimed = true;
      } else {
        copy.action = 'unlisted';
        copy.reason = 'manifest-only';
      }
    } else if (mrec && !ROTATE_IDS) {
      copy.action = 'rebuild';
      copy.reason = 'fingerprint-changed';
      copy.sid = mrec.sessionId;
      copy.src = { sid: mrec.sessionId, path: sessionFileOf(cwd, mrec.sessionId), cwd };
      copy.claimed = true;
    } else if (!ROTATE_IDS) {
      const cand = INDEX ? pickCandidate(conv, cwd, kind) : null;
      if (cand) {
        copy.sid = cand.sid;
        copy.src = cand;
        copy.action = nOf(cand.cwd) === nOf(cwd) ? 'rebuild' : 'move';
        copy.reason = 'legacy-adopt';
        copy.claimed = true;
      } else {
        const orph = NO_ADOPT ? null : pickOrphan(conv, cwd);
        if (orph) {
          copy.sid = orph.sid;
          copy.src = orph;
          copy.action = 'adopt';
          copy.reason = 'orphan-adopt';
          copy.claimed = true;
        } else {
          copy.action = 'new';
          copy.sid = sidNew;
        }
      }
    } else {
      copy.action = 'new';
      copy.sid = sidNew;
      copy.reason = 'rotate-ids';
    }
    if (copy.claimed) claimed.add(copy.sid);
    // 简称变了但内容没变：manifest 里的标题前缀已过期，需要重建标题
    if (['skip', 'skip-touched'].includes(copy.action) && mrec && mrec.title) {
      const want = '[' + conv.__prefix + '] ';
      if (!String(mrec.title).startsWith(want)) { copy.action = 'rebuild'; copy.reason = 'prefix-changed'; }
    }
    if (copy.action !== 'unlisted') node.sessionIds.push(copy.sid);
    copies.push(copy);
  }
}

// ===== 9b. 旧分类工作区：合并补聊 → 备份 → 退役（DSH 工作区只保留月份） =====
const retireStats = { workspaces: 0, sources: 0, mergedCopies: 0, extraTurns: 0, unmatched: [], keptWorkspaces: [] };
const convByKey = new Map(convs.map((c) => [c.__convKey, c]));
function dedupeExtras(groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) for (const e of group || []) {
    if (e.role === 'user') {
      const k = normUserText(e.text);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    } else out.push(e);
  }
  return out;
}
const mergeExtrasOfSources = (sources) => dedupeExtras((sources || []).map((s) => s.extras));
const mrecBySid = new Map();
for (const [key, rec] of Object.entries(manifestCopies)) {
  if (!rec || !rec.sessionId) continue;
  mrecBySid.set(rec.sessionId, { convKey: rec.convKey || key.slice(0, key.lastIndexOf('|')) });
}
function matchConvToSummary(s) {
  const hit = mrecBySid.get(s.sid);
  if (hit && hit.convKey && convByKey.has(hit.convKey)) return convByKey.get(hit.convKey);
  const normT = normTitleOf(s.title);
  const ut = s.userTexts.map(normUserText).filter(Boolean);
  let best = null, bestN = -1, tie = false;
  for (const conv of convs) {
    if (!sameAccount(conv, s)) continue;
    if (String(conv.title || '') !== normT) continue;
    const ds = dsUserTextsOf(conv);
    let n = 0;
    while (n < ds.length && n < ut.length && ut[n] === ds[n]) n += 1;
    if (n !== ds.length) continue;
    if (n > bestN) { best = conv; bestN = n; tie = false; }
    else if (n === bestN) tie = true;
  }
  return tie ? null : best;
}
if (RETIRE_CATEGORIES && retireWsEntries.length) {
  const copyOfConv = new Map(copies.map((c) => [c.conv.__convKey, c]));
  const perWs = [];
  for (const { id, w } of retireWsEntries) {
    const sources = [];
    const unmatched = [];
    for (const sid of w.sessionIds || []) {
      if (claimed.has(sid)) continue;
      const s = INDEX ? INDEX.get(sid) : null;
      const conv = s ? matchConvToSummary(s) : null;
      const copy = conv ? copyOfConv.get(conv.__convKey) : null;
      if (!s || !conv || !copy || !['skip', 'skip-touched', 'rebuild', 'move', 'new'].includes(copy.action)) {
        unmatched.push({ sid, title: s ? s.title : '' });
        continue;
      }
      const extras = extractDshOnlyTurns(conv, readEvents(s.path), prevUsersOf(conv));
      const src = { sid, wsId: id, cwd: w.path, path: s.path, title: s.title, extras, conv, backupOk: false };
      sources.push(src);
      claimed.add(sid); // 不再进入 kept / store
    }
    perWs.push({ id, w, sources, unmatched });
    for (const u of unmatched) retireStats.unmatched.push({ ...u, wsId: id });
    if (unmatched.length) retireStats.keptWorkspaces.push({ id, title: w.title, path: w.path, unmatched });
  }
  for (const { sources } of perWs) {
    for (const src of sources) {
      const copy = copyOfConv.get(src.conv.__convKey);
      (copy.retireSources || (copy.retireSources = [])).push(src);
    }
  }
  for (const c of copies) {
    if (!c.retireSources || !c.retireSources.length) continue;
    if (['skip', 'skip-touched', 'rebuild', 'move', 'new'].includes(c.action)) {
      c.catExtras = mergeExtrasOfSources(c.retireSources);
      if (c.catExtras.length && ['skip', 'skip-touched'].includes(c.action)) { c.action = 'rebuild'; c.reason = 'merge-cat'; }
    } else {
      // 收养/复活等不改写文件，无法合并分类补聊 → 保留原分类副本，绝不删除
      for (const s of c.retireSources) {
        claimed.delete(s.sid);
        retireStats.unmatched.push({ sid: s.sid, title: s.title, wsId: s.wsId, reason: 'month-copy-' + c.action });
      }
      c.retireSources = [];
      c.catExtras = [];
      continue;
    }
    if (c.catExtras.length && ['rebuild', 'move', 'new'].includes(c.action)) {
      retireStats.mergedCopies += 1;
      retireStats.extraTurns += c.catExtras.length / 2;
    }
  }
  for (const { sources } of perWs) retireStats.sources += sources.length;
  retireStats.workspaces = perWs.filter((p) => !p.unmatched.length).length;
}

// 未被任何期望副本认领的既有会话 → 默认保留
const keptSessions = [];
for (const { id, w } of ownedWsEntries) {
  for (const sid of w.sessionIds || []) {
    if (claimed.has(sid)) continue;
    const s = INDEX ? INDEX.get(sid) : null;
    const file = sessionFileOf(w.path, sid);
    const title = s ? s.title : '';
    const prefixed = /^\[[^\]]+\] /.test(title);
    const base = normTitleOf(title);
    const inDataset = convs.some((c) => (c.title || '') === base);
    const reason = !s ? (fs.existsSync(file) ? 'unparsable' : 'missing-file') : (!prefixed ? 'unknown-legacy' : (inDataset ? 'stale-dup' : 'removed'));
    keptSessions.push({ sid, wsId: id, title, reason, size: s ? s.size : 0, path: s ? s.path : file, file });
  }
}
// 真正要移除的（仅 --allow-removals 且判定为 removed）
// 铁律（用户 2026-11-18）：**同名 ≠ 重复**。只有标题在数据集里完全不存在时才可能进入 removed，
// 且默认不删；同名但内容不完全一致的会话永远保留。下面的守卫用于防止未来改坏这条规则。
const removedSessions = ALLOW_REMOVALS ? keptSessions.filter((k) => k.reason === 'removed') : [];
const datasetTitles = new Set(convs.map((c) => String(c.title || '')));
for (const k of removedSessions) {
  if (datasetTitles.has(normTitleOf(k.title))) {
    throw new Error('拒绝删除与数据集同名的会话（同名但内容可能不同）：' + k.sid + ' / ' + k.title);
  }
}

// 孤儿（文件在、store 不在、未被收养）
const orphanList = [];
if (INDEX) {
  for (const s of INDEX.values()) {
    if (storeSidOf.has(s.sid) || claimed.has(s.sid)) continue;
    orphanList.push({ sid: s.sid, title: s.title, size: s.size, path: s.path });
  }
}

// 计划移除的空工作区
const plannedRemoveWs = ownedWsEntries.filter(({ id, w }) => {
  if (desiredWs.some((node) => node.id === id)) return false;
  return (w.sessionIds || []).every((sid) => claimed.has(sid) || removedSessions.some((k) => k.sid === sid));
}).length;

// ===== 10. 执行 =====
const backupEntries = [];
function ensureBackupDir() { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); }
function backupSession(sid, file, kind) {
  try {
    ensureBackupDir();
    const dst = kind === 'cache' ? path.join(BACKUP_DIR, sid + '.cache.json') : path.join(BACKUP_DIR, sid, 'session.v4.jsonl.zstd');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(file, dst);
    backupEntries.push({ sid, kind, from: file, to: dst, size: fs.statSync(file).size });
    return dst;
  } catch (e) { return null; }
}

function extractDshOnlyTurns(conv, events, prevUsers) {
  const dsSet = new Set((conv.messages || []).filter((m) => String(m.role || '').toUpperCase() === 'USER').map((m) => normUserText(m.text)).filter(Boolean));
  const prevSet = new Set(prevUsers || []);
  const extras = [];
  let pendingUser = null;
  let pendingAssistants = [];
  const flush = () => {
    if (pendingUser === null) return;
    extras.push({ role: 'user', text: pendingUser, thinking: '', stages: [], steps: [], searches: [], tips: [], files: [], search: null, tokens: 0, insertedAt: null, model: '' });
    for (const a of pendingAssistants) {
      extras.push({ role: 'assistant', text: a.text, thinking: a.thinking, stages: [], steps: [], searches: [], tips: [], files: [], search: null, tokens: 0, insertedAt: null, model: '' });
    }
    pendingUser = null;
    pendingAssistants = [];
  };
  for (const j of events) {
    if (!j) continue;
    if (j.type === 'user/message') {
      flush();
      const text = ((j.data && j.data.content) || []).map((c) => c.text || '').join('\n');
      if (RUNTIME_RX.test(text)) continue;
      if (/^\s*📎/.test(text)) continue;
      if (/^\[model changed:/.test(text)) continue;
      const fu = normUserText(text);
      if (!fu || dsSet.has(fu) || prevSet.has(fu)) { continue; }
      pendingUser = text;
    } else if (j.type === 'assistant/message' && pendingUser !== null) {
      const blocks = (j.data && j.data.message && j.data.message.content) || [];
      const text = blocks.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
      const thinking = blocks.filter((c) => c.type === 'reasoning').map((c) => c.text || '').join('\n');
      pendingAssistants.push({ text, thinking });
    }
  }
  flush();
  return extras;
}

function unretireSource(s) {
  if (keptSessions.some((k) => k.sid === s.sid)) return;
  keptSessions.push({
    sid: s.sid, wsId: s.wsId, title: s.title, reason: 'retire-skipped',
    size: fs.existsSync(s.path) ? fs.statSync(s.path).size : 0, path: s.path, file: s.path,
  });
}

function applyWrites() {
  // 1) 备份将被覆盖/删除的会话文件与缓存
  for (const c of copies) {
    if (!['rebuild', 'move'].includes(c.action)) continue;
    const oldPath = c.src && c.src.path && fs.existsSync(c.src.path) ? c.src.path : sessionFileOf(c.cwd, c.sid);
    if (fs.existsSync(oldPath)) {
      if (!backupSession(c.sid, oldPath, 'log')) { c.action = 'kept'; c.reason = 'backup-failed'; continue; }
    }
    if (fs.existsSync(cacheFileOf(c.sid))) backupSession(c.sid, cacheFileOf(c.sid), 'cache');
  }
  for (const k of removedSessions) {
    if (fs.existsSync(k.file) && !backupSession(k.sid, k.file, 'log')) { k.reason = 'remove-skipped'; continue; }
    if (fs.existsSync(cacheFileOf(k.sid))) backupSession(k.sid, cacheFileOf(k.sid), 'cache');
  }
  // 退役的分类副本：先全部备份，备份失败则保留不删
  for (const c of copies) {
    for (const s of c.retireSources || []) {
      if (!fs.existsSync(s.path)) { s.backupOk = true; continue; }
      s.backupOk = !!backupSession(s.sid, s.path, 'log');
      if (fs.existsSync(cacheFileOf(s.sid))) backupSession(s.sid, cacheFileOf(s.sid), 'cache');
    }
  }

  // 2) 重建 / 移动 / 新建
  for (const c of copies) {
    if (!['rebuild', 'move', 'new'].includes(c.action)) continue;
    try {
      const sid = c.sid;
      const conv = c.conv;
      conv.__sessionId = sid;
      let extras = [];
      const extraGroups = [];
      if (c.action !== 'new' && c.src && fs.existsSync(c.src.path)) {
        const oldEvents = readEvents(c.src.path);
        if (!oldEvents.length) {
          const oldSize = fs.existsSync(c.src.path) ? fs.statSync(c.src.path).size : 0;
          if (oldSize > 0) { c.action = 'kept'; c.reason = 'unparsable-old'; actions.push({ action: 'kept', sid, title: c.title, reason: 'unparsable-old' }); continue; }
        }
        extraGroups.push(extractDshOnlyTurns(conv, oldEvents, prevUsersOf(conv)));
      }
      if (c.catExtras && c.catExtras.length) extraGroups.push(c.catExtras);
      extras = dedupeExtras(extraGroups);
      // 移动：整体搬目录（旧目录不残留副本）
      const newDir = sessionDirOf(c.cwd, sid);
      if (c.action === 'move' && c.src && c.src.path) {
        const oldDir = path.dirname(c.src.path);
        if (nOf(oldDir) !== nOf(newDir)) {
          if (!fs.existsSync(newDir)) {
            fs.mkdirSync(path.dirname(newDir), { recursive: true });
            fs.renameSync(oldDir, newDir);
          } else {
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) {}
          }
        }
      }
      const sp = writeSources(conv, c.cwd);
      c.merge = extras.length / 2;
      const merged = extras.length ? { ...conv, messages: conv.messages.concat(extras) } : conv;
      const { events, turns, lastSeq } = buildEvents(merged, c.cwd, conv.__createdAt);
      const logStat = writeSessionLog(newDir, events, conv.__createdAt);
      const cacheStat = writeCache(sid, buildCache(merged, c.cwd, conv.__createdAt, lastSeq, turns, c.title), conv.__createdAt);
      c.written = {
        size: logStat.size, mtimeMs: Math.round(logStat.mtimeMs), cacheSize: cacheStat.size,
        sourceDir: sp.dir, sourceFiles: sp.files.map((f) => f.name), dshOnlyMerged: c.merge,
      };
      actions.push({ action: c.action, sid, convKey: conv.__convKey, title: c.title, cwd: c.cwd, mergedDshOnly: c.merge, mergeCat: !!(c.catExtras && c.catExtras.length), reason: c.reason });
    } catch (e) {
      c.action = 'failed';
      c.reason = String((e && e.message) || e);
      actions.push({ action: 'failed', sid: c.sid, title: c.title, error: c.reason });
    }
  }

  // 3) 收养 / 复活：只入 store，不动文件
  for (const c of copies) {
    if (!['adopt', 'revive'].includes(c.action)) continue;
    const f = c.src && c.src.path && fs.existsSync(c.src.path) ? c.src.path : sessionFileOf(c.cwd, c.sid);
    const stt = fs.existsSync(f) ? fs.statSync(f) : null;
    c.written = stt ? {
      size: stt.size, mtimeMs: Math.round(stt.mtimeMs),
      cacheSize: fs.existsSync(cacheFileOf(c.sid)) ? fs.statSync(cacheFileOf(c.sid)).size : 0,
      sourceDir: (planSources(c.conv, c.cwd)).dir, sourceFiles: [], dshOnlyMerged: 0,
    } : null;
    c.srcPath = f;
    actions.push({ action: c.action, sid: c.sid, convKey: c.conv.__convKey, title: c.title, cwd: c.cwd, reason: c.reason });
  }

  // 3.5) 退役分类副本：月份副本已重建/合并成功后才删除（先备份；任何异常都保留）
  if (copies.some((c) => (c.retireSources || []).length) && !SANDBOX) {
    if (dshState() === 'running') throw new Error('检测到 DeepSeek Harness 正在运行，已中止（未删除分类副本、未写 store）');
    if (storeHash0 && sha256(fs.readFileSync(STORE)) !== storeHash0) throw new Error('workspace.json 在运行期间被改动，已中止（未删除分类副本、未写 store）');
  }
  const retiredOk = [];
  for (const c of copies) {
    if (!c.retireSources || !c.retireSources.length) continue;
    const badCopy = ['failed', 'kept', 'unlisted'].includes(c.action);
    for (const s of c.retireSources) {
      if (badCopy || !s.backupOk) { unretireSource(s); continue; }
      try {
        const dir = path.dirname(s.path);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        if (fs.existsSync(cacheFileOf(s.sid))) fs.rmSync(cacheFileOf(s.sid), { force: true });
        retiredOk.push(s);
        actions.push({ action: 'retire-cat', sid: s.sid, title: s.title, cwd: s.cwd, backup: BACKUP_DIR });
      } catch (e) { unretireSource(s); }
    }
  }
  retireStats.retired = retiredOk.length;

  // 4) 删除（仅 --allow-removals；先备份）
  const removedOk = [];
  for (const k of removedSessions) {
    if (k.reason === 'remove-skipped') continue;
    try {
      const dir = path.dirname(k.file);
      fs.rmSync(dir, { recursive: true, force: true });
      if (fs.existsSync(cacheFileOf(k.sid))) fs.rmSync(cacheFileOf(k.sid), { force: true });
      removedOk.push(k);
      actions.push({ action: 'remove', sid: k.sid, title: k.title, reason: 'removed-from-dataset', backup: BACKUP_DIR });
    } catch (e) { k.reason = 'remove-failed'; }
  }

  // 5) 生成 store（只改 owned 工作区；非 owned 原样）
  const wsOut = {};
  for (const [id, w] of Object.entries(store.tables.workspaces)) if (!OWNS(w.path)) wsOut[id] = w;
  // 失败/未纳管的不进 store；备份失败或不可解析的旧会话保留在原工作区
  const badSids = new Set(copies.filter((c) => ['failed', 'unlisted'].includes(c.action)).map((c) => c.sid));
  const keptByWs = new Map();
  for (const k of keptSessions) {
    if (removedOk.some((r) => r.sid === k.sid)) continue;
    if (!keptByWs.has(k.wsId)) keptByWs.set(k.wsId, []);
    keptByWs.get(k.wsId).push(k.sid);
  }
  for (const c of copies) {
    if (c.action !== 'kept') continue;
    const wsId = storeSidOf.get(c.sid) || c.node.id;
    if (!keptByWs.has(wsId)) keptByWs.set(wsId, []);
    if (!keptByWs.get(wsId).includes(c.sid)) keptByWs.get(wsId).push(c.sid);
    badSids.add(c.sid);
  }
  for (const node of desiredWs) node.sessionIds = node.sessionIds.filter((sid) => !badSids.has(sid));
  const finalWs = new Map();
  for (const node of desiredWs) {
    const keptHere = (keptByWs.get(node.id) || []).filter((sid) => !node.sessionIds.includes(sid));
    // 保持既有顺序：已存在会话原位保留（含被 keep 的），新会话追加在末尾
    const desiredSet = new Set(node.sessionIds);
    const keptSet = new Set(keptHere);
    const order = (node.existing && node.existing.sessionIds) || [];
    const merged = [];
    for (const sid of order) if (desiredSet.has(sid) || keptSet.has(sid)) merged.push(sid);
    for (const sid of node.sessionIds) if (!merged.includes(sid)) merged.push(sid);
    for (const sid of keptHere) if (!merged.includes(sid)) merged.push(sid);
    node.sessionIds = [...new Set(merged)];
    if (!node.sessionIds.length) continue;
    const id = node.id || randomUUID();
    node.id = id;
    finalWs.set(id, { path: node.path, title: node.title, sessionIds: node.sessionIds, createdAt: node.createdAt, updatedAt: node.updatedAt });
  }
  const removedWsIds = [];
  for (const { id, w } of ownedWsEntries) {
    if (desiredWs.some((node) => node.id === id)) continue;
    const keptHere = (keptByWs.get(id) || []).filter((sid) => (w.sessionIds || []).includes(sid));
    if (!keptHere.length) { removedWsIds.push(id); continue; }
    finalWs.set(id, { path: w.path, title: w.title, sessionIds: keptHere, createdAt: w.createdAt, updatedAt: w.updatedAt });
  }
  for (const d of duplicateWs) {
    const keptHere = (keptByWs.get(d.id) || []).filter((sid) => (d.w.sessionIds || []).includes(sid));
    if (keptHere.length) finalWs.set(d.id, { path: d.w.path, title: d.w.title, sessionIds: keptHere, createdAt: d.w.createdAt, updatedAt: d.w.updatedAt });
    else removedWsIds.push(d.id);
  }
  for (const [id, w] of finalWs) {
    if (!w.sessionIds.length) finalWs.delete(id);
  }
  for (const [id, w] of finalWs) wsOut[id] = w;
  const nextGlobal = { ...store.global };
  const ownedIds = new Set(ownedWsEntries.map((e) => e.id));
  const ids = (store.global.workspaceIds || []).filter((x) => !ownedIds.has(x) || finalWs.has(x));
  for (const id of finalWs.keys()) if (!ids.includes(id)) ids.push(id);
  nextGlobal.workspaceIds = ids;
  // 归档/置顶列表里指向已退役会话的引用一并清掉（不触碰非导入工作区）
  const goneSids = new Set();
  for (const c of copies) for (const s of c.retireSources || []) goneSids.add(s.sid);
  for (const k of removedOk) goneSids.add(k.sid);
  nextGlobal.archivedSessionIds = (nextGlobal.archivedSessionIds || []).filter((x) => !goneSids.has(x));
  nextGlobal.pinnedSessionIds = (nextGlobal.pinnedSessionIds || []).filter((x) => !goneSids.has(x));
  const nextStore = { unit: store.unit, global: nextGlobal, tables: { ...store.tables, workspaces: wsOut } };

  // 非 owned 工作区必须原样
  for (const [id, w] of Object.entries(nonOwnedSnapshot)) {
    if (stableStringify(wsOut[id]) !== stableStringify(w)) throw new Error('非导入工作区被意外修改: ' + id);
  }

  // 6) 写 store（原子；写前复核 DSH 与 store 未被改动）
  const changed = !storeExists || stableStringify(nextStore) !== stableStringify(store);
  if (changed) {
    if (!SANDBOX) {
      if (dshState() === 'running') throw new Error('检测到 DeepSeek Harness 正在运行，已中止（未写 store）');
      if (storeHash0) {
        const h = sha256(fs.readFileSync(STORE));
        if (h !== storeHash0) throw new Error('workspace.json 在运行期间被改动，已中止（未写 store）');
      }
    }
    if (storeExists) {
      const bak = STORE + '.bak-' + TS;
      fs.copyFileSync(STORE, bak);
      report.backups.store = bak;
    }
    writeFileAtomic(STORE, JSON.stringify(nextStore, null, 2));
  }
  report.storeChanged = changed;

  // 7) manifest
  const nextManifest = { version: 1, keyVersion: KEY_VERSION, buildVersion: BUILD_VERSION, writtenAt: nowIso(), datasets, workspaces: {}, copies: {}, convUsers: {} };
  for (const [id, w] of finalWs) nextManifest.workspaces[id] = { path: w.path, title: w.title, sessions: w.sessionIds };
  for (const c of convs) nextManifest.convUsers[c.__convKey] = dsUserTextsOf(c);
  for (const c of copies) {
    if (['unlisted', 'failed'].includes(c.action)) {
      const prev = manifestCopies[c.key];
      if (prev) nextManifest.copies[c.key] = prev;
      continue;
    }
    if (c.action === 'kept' || !c.written) {
      const prev = manifestCopies[c.key];
      if (prev) nextManifest.copies[c.key] = prev;
      continue;
    }
    nextManifest.copies[c.key] = {
      convKey: c.conv.__convKey, cwd: c.cwd, sessionId: c.sid, title: c.title,
      fingerprint: c.fp, fileSize: c.written.size || 0, fileMtimeMs: c.written.mtimeMs || 0,
      cacheSize: c.written.cacheSize || 0, sourceDir: c.written.sourceDir || '',
      sourceFiles: c.written.sourceFiles || [], dshOnlyMerged: c.written.dshOnlyMerged || 0,
    };
  }
  const manifestChanged = !manifestFresh || stableStringify({ ...manifest, writtenAt: '' }) !== stableStringify({ ...nextManifest, writtenAt: '' });
  if (manifestChanged) writeFileAtomic(MANIFEST, JSON.stringify(nextManifest, null, 2));
  report.manifestChanged = manifestChanged;

  // 8) 备份清单
  if (backupEntries.length) {
    writeFileAtomic(path.join(BACKUP_DIR, 'manifest.json'), JSON.stringify({ ts: TS, installer: 'install-v2 incremental', entries: backupEntries }, null, 2));
    report.backups.sessions = BACKUP_DIR;
    report.backups.entries = backupEntries.length;
  }

  report.removedWorkspaces = removedWsIds.length;
  report.removedSessions = removedOk.length;
  verify(nextStore);
}

function verify(nextStore) {
  const problems = [];
  const warnings = [];
  const wsOf = nextStore.tables.workspaces;
  const actionOf = new Map();
  for (const c of copies) if (c.sid) actionOf.set(c.sid, c.action);
  let sessCount = 0;
  for (const [id, w] of Object.entries(wsOf)) {
    if (!OWNS(w.path)) continue;
    for (const sid of w.sessionIds || []) {
      sessCount += 1;
      if (!fs.existsSync(sessionFileOf(w.path, sid))) problems.push('missing file: ' + sid);
      if (!fs.existsSync(cacheFileOf(sid))) {
        if (['rebuild', 'move', 'new'].includes(actionOf.get(sid))) problems.push('missing cache: ' + sid);
        else warnings.push('missing cache（DSH 启动时会重建）: ' + sid);
      }
    }
  }
  for (const c of copies) {
    if (['unlisted', 'failed', 'kept'].includes(c.action)) continue;
    const inWs = Object.values(wsOf).some((w) => OWNS(w.path) && (w.sessionIds || []).includes(c.sid));
    if (!inWs) problems.push('not in store: ' + c.sid + ' (' + c.title + ')');
  }
  for (const [id, w] of Object.entries(nonOwnedSnapshot)) {
    if (stableStringify(wsOf[id]) !== stableStringify(w)) problems.push('non-owned workspace changed: ' + id);
  }
  if (RETIRE_CATEGORIES) {
    const nonMonth = Object.entries(wsOf).filter(([id, w]) => OWNS(w.path) && !/month-\d{4}-\d{2}/.test(normPath(w.path)));
    if (nonMonth.length) warnings.push('仍保留非月份工作区: ' + nonMonth.map(([, w]) => w.title).join('、'));
    if (retireStats.keptWorkspaces.length) warnings.push('分类工作区含无法配对会话（已保留）: ' + retireStats.keptWorkspaces.map((k) => k.title).join('、'));
  }
  report.verify = { sessions: sessCount, problemCount: problems.length, warningCount: warnings.length, problems: problems.slice(0, 20), warnings: warnings.slice(0, 20) };
  if (problems.length) {
    say('[verify] ❌ ' + problems.length + ' 个问题');
    for (const p of problems.slice(0, 10)) say('  - ' + p);
    process.exitCode = 3;
  } else {
    say('[verify] workspaces ' + Object.keys(wsOf).length + ' sessions ' + sessCount + ' ✓' + (warnings.length ? '（' + warnings.length + ' 条提示）' : ''));
  }
}

// ===== 11. 输出 & 入口 =====
const report = {
  mode: DRY ? 'dry-run' : 'install',
  buildVersion: BUILD_VERSION,
  layout: RETIRE_CATEGORIES ? 'months-only' : 'months+categories',
  retire: retireStats,
  totals: { copies: copies.length, workspaces: desiredWs.length, convs: convs.length },
  actions: {},
  workspaces: { reuse: desiredWs.filter((node) => node.id).length, create: desiredWs.filter((node) => !node.id).length, remove: plannedRemoveWs },
  kept: keptSessions.map((k) => ({ sid: k.sid, title: k.title, reason: k.reason })),
  orphans: orphanList.map((o) => ({ sid: o.sid, title: o.title, size: o.size })),
  plans: copies.map((c) => ({ action: c.action, sid: c.sid, title: c.title, cwd: c.cwd, reason: c.reason })),
  backups: {},
  storeChanged: false,
  manifestChanged: false,
  elapsedMs: 0,
};

if (!DRY) {
  if (!SANDBOX) {
    assertDshStopped();
    try { if (storeExists) fs.appendFileSync(STORE, ''); } catch (e) {
      console.error('ERROR: workspace.json 被占用（' + e.code + '），请完全退出 DeepSeek Harness（含托盘）后重试。未做任何修改。');
      process.exit(1);
    }
  }
  try {
    applyWrites();
  } catch (e) {
    console.error('ERROR: 安装中止：' + ((e && e.message) || e));
    console.error('已写入的会话文件与备份保留；workspace.json 未被修改。');
    process.exitCode = 2;
  }
}

const count = (a) => copies.filter((c) => c.action === a).length;
report.actions = {
  unchanged: count('skip'), touched: count('skip-touched'), rebuilt: count('rebuild'), moved: count('move'),
  created: count('new'), adopted: count('adopt'), revived: count('revive'), unlisted: count('unlisted'),
  kept: keptSessions.length - (report.removedSessions || 0), removed: report.removedSessions || 0,
  orphans: orphanList.length, failed: count('failed'),
};
report.applied = actions;
report.elapsedMs = Date.now() - T0;

if (!AS_JSON) {
  say('[plan] copies=' + copies.length + ' unchanged=' + report.actions.unchanged +
    ' rebuild=' + report.actions.rebuilt + ' move=' + report.actions.moved + ' new=' + report.actions.created +
    ' adopt=' + report.actions.adopted + ' revive=' + report.actions.revived +
    ' unlisted=' + report.actions.unlisted + ' kept=' + report.actions.kept);
  say('[plan] workspaces: reuse ' + report.workspaces.reuse + ' create ' + report.workspaces.create + ' remove ' + report.workspaces.remove);
  if (RETIRE_CATEGORIES) {
    say('[plan] 月份布局：退役分类工作区 ' + retireStats.workspaces + '/' + retireWsEntries.length +
      '，副本 ' + retireStats.sources + '，合并补聊副本 ' + retireStats.mergedCopies + '（' + retireStats.extraTurns + ' 轮）' +
      (retireStats.keptWorkspaces.length ? '，保留 ' + retireStats.keptWorkspaces.length + ' 个含无法配对会话的工作区' : ''));
  }
  if (DRY || VERBOSE) {
    const show = copies.filter((c) => c.action !== 'skip');
    const cap = VERBOSE ? show.length : 20;
    for (const c of show.slice(0, cap)) say('  - ' + c.action + ' | ' + c.sid + ' | ' + c.cwd.replace(ROOT, '…') + ' | ' + c.title + (c.reason ? ' | ' + c.reason : ''));
    if (show.length > cap) say('  … 其余 ' + (show.length - cap) + ' 条用 --verbose 查看');
  }
  if (keptSessions.length) {
    say('[keep] 保留（不删除）' + keptSessions.length + ' 个：');
    for (const k of keptSessions.slice(0, VERBOSE ? 1000 : 10)) say('  · ' + k.reason + ' | ' + (k.title || '(无标题)') + ' | ' + k.sid);
  }
  if (orphanList.length) {
    say('[orphan] store 未纳管、文件保留 ' + orphanList.length + ' 个（' + kb(orphanList.reduce((n, o) => n + o.size, 0)) + '）：');
    for (const o of orphanList.slice(0, VERBOSE ? 1000 : 5)) say('  · ' + o.sid + ' | ' + o.title + ' | ' + kb(o.size));
  }
  if (report.actions.failed) say('[fail] ' + report.actions.failed + ' 个会话处理失败（原文件未破坏）');
  say('[done] ' + (DRY ? 'dry-run' : 'install') + ' in ' + report.elapsedMs + ' ms' +
    (report.backups.store ? ' | store backup: ' + report.backups.store : '') +
    (report.backups.sessions ? ' | session backup: ' + report.backups.sessions : ''));
}

if (!DRY) {
  try {
    fs.mkdirSync(RAW, { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: TS, build: BUILD_VERSION, actions: report.actions, workspaces: report.workspaces, backups: report.backups, storeChanged: report.storeChanged, plans: actions }) + '\n');
  } catch (e) {}
}
if (REPORT_FILE) {
  try { writeFileAtomic(path.resolve(REPORT_FILE), JSON.stringify(report)); } catch (e) { console.error('report write failed: ' + e.message); }
}
if (AS_JSON) console.log(JSON.stringify(report));
if (report.actions.failed) process.exitCode = 1;
