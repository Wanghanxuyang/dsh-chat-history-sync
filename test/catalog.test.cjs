'use strict';
// 目录/同名复查回归：用最小数据集跑 catalog.cjs
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const tmp = path.join(__dirname, '.catalog-fixture');
fs.rmSync(tmp, { recursive: true, force: true });
const raw = path.join(tmp, 'history', '_raw');
fs.mkdirSync(raw, { recursive: true });
fs.writeFileSync(path.join(raw, 'account-prefixes.json'), JSON.stringify({ 'conversations.demo.json': '测试号' }));
const mk = (id, text) => ({ id, title: '同名会话', updated_at: 1700000000, messages: [{ role: 'user', text }, { role: 'assistant', text: '回答：' + text }] });
fs.writeFileSync(path.join(raw, 'conversations.demo.json'), JSON.stringify({ conversations: [mk('a1', '第一个版本的问题'), mk('a2', '第二个版本的问题')] }));
fs.writeFileSync(path.join(raw, 'conversations.broken.json'), '{broken');
const r = spawnSync(process.execPath, [path.join(root, 'lib', 'engine', 'catalog.cjs'), tmp], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
const cat = fs.readFileSync(path.join(raw, '分类目录.md'), 'utf8');
const dup = fs.readFileSync(path.join(raw, '同名不同内容.md'), 'utf8');
if (!dup.includes('2 个版本')) { console.error('duplicate group missing'); process.exit(1); }
if (!cat.includes('同名不同内容保留 1 组')) { console.error('catalog header missing'); process.exit(1); }
if (!cat.includes('06 其他')) { console.error('neutral category missing'); process.exit(1); }
const links = [...dup.matchAll(/\]\(会话位置\/([^)]+)\)/g)].map((m) => m[1]);
if (new Set(links).size !== 2) { console.error('duplicate links not unique', links); process.exit(1); }
const sums = [...cat.matchAll(/摘要：([^\n]+)/g)].map((m) => m[1]);
if (!sums.length || sums.some((s) => [...s].length < 50 || [...s].length > 100)) { console.error('summary length out of range', sums.map((s) => [...s].length)); process.exit(1); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log('catalog duplicate regression passed');
