'use strict';
// 最小包级回归：元数据、必需文件、locale、入口语法
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const ok = (msg) => console.log('ok:', msg);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const key of ['name', 'version', 'description', 'license', 'main', 'files']) {
  if (!pkg[key]) fail('package.json missing ' + key);
if (!pkg.repository || !pkg.repository.url) fail('package.json missing repository');
if (!pkg.homepage) fail('package.json missing homepage');
if (!/^## 安装$/m.test(fs.readFileSync(path.join(root, 'README.md'), 'utf8'))) fail('README install section missing');
if ((fs.readFileSync(path.join(root, 'README.md'), 'utf8').match(/^## 安装$/gm) || []).length > 1) fail('README has duplicate install sections');
if (!fs.existsSync(path.join(root, 'README.en.md'))) fail('README.en.md missing');
if (!fs.existsSync(path.join(root, 'SECURITY.md'))) fail('SECURITY.md missing');
if (!fs.existsSync(path.join(root, 'docs', 'RELEASE.md'))) fail('release checklist missing');
if (!pkg.files.includes('SECURITY.md')) fail('package files missing SECURITY.md');
if (!pkg.files.includes('docs')) fail('package files missing docs');
if (!fs.existsSync(path.join(root, 'locale', 'zh.json'))) fail('locale zh missing');
if (!fs.existsSync(path.join(root, 'lib', 'browser', 'login-save.mjs'))) fail('bundled login script missing');
if (!fs.existsSync(path.join(root, 'lib', 'engine', 'install.cjs'))) fail('bundled installer missing');
if (new RegExp('mobile' + '_number|email', 'i').test(fs.readFileSync(path.join(root, 'lib', 'browser', 'login-save.mjs'), 'utf8'))) fail('login script still collects phone/email');
if (/body\s*:|console\s*:/.test(fs.readFileSync(path.join(root, 'lib', 'browser', 'login-save.mjs'), 'utf8'))) fail('login result still writes page/console data');
if (!Array.isArray(pkg.files) || !pkg.files.includes('lib')) fail('package files must include lib');
if (!pkg.dependencies || !pkg.dependencies['puppeteer-core']) fail('puppeteer-core dependency missing');
if (!pkg.engines || !pkg.engines.dsh) fail('DSH engine declaration missing');
if (!fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes(pkg.version)) fail('CHANGELOG missing current version');
const indexText = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
const clientText = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8');
if (!indexText.includes('accountsCleared') || !clientText.includes('accountsCleared')) fail('account clear path missing');
if (!indexText.includes("runNow: false, status: 'running'")) fail('runNow edge not reset');
if (!indexText.includes('pending.failed')) fail('install failure marker not read');
if (!indexText.includes('该账号在登录期间已被删除')) fail('login stale snapshot guard missing');
if (!indexText.includes('安装未完成，请重试')) fail('install watchdog missing');
if (!indexText.includes('persistSettings failed')) fail('settings write retry/log missing');
if (!indexText.includes("Microsoft', 'Edge'")) fail('per-user Edge path missing');
if (!indexText.includes('AddSeconds(30)')) fail('installer process wait missing');
if (!indexText.includes('opts.failed')) fail('afterSync failure guard missing');
if (!indexText.includes('$LASTEXITCODE = $null')) fail('installer exit reset missing');
if (!indexText.includes("ELECTRON_RUN_AS_NODE: '1'")) fail('child Electron env missing');
if (!indexText.includes('prefix-renamed.json')) fail('prefix rename cache missing');
if (!indexText.includes("status: 'idle'")) fail('no-enabled sync should not report done');
if (/\bout\.(write|close)\(/.test(indexText)) fail('engine log handle must not be used');
if (!clientText.includes('安装未完成')) fail('install watchdog status not rendered');
if (!fs.readFileSync(path.join(root, 'lib', 'engine', 'install.cjs'), 'utf8').includes("return '06-misc'")) fail('neutral category fallback missing');
for (const f of ['catalog.cjs', 'export.cjs']) if (!fs.readFileSync(path.join(root, 'lib', 'engine', f), 'utf8').includes('if (!fs.existsSync(rawDir)) process.exit(0)')) fail(f + ' missing empty workspace guard');
for (const f of ['catalog.cjs', 'export.cjs']) if (!fs.readFileSync(path.join(root, 'lib', 'engine', f), 'utf8').includes('skip corrupt dataset')) fail(f + ' missing corrupt dataset guard');
if (!clientText.includes('移除账号只停止同步')) fail('account removal note missing');
if (!fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes('SECURITY.md')) fail('README security link missing');
if (!fs.readFileSync(path.join(root, 'README.en.md'), 'utf8').includes('SECURITY.md')) fail('README.en security link missing');
if (!fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8').includes('does not silently destroy history')) fail('SECURITY removal semantics missing');
}
if (!/^\d+\.\d+\.\d+/.test(pkg.version)) fail('version is not semver: ' + pkg.version);
if (pkg.license !== 'MIT') fail('license should be MIT');
if (!fs.existsSync(path.join(root, 'LICENSE'))) fail('LICENSE missing');
if (!fs.existsSync(path.join(root, 'cordis.patch.yml'))) fail('cordis.patch.yml missing');
if (!fs.existsSync(path.join(root, 'icon.png'))) fail('icon.png missing');
ok('package metadata and required files');

for (const loc of ['en', 'zh']) {
  const p = path.join(root, 'locale', loc + '.json');
  if (!fs.existsSync(p)) { fail('locale missing: ' + loc); continue; }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!j.meta || !j.meta.title || !j.meta.description) fail('locale meta incomplete: ' + loc);
}
ok('locale en/zh');

for (const f of ['lib/index.js', 'client/client.js', 'lib/engine/catalog.cjs', 'lib/engine/export.cjs', 'lib/engine/sync-all.cjs']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { fail('missing ' + f); continue; }
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (r.status !== 0) fail('syntax ' + f + ': ' + (r.stderr || '').slice(0, 300));
}
ok('syntax lib/client/engine');

const cfg = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', '.dsh-chat-history-sync', 'config.json');
if (fs.existsSync(cfg)) {
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  if ((c.accounts || []).some((a) => a.token)) fail('config.json contains plaintext token');
  else ok('config.json has no plaintext token');
  if ((c.accounts || []).some((a) => a.phone || a.email)) fail('config.json contains phone/email');
  else ok('config.json has no phone/email');
}
// 发布源码中不允许出现手机号/本机绝对路径/真实 token
const textFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tmp') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|cjs|json|md|yml|svg)$/.test(e.name)) textFiles.push(p);
  }
};
walk(root);
const leakPatterns = [/\d{3}\*{6}\d{2}/, /npm_[A-Za-z0-9]{20,}/, /C:\\Users\\[^\\\s]+/i, /Bearer\s+[A-Za-z0-9._-]{20,}/, new RegExp('mobile' + '_number')];
for (const f of textFiles) {
  const text = fs.readFileSync(f, 'utf8');
  for (const re of leakPatterns) if (re.test(text)) fail('possible personal data in ' + path.relative(root, f));
}
ok('no phone/token/local-path patterns in source');
console.log(process.exitCode ? 'TESTS FAILED' : 'TESTS PASSED');
