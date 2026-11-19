// dsh-chat-history-sync 宿主入口
// 设置：通过 export const Config（schemastery）由 Settings 自动生成表单
// 账号/运行时数据：插件自有数据目录 .dsh-chat-history-sync/config.json
// 旧目录 .dsh-memory-sync 首次启动时自动复制迁移
// 同步引擎：lib/engine/sync-all.cjs（独立进程，经 DSH_SYNC_CONFIG 传递配置）
import z from '@deepseek-ai/schemastery';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fsp, existsSync } from 'node:fs';
import nodeFs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
let pluginVersion = '0.0.0';
try { pluginVersion = JSON.parse(nodeFs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version || pluginVersion; } catch (e) {}

const editable = (schema) => schema.extra('volatile', true);

export const Config = z.object({
  attachmentMode: editable(z.union(['all', 'none', 'images']).default('all')),
  autoSync: editable(z.boolean().default(false)),
  autoInstall: editable(z.boolean().default(true)),
  notifyEnabled: editable(z.boolean().default(true)),
  digestEnabled: editable(z.boolean().default(true)),
  lastSyncAt: editable(z.number().default(0)),
  lastSyncResult: editable(z.string().default('')),
  accountHealth: editable(z.string().default('{}')),
  attachmentStats: editable(z.string().default('')),
  installPending: editable(z.boolean().default(false)),
  installNow: editable(z.boolean().default(false)),
  installCancel: editable(z.boolean().default(false)),
  installDeferred: editable(z.boolean().default(false)),
  installDeferredByUser: editable(z.boolean().default(false)),
  installScheduled: editable(z.boolean().default(false)),
  installSucceeded: editable(z.boolean().default(false)),
  exportDiagnostics: editable(z.boolean().default(false)),
  runNow: editable(z.boolean().default(false)),
  cancelSync: editable(z.boolean().default(false)),
  accounts: editable(z.string().default('[]')),
  accountsReady: editable(z.boolean().default(false)),
  accountsCleared: editable(z.boolean().default(false)),
  duplicateCount: editable(z.number().default(0)),
  reportTargetSessionId: editable(z.string().default('')),
  loginRequest: editable(z.number().default(0)),
  loginStatus: editable(z.string().default('')),
  loginCancel: editable(z.number().default(0)),
  reportText: editable(z.string().default('')),
  status: editable(z.union(['idle', 'running', 'done', 'error']).default('idle')),
  statusText: editable(z.string().default('')),
  startedAt: editable(z.number().default(0)),
});

export const name = 'dsh-chat-history-sync';
export const inject = [];

const DEFAULT_ACCOUNTS = {
  version: 1,
  accounts: [],            // { id, name, prefix, token, dataset, root, enabled }
  reportSessionId: null,
};

export function apply(ctx, config = {}) {
  const profileDir = process.env.DSH_PROFILE_DIR || process.cwd();
  const dataDir = path.join(profileDir, '.dsh-chat-history-sync');
  const legacyDataDir = path.join(profileDir, '.dsh-memory-sync');
const dshHomeDir = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
  try {
    if (!existsSync(dataDir) && existsSync(legacyDataDir)) nodeFs.cpSync(legacyDataDir, dataDir, { recursive: true });
  } catch (e) {}
  const cfgPath = path.join(dataDir, 'config.json');
  // 宿主异常退出时可能留下含明文 token 的运行配置/登录结果，启动先清掉
  for (const f of ['run-config.json', 'login-result.json']) {
    try { nodeFs.rmSync(path.join(dataDir, f), { force: true }); } catch (e) {}
  }
  // 启动清理异常退出留下的临时登录配置（不碰正在使用的目录）
  try {
    const tmpRoot = process.env.TEMP || os.tmpdir();
    for (const name of nodeFs.readdirSync(tmpRoot)) {
      if (!/^dsh-chat-history-sync-login-/.test(name)) continue;
      const p = path.join(tmpRoot, name);
      try {
        const st = nodeFs.statSync(p);
        if (Date.now() - st.mtimeMs > 30 * 60 * 1000) nodeFs.rmSync(p, { recursive: true, force: true });
      } catch (e) {}
    }
  } catch (e) {}
  // 清理旧日志里可能残留的 profile 昵称/联系方式尾号
  try {
    const logPath = path.join(dataDir, 'settings.log');
    if (nodeFs.existsSync(logPath)) {
      const lines = nodeFs.readFileSync(logPath, 'utf8').split('\n');
      const kept = lines.filter((line) => !/contact=|dsh profile: name=/.test(line));
      if (kept.length !== lines.length) nodeFs.writeFileSync(logPath, kept.join('\n'));
    }
  } catch (e) {}
  // 旧 sync.log 可能含进度标题/旧格式重命名标题，启动时清掉这两类行
  try {
    const logPath = path.join(dataDir, 'sync.log');
    if (nodeFs.existsSync(logPath)) {
      const lines = nodeFs.readFileSync(logPath, 'utf8').split('\n');
      const kept = lines.filter((line) => !/^PROGRESS\t/.test(line)
        && !/^rename failed .* -> /.test(line)
        && !/^ - /.test(line)
        && !/^\S[^:\n]*: (总数|数据集损坏|列表失败)/.test(line));
      if (kept.length !== lines.length) nodeFs.writeFileSync(logPath, kept.join('\n'));
    }
  } catch (e) {}
  try {
    for (const f of nodeFs.readdirSync(dataDir)) {
      if (!/^config\.json\.bak/.test(f)) continue;
      const p = path.join(dataDir, f);
      try {
        const c = JSON.parse(nodeFs.readFileSync(p, 'utf8'));
        let changed = false;
        for (const a of c.accounts || []) {
          for (const k of ['token', 'phone', 'email']) if (k in a) { delete a[k]; changed = true; }
        }
        if (changed) nodeFs.writeFileSync(p, JSON.stringify(c, null, 2));
      } catch (e) {}
    }
  } catch (e) {}
  let syncInFlight = false; // 防止手动同步与自动巡检并发写同一份数据集
let activeChild = null;
let cancelRequested = false;

  const loadAccounts = async () => {
    if (!existsSync(cfgPath)) {
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.writeFile(cfgPath, JSON.stringify(DEFAULT_ACCOUNTS, null, 2));
      return { ...DEFAULT_ACCOUNTS };
    }
    try {
      const c = { ...DEFAULT_ACCOUNTS, ...JSON.parse(await fsp.readFile(cfgPath, 'utf8')) };
      for (const a of c.accounts || []) {
        if (!a.token && a.tokenEnc) {
          try { a.token = dpapiDecrypt(a.tokenEnc); } catch (e) {}
        }
      }
      return c;
    } catch (e) { return { ...DEFAULT_ACCOUNTS }; }
  };
  const saveAccounts = async (c) => {
    const out = { ...c, accounts: (c.accounts || []).map((a) => {
      const x = { ...a };
      if (x.token) {
        try {
          const enc = dpapiEncrypt(x.token);
          if (enc) { x.tokenEnc = enc; delete x.token; }
          else { delete x.token; }
        } catch (e) { delete x.token; }
      } else if (x.tokenEnc) {
        delete x.token;
      }
      delete x.phone;
      delete x.email;
      return x;
    }) };
    try {
      if (!existsSync(cfgPath + '.bak-dpapi')) await fsp.copyFile(cfgPath, cfgPath + '.bak-dpapi');
    } catch (e) {}
    await fsp.writeFile(cfgPath, JSON.stringify(out, null, 2));
  };
  const DPAPI_PS = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const dpapiCache = new Map();
  const dpapiCrypt = (mode, b64) => {
    const script = "Add-Type -AssemblyName System.Security; " + (mode === 'enc'
      ? "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('" + b64 + "'),$null,'CurrentUser'))"
      : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" + b64 + "'),$null,'CurrentUser'))");
    const out = execFileSync(DPAPI_PS, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return String(out || '').trim();
  };
  const dpapiEncrypt = (plain) => dpapiCrypt('enc', Buffer.from(String(plain), 'utf8').toString('base64'));
  const dpapiDecrypt = (enc) => {
    if (dpapiCache.has(enc)) return dpapiCache.get(enc);
    const dec = Buffer.from(dpapiCrypt('dec', enc), 'base64').toString('utf8');
    dpapiCache.set(enc, dec);
    return dec;
  };
  // 首次升级：把已有明文 token 迁移为 DPAPI 密文
  setTimeout(async () => {
    try {
      const c = await loadAccounts();
      if ((c.accounts || []).some((a) => a.token)) await saveAccounts(c);
    } catch (e) {}
  }, 2500);

  // 设置页：DSH 0.2.x 由插件 Config 自动投影成设置命名空间（入口 id 如 include:dsh-chat-history-sync），
  // 旧版的 settings.register 已不存在。这里只关闭「自动生成页」，命名空间保留给自定义卡片使用。
  const cfgGet = (key, fallback) => {
    const f = config && config[key];
    if (f && typeof f.get === 'function') {
      try { const v = f.get(); return v === undefined ? fallback : v; } catch (e) { return fallback; }
    }
    return f === undefined ? fallback : f;
  };
  const liveConfig = {
    get attachmentMode() { const v = cfgGet('attachmentMode', 'all'); return ['all', 'none', 'images'].includes(v) ? v : 'all'; },
    get autoSync() { return !!cfgGet('autoSync', false); },
    get autoInstall() { return cfgGet('autoInstall', true) !== false; },
    get reportTargetSessionId() { return String(cfgGet('reportTargetSessionId', '') || ''); },
    get accounts() { return cfgGet('accounts', '[]'); },
    get accountsReady() { return !!cfgGet('accountsReady', false); },
    get accountsCleared() { return !!cfgGet('accountsCleared', false); },
  };
  let settingsSvc = null;
  ctx.inject(['settings'], (scoped) => {
    try {
      const svc = scoped.settings;
      settingsSvc = svc || null;
      if (svc && typeof svc.configure === 'function' && ctx.fiber) {
        scoped.effect(() => svc.configure({ auto: false }, ctx.fiber));
      }
      let dbg = 'entry=' + (ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.id);
      try {
        const rows = typeof svc.describe === 'function' ? svc.describe() : [];
        dbg += ' total=' + rows.length + ' ns=[' + rows.map((r) => r.ns + '|auto=' + r.autoGenerate + '|keys=' + Object.keys(r.value || {}).join(',')).join(' ; ') + ']';
      } catch (e) { dbg += ' describe-err=' + String(e); }
      try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' settings.configured auto=false ' + dbg + '\n'); } catch (e) {}
    } catch (e) {
      try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' settings.configure failed: ' + ((e && e.stack) || e) + '\n'); } catch (e2) {}
      ctx.logger.warn?.('[memory-sync] settings.configure 失败: ' + (e && e.message || e));
    }
  });

  const scheduleWorkspaceInstall = async (wsDir) => {
    try {
      let runHidden = path.join(dataDir, 'install-public.vbs');
      let installScript = path.join(dataDir, 'install-public.ps1');
      try { nodeFs.rmSync(path.join(dataDir, 'install-result.json'), { force: true }); } catch (e) {}
      try { nodeFs.rmSync(runHidden, { force: true }); nodeFs.rmSync(installScript, { force: true }); } catch (e) {}
      if (!existsSync(runHidden) || !existsSync(installScript)) {
        // 公开发行版没有工作区脚本时，使用插件内置导入器
        const bundledInstaller = path.join(here, 'engine', 'install.cjs');
        if (!existsSync(bundledInstaller)) return false;
        const ps1Path = path.join(dataDir, 'install-public.ps1');
        const vbsPath = path.join(dataDir, 'install-public.vbs');
        const dshHome = dshHomeDir;
        const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
        const ps1 = [
          '$ErrorActionPreference = "SilentlyContinue"',
          '$log = ' + q(path.join(dataDir, 'install-public.log')),
          '"=== install start " + (Get-Date).ToString("o") + " ===" | Out-File -FilePath $log -Encoding utf8 -Append',
          'Start-Sleep -Seconds 20',
          'taskkill.exe /IM "DeepSeek Harness.exe" /F | Out-Null',
          'taskkill.exe /PID ' + process.pid + ' /T /F | Out-Null',
          '$deadline = (Get-Date).AddSeconds(30)',
          'while ((tasklist.exe /FI "IMAGENAME eq DeepSeek Harness.exe" | Select-String "DeepSeek Harness.exe") -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 500 }',
          'Start-Sleep -Seconds 1',
          '$env:DSH_SYNC_WORKSPACE = ' + q(wsDir),
          '$env:DSH_HOME = ' + q(dshHome),
          '$env:DSH_SYNC_INSTALL_RESULT = ' + q(path.join(dataDir, 'install-result.json')),
          '$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source',
          'if (-not $node) { $node = "D:\\Software\\nodejs\\node.exe" }',
          '"node=" + $node | Out-File -FilePath $log -Encoding utf8 -Append',
          '$LASTEXITCODE = $null',
          '& $node ' + q(bundledInstaller) + ' --assume-dsh-stopped 2>&1 | Out-File -FilePath $log -Encoding utf8 -Append',
          '$installCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
          '"exit=" + $installCode | Out-File -FilePath $log -Encoding utf8 -Append',
          '$installResult = @{ ok = ($installCode -eq 0); code = $installCode; at = (Get-Date).ToString("o"); log = $log } | ConvertTo-Json -Compress',
          '[IO.File]::WriteAllText($env:DSH_SYNC_INSTALL_RESULT, $installResult)',
          'Start-Process -FilePath ' + q(process.execPath),
          'schtasks.exe /delete /TN DshSyncInstall2 /f | Out-Null',
        ].join('\r\n') + '\r\n';
        const vbs = 'Set sh = CreateObject("WScript.Shell")\r\nsh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """", 0, False\r\n';
        await fsp.writeFile(ps1Path, '\ufeff' + ps1, 'utf8');
        await fsp.writeFile(vbsPath, vbs, 'utf8');
        runHidden = vbsPath;
        installScript = ps1Path;
      }
      const schtasks = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
      const when = new Date(Date.now() + 2 * 60 * 1000);
      const st = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
      const tr = 'wscript.exe //B //Nologo "' + runHidden + '" "' + installScript + '"';
      const createCode = await new Promise((resolve) => {
        const c = spawn(schtasks, ['/Create', '/TN', 'DshSyncInstall2', '/SC', 'ONCE', '/ST', st, '/TR', tr, '/F', '/IT', '/RL', 'LIMITED'], { windowsHide: true, stdio: 'ignore' });
        c.on('close', (code) => resolve(code)); c.on('error', () => resolve(-1));
      });
      if (createCode !== 0) return false;
      const runCode = await new Promise((resolve) => {
        const r = spawn(schtasks, ['/Run', '/TN', 'DshSyncInstall2'], { windowsHide: true, stdio: 'ignore' });
        r.on('close', (code) => resolve(code)); r.on('error', () => resolve(-1));
      });
      if (runCode !== 0) return false;
      try { await fsp.rm(path.join(dataDir, 'install-pending.json'), { force: true }); } catch (e) {}
      return true;
    } catch (e) { return false; }
  };
  // 设置页编辑昵称后，定期合并到 config.json（用户可能不点同步就刷新/重启）
  const nicknameTimer = setInterval(() => { void withSettingsAccounts().catch(() => {}); }, 5000);
  ctx.effect(() => () => clearInterval(nicknameTimer));
  setTimeout(async () => {
    try {
      const st = estimateAttachments(resolveWorkspaceDir(await loadAccounts()));
      if (st) await publish({ attachmentStats: st });
    } catch (e) {}
  }, 6500);
  setTimeout(async () => {
    try {
      const ws = resolveWorkspaceDir(await loadAccounts());
      if (!ws) return;
      const p = path.join(ws, 'history', '_raw', '同名不同内容.md');
      if (!existsSync(p)) return;
      const n = (nodeFs.readFileSync(p, 'utf8').match(/^## /gm) || []).length;
      await publishPersistent({ duplicateCount: n });
    } catch (e) {}
  }, 7000);
  setTimeout(async () => {
    try {
      const p = path.join(dataDir, 'install-pending.json');
      if (existsSync(p)) {
        let pending = null;
        try { pending = JSON.parse(nodeFs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
        if (pending && pending.failed) {
          await publishPersistent({ installPending: true, installDeferred: false, installDeferredByUser: false, installScheduled: false, installSucceeded: false, statusText: '导入失败，请重试' });
        } else {
          const deferred = !!cfgGet('installDeferred', false);
          await publishPersistent({ installPending: !deferred, installDeferred: deferred, installDeferredByUser: false, statusText: deferred ? '有会话待导入' : '同步完成：检测到新对话，请确认是否导入到工作区' });
        }
        try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' pending-publish cfg=' + String(cfgGet('installPending', false)) + ' statusText=' + JSON.stringify(String(cfgGet('statusText', ''))).slice(0, 80) + '\n'); } catch (e) {}
      }
    } catch (e) {}
  }, 7000);
  setTimeout(async () => {
    try {
      const resultPath = path.join(dataDir, 'install-result.json');
      if (!existsSync(resultPath)) return true;
      let r = null;
      try { r = JSON.parse(nodeFs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { r = null; }
      try { nodeFs.rmSync(resultPath, { force: true }); } catch (e) {}
      if (r && r.ok) {
        try { nodeFs.rmSync(path.join(dataDir, 'install-pending.json'), { force: true }); } catch (e) {}
        await publishPersistent({ installPending: false, installDeferred: false, installDeferredByUser: false, installScheduled: false, installSucceeded: true, statusText: '导入完成' });
        setTimeout(() => { if (String(cfgGet('statusText', '')) === '导入完成') void publishPersistent({ statusText: '已同步' }); }, 8000);
        setTimeout(() => { if (cfgGet('installSucceeded', false)) void publishPersistent({ installSucceeded: false }); }, 12000);
        notify('聊天历史同步', '新对话已加入 DSH');
        let reportOk = false;
        try {
          const ws = resolveWorkspaceDir(await withSettingsAccounts());
          if (ws) reportOk = !!(await writeReport(ws, '🧠 DSH 导入报告', '# DSH 导入完成\n\n时间：' + new Date().toISOString() + '\n\n本地归档已写入 DSH；本次导入结果见同步报告与 history/_raw/install-audit.jsonl。\n'));
        } catch (e) {}
        if (!reportOk) {
          await publishPersistent({ installSucceeded: false, statusText: '导入完成，但报告未生成' });
        }
      } else if (r) {
        try { nodeFs.writeFileSync(path.join(dataDir, 'install-pending.json'), JSON.stringify({ at: Date.now(), failed: r.code || 1 })); } catch (e) {}
        await publishPersistent({ installPending: true, installDeferred: false, installDeferredByUser: false, installScheduled: false, installSucceeded: false, statusText: '导入失败，请重试' });
      }
      try { await refreshAccountsMirror(); } catch (e) {}
      return true;
    } catch (e) {}
  }, 8000);
  setTimeout(async () => {
    try {
      if (!cfgGet('installScheduled', false)) return;
      const pendingPath = path.join(dataDir, 'install-pending.json');
      const resultPath = path.join(dataDir, 'install-result.json');
      if (existsSync(pendingPath) || existsSync(resultPath)) return;
      await publishPersistent({ installPending: true, installDeferred: false, installDeferredByUser: false, installScheduled: false, installSucceeded: false, statusText: '导入未完成，请重试' });
    } catch (e) {}
  }, 15000);
  setTimeout(async () => {
    try { if (cfgGet('installSucceeded', false)) await publishPersistent({ installSucceeded: false }); } catch (e) {}
  }, 12000);
  setTimeout(async () => {
    try {
      if (!/^已安排导入/.test(String(cfgGet('statusText', '')))) return;
      const pendingPath = path.join(dataDir, 'install-pending.json');
      const resultPath = path.join(dataDir, 'install-result.json');
      if (existsSync(pendingPath) || existsSync(resultPath)) return;
      try { nodeFs.writeFileSync(pendingPath, JSON.stringify({ at: Date.now(), failed: 1 })); } catch (e) {}
      await publishPersistent({ installPending: true, installDeferred: false, installDeferredByUser: false, installScheduled: false, installSucceeded: false, statusText: '导入未完成，请重试' });
    } catch (e) {}
  }, 60000);
  setTimeout(async () => {
    try { await writePrefixMap((await loadAccounts()).accounts || []); } catch (e) {
      try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'startup prefix rename: ' + String(e) + '\n'); } catch (e2) {}
    }
  }, 8500);

  const readDataJson = async (name, fb) => {
    try { return { ...fb, ...JSON.parse(await fsp.readFile(path.join(dataDir, name), 'utf8')) }; } catch (e) { return { ...fb }; }
  };
  const writeDataJson = async (name, obj) => {
    try { await fsp.writeFile(path.join(dataDir, name), JSON.stringify(obj, null, 2)); } catch (e) {}
  };

  const estimateAttachments = (wsDir) => {
    try {
      const raw = path.join(wsDir, 'history', '_raw');
      let count = 0, bytes = 0;
      for (const f of nodeFs.readdirSync(raw)) {
        if (!/^conversations\..*\.json$/.test(f)) continue;
        let d = null; try { d = JSON.parse(nodeFs.readFileSync(path.join(raw, f), 'utf8')); } catch (e) { continue; }
        for (const c of d.conversations || []) for (const m of c.messages || []) for (const x of m.files || []) {
          count += 1; bytes += Number(x.size) || 0;
        }
      }
      return JSON.stringify({ count, bytes });
    } catch (e) { return ''; }
  };

  const notify = (title, body, urgent = false) => {
    try {
      if (!cfgGet('notifyEnabled', true)) return;
      const ps = path.join(process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = [
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }'",
        "$h=[W]::GetForegroundWindow(); $p=0; [void][W]::GetWindowThreadProcessId($h,[ref]$p); $proc=Get-Process -Id $p -ErrorAction SilentlyContinue",
        "if ($proc -and $proc.ProcessName -like '*DeepSeek*') { exit }",
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
        "function X([string]$s){ return $s.Replace(\"&\",\"&amp;\").Replace(\"<\",\"&lt;\").Replace(\">\",\"&gt;\") }",
        "$urgent = ($env:NURGENT -eq '1')",
        "$open = if ($urgent) { '<toast scenario=\"reminder\">' } else { '<toast>' }",
        "$actions = if ($urgent) { '<actions><action content=\"打开 DSH\" activationType=\"protocol\" arguments=\"dsh-app://app/\"/></actions>' } else { '' }",
        "$t = $open + \"<visual><binding template=\\\"ToastGeneric\\\"><text>\" + (X $env:NT) + \"</text><text>\" + (X $env:NB) + \"</text></binding></visual>\" + $actions + '</toast>'",
        "$xml = [Windows.Data.Xml.Dom.XmlDocument]::new(); $xml.LoadXml($t)",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe\").Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
      ].join('\n');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const child = spawn(ps, ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        env: { ...process.env, NT: title, NB: body, NURGENT: urgent ? '1' : '0' }, windowsHide: true, stdio: 'ignore',
      });
      child.on('error', () => {});
    } catch (e) {}
  };

  const settingsNs = () => (ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.id) || 'dsh-chat-history-sync';
  let settingsWriteChain = Promise.resolve();
  const persistSettings = async (patch) => {
    const run = async () => {
      const svc = settingsSvc || ctx.get('settings');
      if (!svc || typeof svc.update !== 'function') return false;
      let last = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (attempt) await new Promise((r) => setTimeout(r, 160));
          else await new Promise((r) => setTimeout(r, 30));
          await svc.update(settingsNs(), patch);
          return true;
        } catch (e) {
          last = e;
        }
      }
      try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' persistSettings failed: ' + String((last && last.message) || last).slice(0, 200) + '\n'); } catch (e) {}
      return false;
    };
    const next = settingsWriteChain.then(run, run);
    settingsWriteChain = next.then(() => undefined, () => undefined);
    return next;
  };
  const cleanLabel = (s) => String(s || '').replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').trim();
  const safeName = (s) => {
    let t = String(s || '').replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    t = t.replace(/[. ]+$/, '');
    if (!t || t === '.' || t === '..') return '';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(t)) t = '_' + t;
    return Array.from(t).slice(0, 40).join('');
  };
  // 把每个账号的「简称」写到 history/_raw/account-prefixes.json，供导入器生成 [简称] 标题
  const readSessionTitle = (cwd, sid) => {
    try {
      const slug = '--' + String(cwd).replace(/[\\/:]+/g, '-') + '--';
      const p = path.join(dshHomeDir, 'sessions', slug, sid, 'session.v4.jsonl.zstd');
      const b = nodeFs.readFileSync(p);
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      const offs = []; let i = 0;
      while ((i = b.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
      let last = '';
      for (let k = 0; k < offs.length; k += 1) {
        try {
          const t = zlib.zstdDecompressSync(b.subarray(offs[k], offs[k + 1] || b.length)).toString('utf8');
          for (const line of t.split('\n').filter(Boolean)) {
            try { const e = JSON.parse(line); if (e.type === 'session/title' && e.data && e.data.title) last = e.data.title; } catch (err) {}
          }
        } catch (e) {}
      }
      return last;
    } catch (e) { return ''; }
  };
  const renameSessionsForPrefix = async (rawDir, prev, next) => {
    let failed = false;
    try {
      const mfPath = path.join(rawDir, 'install-manifest.json');
      if (!existsSync(mfPath)) return false;
      const mf = JSON.parse(nodeFs.readFileSync(mfPath, 'utf8'));
      const sc = ctx.get('sessionController');
      if (!sc || typeof sc.rename !== 'function') return false;
      let touched = false;
      for (const [file, np] of Object.entries(next)) {
        const key = file === 'conversations.full.json' ? 'account' : file.replace(/^conversations\./, '').replace(/\.json$/, '');
        for (const [mk, c] of Object.entries(mf.copies || {})) {
          if (!c || !c.sessionId || !String(c.convKey || '').startsWith(key + '|')) continue;
          const actual = readSessionTitle(c.cwd, c.sessionId);
          const base = String(actual || c.title || '').replace(/^\[[^\]]+\]\s*/, '');
          const nt = '[' + np + '] ' + base;
          if (actual === nt) continue;
          try {
            await sc.rename({ sessionId: c.sessionId, title: nt });
            c.title = nt;
            mf.copies[mk] = c;
            touched = true;
          } catch (e) {
            failed = true;
            try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'rename failed ' + c.sessionId + ': ' + String(e).slice(0, 300) + '\n'); } catch (e2) {}
          }
        }
      }
      if (touched) {
        mf.writtenAt = new Date().toISOString();
        await fsp.writeFile(mfPath, JSON.stringify(mf, null, 2));
      }
      return !failed;
    } catch (e) { return false; }
  };
  // 把每个账号的「简称」写到 history/_raw/account-prefixes.json；简称变化时直接重命名现有会话标题
  const writePrefixMap = async (list) => {
    try {
      const rows = (list || []).filter((a) => a && a.dataset);
      if (!rows.length) return;
      const rawDir = path.dirname(rows[0].dataset);
      const target = path.join(rawDir, 'account-prefixes.json');
      const map = {};
      for (const a of rows) {
        const display = safeName(a.prefix || a.name || '');
        if (!display) continue;
        map[path.basename(a.dataset)] = display;
      }
      let prev = {};
      try { prev = JSON.parse(nodeFs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) { prev = {}; }
      const text = JSON.stringify(map, null, 2) + '\n';
      if (text !== prefixMapCache) {
        prefixMapCache = text;
        await fsp.writeFile(target, text);
      }
      const marker = path.join(rawDir, 'prefix-renamed.json');
      const mapHash = createHash('sha256').update(JSON.stringify(map)).digest('hex');
      let applied = '';
      try { applied = JSON.parse(nodeFs.readFileSync(marker, 'utf8')).hash || ''; } catch (e) {}
      if (applied !== mapHash) {
        const renamed = await renameSessionsForPrefix(rawDir, prev, map);
        if (renamed) {
          try { await fsp.writeFile(marker, JSON.stringify({ hash: mapHash, at: Date.now() })); } catch (e) {}
        }
      }
    } catch (e) {}
  };
  let prefixMapCache = '';
  // 账号镜像：设置里只存 name/prefix/enabled（**不含 token**），token 始终只存在 config.json
  const refreshAccountsMirror = async () => {
    try {
      let persisted = [];
      try { persisted = JSON.parse(config.accounts && config.accounts.get ? config.accounts.get() : '[]') || []; } catch (e) { persisted = []; }
      const f = await loadAccounts();
      if (Array.isArray(persisted) && !persisted.length && cfgGet('accountsCleared', false)) return;
      const next = (f.accounts || []).map((a) => {
        const hit = persisted.find((p) => p && ((p.prefix && p.prefix === a.prefix) || (p.name && (p.name === a.name || p.name === a.prefix))));
        return { name: cleanLabel((hit && hit.name) || a.name || a.prefix || ''), prefix: cleanLabel(hit ? (hit.prefix || '') : (a.prefix || '')), nickname: cleanLabel(a.nickname || (hit && hit.nickname) || ''), avatarUrl: a.avatarUrl || (hit && hit.avatarUrl) || '', enabled: (hit ? hit.enabled !== false : true) && a.enabled !== false };
      });
      if (!next.length) {
        try { if (!(await persistSettings({ accounts: '[]', accountsReady: true }))) await publish({ accounts: '[]', accountsReady: true }); } catch (e) {}
        return;
      }
      let how = 'update';
      try { if (!(await persistSettings({ accounts: JSON.stringify(next), accountsReady: true, accountsCleared: false }))) { await publish({ accounts: JSON.stringify(next), accountsReady: true, accountsCleared: false }); how = 'publish'; } } catch (e) { await publish({ accounts: JSON.stringify(next), accountsReady: true, accountsCleared: false }); how = 'publish-fallback'; }
      const merged = (f.accounts || []).map((a, i) => ({ ...a, prefix: (next[i] && next[i].prefix) || a.prefix || a.name || '' }));
      await writePrefixMap(merged);
      try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' accounts mirror: ' + next.length + ' via ' + how + ' (token 不入设置)\n'); } catch (e) {}
    } catch (e) {
      try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' accounts mirror failed: ' + String(e) + '\n'); } catch (e2) {}
    }
  };
  setTimeout(() => { void refreshAccountsMirror(); }, 6000);
  // 用 DSH 当前登录账号的 Platform 资料补齐「头像 + 原昵称」（按手机尾号匹配）
  ctx.inject(['deepseekAccount'], (scoped) => {
    setTimeout(async () => {
      try {
        const res = await scoped.deepseekAccount.getProfile({ version: '1', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
        if (!res || res.status !== 'ready' || !res.value) return;
        const prof = res.value;
        const profId = prof.id ? String(prof.id) : '';
        try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' dsh profile: matched=' + (profId ? 'yes' : 'no') + '\n'); } catch (e) {}
        const accs = await loadAccounts();
        let changed = false;
        for (const a of accs.accounts || []) {
          const byId = profId && a.userId && profId === String(a.userId);
          if (!byId) continue;
          if (prof.name && a.nickname !== prof.name) { a.nickname = prof.name; changed = true; }
          if (prof.avatarUrl && a.avatarUrl !== prof.avatarUrl) { a.avatarUrl = prof.avatarUrl; changed = true; }
          if (prof.id && !a.userId) { a.userId = String(prof.id); changed = true; }
        }
        if (changed) { await saveAccounts(accs); await refreshAccountsMirror(); }
      } catch (e) {}
    }, 4000);
  });
  // 用聊天 API 补齐每个账号的手机号（设置页仅显示脱敏号码）
  setTimeout(async () => {
    try {
      const accs = await loadAccounts();
      let changed = false;
      for (const a of accs.accounts || []) {
        if (!a.token || a.userId) continue;
        const id = await fetchIdentity(a.token);
        if (id && id.userId) { a.userId = id.userId; changed = true; }
      }
      if (changed) { await saveAccounts(accs); await refreshAccountsMirror(); }
    } catch (e) {}
  }, 7000);

  const ensureReportSession = async (cwd) => {
    const cfg = await loadAccounts();
    const reg = ctx.get('workspaceRegistry');
    const ws = reg && typeof reg.list === 'function'
      ? reg.list().find((w) => path.resolve(w.path).toLowerCase() === path.resolve(cwd).toLowerCase())
      : null;
    if (cfg.reportSessionId && ws && (ws.sessionIds || []).includes(cfg.reportSessionId)) return cfg.reportSessionId;
    const sc = await new Promise((resolve) => { ctx.inject(['sessionController'], (s) => resolve(s.sessionController)); setTimeout(() => resolve(null), 5000); });
    if (!sc || typeof sc.create !== 'function') {
      try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: no sessionController\n'); } catch (e) {}
      return null;
    }
    try {
      const req = ws ? { workspaceId: ws.id, agentPreset: 'standard' } : { cwd, agentPreset: 'standard' };
      const created = await sc.create(req);
      const sid = created && created.sessionId;
      if (!sid) { try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: create returned no sessionId\n'); } catch (e) {} return null; }
      if (ws) {
        try { if (!(ws.sessionIds || []).includes(sid)) await ws.attachSession(sid); } catch (e) {
          try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: attach failed ' + String(e) + '\n'); } catch (e2) {}
        }
      }
      try {
        if (typeof sc.rename === 'function') await sc.rename({ sessionId: sid, title: '聊天历史同步报告' });
      } catch (e) {
        try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: title rename failed ' + String(e) + '\n'); } catch (e2) {}
      }
      cfg.reportSessionId = sid;
      await saveAccounts(cfg);
      return sid;
    } catch (e) {
      try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: create failed ' + String(e) + '\n'); } catch (e2) {}
      return null;
    }
  };

  // 直接用 sessionPersistence 落一个带内容的报告会话文件，再挂进工作区（不依赖 live agent）
  const createReportSessionFile = async (cwd, title, body) => {
    try {
      // 优先：用 sessionController 创建 live 会话（侧栏立即出现、projcache 自动生成），再写内容
      const sc = ctx.get('sessionController');
      const sessionsSvc = ctx.get('sessions');
      const regSvc = ctx.get('workspaceRegistry');
      const wsLive = regSvc && typeof regSvc.list === 'function'
        ? regSvc.list().find((w) => path.resolve(w.path).toLowerCase() === path.resolve(cwd).toLowerCase())
        : null;
      if (sc && wsLive && typeof sc.create === 'function') {
        try {
          const created = await sc.create({ workspaceId: wsLive.id, agentPreset: 'standard' });
          const sidLive = created && created.sessionId;
          if (sidLive) {
            let live = sessionsSvc && sessionsSvc.get ? sessionsSvc.get(sidLive) : null;
            for (let i = 0; i < 20 && !live; i += 1) { await new Promise((r) => setTimeout(r, 100)); live = sessionsSvc.get(sidLive); }
            if (live && typeof live.append === 'function') {
              live.append('turn/start', { turn: 1 });
              live.append('step/start', { turn: 1, step: 1 });
              live.append('user/message', { id: 'msg-' + randomUUID(), role: 'user', content: [{ type: 'text', text: title }], source: { kind: 'user' } }, { surfaceOp: 'append' });
              live.append('assistant/message', { turn: 1, step: 1, message: { id: 'msg-' + randomUUID(), role: 'assistant', content: [{ type: 'text', text: body }], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } }, stream: [] }, { surfaceOp: 'append' });
              live.append('step/end', { turn: 1, step: 1 });
              live.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
              if (sessionsSvc.flush) await sessionsSvc.flush(live);
              try { await sc.rename({ sessionId: sidLive, title: '聊天历史同步报告' }); } catch (e) {}
              const cfgLive = await loadAccounts();
              cfgLive.reportSessionId = sidLive;
              await saveAccounts(cfgLive);
              try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: live path ok ' + sidLive + '\n'); } catch (e) {}
              return sidLive;
            }
          }
        } catch (e) {
          try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: live create failed ' + String(e) + '\n'); } catch (e2) {}
        }
      }
      const persistence = ctx.get('sessionPersistence');
      if (!persistence || typeof persistence.create !== 'function') {
        try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: no sessionPersistence\n'); } catch (e) {}
        return null;
      }
      const sid = 'session-' + randomUUID();
      const header = { version: 4, id: sid, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
      const handle = await persistence.create(header);
      let seq = 0;
      const now = Date.now();
      const ev = (type, data, extra) => ({ type, seq: seq++, time: now + seq, data, ...(extra || {}) });
      const events = [
        ev('turn/start', { turn: 1 }),
        ev('step/start', { turn: 1, step: 1 }),
        ev('user/message', { id: 'msg-' + randomUUID(), role: 'user', content: [{ type: 'text', text: title }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
        ev('assistant/message', { turn: 1, step: 1, message: { id: 'msg-' + randomUUID(), role: 'assistant', content: [{ type: 'text', text: body }], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } }, stream: [] }, { surfaceOp: 'append' }),
        ev('step/end', { turn: 1, step: 1 }),
        ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
        ev('session/title', { title: '聊天历史同步报告', messageSeqs: [2], source: { kind: 'fallback' } }),
      ];
      await handle.append(events);
      await handle.flush();
      await handle.close();
      const reg = ctx.get('workspaceRegistry');
      const ws = reg && typeof reg.list === 'function'
        ? reg.list().find((w) => path.resolve(w.path).toLowerCase() === path.resolve(cwd).toLowerCase())
        : null;
      if (ws) {
        try { if (!(ws.sessionIds || []).includes(sid)) await ws.attachSession(sid); } catch (e) {
          try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: attach failed ' + String(e) + '\n'); } catch (e2) {}
        }
      }
      const cfg = await loadAccounts();
      cfg.reportSessionId = sid;
      await saveAccounts(cfg);
      return sid;
    } catch (e) {
      try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: file create failed ' + String(e) + '\n'); } catch (e2) {}
      return null;
    }
  };

  // 追加到既有报告会话（一个专用会话，历史可回看）
  const appendReportSession = async (sid, title, body) => {
    const persistence = ctx.get('sessionPersistence');
    if (!persistence || typeof persistence.open !== 'function') throw new Error('no sessionPersistence');
    const handle = await persistence.open(sid, 'write');
    try {
      const snap = await handle.read(0, undefined);
      const events = snap.events || [];
      let lastSeq = -1, lastTurn = 0;
      for (const e of events) {
        if (typeof e.seq === 'number') lastSeq = Math.max(lastSeq, e.seq);
        if (e.type === 'turn/start' && e.data && typeof e.data.turn === 'number') lastTurn = Math.max(lastTurn, e.data.turn);
      }
      const turn = lastTurn + 1;
      let seq = lastSeq + 1;
      const now = Date.now();
      const ev = (type, data, extra) => ({ type, seq: seq++, time: now + seq, data, ...(extra || {}) });
      const batch = [
        ev('turn/start', { turn }),
        ev('step/start', { turn, step: 1 }),
        ev('user/message', { id: 'msg-' + randomUUID(), role: 'user', content: [{ type: 'text', text: title }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
        ev('assistant/message', { turn, step: 1, message: { id: 'msg-' + randomUUID(), role: 'assistant', content: [{ type: 'text', text: body }], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } }, stream: [] }, { surfaceOp: 'append' }),
        ev('step/end', { turn, step: 1 }),
        ev('turn/end', { turn, reason: { kind: 'completed' } }),
      ];
      await handle.append(batch);
      await handle.flush();
    } finally {
      await handle.close().catch(() => {});
    }
  };

  const appendLiveReport = async (live, title, body) => {
    let turn = 1;
    try {
      const events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents() : [];
      for (const e of events) if (e.type === 'turn/start' && e.data && typeof e.data.turn === 'number') turn = Math.max(turn, e.data.turn + 1);
    } catch (e) {}
    live.append('turn/start', { turn });
    live.append('step/start', { turn, step: 1 });
    live.append('user/message', { id: 'msg-' + randomUUID(), role: 'user', content: [{ type: 'text', text: title }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    live.append('assistant/message', { turn, step: 1, message: { id: 'msg-' + randomUUID(), role: 'assistant', content: [{ type: 'text', text: body }], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } }, stream: [] }, { surfaceOp: 'append' });
    live.append('step/end', { turn, step: 1 });
    live.append('turn/end', { turn, reason: { kind: 'completed' } });
    const sessions = ctx.get('sessions');
    if (sessions && sessions.flush) await sessions.flush(live);
  };

  const writeReport = async (cwd, title, body) => {
    try {
      const sessions = ctx.get('sessions');
      const sid0 = liveConfig.reportTargetSessionId;
      const live = sid0 && sessions && sessions.get && sessions.get(sid0);
      if (live && typeof live.append === 'function') {
        await appendLiveReport(live, title, body);
        return true;
      }
      // 不把报告写进无法被 DSH 会话列表感知的旧文件：每次生成可见的新报告会话
      const sid = await createReportSessionFile(cwd, title, body);
      return !!sid;
    } catch (e) { try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'report: ' + String(e) + '\n'); } catch (e2) {} return false; }
  };

  const editor = ctx.get('configEditor');
  const entry = ctx.fiber && ctx.fiber.entry;
  const publish = async (patch) => {
    try {
      if (!editor || !entry) return;
      await editor.edit(entry, (cur) => ({ ...cur, ...patch }));
    } catch (e) {}
  };
  // editor.edit 在当前 DSH 版本只改内存副本，settings.describe 读不到；关键 UI 状态改用 update 持久化
  const publishPersistent = async (patch) => {
    try {
      if (await persistSettings(patch)) return;
    } catch (e) {}
    await publish(patch);
  };

  // 启动时清理上次异常退出可能残留的「同步中」状态（只清 running，保留完成/失败结果）
  const bootLoginRequest = Number(cfgGet('loginRequest', 0));
  setTimeout(() => {
    try {
      if (Number(cfgGet('loginRequest', 0)) !== bootLoginRequest) return;
      if (String(cfgGet('loginStatus', ''))) void publishPersistent({ loginStatus: '' });
    } catch (e) {}
  }, 1200);
  setTimeout(() => {
    try {
      const st = config && config.status && typeof config.status.get === 'function' ? config.status.get() : '';
      if (st === 'running') void publish({ status: 'idle', statusText: '', startedAt: 0 });
    } catch (e) {}
    // runNow 是按钮的上升沿信号：启动时残留 true 会在每次开 DSH 时白跑一次同步
    try {
      if (config && config.runNow && typeof config.runNow.get === 'function' && config.runNow.get()) {
        void publishPersistent({ runNow: false });
        try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' runNow reset on startup\n'); } catch (e) {}
      }
    } catch (e) {}
    // 启动时把上次报告正文带到设置页（volatile 字段重启会清空）
    try {
      const rp = path.join(dataDir, '同步报告.md');
      if (existsSync(rp)) {
        const t = nodeFs.readFileSync(rp, 'utf8');
        if (t) void publish({ reportText: t.slice(0, 4000) });
      }
    } catch (e) {}
  }, 1200);

  const runEngine = async (accounts, attachmentMode, dry, onProgress) => {
    const list = Array.isArray(accounts) ? accounts : (accounts.accounts || []);
    const enabled = list.filter((a) => a.enabled);
    if (!enabled.length) return '没有启用的账号，请先在设置里登录并启用账号';
    const ready = enabled.filter((a) => a && a.token && a.dataset && a.root);
    if (!ready.length) return '同步失败：启用账号缺少 token 或数据文件，请重新登录后重试';
    const skippedAccounts = enabled.length - ready.length;
    await writePrefixMap(list);
    const runCfg = path.join(dataDir, 'run-config.json');
    await fsp.writeFile(runCfg, JSON.stringify({ version: 1, accounts: ready, attachmentMode, categories: [] }));
    const logPath = path.join(dataDir, 'sync.log');
    const engine = path.join(here, 'engine', 'sync-all.cjs');
    let child;
    try {
      child = spawn(process.execPath, [engine, ...(dry ? ['--dry-run'] : [])], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SYNC_CONFIG: runCfg },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      try { await fsp.rm(runCfg, { force: true }); } catch (e2) {}
      throw e;
    }
    activeChild = child;
    cancelRequested = false;
    let s = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      s += d;
      if (!onProgress) return;
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/^PROGRESS\t(\d+)\t(\d+)\t(.*)$/);
        if (m) onProgress(Number(m[1]), Number(m[2]), m[3]);
      }
    });
    child.stderr.on('data', (d) => { s += d; });
    let code;
    let spawnError = null;
    try {
      code = await new Promise((resolve) => {
        child.once('close', resolve);
        child.once('error', (e) => { spawnError = e; resolve(-1); });
      });
    } finally {
      activeChild = null;
      try { await fsp.rm(runCfg, { force: true }); } catch (e) {}
    }
    if (spawnError) return '同步失败：无法启动同步引擎：' + String((spawnError && spawnError.message) || spawnError).slice(0, 300);
    const logSafe = s.replace(/^PROGRESS\t\d+\t\d+\t.*$/gm, 'PROGRESS\t[title omitted]');
    let logPrivate = logSafe;
    for (const a of enabled) {
      for (const raw of [a && a.name, a && a.prefix]) {
        const n = String(raw || '').trim();
        if (n) logPrivate = logPrivate.split(n).join('[account]');
      }
    }
    try { await fsp.appendFile(logPath, '[' + new Date().toISOString() + '] run dry=' + dry + ' exit=' + code + '\n' + logPrivate + '\n'); } catch (e) {}
    if (code !== 0) return `同步失败（exit ${code}）：\n` + s.slice(-800);
    const failures = s.split('\n').filter((line) => !/^\s*-/.test(line) && /^.+:\s*(数据集损坏|写入失败|全部抓取失败|列表失败|失败)(?:[，,；;]|$)/.test(line));
    if (failures.length) return '同步失败：' + failures.join('；').slice(0, 800);
    const parts = [];
    for (const line of s.split('\n')) {
      const m = line.match(/^(.+):\s*总数\s+(\d+)[，,]\s*新增\s+(\d+)[，,]\s*更新\s+(\d+)/);
      if (m) parts.push(m[1] + '：新增 ' + m[3] + ' / 更新 ' + m[4]);
    }
    const partialFailures = s.split('\n').filter((line) => /^ - .*: (数据集损坏|写入失败|全部抓取失败|失败)(?:[，,；;]|$)|^ - .*: .*抓取失败/.test(line));
    if (!parts.length) return (partialFailures.length || skippedAccounts) ? '同步失败：没有账号成功同步' : '同步完成（无变化）';
    const changed = parts.some((p) => !/:新增 0 \/ 更新 0$/.test(p));
    const head = (partialFailures.length || skippedAccounts) ? '同步完成（部分账号失败）' : '同步完成';
    return head + (changed ? ' · ' + parts.join(' · ') : '（无变化）');
  };

  // 账号合并：「设置」里的行（name/token/enabled）叠加到 config.json 的账号上，
  // 保留 dataset/root（设置行里没有这两个字段，直接整组替换会让引擎把账号全部跳过）
  const accountList = (accounts) => (Array.isArray(accounts) ? accounts : (accounts.accounts || [])).map((a) => ({ ...a, name: cleanLabel(a.name || a.prefix), prefix: cleanLabel(a.prefix || a.name) }));
  const attachmentModeOf = () => (['all', 'none', 'images'].includes(liveConfig.attachmentMode) ? liveConfig.attachmentMode : 'all');
  const withSettingsAccounts = async () => {
    const accounts = await loadAccounts();
    const base = accountList(accounts);
    let rows = [];
    try { rows = JSON.parse(liveConfig.accounts || '[]'); } catch (e) { rows = []; }
    if (Array.isArray(rows) && !rows.length && base.length && liveConfig.accountsCleared) {
      // 用户在设置里删掉了最后一个账号：显式清空 config，别让镜像把它带回来
      accounts.accounts = [];
      try { await saveAccounts(accounts); } catch (e) {}
      try { await persistSettings({ accountsCleared: false }); } catch (e) {}
      return accounts;
    }
    if (Array.isArray(rows) && rows.length) {
      const byName = new Map();
      for (const a of base) {
        if (a.name) byName.set(String(a.name), a);
        if (a.prefix) byName.set(String(a.prefix), a);
      }
      let dirty = false;
      const nextAccounts = rows.map((r, i) => {
        // 名称/前缀匹配；用户改名时按同一位置兜底（行数与 config 一致时）
        const b = byName.get(String(r.name || '')) || byName.get(String(r.prefix || ''))
          || (rows.length === base.length ? base[i] : null) || {};
        const nextPrefix = safeName(r.prefix || r.name) || safeName(b.prefix || b.name) || ('账号' + String(b.id || b.userId || '').slice(-4));
        const next = {
          ...b,
          name: r.name || b.name || '', prefix: nextPrefix,
          token: r.token || b.token || '', enabled: r.enabled !== false,
          nickname: r.nickname !== undefined ? r.nickname : b.nickname,
          avatarUrl: r.avatarUrl !== undefined ? r.avatarUrl : b.avatarUrl,
          dataset: b.dataset, root: b.root, id: b.id,
        };
        if (next.name !== b.name || next.prefix !== b.prefix || next.nickname !== b.nickname || next.avatarUrl !== b.avatarUrl) dirty = true;
        return next;
      }).filter((a) => a.dataset && a.root);
      const seenPrefixes = new Set();
      for (const a of nextAccounts) {
        if (!a.prefix || seenPrefixes.has(a.prefix)) {
          const base = a.prefix || '账号';
          const suffix = String(a.id || a.userId || '').slice(-4);
          let unique = safeName(base + '-' + suffix) || base;
          let n = 1;
          while (seenPrefixes.has(unique) && n < 20) {
            n += 1;
            unique = safeName(base + '-' + suffix + '-' + n) || (base + '-' + n);
          }
          if (unique && unique !== a.prefix) { a.prefix = unique; dirty = true; }
        }
        seenPrefixes.add(a.prefix);
      }
      accounts.accounts = nextAccounts;
      if (nextAccounts.length !== base.length) dirty = true;
      if (dirty) { try { await saveAccounts(accounts); } catch (e) {} }
      if (accounts.accounts.length < rows.length) {
        try { await fsp.appendFile(path.join(dataDir, 'sync.log'), '[accounts] ' + (rows.length - accounts.accounts.length) + ' 个设置账号缺少 dataset/root，已跳过（可能是旧配置）\n'); } catch (e) {}
      }
    }
    return accounts;
  };
  const resolveWorkspaceDir = (accounts) => {
    const acc = accountList(accounts).find((a) => a.enabled !== false && a.dataset);
    if (acc) return path.resolve(path.dirname(acc.dataset), '..', '..');
    // 全新导入还没有账号：用 DSH 当前默认工作区，保证「登录新账号」可用
    try {
      const reg = ctx.get('workspaceRegistry');
      const list = reg && typeof reg.list === 'function' ? reg.list() : [];
      const preferred = reg && reg.defaultWorkspaceId ? list.find((w) => w.id === reg.defaultWorkspaceId) : null;
      return (preferred || list[0])?.path ? path.resolve((preferred || list[0]).path) : null;
    } catch (e) { return null; }
  };
  const afterSync = async (accounts, result, opts = {}) => {
    const wsDir = resolveWorkspaceDir(accounts);
    // 分类目录 + 导出（若可定位工作区；失败不影响主流程）
    if (wsDir) {
      for (const script of ['catalog.cjs', 'export.cjs']) {
        await new Promise((resolve) => {
          try {
            const c = spawn(process.execPath, [path.join(here, 'engine', script), wsDir], { stdio: 'ignore' });
            c.on('close', resolve);
            c.on('error', resolve);
          } catch (e) { resolve(); }
        });
      }
    }
    // 分类只以报告形式交付：把目录按类汇总进同步报告
    let catLines = [];
    if (wsDir) {
      try {
        const md = nodeFs.readFileSync(path.join(wsDir, 'history', '_raw', '分类目录.md'), 'utf8');
        for (const s of md.split(/\n(?=## )/)) {
          if (!s.startsWith('## ')) continue;
          const title = s.split('\n')[0].slice(3).trim();
          const n = (s.match(/\n- /g) || []).length;
          if (n) catLines.push(title + '：' + n + ' 条');
        }
      } catch (e) {}
    }
    const catBlock = catLines.length ? '\n\n分类目录（' + catLines.length + ' 类）：\n' + catLines.map((l) => '- ' + l).join('\n') : '';
    // 报告正文附完整目录（含账号简称、月份、标题与会话位置链接）
    let dirBlock = '';
    try {
      if (wsDir) {
        const md = nodeFs.readFileSync(path.join(wsDir, 'history', '_raw', '分类目录.md'), 'utf8');
        const body = md.replace(/^# 分类目录[\s\S]*?(?=\n## )/, '').replace('](会话位置/', '](history/_raw/会话位置/').trim();
        if (body) dirBlock = '\n\n' + body;
      }
    } catch (e) {}
    let dupBlock = '';
    let dupCount = 0;
    try {
      if (wsDir) {
        const dup = nodeFs.readFileSync(path.join(wsDir, 'history', '_raw', '同名不同内容.md'), 'utf8');
        dupCount = (dup.match(/^## /gm) || []).length;
        if (dup.includes('## ')) dupBlock = '\n\n' + dup.replace('](会话位置/', '](history/_raw/会话位置/').trim();
      }
    } catch (e) {}
    const reportHead = /^同步失败/.test(String(result || '')) ? '同步失败' : '同步完成';
    const reportBody = reportHead + '\n\n' + result + catBlock + dirBlock + dupBlock +
      '\n\n摘要由本地规则生成，不调用模型；同步免费、无遥测。\n' +
      '\n\n分类不再创建独立工作区，以本报告 + 分类目录交付。\n完整目录：history/_raw/分类目录.md\n同名复查：history/_raw/同名不同内容.md\n导出：history/_raw/导出/';
    // 本地留档
    try {
      await fsp.writeFile(path.join(dataDir, '同步报告.md'), '# 🧠 聊天历史同步报告\n\n- 时间：' + new Date().toISOString() + '\n- 结果：' + result + '\n- 分类目录：history/_raw/分类目录.md\n- 导出：history/_raw/导出/\n' + catBlock + '\n\n详见 sync.log\n');
    } catch (e) {}
    // 最近一次报告正文 + 状态/健康/附件一次性 publish，避免连续 edit 互相覆盖
    const patch = { reportText: ('# 聊天历史同步报告\n\n时间：' + new Date().toISOString() + '\n\n结果：' + result + catBlock + dupBlock).slice(0, 12000) };
    if (!opts.failed && !/^同步失败/.test(String(result || ''))) {
      patch.status = 'done';
      patch.statusText = String(result || '').slice(0, 200);
    }
    // 写入报告会话（可定位时）
    try {
      if (wsDir) await writeReport(wsDir, '🧠 聊天历史同步', reportBody);
    } catch (e) {}
    // 有新增/更新且开启自动导入：先置「待确认」，由用户在界面点「立即导入」后再调度
    try {
      const changed = /新增 [1-9]|更新 [1-9]/.test(String(result || ''));
      if (!opts.failed && !/^同步失败/.test(String(result || ''))) patch.lastSyncAt = Date.now();
      patch.lastSyncResult = String(result || '').slice(0, 300);
      patch.duplicateCount = dupCount;
      try {
        const health = {};
        for (const line of String(result || '').split('\n')) {
          const m = line.match(/^\s*-\s*(.+)[:：]\s*(.+)$/);
          if (m) health[m[1].trim()] = m[2].trim().slice(0, 120);
        }
        patch.accountHealth = JSON.stringify(health);
      } catch (e) {}
      try {
        const stats = estimateAttachments(wsDir);
        if (stats) patch.attachmentStats = stats;
      } catch (e) {}
      if (opts.auto && changed) {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const st = await readDataJson('digest.json', { date: today, add: 0, upd: 0 });
          if (st.date !== today) { st.date = today; st.add = 0; st.upd = 0; }
          for (const line of String(result || '').split('\n')) {
            if (!/^\s*-/.test(line)) continue;
            const a = line.match(/新增\s*(\d+)/); const u = line.match(/更新\s*(\d+)/);
            if (a) st.add += Number(a[1]);
            if (u) st.upd += Number(u[1]);
          }
          await writeDataJson('digest.json', st);
        } catch (e) {}
      }
      if (wsDir && changed) {
        patch.installPending = true;
        patch.installDeferred = !liveConfig.autoInstall;
        patch.installDeferredByUser = false;
        patch.installScheduled = false;
        patch.installSucceeded = false;
        patch.statusText = liveConfig.autoInstall ? '同步完成：检测到新对话，请确认是否导入到工作区' : '同步完成：导入提醒已关闭';
        try { await writeDataJson('install-pending.json', { at: Date.now(), result: String(result || '').slice(0, 300) }); } catch (e) {}
        if (liveConfig.autoInstall) notify('聊天历史同步完成', '检测到新对话，是否导入到工作区并重启 DSH？', true);
        try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'install-pending (awaiting user)\n'); } catch (e) {}
        try { await refreshAccountsMirror(); } catch (e) {}
      }
    } catch (e) {}
    await publishPersistent(patch);
  };

  // 「立即同步」按钮触发：runNow 上升沿触发一次（防止重复执行）
  const runNowField = config && config.runNow;
  if (runNowField && typeof runNowField.get === 'function') {
    const bootAt = Date.now();
    let armed = true; // 启动时忽略持久化的 true（旧补丁可能残留），等它被复位为 false 后才接受点击
    let forceTried = false;
    const forceRunNowFalse = async () => {
      try {
        await publishPersistent({ runNow: false });
        try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' runNow force-false\n'); } catch (e) {}
      } catch (e) {
        try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' runNow force-false failed: ' + String(e) + '\n'); } catch (e2) {}
      }
    };
    const timer = setInterval(async () => {
      try {
        const v = !!runNowField.get();
        if (!v) { armed = false; return; }
        if (armed) {
          // 启动 8 秒内不响应残留 true；之后仍未复位就强制持久化为 false
          if (Date.now() - bootAt > 8000 && !forceTried) { forceTried = true; await forceRunNowFalse(); }
          return;
        }
        armed = true;
        if (/正在打开登录页|请在弹出的浏览器/.test(String(cfgGet('loginStatus', '')))) {
          await publishPersistent({ runNow: false });
          return;
        }
        const accounts = await withSettingsAccounts();
        if (syncInFlight) {
          await publishPersistent({ runNow: false });
          return;
        }
        await publishPersistent({ runNow: false, status: 'running', statusText: '正在同步…', startedAt: Date.now() });
        let lastNote = 0;
        syncInFlight = true;
        let result;
        try {
          result = await runEngine(accounts, attachmentModeOf(), false, (x, y, title) => {
            const now = Date.now();
            if (now - lastNote < 800 && x < y) return;
            lastNote = now;
            void publish({ status: 'running', statusText: '正在同步 ' + x + '/' + y + '：' + title });
          });
        } finally {
          syncInFlight = false;
        }
        const authHit = /^同步失败/.test(String(result || '')) && /401|403|风控|验证|token|登录|AUTH|unauthorized|forbidden/i.test(String(result || ''));
        if (cancelRequested) {
          cancelRequested = false;
          await publishPersistent({ status: 'done', statusText: '已取消同步', startedAt: 0 });
          return;
        }
        if (/^没有启用/.test(String(result || ''))) {
          await publishPersistent({ status: 'idle', statusText: String(result).slice(0, 200), startedAt: 0 });
          return;
        }
        const finalStatus = (result && result.indexOf('失败') === 0) || authHit ? 'error' : 'done';
        const statusText2 = authHit ? '同步失败：登录失效或触发风控，请在「同步账号」重新登录该账号后重试。' : String(result).slice(0, 200);
        const statusPatch = { status: finalStatus, statusText: statusText2, startedAt: 0, lastSyncResult: String(result || '').slice(0, 300) };
        if (finalStatus === 'done') statusPatch.lastSyncAt = Date.now();
        await publishPersistent(statusPatch);
        const changedNow = /新增 [1-9]|更新 [1-9]/.test(String(result || ''));
        if (finalStatus === 'error') notify('聊天历史同步失败', authHit ? 'token 失效/风控，请更新后重试' : String(result).slice(0, 100), true);
        else if (changedNow) notify('聊天历史同步完成', String(result).slice(0, 100));
        if (!/^没有启用/.test(String(result || ''))) {
          syncInFlight = true;
          try { await afterSync(accounts, result, { failed: finalStatus === 'error' }); } finally { syncInFlight = false; }
        }
      } catch (e) {
        try { await fsp.appendFile(path.join(dataDir, 'sync.log'), String(e) + '\n'); } catch (e2) {}
      }
    }, 1500);
    ctx.effect(() => () => clearInterval(timer));
  }

  // 「取消同步」：运行中把 cancelSync 置 true，结束引擎进程树
  const cancelField = config && config.cancelSync;
  if (cancelField && typeof cancelField.get === 'function') {
    const timerC = setInterval(async () => {
      try {
        if (!cancelField.get()) return;
        await persistSettings({ cancelSync: false });
        if (!activeChild) return;
        cancelRequested = true;
        const pid = activeChild.pid;
        try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
        try { activeChild.kill(); } catch (e) {}
        await publishPersistent({ status: 'done', statusText: '已取消同步', startedAt: 0 });
        try { nodeFs.appendFileSync(path.join(dataDir, 'settings.log'), new Date().toISOString() + ' sync cancel requested pid=' + pid + '\n'); } catch (e) {}
      } catch (e) {}
    }, 700);
    ctx.effect(() => () => clearInterval(timerC));
  }

  // 「导出诊断」：只导出计数/状态，不含日志、账号名、token 或本机路径
  const diagField = config && config.exportDiagnostics;
  if (diagField && typeof diagField.get === 'function') {
    const timerD = setInterval(async () => {
      try {
        if (!diagField.get()) return;
        await persistSettings({ exportDiagnostics: false });
        const ws = resolveWorkspaceDir(await withSettingsAccounts());
        const c = await loadAccounts();
        const safeAccounts = (c.accounts || []).map((a, index) => ({ index, hasTokenEnc: !!a.tokenEnc, enabled: a.enabled !== false }));
        let sessions = 0;
        try { const st = JSON.parse(nodeFs.readFileSync(path.join(dshHomeDir, 'storages', 'workspace.json'), 'utf8')); for (const w of Object.values(st.tables.workspaces)) sessions += (w.sessionIds || []).length; } catch (e) {}
        const diag = {
          at: new Date().toISOString(), version: pluginVersion, platform: process.platform, node: process.version,
          workspace: !!ws, sessions, duplicateCount: cfgGet('duplicateCount', 0), accounts: safeAccounts,
          lastSyncAt: cfgGet('lastSyncAt', ''), status: cfgGet('status', ''), statusTextLength: String(cfgGet('statusText', '')).length,
        };
        const outDir = path.join(dataDir, 'diagnostics');
        await fsp.mkdir(outDir, { recursive: true });
        const out = path.join(outDir, 'diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
        await fsp.writeFile(out, JSON.stringify(diag, null, 2));
        await publishPersistent({ statusText: '诊断已导出：' + path.basename(out) });
      } catch (e) {}
    }, 800);
    ctx.effect(() => () => clearInterval(timerD));
  }

  // 「立即导入」确认：installNow 上升沿 → 调度独立进程导入（20 秒后预检→重启）
  const installNowField = config && config.installNow;
  if (installNowField && typeof installNowField.get === 'function') {
    const bootAt2 = Date.now();
    let armed2 = true;
    let forceTried2 = false;
    const timer2 = setInterval(async () => {
      try {
        const v = !!installNowField.get();
        if (!v) { armed2 = false; return; }
        if (armed2) {
          if (Date.now() - bootAt2 > 8000 && !forceTried2) { forceTried2 = true; await publishPersistent({ installNow: false }); }
          return;
        }
        armed2 = true;
        if (syncInFlight) {
          await publishPersistent({ installNow: false });
          return;
        }
        if (/正在打开登录页|请在弹出的浏览器/.test(String(cfgGet('loginStatus', '')))) {
          await publishPersistent({ installNow: false });
          return;
        }
        const wsDir = resolveWorkspaceDir(await withSettingsAccounts());
        const ok = wsDir ? await scheduleWorkspaceInstall(wsDir) : false;
        const patch2 = { installNow: false, statusText: ok ? '已安排导入：约 20 秒后重启 DSH' : '导入调度失败，请重试或重新导入插件' };
        if (ok) { patch2.installPending = false; patch2.installDeferred = false; patch2.installDeferredByUser = false; patch2.installScheduled = true; patch2.installSucceeded = false; }
        else { patch2.installDeferred = false; patch2.installDeferredByUser = false; patch2.installScheduled = false; patch2.installSucceeded = false; }
        await publishPersistent(patch2);
        try { await refreshAccountsMirror(); } catch (e) {}
        if (ok) {
          notify('聊天历史同步', '约 20 秒后导入到工作区并重启 DSH');
          try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'install scheduled by user\n'); } catch (e) {}
        }
      } catch (e) {
        try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'install trigger: ' + String(e) + '\n'); } catch (e2) {}
      }
    }, 1500);
    ctx.effect(() => () => clearInterval(timer2));
  }

  // 「取消本次导入」：保留待导入文件，标记为稍后处理；状态卡会保留「导入」入口
  const installCancelField = config && config.installCancel;
  if (installCancelField && typeof installCancelField.get === 'function') {
    const installCancelTimer = setInterval(async () => {
      try {
        if (!installCancelField.get()) return;
        await persistSettings({ installCancel: false, installPending: false, installDeferred: true, installDeferredByUser: true });
        const cancelMsg = '已取消本次导入，可稍后点「导入」';
        await publishPersistent({ installPending: false, installDeferred: true, installDeferredByUser: true, installScheduled: false, installSucceeded: false, statusText: cancelMsg });
        setTimeout(() => { if (String(cfgGet('statusText', '')) === cancelMsg) void publishPersistent({ statusText: '有会话待导入' }); }, 8000);
        try { await refreshAccountsMirror(); } catch (e) {}
      } catch (e) {}
    }, 700);
    ctx.effect(() => () => clearInterval(installCancelTimer));
  }

  // 「登录新账号」：全新临时 Edge 配置 + 直接打开登录页（不显示旧账号、无黑框）
  // → 等用户登录 → 校验 token/userId → 只写入插件数据目录；未登录不新增账号。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const EDGE_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  try {
    const localEdge = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (localEdge) EDGE_PATHS.push(localEdge);
  } catch (e) {}
  const launchLoginBrowser = (profileDir, port) => {
    const exe = EDGE_PATHS.find((p) => { try { return nodeFs.existsSync(p); } catch (e) { return false; } });
    if (!exe) throw new Error('找不到 Microsoft Edge');
    try { nodeFs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
    const child = spawn(exe, [
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profileDir,
      '--no-first-run', '--no-default-browser-check',
      '--new-window', 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return child;
  };
  const fetchIdentity = (token) => new Promise((resolve) => {
    try {
      const req = https.get('https://chat.deepseek.com/api/v0/users/current', {
        headers: {
          accept: '*/*', authorization: 'Bearer ' + token,
          'x-client-bundle-id': 'com.deepseek.chat', 'x-client-locale': 'zh_CN',
          'x-client-platform': 'web', 'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
          'x-client-version': '2.7.1',
        },
        timeout: 20000,
      }, (r) => {
        const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(c).toString('utf8'));
            const b = (j.data && (j.data.biz_data || j.data)) || {};
            resolve({ userId: String(b.id || '') });
          } catch (e) { resolve(null); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch (e) { resolve(null); }
  });
  const accountIdentity = async (a) => {
    if (a.userId) return a.userId;
    if (!a.token) return '';
    const id = await fetchIdentity(a.token);
    if (id && id.userId) { a.userId = id.userId; return id.userId; }
    return '';
  };
  const loginReqField = config && config.loginRequest;
  const loginCancelField = config && config.loginCancel;
  if (loginReqField && typeof loginReqField.get === 'function') {
    let lastReq = Number((loginReqField.get && loginReqField.get()) || 0); // 启动时忽略历史登录请求
    let loginBusy = false;
    const loginTimer = setInterval(async () => {
      let cleanupPid = 0;
      let cleanupRunnerPid = 0;
      let cleanupProfile = '';
      try {
        const req = Number(loginReqField.get() || 0);
        if (!req || req === lastReq) return;
        lastReq = req;
        if (syncInFlight) {
          await publishPersistent({ loginStatus: '同步进行中，完成后再登录' });
          return;
        }
        if (loginBusy) return;
        loginBusy = true;
        const wsDir = resolveWorkspaceDir(await loadAccounts());
        if (!wsDir) { await publishPersistent({ loginStatus: '找不到可用工作区，请先在 DSH 创建或打开一个工作区' }); return; }
        const resultFile = path.join(dataDir, 'login-result.json');
        const knownFile = path.join(dataDir, 'login-known.json');
        const profileDir = path.join(process.env.TEMP || dataDir, 'dsh-chat-history-sync-login-' + Date.now());
        cleanupProfile = profileDir;
        try { nodeFs.rmSync(resultFile, { force: true }); } catch (e) {}
        const port = 9300 + Math.floor(Math.random() * 400);
        try { nodeFs.rmSync(resultFile, { force: true }); } catch (e) {}
        const accs = await loadAccounts();
        const knownHashes = [];
        nodeFs.writeFileSync(knownFile, JSON.stringify(knownHashes));
        await publishPersistent({ loginStatus: '正在打开登录页…' });
        const browserChild = launchLoginBrowser(profileDir, port);
        cleanupPid = browserChild && browserChild.pid ? browserChild.pid : 0;
        await sleep(3000);
        const bundledLogin = path.join(here, 'browser', 'login-save.mjs');
        let bundledDeps = false;
        try { createRequire(import.meta.url).resolve('puppeteer-core'); bundledDeps = true; } catch (e) {}
        const runnerScript = existsSync(bundledLogin) && bundledDeps ? bundledLogin : path.join(wsDir, 'tools', 'browser', 'login-save.mjs');
        if (!existsSync(runnerScript)) {
          try { if (browserChild && browserChild.pid) spawn('taskkill.exe', ['/PID', String(browserChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
          try { nodeFs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
          await publishPersistent({ loginStatus: '缺少登录脚本，请重新导入插件' });
          return;
        }
        const runner = spawn(process.execPath, [runnerScript, resultFile, knownFile, String(port)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        cleanupRunnerPid = runner && runner.pid ? runner.pid : 0;
        runner.on('error', () => {});
        runner.unref();
        let cancelMark = Number((loginCancelField && loginCancelField.get && loginCancelField.get()) || 0);
        await publishPersistent({ loginStatus: '请在弹出的浏览器窗口登录新账号；登录成功后自动保存，5 分钟未登录则取消' });
        let done = false;
        for (let i = 0; i < 150 && !done; i += 1) {
          await sleep(2000);
          const cancelNow = Number((loginCancelField && loginCancelField.get && loginCancelField.get()) || 0);
          if (cancelNow && cancelNow !== cancelMark) {
            try { if (browserChild && browserChild.pid) spawn('taskkill.exe', ['/PID', String(browserChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
            try { if (runner && runner.pid) spawn('taskkill.exe', ['/PID', String(runner.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
            await publishPersistent({ loginStatus: '已取消登录，未保存账号' });
            done = true;
            break;
          }
          if (!existsSync(resultFile)) continue;
          let r = null;
          try { r = JSON.parse(nodeFs.readFileSync(resultFile, 'utf8')); } catch (e) { continue; }
          if (!r || r.status === 'waiting') continue;
          if (!r.ok) { await publishPersistent({ loginStatus: '未保存：' + (r.error || r.status || '失败') }); done = true; break; }
          const token = String(r.token || '');
          const userId = String(r.userId || '');
          const nickname = String(r.nickname || '');
          const avatarUrl = String(r.avatarUrl || '');
          try { nodeFs.rmSync(resultFile, { force: true }); } catch (e) {}
          if (!token || token.length < 30 || /[{}\s"]/.test(token) || !userId) {
            await publishPersistent({ loginStatus: '未获取到有效登录信息（可能未登录或已取消），未新增账号' });
            done = true; break;
          }
          accs.accounts = accs.accounts || [];
          // 账号是否已存在：token / 已存 userId / 手机号 / 逐个已存账号反查 userId
          let existing = accs.accounts.find((a) => a.token === token || (userId && a.userId === userId));
          if (!existing) {
            for (const a of accs.accounts) {
              if (!a.token && !a.userId) continue;
              const id = await accountIdentity(a);
              if (id && id === userId) { existing = a; break; }
            }
          }
          if (existing) {
            // 登录期间用户可能删除了账号：保存前重新读取，绝不写回旧快照
            const fresh = await loadAccounts();
            const target = (fresh.accounts || []).find((a) => a.token === token || (userId && a.userId === userId));
            if (!target) {
              await publishPersistent({ loginStatus: '该账号在登录期间已被删除，未恢复' });
              done = true;
              break;
            }
            target.token = token;
            target.userId = userId;
            if (nickname) target.nickname = nickname;
            if (avatarUrl) target.avatarUrl = avatarUrl;
            await saveAccounts(fresh);
            const savedCheck = (await loadAccounts()).accounts.find((a) => a.userId === userId);
            if (!savedCheck || !savedCheck.tokenEnc) {
              await publishPersistent({ loginStatus: '保存失败：系统凭据加密不可用，请重试' });
              done = true;
              break;
            }
            try { await persistSettings({ accountsCleared: false }); } catch (e) {}
            await refreshAccountsMirror();
            const okMsg = '该账号已在列表中，已更新登录信息';
            const clearOld = String(cfgGet('status', '')) === 'error';
            await publishPersistent({ loginStatus: okMsg, status: 'idle', statusText: '', ...(clearOld ? { lastSyncResult: '' } : {}) });
            setTimeout(() => { if (String(cfgGet('loginStatus', '')) === okMsg) void publishPersistent({ loginStatus: '' }); }, 8000);
            done = true; break;
          }
          const name = r.name || nickname || ('账号' + String(userId || '').slice(-4));
          let prefix = safeName(name) || ('账号' + userId.slice(-4));
          const fresh = await loadAccounts();
          fresh.accounts = fresh.accounts || [];
          const used = new Set(fresh.accounts.map((a) => path.basename(a.dataset || '')));
          const usedPrefixes = new Set(fresh.accounts.map((a) => String(a.prefix || '')));
          const basePrefix = prefix;
          let fname = 'conversations.' + prefix + '.json';
          let n = 1;
          while ((used.has(fname) || usedPrefixes.has(prefix)) && n < 20) {
            prefix = basePrefix + '-' + userId.slice(-4) + (n > 1 ? '-' + n : '');
            fname = 'conversations.' + prefix + '.json';
            n += 1;
          }
          const datasetPath = path.join(wsDir, 'history', '_raw', fname);
          const accountRoot = path.join(wsDir, 'history', 'ws-' + prefix);
          try { nodeFs.mkdirSync(path.dirname(datasetPath), { recursive: true }); nodeFs.mkdirSync(accountRoot, { recursive: true }); } catch (e) {}
          fresh.accounts.push({
            id: 'acc-' + Date.now().toString(36), name, prefix, userId, nickname, avatarUrl,
            token, dataset: datasetPath,
            root: accountRoot, enabled: true,
          });
          await saveAccounts(fresh);
          const savedCheck = (await loadAccounts()).accounts.find((a) => a.userId === userId);
          if (!savedCheck || !savedCheck.tokenEnc) {
            await publishPersistent({ loginStatus: '保存失败：系统凭据加密不可用，请重试' });
            done = true;
            break;
          }
          try { await persistSettings({ accountsCleared: false }); } catch (e) {}
          await refreshAccountsMirror();
          const okMsg = '已保存账号：' + name;
          await publishPersistent({ loginStatus: okMsg, status: 'idle', statusText: '', lastSyncAt: 0, lastSyncResult: '' });
          setTimeout(() => { if (String(cfgGet('loginStatus', '')) === okMsg) void publishPersistent({ loginStatus: '' }); }, 8000);
          done = true;
        }
        if (!done) {
          try { if (browserChild && browserChild.pid) spawn('taskkill.exe', ['/PID', String(browserChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
          try { if (runner && runner.pid) spawn('taskkill.exe', ['/PID', String(runner.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
          try { nodeFs.rmSync(resultFile, { force: true }); } catch (e) {}
          try { nodeFs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
          await publishPersistent({ loginStatus: '登录超时（5 分钟），未保存；可重新点按钮' });
        }
        await sleep(3000);
        try { nodeFs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
      } catch (e) {
        try { if (cleanupPid) spawn('taskkill.exe', ['/PID', String(cleanupPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e2) {}
        try { if (cleanupRunnerPid) spawn('taskkill.exe', ['/PID', String(cleanupRunnerPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e2) {}
        try { if (cleanupProfile) nodeFs.rmSync(cleanupProfile, { recursive: true, force: true }); } catch (e2) {}
        try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'login: ' + String(e) + '\n'); } catch (e2) {}
        await publishPersistent({ loginStatus: '登录流程出错：' + String((e && e.message) || e).slice(0, 120) });
      } finally { loginBusy = false; }
    }, 1500);
    ctx.effect(() => () => clearInterval(loginTimer));
  }

  // 每日汇总：9:00 后若今天自动巡检有新增/更新，只发一条普通通知
  ctx.effect(() => {
    const t = setInterval(async () => {
      try {
        if (!cfgGet('digestEnabled', true)) return;
        const now = new Date();
        if (now.getHours() < 9) return;
        const today = now.toISOString().slice(0, 10);
        const sent = await readDataJson('digest-sent.json', { date: '' });
        if (sent.date === today) return;
        const st = await readDataJson('digest.json', { date: '', add: 0, upd: 0 });
        if (st.date !== today || (!st.add && !st.upd)) return;
        notify('聊天历史同步（每日汇总）', '今天自动巡检：新增 ' + st.add + ' / 更新 ' + st.upd + ' 个会话', false);
        await writeDataJson('digest-sent.json', { date: today });
      } catch (e) {}
    }, 10 * 60 * 1000);
    return () => clearInterval(t);
  });

  // 导入提醒从关到开：把之前被隐藏的待导入状态重新暴露
  ctx.effect(() => {
    let lastAutoInstall = !!liveConfig.autoInstall;
    try {
      if (liveConfig.autoInstall && liveConfig.installDeferred && !liveConfig.installDeferredByUser && cfgGet('installPending', false)) {
        void publishPersistent({ installDeferred: false, installDeferredByUser: false, statusText: '有会话待导入' });
      }
    } catch (e) {}
    const t = setInterval(() => {
      const now = !!liveConfig.autoInstall;
      if (now && !lastAutoInstall && cfgGet('installPending', false)) {
        void publishPersistent({ installDeferred: false, installDeferredByUser: false, statusText: '有会话待导入' });
      }
      lastAutoInstall = now;
    }, 2000);
    return () => clearInterval(t);
  });
  ctx.effect(() => {
    const iv = setInterval(() => {
      if (!liveConfig.autoSync) return;
      if (/正在打开登录页|请在弹出的浏览器/.test(String(cfgGet('loginStatus', '')))) return;
      (async () => {
        if (syncInFlight) return;
        syncInFlight = true;
        try {
          const accounts = await withSettingsAccounts();
          const result = await runEngine(accounts, attachmentModeOf(), false);
          if (/^没有启用/.test(String(result || ''))) {
            await publishPersistent({ status: 'idle', statusText: String(result).slice(0, 200) });
            return;
          }
          if (/^同步失败/.test(String(result || ''))) {
            await publishPersistent({ status: 'error', statusText: String(result).slice(0, 200), lastSyncResult: String(result).slice(0, 300) });
            notify('聊天历史同步失败', String(result).slice(0, 100), true);
            return;
          }
          const changed = /新增 [1-9]|更新 [1-9]/.test(String(result || ''));
          if (!changed) {
            const noChangeText = /部分账号失败/.test(String(result || '')) ? String(result).slice(0, 200) : '同步完成（无变化）';
            await publishPersistent({ status: 'done', statusText: noChangeText, lastSyncAt: Date.now() });
            return;
          }
          await afterSync(accounts, result, { auto: true });
          // 自动巡检静默：只更新报告/状态，不弹系统通知
        } catch (e) {
          try { await fsp.appendFile(path.join(dataDir, 'sync.log'), 'autoSync: ' + String(e) + '\n'); } catch (e2) {}
          try {
            const msg = '自动同步失败：' + String((e && e.message) || e).slice(0, 180);
            await publishPersistent({ status: 'error', statusText: msg, lastSyncResult: msg.slice(0, 300) });
          } catch (e2) {}
        } finally {
          syncInFlight = false;
        }
      })();
    }, 60 * 60 * 1000);
    return () => clearInterval(iv);
  });

  ctx.inject(['commands'], (c) => {
    c.commands.register({
      definitionId: 'dsh-chat-history-sync.ping',
      name: 'chat-history-sync.ping',
      action: () => 'memory-sync is alive',
    });
    c.commands.register({
      definitionId: 'dsh-chat-history-sync.accounts',
      name: 'chat-history-sync.accounts',
      action: async () => {
        const a = await loadAccounts();
        return 'accounts: ' + (a.accounts.length ? a.accounts.map((x) => `${x.name}[${x.prefix}]${x.enabled ? '' : '(停用)'}`).join(', ') : '（无，请在设置里登录账号）');
      },
    });
    const runExclusive = async (dry) => {
      if (syncInFlight) return '已有同步在运行，请稍后';
      syncInFlight = true;
      try {
        const a = await withSettingsAccounts();
        return await runEngine(a, attachmentModeOf(), dry);
      } finally {
        syncInFlight = false;
      }
    };
    c.commands.register({
      definitionId: 'dsh-chat-history-sync.run',
      name: 'chat-history-sync.run',
      action: async () => runExclusive(false),
    });
    c.commands.register({
      definitionId: 'dsh-chat-history-sync.dry',
      name: 'chat-history-sync.dry',
      action: async () => runExclusive(true),
    });
    c.commands.register({
      definitionId: 'dsh-chat-history-sync.report',
      name: 'chat-history-sync.report',
      action: async () => {
        const logPath = path.join(dataDir, 'sync.log');
        if (!existsSync(logPath)) return '还没有同步记录';
        const t = await fsp.readFile(logPath, 'utf8');
        return '最近同步：\n' + t.trim().split('\n').slice(-30).join('\n');
      },
    });
    c.commands.register({
      definitionId: 'dsh-chat-history-sync.config',
      name: 'chat-history-sync.config',
      action: async () => {
        const a = await loadAccounts();
        return JSON.stringify({ accounts: a.accounts.length, attachmentMode: attachmentModeOf(), autoSync: !!liveConfig.autoSync }, null, 2);
      },
    });
  });
}
