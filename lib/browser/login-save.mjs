// 登录新账号：连接本次启动的临时 Edge（CDP 端口由宿主传入），
// 清掉任何残留登录状态 → 打开登录页 → 等用户登录并校验 userId → 写结果 JSON。
// 结果只写文件（不打印 token）；结束后自动关闭这个临时浏览器。
// 用法：node login-save.mjs <result.json> <known-tokens.json> [port]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import crypto from 'node:crypto';

const outPath = process.argv[2];
const knownPath = process.argv[3];
const port = String(process.argv[4] || '9222');
const write = (o) => { try { fs.writeFileSync(outPath, JSON.stringify({ ...o, at: Date.now() })); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!outPath) { console.error('usage: login-save.mjs <result.json> <known-tokens.json> [port]'); process.exit(2); }
let known = [];
try { known = JSON.parse(fs.readFileSync(knownPath, 'utf8')); } catch (e) { known = []; }
const knownSet = new Set((known || []).filter(Boolean));

const parseToken = (raw) => {
  if (!raw) return '';
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') return typeof p.value === 'string' ? p.value : '';
  } catch (e) { /* 不是 JSON，按原始字符串处理 */ }
  return typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : '';
};
const validToken = (t) => !!t && t.length >= 30 && !/[{}\s"]/.test(t);

let browser = null;
let failed = [], consoleErrors = [], pageState = {};
const finish = async (obj, code) => {
  write(obj);
  try { if (browser) await browser.close(); } catch (e) {}
  process.exit(code);
};

try {
  for (let i = 0; i < 20 && !browser; i += 1) {
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null }); }
    catch (e) { await sleep(1000); }
  }
  if (!browser) throw new Error('无法连接浏览器（CDP ' + port + ' 未就绪）');

  const pages = (await browser.pages()).filter((p) => !p.isClosed());
  const page = pages.find((p) => p.url() === 'about:blank') || pages[0] || (await browser.newPage());
  failed = [];
  consoleErrors = [];
  page.on('requestfailed', (r) => {
    try { failed.push({ url: r.url().slice(0, 240), err: r.failure() && r.failure().errorText }); } catch (e) {}
  });
  page.on('console', (m) => {
    try { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); } catch (e) {}
  });

  // 新临时配置本来就是干净状态；不要再清 cookie（会破坏 Cloudflare/Turnstile 的挑战态）
  await page.goto('https://chat.deepseek.com/sign_in', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);
  pageState = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    hasPhone: !!document.querySelector('input[type="tel"], input[placeholder*="手机"], input[placeholder*="验证码"]'),
    body: (document.body && document.body.innerText || '').slice(0, 300),
  })).catch(() => ({}));
  write({ ok: false, status: 'waiting', page: pageState, failed: failed.slice(-10), console: consoleErrors.slice(-10) });

  for (let i = 0; i < 150; i += 1) {
    if (page.isClosed()) await finish({ ok: false, status: 'cancelled', error: '浏览器页面已关闭，未保存', failed: failed.slice(-10), console: consoleErrors.slice(-10) }, 1);
    const raw = await page.evaluate(() => {
      try { return localStorage.getItem('userToken') || ''; } catch (e) { return ''; }
    }).catch(() => '');
    const tok = parseToken(raw);
    if (validToken(tok) && !knownSet.has(crypto.createHash('sha256').update(tok).digest('hex'))) {
      const info = await page.evaluate(async (token) => {
        const h = {
          accept: '*/*', authorization: 'Bearer ' + token,
          'x-client-bundle-id': 'com.deepseek.chat', 'x-client-locale': 'zh_CN',
          'x-client-platform': 'web', 'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
          'x-client-version': '2.7.1',
        };
        try {
          const r = await fetch('/api/v0/users/current', { headers: h, credentials: 'include' });
          const me = await r.json();
          const b = (me.data && (me.data.biz_data || me.data)) || {};
          let ui = {};
          try { ui = JSON.parse(localStorage.getItem('userInfo') || '{}') || {}; } catch (e) { ui = {}; }
          return {
            userId: b.id || b.user_id || '',
            phone: b.mobile_number || '',
            email: b.email || '',
            nickname: ui.name || ui.nickname || ui.user_name || ui.userName || ui.nickName || '',
            avatarUrl: ui.avatar || ui.avatar_url || ui.avatarUrl || ui.head_url || ui.headUrl || '',
          };
        } catch (e) { return { userId: '', phone: '', email: '', nickname: '', avatarUrl: '' }; }
      }, tok).catch(() => ({ userId: '', phone: '', email: '', nickname: '', avatarUrl: '' }));
      if (info.userId) {
        await finish({ ok: true, token: tok, userId: info.userId, phone: info.phone || '', email: info.email || '', nickname: info.nickname || '', avatarUrl: info.avatarUrl || '' }, 0);
      }
    }
    await sleep(2000);
  }
  await finish({ ok: false, status: 'timeout', error: '登录超时（5 分钟），未保存', failed: failed.slice(-10), console: consoleErrors.slice(-10), page: pageState }, 1);
} catch (e) {
  await finish({ ok: false, status: 'error', error: String((e && e.message) || e).slice(0, 200), failed: failed.slice(-10), console: consoleErrors.slice(-10) }, 1);
}
