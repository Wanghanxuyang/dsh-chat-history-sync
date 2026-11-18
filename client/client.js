// dsh-chat-history-sync 客户端包：设置页「聊天历史同步」卡片（DSH 原生设置风格）
window.__ModuleLoader__.load({
  id: 'dsh-chat-history-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-chat-history-sync';
    const START_KEY = 'ms-sync-started';
    const WINDOW_MS = 180000;
    let clientCtx = null;

    // 可编辑文本：输入时不写设置，失焦/回车才提交（避免每敲一字触发 HMR/失焦）
    const EditableField = ({ value, placeholder, disabled, width, bold, label, onCommit }) => {
      const [v, setV] = React.useState(value || '');
      const editing = React.useRef(false);
      React.useEffect(() => { if (!editing.current) setV(value || ''); }, [value]);
      return h('input', {
        className: 'msx-input',
        value: v,
        placeholder,
        'aria-label': label || placeholder || '输入',
        disabled,
        style: { width, fontWeight: bold ? 600 : 400 },
        onFocus: () => { editing.current = true; },
        onChange: (e) => setV(e.target.value),
        onBlur: () => { editing.current = false; if (v !== (value || '')) onCommit(v); },
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
      });
    };

    const renderReportText = (s) => String(s || '').split('\n').filter((l) => l.trim()).map((line, i) => {
      const key = 'r' + i;
      if (/^##\s+/.test(line)) return h('div', { key, className: 'msx-report-h' }, line.replace(/^##\s+/, ''));
      if (/^\s*-\s+摘要：/.test(line)) return h('div', { key, className: 'msx-report-sum' }, line.replace(/^\s*-\s+/, ''));
      if (/^-\s+/.test(line)) return h('div', { key, className: 'msx-report-item' }, '• ' + line.replace(/^-\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
      return h('div', { key, className: 'msx-report-line' }, line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
    });

    const CSS = `
      .msx-card{background:var(--dsw-alias-bg-layer-1);border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);border-radius:14px;overflow:hidden}
      .msx-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px}
      .msx-row+.msx-row{border-top:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)}
      .msx-input{box-sizing:border-box;width:100%;padding:8px 10px;border-radius:9px;border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;outline:none;font-family:inherit}
      .msx-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
      .msx-input:focus{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base)}
      .msx-btn{appearance:none;border-radius:9px;padding:7px 14px;font-size:13px;line-height:20px;cursor:pointer;font-family:inherit;white-space:nowrap}
      .msx-btn:disabled{opacity:.45;cursor:default}
      .msx-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border:1px solid transparent;font-weight:600}
      .msx-btn-primary:hover:not(:disabled){opacity:.88}
      .msx-btn-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
      .msx-btn-ghost:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
      .msx-btn-danger{background:transparent;border:none;color:var(--dsw-alias-state-error-primary);padding:7px 6px}
      .msx-btn-danger:hover{opacity:.8}
      .msx-dashed{box-sizing:border-box;width:100%;margin-top:10px;padding:11px;border:1px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;font-family:inherit}
      .msx-dashed:hover{background:var(--dsw-alias-bg-layer-2)}
      .msx-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .msx-h3{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 0 8px 2px}
      .msx-kbar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;position:relative;margin:0 16px 14px}
      .msx-kbar>i{position:absolute;top:0;bottom:0;width:34%;border-radius:2px;background:var(--dsw-alias-brand-primary);animation:msx-move 1.1s ease-in-out infinite}
      @keyframes msx-move{0%{left:-34%}100%{left:100%}}
      .msx-label{font-size:13px;color:var(--dsw-alias-label-primary);white-space:nowrap}
      .msx-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px;margin-top:2px}
      .msx-select{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:7px 28px 7px 10px;font-size:13px;font-family:inherit;outline:none;cursor:pointer}
      .msx-select:focus{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base)}
      .msx-avatar{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);flex:0 0 auto}
      .msx-avatar-img{width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);flex:0 0 auto}
      .msx-report{white-space:pre-wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:0 16px 14px;max-height:240px;overflow:auto}
      .msx-report-h{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:10px 0 4px;white-space:normal}
      .msx-report-item{white-space:normal;margin:3px 0;color:var(--dsw-alias-label-secondary)}
      .msx-report-sum{white-space:normal;margin:2px 0 6px 14px;color:var(--dsw-alias-label-tertiary)}
      .msx-report-line{white-space:normal;margin:4px 0}
      .msx-fieldlabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-bottom:2px}
      .msx-linkbtn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;padding:2px 4px;font-family:inherit}
      .msx-linkbtn:hover{color:var(--dsw-alias-label-primary)}
      .msx-btn:focus-visible,.msx-input:focus-visible,.msx-linkbtn:focus-visible,.msx-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      @media (max-width:560px){
        .msx-row{flex-wrap:wrap}
        .msx-row .msx-input{width:100%!important}
        .msx-row>label{width:100%;justify-content:space-between}
      }
    `;

    function Card() {
      const [value, setValue] = React.useState(null);
      const [revision, setRevision] = React.useState(0);
      const [msg, setMsg] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [startedAt, setStartedAt] = React.useState(0);
      const [accOpen, setAccOpen] = React.useState(true);
      const [reportOpen, setReportOpen] = React.useState(false);
      const [reportFull, setReportFull] = React.useState(false);
      const [confirmDel, setConfirmDel] = React.useState(-1);
      const lastRev = React.useRef(0);
      const nsRef = React.useRef(NS);

      const findNs = async () => {
        // remote.settings.describe() 返回 typed-remote 信封：{ ok, value } / { ok:false, error }
        const res = await clientCtx.remote.settings.describe();
        const doc = res && res.ok ? res.value : null;
        const list = (doc && doc.namespaces) || [];
        const exact = list.find((n) => n.ns === NS);
        if (exact) { nsRef.current = exact.ns; return exact; }
        // 宿主 0.2.x 的命名空间是 Loader 入口 id（如 include:dsh-memory-sync）
        const bySuffix = list.find((n) => String(n.ns).endsWith(':' + NS) || String(n.ns).endsWith('/' + NS));
        if (bySuffix) nsRef.current = bySuffix.ns;
        return bySuffix || null;
      };

      const load = async () => {
        try {
          let ns = await findNs();
          for (let i = 0; !ns && i < 3; i += 1) {
            await clientCtx.remote.settings.mutate(nsRef.current, [{ op: 'set', path: ['attachmentMode'], value: 'all' }], 0).catch(() => {});
            await new Promise((r) => setTimeout(r, 800));
            ns = await findNs();
          }
          if (!ns) {
            setMsg('插件未就绪，请重启一次 DSH。');
            setStartedAt(0);
            try { window.localStorage.removeItem(START_KEY); } catch (e) {}
            return;
          }
          nsRef.current = ns.ns;
          setValue(ns.value || {});
          setRevision(ns.revision || 0);
          lastRev.current = ns.revision || 0;
          setMsg('');
          if ((ns.value || {}).status !== 'running') {
            setStartedAt(0);
            try { window.localStorage.removeItem(START_KEY); } catch (e) {}
          }
        } catch (e) { setMsg('读取失败：' + (e && e.message)); }
      };

      React.useEffect(() => {
        void load();
        try {
          const s = Number(window.localStorage.getItem(START_KEY) || 0);
          if (s && Date.now() - s < WINDOW_MS) setStartedAt(s);
          else if (s) window.localStorage.removeItem(START_KEY);
        } catch (e) {}
      }, []);

      React.useEffect(() => {
        let missing = 0;
        const t = setInterval(async () => {
          try {
            const ns = await findNs();
            if (!ns) {
              missing += 1;
              if (missing >= 2) {
                setStartedAt(0);
                try { window.localStorage.removeItem(START_KEY); } catch (e) {}
                setMsg('插件未就绪，请重启一次 DSH。');
              }
              return;
            }
            missing = 0;
            const v = ns.value || {};
            if (ns.revision !== lastRev.current) {
              lastRev.current = ns.revision;
              setRevision(ns.revision);
              setValue((cur) => {
                const next = { ...(cur || {}) };
                for (const k of ['accounts', 'attachmentMode', 'autoSync', 'autoInstall', 'installPending', 'installNow', 'duplicateCount', 'notifyEnabled', 'digestEnabled', 'lastSyncAt', 'lastSyncResult', 'accountHealth', 'attachmentStats', 'reportTargetSessionId', 'loginStatus', 'loginRequest', 'status', 'statusText', 'reportText']) if (v[k] !== undefined) next[k] = v[k];
                return next;
              });
            }
            if (v.status === 'running') {
              setStartedAt((cur) => {
                if (!cur) return Date.now();
                if (Date.now() - cur > WINDOW_MS) { try { window.localStorage.removeItem(START_KEY); } catch (e) {} return 0; }
                return cur;
              });
              setMsg(v.statusText || '正在同步…');
            } else if (v.status === 'done') {
              setStartedAt(0);
              try { window.localStorage.removeItem(START_KEY); } catch (e) {}
              setMsg('尚未同步');
            } else if (v.status === 'error') {
              setStartedAt(0);
              try { window.localStorage.removeItem(START_KEY); } catch (e) {}
              setMsg(v.statusText || '同步失败');
            } else {
              setStartedAt((cur) => {
                if (cur && Date.now() - cur > 5000) {
                  try { window.localStorage.removeItem(START_KEY); } catch (e) {}
                  return 0;
                }
                return cur;
              });
              setMsg((cur) => (/同步中|正在同步/.test(String(cur || '')) ? '' : cur));
            }
          } catch (e) {}
        }, 1500);
        return () => clearInterval(t);
      }, []);

      const write = async (field, v) => {
        setBusy(true);
        try {
          const r = await clientCtx.remote.settings.mutate(nsRef.current, [{ op: 'set', path: [field], value: v }], revision);
          if (r && r.ok) { setRevision(r.value.revision); lastRev.current = r.value.revision; setValue(r.value.value || {}); setMsg('已保存'); }
          else { setMsg('保存被拒绝'); void load(); }
        } catch (e) { setMsg('保存失败：' + (e && e.message)); }
        setBusy(false);
      };

      const trigger = async () => {
        setBusy(true);
        const now = Date.now();
        setStartedAt(now);
        setMsg('同步中，可以离开此页面；完成后会生成同步报告');
        try { window.localStorage.setItem(START_KEY, String(now)); } catch (e) {}
        try {
          const r = await clientCtx.remote.settings.mutate(nsRef.current, [{ op: 'set', path: ['runNow'], value: true }], revision);
          if (!r || !r.ok) {
            setMsg('触发被拒绝，请重试');
            setStartedAt(0);
            setBusy(false);
            try { window.localStorage.removeItem(START_KEY); } catch (e) {}
            return;
          }
          setRevision(r.value.revision);
          lastRev.current = r.value.revision;
          setTimeout(async () => {
            try {
              const ns = await findNs();
              if (ns) {
                const rr = await clientCtx.remote.settings.mutate(nsRef.current, [{ op: 'set', path: ['runNow'], value: false }], ns.revision);
                if (rr && rr.ok) setRevision(rr.value.revision);
              }
            } catch (e) {}
          }, 5000);
        } catch (e) { setMsg('触发失败：' + (e && e.message)); setStartedAt(0); try { window.localStorage.removeItem(START_KEY); } catch (e2) {} }
        setBusy(false);
      };

      const login = async () => {
        setBusy(true);
        try {
          await clientCtx.remote.settings.mutate(nsRef.current, [{ op: 'set', path: ['loginRequest'], value: Date.now() }], revision);
        } catch (e) {}
        setBusy(false);
      };

      const mode = (value && value.attachmentMode) || 'all';
      const auto = !!(value && value.autoSync);
      const autoInstall = value ? value.autoInstall !== false : true;
      const notifyOn = value ? value.notifyEnabled !== false : true;
      const digestOn = value ? value.digestEnabled !== false : true;
      const running = startedAt > 0 || !!(value && value.status === 'running');
      let accounts = [];
      try { accounts = JSON.parse((value && value.accounts) || '[]'); } catch (e) { accounts = []; }
      if (!Array.isArray(accounts)) accounts = [];
      const installPending = !!(value && value.installPending) || accounts.some((a) => a && a.__installPending);
      let health = {};
      try { health = JSON.parse((value && value.accountHealth) || '{}'); } catch (e) { health = {}; }
      let attachStats = null;
      try { attachStats = JSON.parse((value && value.attachmentStats) || 'null'); } catch (e) { attachStats = null; }
      const attachText = attachStats ? '预计 ' + attachStats.count + ' 个附件 · ' + (attachStats.bytes / 1048576).toFixed(1) + ' MB' : '';
      const setAccounts = (next) => { void write('accounts', JSON.stringify(next)); };
      const patchRow = (i, patch) => { const n = accounts.slice(); n[i] = { ...n[i], ...patch }; setAccounts(n); };
      const loginStatus = value && value.loginStatus;
      const statusLine = msg || (running ? '正在同步…' : '尚未同步');
      const pendingText = /检测到新会话/.test(String((value && value.statusText) || ''));
      const needInstall = installPending || pendingText;
      const shownStatus = (!running && pendingText) ? '同步完成 · 待确认安装' : statusLine;
      const failed = !!(value && (value.status === 'error' || /失败|失效/.test(String(shownStatus || ''))));
      const fmtPhone = (p) => {
        const s = String(p || '');
        if (!s) return '';
        if (s.includes('*')) return s;
        const d = s.replace(/\D/g, '');
        return d.length >= 11 ? d.slice(0, 3) + '****' + d.slice(-4) : '';
      };

      return h('div', { className: 'msx', style: { display: 'grid', gap: 18, maxWidth: 640, padding: '2px 0 8px' } },
        h('style', null, CSS),

        h('div', null,
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '聊天历史同步'),
          h('div', { className: 'msx-muted', style: { marginTop: 6 } }, '把 DeepSeek 账号的网页端 / 手机 App 聊天历史同步进 DSH：只增不减，不改动已有数据。'),
        ),

        // 同步状态 + 立即同步
        h('div', { className: 'msx-card' },
          h('div', { className: 'msx-row' },
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'msx-label' }, running ? '同步中' : '同步状态'),
              h('div', { className: 'msx-sub', role: 'status', 'aria-live': 'polite', style: failed ? { color: 'var(--dsw-alias-state-error)' } : null }, shownStatus),
            ),
            h('div', { style: { display: 'flex', gap: 8 } },
              running ? h('button', { className: 'msx-btn', disabled: busy, 'aria-label': '取消当前同步', onClick: () => void write('cancelSync', true) }, '取消') : null,
              h('button', { className: 'msx-btn msx-btn-primary', disabled: busy || running, 'aria-label': running ? '同步进行中' : '立即同步聊天历史', onClick: trigger }, running ? '同步中…' : '立即同步'),
            ),
          ),
          running ? h('div', { className: 'msx-kbar', role: 'progressbar', 'aria-busy': 'true', 'aria-valuetext': '同步进行中' }, h('i', null)) : null,
          (value && value.lastSyncAt) ? h('div', { className: 'msx-sub', style: { paddingTop: 6 } },
            '上次同步 ' + new Date(value.lastSyncAt).toLocaleString() + (value.lastSyncResult ? ' · ' + String(value.lastSyncResult).slice(0, 80) : ''),
          ) : null,
          (value && value.reportText) ? h('div', { className: 'msx-row', style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10, paddingBottom: 10 } },
            h('button', { className: 'msx-linkbtn', 'aria-expanded': reportOpen, onClick: () => setReportOpen(!reportOpen) }, reportOpen ? '收起最近报告' : '查看最近报告'),
            h('span', { className: 'msx-muted' }, '最近一次同步结果'),
          ) : null,
          (reportOpen && value && value.reportText) ? h('div', { className: 'msx-report' },
            renderReportText(reportFull ? value.reportText : (String(value.reportText).slice(0, 1200) + (String(value.reportText).length > 1200 ? '\n…' : ''))),
            String(value.reportText).length > 1200 ? h('div', { style: { marginTop: 6 } }, h('button', { className: 'msx-linkbtn', onClick: () => setReportFull(!reportFull) }, reportFull ? '收起全文' : '展开全文')) : null,
          ) : null,
        ),

        // 有新会话时：先确认，再安装并重启
        needInstall ? h('div', { className: 'msx-card', style: { marginTop: 10 } },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'msx-label' }, '检测到新会话'),
            h('div', { className: 'msx-sub' }, '是否现在安装到工作区？DSH 会重启一次。'),
          ),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', { className: 'msx-btn msx-btn-primary', disabled: busy, 'aria-label': '立即安装到工作区并重启 DSH', onClick: () => void write('installNow', true) }, '立即安装'),
            h('button', { className: 'msx-btn', disabled: busy, 'aria-label': '稍后安装', onClick: () => void write('installPending', false) }, '稍后'),
          ),
        ) : null,

        // 同步账号（可折叠）
        h('section', null,
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
              h('h3', { className: 'msx-h3', style: { margin: 0 } }, '同步账号'),
              h('span', { className: 'msx-muted' }, accounts.length + ' 个'),
            ),
            h('button', { className: 'msx-linkbtn', 'aria-expanded': accOpen, onClick: () => setAccOpen(!accOpen) }, accOpen ? '收起' : '展开'),
          ),
          accOpen ? h('div', { className: 'msx-card', style: { marginTop: 8 } },
            accounts.length === 0
              ? h('div', null,
                h('div', { className: 'msx-muted' }, '还没有账号。登录后会自动保存 token（只存本机），并同步该账号的网页端历史。'),
                h('div', { className: 'msx-muted', style: { marginTop: 4 } }, '不会动 DSH 自建会话；同名但内容不同的会话会保留。'),
                h('div', { className: 'msx-sub', style: { marginTop: 8 } }, '开始使用：1）登录新账号  2）点「立即同步」  3）有新会话时点「立即安装」'),
              )
              : accounts.map((a, i) => h('div', { key: i, className: 'msx-row', style: { gap: 10 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 auto' } },
                  a.avatarUrl
                    ? h('img', { src: a.avatarUrl, className: 'msx-avatar-img', alt: '', referrerPolicy: 'no-referrer' })
                    : h('div', { className: 'msx-avatar' }, String(a.nickname || a.name || a.prefix || '?').slice(0, 1)),
                  h('div', { style: { minWidth: 0 } },
                    h('div', { className: 'msx-fieldlabel' }, '显示名'),
                    h(EditableField, {
                      value: a.nickname || '', placeholder: a.name || '显示名', label: '显示名', disabled: busy, width: 130, bold: true,
                      onCommit: (v) => patchRow(i, { nickname: v }),
                    }),
                    h('div', { className: 'msx-sub' }, fmtPhone(a.phone) || '未绑定手机'),
                    (health[a.name] || health[a.prefix]) ? h('div', { className: 'msx-sub', style: { color: /失败|error|失效/.test(String(health[a.name] || health[a.prefix])) ? 'var(--dsw-alias-state-error)' : 'var(--dsw-alias-label-secondary)' } }, String(health[a.name] || health[a.prefix]).slice(0, 80)) : null,
                  ),
                ),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' } },
                  h('span', null, '简称：'),
                  h(EditableField, {
                    value: a.prefix || '', placeholder: a.name || '自动', label: '账号简称', disabled: busy, width: 110,
                    onCommit: (v) => patchRow(i, { prefix: v }),
                  }),
                ),
                h('label', { style: { display: 'flex', gap: 5, alignItems: 'center', fontSize: 13, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
                  h('input', { type: 'checkbox', checked: a.enabled !== false, disabled: busy, 'aria-label': '启用账号 ' + (a.nickname || a.name || a.prefix), onChange: (e) => patchRow(i, { enabled: e.target.checked }) }),
                  '启用',
                ),
                h('button', { className: 'msx-btn msx-btn-danger', disabled: busy, 'aria-label': confirmDel === i ? '取消删除' : '删除账号', onClick: () => setConfirmDel(confirmDel === i ? -1 : i) }, confirmDel === i ? '取消' : '删除'),
                confirmDel === i ? h('button', { className: 'msx-btn msx-btn-danger', disabled: busy, 'aria-label': '确认删除账号', onClick: () => { setConfirmDel(-1); setAccounts(accounts.filter((_, j) => j !== i)); } }, '确认删除') : null,
              )),
          ) : null,
          h('button', { className: 'msx-dashed', disabled: busy, 'aria-label': '登录新的 DeepSeek 账号', onClick: login }, '＋ 登录新账号'),
          (value && Number(value.duplicateCount) > 0) ? h('div', { className: 'msx-sub', style: { marginTop: 8 } },
            '同名不同内容保留 ' + Number(value.duplicateCount) + ' 组；展开「查看最近报告」可逐条复查。',
          ) : null,
          (value && value.loginStatus && /请在弹出的浏览器|正在打开登录页/.test(String(value.loginStatus)))
            ? h('button', { className: 'msx-btn', style: { marginTop: 8 }, disabled: busy, onClick: () => void write('loginCancel', Date.now()) }, '取消登录')
            : null,
          loginStatus ? h('div', { className: 'msx-sub', style: { marginTop: 8 } }, loginStatus) : null,
        ),

        // 同步设置
        h('section', null,
          h('h3', { className: 'msx-h3' }, '同步设置'),
          h('div', { className: 'msx-card' },
            h('div', { className: 'msx-row' },
              h('div', null,
                h('div', { className: 'msx-label' }, '附件策略'),
                h('div', { className: 'msx-sub' }, '下载文档原件与图片，或只记录文件名'),
                attachText ? h('div', { className: 'msx-sub' }, attachText) : null,
              ),
              h('select', { className: 'msx-select', 'aria-label': '附件策略', value: mode, disabled: busy, onChange: (e) => void write('attachmentMode', e.target.value) },
                h('option', { value: 'all' }, '全部下载'),
                h('option', { value: 'images' }, '只存图片'),
                h('option', { value: 'none' }, '都不下载'),
              ),
            ),
            h('div', { className: 'msx-row' },
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'msx-label' }, '报告会话 ID'),
                h('div', { className: 'msx-sub' }, '写入指定会话；留空则自动创建'),
              ),
              h('input', {
                className: 'msx-input', value: (value && value.reportTargetSessionId) || '', placeholder: 'session-…', disabled: busy,
                onChange: (e) => void write('reportTargetSessionId', e.target.value), style: { flex: '0 0 200px' },
              }),
            ),
            h('div', { className: 'msx-row' },
              h('div', null,
                h('div', { className: 'msx-label' }, '自动巡检'),
                h('div', { className: 'msx-sub' }, '有新增/更新时生成报告，无变化静默'),
              ),
              h('label', { style: { display: 'flex', alignItems: 'center' } },
                h('input', { type: 'checkbox', checked: auto, disabled: busy, onChange: (e) => void write('autoSync', e.target.checked) }),
              ),
            ),
            h('div', { className: 'msx-row' },
              h('div', null,
                h('div', { className: 'msx-label' }, '同步后自动安装'),
                h('div', { className: 'msx-sub' }, '有新会话时自动安装到工作区（DSH 会短暂重启）'),
              ),
              h('label', { style: { display: 'flex', alignItems: 'center' } },
                h('input', { type: 'checkbox', checked: autoInstall, disabled: busy, onChange: (e) => void write('autoInstall', e.target.checked) }),
              ),
            ),
            h('div', { className: 'msx-row' },
              h('div', null,
                h('div', { className: 'msx-label' }, '系统通知'),
                h('div', { className: 'msx-sub' }, '仅失败/待确认时弹；成功静默'),
              ),
              h('label', { style: { display: 'flex', alignItems: 'center' } },
                h('input', { type: 'checkbox', checked: notifyOn, disabled: busy, onChange: (e) => void write('notifyEnabled', e.target.checked) }),
              ),
            ),
            h('div', { className: 'msx-row' },
              h('div', null,
                h('div', { className: 'msx-label' }, '每日汇总'),
                h('div', { className: 'msx-sub' }, '自动巡检有变化时，9:00 后只发一条摘要'),
              ),
              h('label', { style: { display: 'flex', alignItems: 'center' } },
                h('input', { type: 'checkbox', checked: digestOn, disabled: busy, onChange: (e) => void write('digestEnabled', e.target.checked) }),
              ),
            ),
          ),
        ),

        h('div', { style: { marginTop: 8 } },
          h('button', { className: 'msx-linkbtn', disabled: busy, 'aria-label': '导出脱敏诊断信息', onClick: () => void write('exportDiagnostics', true) }, '导出诊断（不含 token）'),
        ),
        h('div', { className: 'msx-muted' }, '同步有新增时会先出「检测到新会话」确认卡；点「立即安装」才重启。成功且无新增不弹系统通知；自动巡检只更新报告，不打扰。'),
      );
    }

    return {
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        clientCtx = ctx;
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'chat-history-sync',
          order: 16,
          label: '聊天历史同步',
        }, Card));
      },
    };
  },
});
