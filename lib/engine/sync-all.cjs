// dsh-memory-sync 引擎 v1（CommonJS，独立进程运行）
// 输入：DSH_SYNC_CONFIG=config.json；argv: [--dry-run]
// 能力：多账号 token 巡检 → 增量历史导出 → 附件下载（三档）→ 数据集更新。
// 角标：v1 不做页面抓取（按零捏造政策直接删除未实证编号），页面抓取在后续版本接入。
const fs = require('fs');
const path = require('path');
const https = require('https');

const cfgPath = process.env.DSH_SYNC_CONFIG;
if (!cfgPath || !fs.existsSync(cfgPath)) { console.error('DSH_SYNC_CONFIG missing'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const DRY = process.argv.includes('--dry-run');

const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);

function get(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        accept: '*/*', authorization: 'Bearer ' + token,
        'x-client-bundle-id': 'com.deepseek.chat', 'x-client-locale': 'zh_CN',
        'x-client-platform': 'web', 'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
        'x-client-version': '2.7.1',
      }, timeout: 60000,
    }, (r) => {
      const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(c).toString('utf8'));
          if (r.statusCode === 401 || r.statusCode === 403) { const e = new Error('登录已失效'); e.code = 'AUTH'; reject(e); return; }
          if (r.statusCode >= 400) { const e = new Error('HTTP ' + r.statusCode); e.status = r.statusCode; reject(e); return; }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}
async function getRetry(url, token, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { return await get(url, token); } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}
function dl(url, dest) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'user-agent': 'Mozilla/5.0' }, timeout: 180000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return resolve({ ok: false, status: r.statusCode }); }
      const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => { const b = Buffer.concat(c); fs.writeFileSync(dest, b); resolve({ ok: true, size: b.length }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function buildMessages(b) {
  const out = [];
  let prevAcc = 0;
  for (const m of b.chat_messages || b.messages || []) {
    const role = String(m.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant';
    let text = '';
    const stages = [], steps = [], tips = [], files = [], union = [], queries = [], searches = [];
    const seen = new Set();
    for (const f of m.fragments || []) {
      if (['REQUEST', 'RESPONSE', 'TEMPLATE_RESPONSE'].includes(f.type)) text += f.content || '';
      else if (f.type === 'THINK') { stages.push({ secs: f.elapsed_secs || null, text: f.content || '' }); steps.push({ k: 'think', secs: f.elapsed_secs || null, text: f.content || '' }); }
      else if (f.type === 'TIP') tips.push(f.content || '');
      else if (f.type === 'FILE') for (const x of f.files || []) files.push({ name: x.file_name, size: x.file_size, is_image: !!x.is_image, id: x.id, signed_path: x.signed_path || '' });
      else if (f.type === 'SEARCH' || f.type === 'TOOL_SEARCH') {
        for (const q of f.queries || []) if (q.query) queries.push(q.query);
        for (const r of f.results || []) if (r.url && !seen.has(r.url)) { seen.add(r.url); union.push(r.url); }
        const grp = { queries: (f.queries || []).map((x) => x.query).filter(Boolean), results: (f.results || []).map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.snippet || '', published_at: r.published_at || '', site_name: r.site_name || '' })) };
        searches.push(grp);
        steps.push({ k: 'search', count: grp.results.length, queries: grp.queries });
      } else if (f.type === 'TOOL_OPEN' && f.result && f.result.url) {
        if (!seen.has(f.result.url)) { seen.add(f.result.url); union.push(f.result.url); }
        if (steps.length && steps[steps.length - 1].k === 'open') steps[steps.length - 1].items.push({ title: f.result.title || f.result.url, url: f.result.url });
        else steps.push({ k: 'open', items: [{ title: f.result.title || f.result.url, url: f.result.url }] });
      }
    }
    const acc = Number(m.accumulated_token_usage) || 0;
    const delta = acc > prevAcc ? acc - prevAcc : 0;
    prevAcc = acc;
    if (!text && !stages.length && !files.length && !tips.length) continue;
    out.push({ role, text, thinking: stages.map((x) => x.text).join(''), stages, steps, searches, tips, files, search: union.length ? { queries: [...new Set(queries)], results: union.map((u) => ({ url: u, title: u })) } : null, tokens: delta, insertedAt: m.inserted_at || null, model: m.model || '' });
  }
  return out;
}

