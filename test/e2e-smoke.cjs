'use strict';
// 发布/安装冒烟：在真实工作区跑 installer dry-run，并检查取消/安装字段存在
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const workspace = path.resolve(root, '..', '..');
const installer = path.join(workspace, 'tools', 'install-v2.js');
if (!fs.existsSync(installer)) {
  console.log('e2e skipped: installer not present');
  process.exit(0);
}
const report = path.join(workspace, 'tmp', 'e2e-install-report.json');
const r = spawnSync(process.execPath, [installer, '--dry-run', '--report', report], { encoding: 'utf8', timeout: 180000 });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
const data = JSON.parse(fs.readFileSync(report, 'utf8'));
if (data.actions && data.actions.failed) { console.error('installer failures', data.actions); process.exit(1); }
console.log('installer dry-run ok', data.actions || '');
const client = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8');
for (const s of ['cancelSync', 'installPending', 'installNow', 'exportDiagnostics']) {
  if (!client.includes(s)) { console.error('missing UI control ' + s); process.exit(1); }
}
console.log('cancel/install controls present');

if (process.platform === 'win32') {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  setTimeout(() => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('close', () => {
      setTimeout(() => {
        if (child.exitCode === null) { console.error('cancel child still alive'); process.exit(1); }
        console.log('cancel process-tree test passed');
      }, 300);
    });
  }, 300);
}

