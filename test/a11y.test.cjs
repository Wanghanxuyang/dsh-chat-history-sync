'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8');
const checks = [
  ["aria-label", /aria-label/],
  ["aria-expanded", /aria-expanded/],
  ["role=status", /role: 'status'/],
  ["aria-live", /aria-live/],
  ["focus-visible", /focus-visible/],
  ["narrow breakpoint", /@media \(max-width:560px\)/],
];
for (const [name, re] of checks) {
  if (!re.test(client)) { console.error('a11y missing:', name); process.exit(1); }
}
if (/window\.confirm/.test(client)) { console.error('browser confirm still used'); process.exit(1); }
const banned = ['自动巡检', '报告会话 ID', '留空自动管理', '都不下载', '仅失败/待确认', '登录后自动同步该账号', '自动安装新会话', '自动检查更新'];
for (const s of banned) if (client.includes(s)) { console.error('unclear copy still present:', s); process.exit(1); }
for (const s of ['附件下载', '自动同步（每小时）', '新会话安装提醒', '更多设置']) if (!client.includes(s)) { console.error('clear copy missing:', s); process.exit(1); }
console.log('a11y static checks passed');
