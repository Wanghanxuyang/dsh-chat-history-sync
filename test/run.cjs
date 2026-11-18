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
if (!fs.existsSync(path.join(root, 'README.en.md'))) fail('README.en.md missing');
if (!fs.existsSync(path.join(root, 'locale', 'zh.json'))) fail('locale zh missing');
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
console.log(process.exitCode ? 'TESTS FAILED' : 'TESTS PASSED');