(async () => {
  let summary = [];
  for (const acc of cfg.accounts.filter((a) => a.enabled)) {
    if (!acc.token || !acc.dataset || !acc.root) { console.log(`skip ${acc.name}: 缺 token/dataset/root`); continue; }
    const ds = (() => { try { return fs.existsSync(acc.dataset) ? JSON.parse(fs.readFileSync(acc.dataset, 'utf8')) : { conversations: [] }; } catch (e) { console.log(`${acc.name}: 数据集损坏，跳过本次，不覆盖`); summary.push(`${acc.name}: 数据集损坏`); return null; } })();
    if (!ds) continue;
    const known = new Set(ds.conversations.map((c) => c.id));
    const list = await getRetry('https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=100', acc.token).catch((e) => ({ error: String(e) }));
    const biz = (list.data && (list.data.biz_data || list.data)) || {};
    const sessions = biz.chat_sessions || [];
    if (list.error) { console.log(`${acc.name}: 列表失败 ${list.error}`); summary.push(`${acc.name}: 失败`); continue; }
    const fresh = sessions.filter((s) => !known.has(s.id));
    const byId = new Map(ds.conversations.map((c) => [c.id, c]));
    const updated = sessions.filter((s) => byId.has(s.id) && (Number(s.updated_at) || 0) > (Number(byId.get(s.id).updated_at) || 0) + 5);
    console.log(`${acc.name}: 总数 ${sessions.length}，新增 ${fresh.length}，更新 ${updated.length}`);
    if (!fresh.length && !updated.length) { summary.push(`${acc.name}: 无变化`); continue; }
    const targets = [...fresh, ...updated];
    let doneCount = 0;
    const totalCount = targets.length;
    const rebuilt = [];
    let fOk = 0, fBad = 0, fetchBad = 0;
    for (const s of targets) {
      doneCount += 1;
      console.log('PROGRESS\t' + doneCount + '\t' + totalCount + '\t' + String(s.title || '').slice(0, 40));
      if (doneCount > 1) await new Promise((r) => setTimeout(r, 350));
      const r = await get('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(s.id), acc.token).catch(() => null);
      if (!r || !r.data) { fetchBad += 1; continue; }
      const b = (r.data.biz_data || r.data) || {};
      const msgs = buildMessages(b);
      const previous = byId.get(s.id);
      if (!msgs.length && previous && (previous.messages || []).length) { fetchBad += 1; continue; }
      // 角标政策 v1：未实证一律删除编号
      for (const m of msgs) m.text = m.text.replace(/\[reference:\d+\]/g, '');
      // 附件（三档）
      const convDir = path.join(acc.root, safe(s.title));
      fs.mkdirSync(convDir, { recursive: true });
      for (const m of msgs) {
        for (const f of m.files || []) {
          if (!f.signed_path) { fBad += 1; continue; }
          if (cfg.attachmentMode === 'none') continue;
          if (cfg.attachmentMode === 'images' && !f.is_image) continue;
          const id8 = String(f.id || '').replace(/^file-/, '').slice(0, 8);
          const dest = path.join(convDir, id8 + '_' + safe(f.name));
          if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) { fOk += 1; continue; }
          const url = 'https://files.deepseeksvc.com/api' + f.signed_path + (f.is_image ? '&ty=p' : '&ty=r');
          const d = await dl(url, dest);
          d.ok ? (fOk += 1) : (fBad += 1);
        }
      }
      rebuilt.push({ id: s.id, title: s.title, updated_at: s.updated_at, messages: msgs });
    }
    if (!DRY) {
      for (const c of rebuilt) {
        const idx = ds.conversations.findIndex((x) => x.id === c.id);
        const entry = { id: c.id, title: c.title, updated_at: c.updated_at, messages: c.messages };
        if (idx >= 0) ds.conversations[idx] = entry; else ds.conversations.push(entry);
      }
      fs.mkdirSync(path.dirname(acc.dataset), { recursive: true });
      const tmp = acc.dataset + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(ds, null, 2));
      try { fs.copyFileSync(acc.dataset, acc.dataset + '.bak'); } catch (e) {}
      fs.renameSync(tmp, acc.dataset);
    }
    summary.push(`${acc.name}: 新增 ${fresh.length}，更新 ${updated.length}，附件 ${fOk} 成功/${fBad} 失败${fetchBad ? '，' + fetchBad + ' 条抓取失败' : ''}${DRY ? '（干跑未写入）' : ''}`);
    await new Promise((r) => setTimeout(r, 600));
  }
  console.log('=== SUMMARY ===');
  for (const s of summary) console.log(' - ' + s);
})();
