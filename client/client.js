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
    const EditableField = ({ value, placeholder, disabled, width, bold, label, maxLength, onCommit }) => {
      const [v, setV] = React.useState(value || '');
      const editing = React.useRef(false);
      const cancelled = React.useRef(false);
      React.useEffect(() => { if (!editing.current) setV(value || ''); }, [value]);
      return h('input', {
        className: 'msx-input',
        value: v,
        placeholder,
        maxLength,
        title: label || placeholder || '',
        'aria-label': label || placeholder || '输入',
        disabled,
        style: { width, fontWeight: bold ? 600 : 400 },
        onFocus: () => { editing.current = true; cancelled.current = false; },
        onChange: (e) => setV(e.target.value),
        onBlur: () => {
          editing.current = false;
          if (cancelled.current) { cancelled.current = false; setV(value || ''); return; }
          if (v !== (value || '')) onCommit(v);
        },
        onKeyDown: (e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { cancelled.current = true; setV(value || ''); e.currentTarget.blur(); }
        },
      });
    };

    const renderReportText = (s) => String(s || '').split('\n').filter((l) => l.trim()).map((line, i) => {
      const key = 'r' + i;
      if (/^##\s+/.test(line)) return h('div', { key, className: 'msx-report-h' }, line.replace(/^##\s+/, ''));
      if (/^\s*-\s+摘要：/.test(line)) return h('div', { key, className: 'msx-report-sum' }, line.replace(/^\s*-\s+/, ''));
      if (/^-\s+/.test(line)) {
        const link = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
        return h('div', { key, className: 'msx-report-item' },
          '• ' + line.replace(/^-\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'),
          link ? h('button', { className: 'msx-linkbtn', 'aria-label': '复制会话位置路径', title: link[2], onClick: () => { try { navigator.clipboard.writeText(link[2]); } catch (e) {} } }, '复制路径') : null,
        );
      }
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

    function FooterEntry({ wide }) {
      const [busy, setBusy] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const [meta, setMeta] = React.useState({ running: false, pending: false, deferred: false, empty: false, noEnabled: false, loginWaits: false, authFailed: false });
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          if (document.visibilityState === 'hidden') return;
          try {
            const res = await clientCtx.remote.settings.describe();
            const doc = res && res.ok ? res.value : null;
            const list = (doc && doc.namespaces) || [];
            const ns = list.find((n) => n.ns === NS) || list.find((n) => String(n.ns).endsWith(':' + NS) || String(n.ns).endsWith('/' + NS));
            if (alive && ns) {
              let accounts = [];
              try { accounts = JSON.parse((ns.value && ns.value.accounts) || '[]'); } catch (e) { accounts = []; }
              setMeta({ running: ns.value && ns.value.status === 'running', pending: !!(ns.value && ns.value.installPending) && ns.value.autoInstall !== false, deferred: !!(ns.value && ns.value.installDeferred) && ns.value.autoInstall !== false, empty: !accounts.length, noEnabled: accounts.length > 0 && !accounts.some((a) => a && a.enabled !== false), loginWaits: /正在打开登录页|请在弹出的浏览器/.test(String((ns.value && ns.value.loginStatus) || '')), authFailed: !!(ns.value && ns.value.status === 'error' && /登录失效|风控|401|403/.test(String(ns.value.statusText || ''))) });
            }
          } catch (e) {}
        };
        tick();
        const id = setInterval(tick, 5000);
        return () => { alive = false; clearInterval(id); };
      }, []);
      const running = busy || meta.running;
      const loginWaits = !!meta.loginWaits;
      const authFailed = !!meta.authFailed;
      const blocked = running || meta.empty || meta.noEnabled || loginWaits || authFailed;
      const run = async () => {
        if (blocked) return;
        setBusy(true);
        try {
          const res = await clientCtx.remote.settings.describe();
          const doc = res && res.ok ? res.value : null;
          const list = (doc && doc.namespaces) || [];
          const ns = list.find((n) => n.ns === NS) || list.find((n) => String(n.ns).endsWith(':' + NS) || String(n.ns).endsWith('/' + NS));
          if (!ns) return;
          let r = await clientCtx.remote.settings.mutate(ns.ns, [{ op: 'set', path: ['runNow'], value: true }], ns.revision || 0);
          if (!r || !r.ok) {
            const freshRes = await clientCtx.remote.settings.describe();
            const freshDoc = freshRes && freshRes.ok ? freshRes.value : null;
            const freshList = (freshDoc && freshDoc.namespaces) || [];
            const freshNs = freshList.find((n) => n.ns === NS) || freshList.find((n) => String(n.ns).endsWith(':' + NS) || String(n.ns).endsWith('/' + NS));
            if (freshNs) await clientCtx.remote.settings.mutate(freshNs.ns, [{ op: 'set', path: ['runNow'], value: true }], freshNs.revision || 0);
          }
        } catch (e) {} finally {
          setTimeout(() => setBusy(false), 5000);
        }
      };
      return h('button', {
        type: 'button',
        className: 'msx-footer-action',
        title: meta.empty ? '请先在设置中登录账号' : (meta.noEnabled ? '请先在设置中启用账号' : (authFailed ? '登录已失效，请先在设置页重新登录' : (loginWaits ? '等待浏览器登录完成' : (running ? '正在同步，可在设置页查看进度' : '立即同步聊天历史')))),
        'aria-label': meta.empty ? '未登录，请先在设置中登录账号' : (meta.noEnabled ? '未启用账号，请先在设置中启用' : (authFailed ? '登录已失效，请先在设置页重新登录' : (loginWaits ? '等待浏览器登录完成' : (running ? '正在同步聊天历史' : '立即同步聊天历史')))),
        'aria-busy': running || undefined,
        disabled: blocked,
        onClick: run,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: { display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 9, background: hover && !running ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 13, cursor: 'pointer' },
      }, h('span', { 'aria-hidden': 'true', style: { fontSize: 16, lineHeight: 1, position: 'relative' } }, running ? '…' : '↻', (meta.pending || meta.deferred) && !running ? h('i', { style: { position: 'absolute', right: -3, top: -2, width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-warning, #f5a623)' } }) : null), wide ? h('span', null, meta.empty ? '未登录' : (meta.noEnabled ? '先启用' : (authFailed ? '需重新登录' : (loginWaits ? '等待登录' : (running ? '正在同步' : '同步聊天历史'))))) : null);
    }

    class SlotBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) { return { err }; }
      render() {
        if (this.state.err) return h('div', { style: { padding: '12px 16px', color: 'var(--dsw-alias-state-error)', fontSize: 13 } }, '界面加载失败，请关闭设置后重开。');
        return this.props.children;
      }
    }

    function CardSafe() { return h(SlotBoundary, null, h(Card)); }
    function FooterSafe(props) { return h(SlotBoundary, null, h(FooterEntry, props)); }

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
      const [advOpen, setAdvOpen] = React.useState(false);
      const lastRev = React.useRef(0);
      const nsRef = React.useRef(NS);

      const findNs = async () => {
        // remote.settings.describe() 返回 typed-remote 信封：{ ok, value } / { ok:false, error }
        const res = await clientCtx.remote.settings.describe();
        const doc = res && res.ok ? res.value : null;
        const list = (doc && doc.namespaces) || [];
        const exact = list.find((n) => n.ns === NS);
        if (exact) { nsRef.current = exact.ns; return exact; }
        // 宿主 0.2.x 的命名空间是 Loader 入口 id（如 include:dsh-chat-history-sync）
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
                for (const k of ['accounts', 'attachmentMode', 'autoSync', 'autoInstall', 'installPending', 'installNow', 'installDeferred', 'duplicateCount', 'notifyEnabled', 'digestEnabled', 'lastSyncAt', 'lastSyncResult', 'accountHealth', 'attachmentStats', 'reportTargetSessionId', 'loginStatus', 'loginRequest', 'status', 'statusText', 'reportText']) if (v[k] !== undefined) next[k] = v[k];
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
              const doneText = String(v.statusText || '');
              setMsg(doneText && !/^同步完成/.test(doneText) ? doneText : '');
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

      const write = async (field, v, clearAccounts = false) => {
        setBusy(true);
        try {
          const ops = [{ op: 'set', path: [field], value: v }];
          if (typeof clearAccounts === 'boolean') ops.push({ op: 'set', path: ['accountsCleared'], value: clearAccounts });
          let r = await clientCtx.remote.settings.mutate(nsRef.current, ops, revision);
          if (!r || !r.ok) {
            // 同步进度会频繁 bump revision；重新读取一次再重试，避免编辑被静默回滚
            const fresh = await findNs();
            if (fresh) r = await clientCtx.remote.settings.mutate(nsRef.current, ops, fresh.revision);
          }
          if (r && r.ok) {
            setRevision(r.value.revision); lastRev.current = r.value.revision; setValue(r.value.value || {}); setMsg('已保存');
            setTimeout(() => setMsg((cur) => (cur === '已保存' ? '' : cur)), 1800);
          } else { setMsg('保存被拒绝'); void load(); }
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
          const ops = [{ op: 'set', path: ['loginRequest'], value: Date.now() }];
          let r = await clientCtx.remote.settings.mutate(nsRef.current, ops, revision);
          if (!r || !r.ok) {
            const fresh = await findNs();
            if (fresh) r = await clientCtx.remote.settings.mutate(nsRef.current, ops, fresh.revision);
          }
          if (r && r.ok) {
            setRevision(r.value.revision);
            setValue(r.value.value || {});
            setTimeout(() => setBusy(false), 3000);
            return;
          } else {
            setMsg('登录触发失败，请重试');
          }
        } catch (e) { setMsg('登录触发失败：' + (e && e.message)); }
        setBusy(false);
      };

      const mode = (value && value.attachmentMode) || 'all';
      const modeText = mode === 'all' ? '保存原件和图片' : (mode === 'images' ? '只保存图片' : '只记录文件名');
      const auto = !!(value && value.autoSync);
      const autoInstall = value ? value.autoInstall !== false : true;
      const notifyOn = value ? value.notifyEnabled !== false : true;
      const digestOn = value ? value.digestEnabled !== false : true;
      const running = startedAt > 0 || !!(value && value.status === 'running');
      let accounts = [];
      try { accounts = JSON.parse((value && value.accounts) || '[]'); } catch (e) { accounts = []; }
      if (!Array.isArray(accounts)) accounts = [];
      const installPending = !!(value && value.installPending) || accounts.some((a) => a && a.__installPending);
      const installDeferred = !!(value && value.installDeferred);
      const duplicateCount = Number(value && value.duplicateCount) || 0;
      let health = {};
      try { health = JSON.parse((value && value.accountHealth) || '{}'); } catch (e) { health = {}; }
      let attachStats = null;
      try { attachStats = JSON.parse((value && value.attachmentStats) || 'null'); } catch (e) { attachStats = null; }
      const attachText = attachStats ? '本地已有 ' + attachStats.count + ' 个附件 · ' + (attachStats.bytes / 1048576).toFixed(1) + ' MB' : '';
      const setAccounts = (next) => { void write('accounts', JSON.stringify(next), !next.length); };
      const hasAccounts = accounts.some((a) => a && a.enabled !== false);
      const hasAnyAccounts = accounts.length > 0;
      const patchRow = (i, patch) => { const n = accounts.slice(); n[i] = { ...n[i], ...patch }; setAccounts(n); };
      const loginStatus = value && value.loginStatus;
      const loginPending = /正在打开登录页|请在弹出的浏览器/.test(String(loginStatus || ''));
      const statusText = String((value && value.statusText) || '');
      const progressMatch = statusText.match(/正在同步\s+(\d+)\/(\d+)/);
      const progressPct = progressMatch && Number(progressMatch[2]) > 0 ? Math.round((Number(progressMatch[1]) / Number(progressMatch[2])) * 100) : 0;
      const progressText = progressMatch ? '正在同步 ' + progressMatch[1] + '/' + progressMatch[2] : '正在同步…';
      const actionVisible = autoInstall && /^(安装完成|安装失败|安装未完成|安装调度失败|已安排安装|已取消本次安装|有会话待安装)/.test(statusText);
      const installFailed = autoInstall && /^(安装失败|安装未完成|安装调度失败)/.test(statusText);
      const statusLine = value ? (msg || (running ? progressText : (value.status === 'error' ? String(value.statusText || '同步失败') : (actionVisible ? statusText : (value.lastSyncAt ? '已同步' : '尚未同步'))))) : (msg || '读取中…');
      const pendingText = /^同步完成：检测到新会话/.test(String((value && value.statusText) || ''));
      const pendingInstall = (installPending || pendingText) && autoInstall;
      const needInstall = !installDeferred && pendingInstall;
      const shownStatus = loginPending ? '等待登录…' : ((!running && pendingText) ? '同步完成 · 待确认安装' : statusLine);
      const failed = !!(value && (value.status === 'error' || /^同步失败|^自动同步失败|部分账号失败|^安装失败|^安装未完成|^安装调度失败/.test(String(shownStatus || ''))));
      const needRelogin = failed && /^(同步失败|自动同步失败).*(登录失效|风控|401|403)/.test(statusText);
      const fmtTime = (ts) => {
        try { return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
      };

      return h('div', { className: 'msx', style: { display: 'grid', gap: 18, maxWidth: 640, padding: '2px 0 8px' } },
        h('style', null, CSS),

        h('div', null,
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '聊天历史同步'),
          h('div', { className: 'msx-muted', style: { marginTop: 6 } }, 'DeepSeek 聊天记录 → DSH，按月份归档。'),
        ),

        // 同步状态 + 立即同步
        h('div', { className: 'msx-card' },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '14px 16px 12px', flexWrap: 'wrap' } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 } },
                h('span', { className: 'msx-label' }, '同步状态'),
                h('span', { role: 'status', 'aria-live': running ? 'off' : 'polite', style: { fontSize: 14, fontWeight: 600, color: failed ? 'var(--dsw-alias-state-error)' : 'var(--dsw-alias-label-primary)' } }, shownStatus),
                !running ? h('i', { 'aria-hidden': 'true', style: { display: 'inline-block', flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', background: failed ? 'var(--dsw-alias-state-error, #e5484d)' : (pendingInstall ? 'var(--dsw-alias-state-warning, #f5a623)' : (hasAccounts ? 'var(--dsw-alias-state-success, #30a46c)' : 'var(--dsw-alias-label-tertiary, #8b8f98)')) } }) : null,
              ),
              h('div', { className: 'msx-sub' }, !value ? '正在读取同步设置…' : (loginPending ? '请在弹出的浏览器完成登录。' : (running ? '后台同步中，可离开此页。' : (!hasAccounts ? (hasAnyAccounts ? '先启用账号，再同步。' : '先登录账号，再同步。') : (installFailed ? '可稍后重试安装。' : (needRelogin ? '登录失效，请点「重新登录」。' : (failed ? '可重试，或查看报告。' : '同步时可离开此页。'))))))),
            ),
            h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
              loginPending ? h('button', { className: 'msx-btn', disabled: busy, 'aria-label': '取消登录', onClick: () => void write('loginCancel', Date.now()) }, '取消登录') : null,
              running ? h('button', { className: 'msx-btn', disabled: busy, 'aria-label': '取消当前同步', onClick: () => void write('cancelSync', true) }, '取消') : null,
              needRelogin ? h('button', { className: 'msx-btn', disabled: busy || running || loginPending, 'aria-label': '重新登录 DeepSeek 账号', onClick: () => void write('loginRequest', Date.now()) }, '重新登录') : null,
              h('button', { className: 'msx-btn msx-btn-primary', disabled: busy || running || !hasAccounts || !value || loginPending || needRelogin, 'aria-label': !value ? '加载中' : (loginPending ? '等待浏览器登录' : (!hasAccounts ? (hasAnyAccounts ? '请先启用账号' : '登录 DeepSeek 账号') : (running ? '同步进行中' : (needRelogin ? '请先重新登录' : '立即同步聊天历史')))), onClick: !hasAccounts && !hasAnyAccounts ? login : trigger }, !value ? '加载中' : (loginPending ? '登录中…' : (!hasAccounts ? (hasAnyAccounts ? '先启用' : '登录账号') : (running ? '同步中…' : (needRelogin ? '先重新登录' : '立即同步'))))),
            ),
          ),
          running ? h('div', { className: 'msx-kbar', role: 'progressbar', 'aria-busy': 'true', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': progressMatch ? progressPct : undefined, 'aria-valuetext': progressMatch ? '同步 ' + progressMatch[1] + '/' + progressMatch[2] : '同步进行中' }, h('i', null)) : null,
          (value && (value.lastSyncAt || value.reportText || (installDeferred && autoInstall))) ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '9px 16px', flexWrap: 'wrap' } },
            h('span', { className: 'msx-sub', 'aria-label': installDeferred ? '有会话待安装' : (value.lastSyncAt ? '上次同步 ' + fmtTime(value.lastSyncAt) : '还没有同步记录'), title: value && value.lastSyncResult ? String(value.lastSyncResult).slice(0, 300) : undefined, style: { marginTop: 0, color: installDeferred ? 'var(--dsw-alias-state-warning, #b86e00)' : undefined } }, installDeferred ? '有会话待安装' : (value.lastSyncAt ? '上次同步 ' + fmtTime(value.lastSyncAt) : '还没有同步记录')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 } },
              installDeferred ? h('button', { className: 'msx-linkbtn', disabled: busy || running, onClick: () => void write('installNow', true) }, '安装') : null,
              (value.reportText) ? h('button', { className: 'msx-linkbtn', style: { flexShrink: 0 }, 'aria-expanded': reportOpen, title: duplicateCount > 0 ? duplicateCount + ' 组同名但内容不同的会话已分别保留，点开报告查看' : undefined, 'aria-label': duplicateCount > 0 ? '查看报告，含 ' + duplicateCount + ' 组同名会话' : '查看报告', onClick: () => setReportOpen(!reportOpen) }, reportOpen ? '收起报告' : (duplicateCount > 0 ? '查看报告 · ' + duplicateCount + ' 组同名' : '查看报告')) : null,
            ),
          ) : null,
          (reportOpen && value && value.reportText) ? h('div', { className: 'msx-report' },
            renderReportText(reportFull ? value.reportText : (String(value.reportText).slice(0, 1200) + (String(value.reportText).length > 1200 ? '\n…' : ''))),
            String(value.reportText).length > 1200 ? h('div', { style: { marginTop: 6 } }, h('button', { className: 'msx-linkbtn', onClick: () => setReportFull(!reportFull) }, reportFull ? '收起全文' : '展开全文')) : null,
          ) : null,
        ),

        // 有新会话时：先确认，再安装并重启
        needInstall ? h('div', { className: 'msx-card', style: { marginTop: 10 } },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'msx-label' }, installFailed ? '上次安装失败' : '检测到新会话'),
            h('div', { className: 'msx-sub' }, installFailed ? '待安装状态已保留；重试会再次重启 DSH。' : '加入 DSH 会重启一次；请先完成当前回复。'),
          ),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', { className: 'msx-btn msx-btn-primary', disabled: busy || running, 'aria-label': installFailed ? '重试安装并重启 DSH' : '现在加入并重启 DSH', onClick: () => void write('installNow', true) }, installFailed ? '重试安装' : '现在加入并重启'),
            h('button', { className: 'msx-btn', disabled: busy, 'aria-label': '稍后再说', onClick: () => void write('installCancel', true) }, '稍后再说'),
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
              ? h('div', { style: { padding: '14px 16px' } },
                h('div', { className: 'msx-muted' }, '还没有账号。登录后即可同步该账号的聊天历史。'),
                h('div', { className: 'msx-sub', style: { marginTop: 6 } }, 'DSH 自建会话不会被改动。'),
              )
              : accounts.map((a, i) => h('div', { key: i, className: 'msx-row', style: { gap: 10 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 auto' } },
                  a.avatarUrl
                    ? h('img', { src: a.avatarUrl, className: 'msx-avatar-img', alt: '', referrerPolicy: 'no-referrer' })
                    : h('div', { className: 'msx-avatar' }, String(a.nickname || a.name || a.prefix || '?').slice(0, 1)),
                  h('div', { style: { minWidth: 0 } },
                    h(EditableField, {
                      value: a.nickname || '', placeholder: a.name || '显示名', label: '显示名', disabled: busy, width: 130, bold: true, maxLength: 80,
                      onCommit: (v) => patchRow(i, { nickname: v }),
                    }),
                    (health[a.name] || health[a.prefix]) && /失败|error|失效/.test(String(health[a.name] || health[a.prefix])) ? h('div', { className: 'msx-sub', style: { color: 'var(--dsw-alias-state-error)' } }, String(health[a.name] || health[a.prefix]).slice(0, 80)) : null,
                  ),
                ),
                h('label', { title: '账号简称会作为会话标题前缀，修改会重命名已生成的会话', style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' } },
                  h('span', null, '简称：'),
                  h(EditableField, {
                    value: a.prefix || '', placeholder: a.name || '自动', label: '账号简称', disabled: busy, width: 110, maxLength: 40,
                    onCommit: (v) => patchRow(i, { prefix: v }),
                  }),
                ),
                h('label', { style: { display: 'flex', gap: 5, alignItems: 'center', fontSize: 13, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
                  h('input', { type: 'checkbox', checked: a.enabled !== false, disabled: busy, 'aria-label': '启用账号 ' + (a.nickname || a.name || a.prefix), onChange: (e) => patchRow(i, { enabled: e.target.checked }) }),
                  '启用',
                ),
                h('button', { className: 'msx-btn msx-btn-danger', disabled: busy, 'aria-label': confirmDel === i ? '取消移除账号' : '移除账号', onClick: () => setConfirmDel(confirmDel === i ? -1 : i) }, confirmDel === i ? '取消' : '移除'),
                confirmDel === i ? h('button', { className: 'msx-btn msx-btn-danger', autoFocus: true, disabled: busy, 'aria-label': '确认移除账号', onClick: () => { setConfirmDel(-1); setAccounts(accounts.filter((_, j) => j !== i)); } }, '确认移除') : null,
              )),
          ) : null,
          h('button', { className: 'msx-dashed', disabled: busy || running || loginPending, 'aria-label': '登录新的 DeepSeek 账号', onClick: login }, '＋ 登录新账号'),

          loginStatus ? h('div', { className: 'msx-sub', style: { marginTop: 8 } }, loginStatus) : null,
          h('div', { className: 'msx-sub', style: { marginTop: 8 } }, '移除账号只停止同步，不删除已归档会话。'),
        ),

        // 同步设置
        h('section', null,
          h('h3', { className: 'msx-h3' }, '同步设置'),
          h('div', { className: 'msx-card' },
            h('div', { className: 'msx-row' },
              h('div', null,
                h('div', { className: 'msx-label' }, '附件下载'),
                h('div', { className: 'msx-sub' }, modeText),
                attachText ? h('div', { className: 'msx-sub' }, attachText) : null,
              ),
              h('select', { className: 'msx-select', 'aria-label': '附件下载方式', value: mode, disabled: busy, onChange: (e) => void write('attachmentMode', e.target.value) },
                h('option', { value: 'all' }, '全部保存'),
                h('option', { value: 'images' }, '只保存图片'),
                h('option', { value: 'none' }, '只记录文件名'),
              ),
            ),
            h('label', { className: 'msx-row', style: { cursor: 'pointer' } },
              h('div', null,
                h('div', { className: 'msx-label' }, '每小时自动同步'),
                h('div', { className: 'msx-sub' }, '有变化才生成同步报告'),
              ),
              h('input', { type: 'checkbox', checked: auto, disabled: busy, 'aria-label': '每小时自动同步', onChange: (e) => void write('autoSync', e.target.checked) }),
            ),
            h('label', { className: 'msx-row', style: { cursor: 'pointer' } },
              h('div', null,
                h('div', { className: 'msx-label' }, '新会话安装提醒'),
                h('div', { className: 'msx-sub' }, '有新增时提示安装（确认后才重启）'),
              ),
              h('input', { type: 'checkbox', checked: autoInstall, disabled: busy, 'aria-label': '新会话安装提醒', onChange: (e) => void write('autoInstall', e.target.checked) }),
            ),
            h('div', { className: 'msx-row' },
              h('button', { className: 'msx-linkbtn', 'aria-expanded': advOpen, onClick: () => setAdvOpen(!advOpen) }, advOpen ? '收起更多设置 ▴' : '更多设置 ▾'),
            ),
            advOpen ? h('div', null,
              h('label', { className: 'msx-row', style: { cursor: 'pointer' } },
                h('div', null,
                  h('div', { className: 'msx-label' }, '系统通知'),
                  h('div', { className: 'msx-sub' }, '仅在失败、待安装或安装状态变化时提醒'),
                ),
                h('input', { type: 'checkbox', checked: notifyOn, disabled: busy, 'aria-label': '系统通知', onChange: (e) => void write('notifyEnabled', e.target.checked) }),
              ),
              h('label', { className: 'msx-row', style: { cursor: 'pointer' } },
                h('div', null,
                  h('div', { className: 'msx-label' }, '每日汇总'),
                  h('div', { className: 'msx-sub' }, '需开启自动同步；有变化时 9:00 后发一条摘要'),
                ),
                h('input', { type: 'checkbox', checked: digestOn, disabled: busy, 'aria-label': '每日汇总', onChange: (e) => void write('digestEnabled', e.target.checked) }),
              ),
              h('div', { className: 'msx-row' },
                h('button', { className: 'msx-linkbtn', disabled: busy, 'aria-label': '导出脱敏诊断信息，不含登录信息', onClick: () => void write('exportDiagnostics', true) }, '导出诊断（不含登录信息）'),
              ),
            ) : null,
          ),
        ),

        h('div', { className: 'msx-muted' }, '免费 · 摘要在本机生成 · 无遥测'),
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
        }, CardSafe));
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'chat-history-sync',
          order: 27,
          label: () => '同步聊天历史',
        }, FooterSafe));
      },
    };
  },
});
