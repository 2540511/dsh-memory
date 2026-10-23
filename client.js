/**
 * 长记忆插件 · 客户端半。
 *
 * 左侧「插件」下面的入口 + 主栏记忆页。数据全部来自宿主的同源精确路由：
 *   GET  /memory/api/state     目录与配置概览
 *   GET  /memory/api/sessions  可保存会话
 *   GET  /memory/api/preview   保存前的目标文件名
 *   POST /memory/api/save      保存
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-memory';
    const PANEL_ID = 'dsh-memory';

    const EN = {
      panel: 'Memory',
      title: 'Memory',
      subtitle: 'Long-term memory · local Markdown · nothing leaves this machine',
      statusBadge: 'Save ready',
      channelLabel: 'Host channel',
      channelLoading: 'checking…',
      channelOk: 'connected',
      channelFail: 'unreachable',
      dirLabel: 'Memory folder',
      filesLabel: 'files',
      configLabel: 'Config',
      configCreated: 'created with defaults',
      configExisting: 'loaded',
      conflictsLabel: 'Conflicts',
      conflictsValue: '{pending} pending · {superseded} superseded',
      configDetail: 'defaults {defaults} · unknown {unknown}',
      saveTitle: 'Save a session',
      saveHint: 'Pick one session. Each save writes a new Markdown file and never overwrites an older one.',
      searchTitle: 'Search memory',
      searchPlaceholder: 'Keyword, entity, or topic',
      searchButton: 'Search',
      searching: 'searching…',
      noMemory: 'No usable memory.',
      results: '{count} hits · scanned {files} files / {entries} entries · {ms} ms',
      freshnessFresh: 'fresh',
      freshnessAging: 'aging',
      freshnessStale: 'stale',
      freshnessUnknown: 'unknown',
      freshnessAnomaly: 'time anomaly',
      loading: 'loading…',
      empty: 'No sessions yet.',
      truncated: 'showing the {shown} most recent of {total}',
      messages: 'msgs',
      lastActive: 'active',
      confirmTitle: 'Will write',
      confirmNote: 'Nothing leaves this machine: the summary is extracted locally.',
      workConfirmNote: 'Verbatim copy of every message, diffs captured separately, split into volumes when large.',
      confirm: 'Save memory',
      modeChat: 'Chat memory',
      modeWork: 'Work memory',
      modeChatHint: 'extractive digest, decays',
      modeWorkHint: 'verbatim, splits into volumes',
      volumes: 'volumes',
      diffs: 'diffs',
      transferTitle: 'Import / export',
      exportAll: 'Export all',
      exporting: 'exporting…',
      importFile: 'Import file',
      importing: 'importing…',
      importReport: 'accepted {accepted} · skipped {skipped} · conflicts {conflicts} · rejected {rejected} · failed {failed}',
      exportDone: 'Exported {entries} entries',
      indexLabel: 'Startup pack',
      indexValue: '{tokens} tokens · {entries} entries',      maintainLabel: 'Tidy up',
      maintaining: 'tidying…',
      maintainResult: 'reweighted {reweighted} · purged {purged} · files {rewritten} · index {indexTokens} tokens',
      conflictsTitle: 'Unresolved conflicts',
      acceptNew: 'Adopt new',
      keepOld: 'Keep old',
      noConflicts: 'No unresolved conflicts.',
      resolvedOk: 'Resolved',
      proposalsTitle: 'Pending proposals',
      noProposals: 'No pending proposals.',
      accept: 'Accept',
      reject: 'Reject',
      workspaceLabel: 'Memory library',
      settingsTitle: 'Settings',
      saveSettings: 'Save settings',
      savingSettings: 'saving…',
      settingsSaved: 'Saved',
      saving: 'saving…',
      cancel: 'Cancel',
      resultOk: 'Saved',
      resultFail: 'Save failed',
      entries: 'entries',
      summaryLabel: 'summary',
      conflicts: 'conflicts',
      carriedFrom: 'carried from {id}',
      reload: 'Reload',
      note: 'Chat memory only for now: a digest entry plus a file-level index. Work memory, search, conflicts and import/export come next.',
      hintChannel: 'Whether this page can reach the plugin host',
      hintDir: 'Where memory Markdown files live',
      hintConfig: 'File-level settings file (_config.md)',
      hintConflicts: 'Memory entries waiting for your decision',
      hintIndex: 'Compact index injected into every model step',
      hintWorkspace: 'Switch this page to another workspace memory library',
      hintExport: 'Download all memory as one re-importable Markdown file',
      hintImport: 'Import a previously exported Markdown file',
      hintMaintain: 'Recompute weights, recycle details, merge duplicates, rebuild index',
      hintRefresh: 'Reload data from the host',
      hintAccept: 'Turn this proposal into a memory',
      hintReject: 'Reject it; the entry is kept but marked deprecated',
      settingsHint: 'Advanced tuning — defaults suit most users. Hover a field for details.',
      version: 'v0.1.0',
    };

    const ZH = {
      panel: '记忆',
      title: '记忆',
      subtitle: '长期记忆插件 · 本地 Markdown · 不向云端发送任何内容',
      statusBadge: '可保存',
      channelLabel: '宿主通道',
      channelLoading: '检测中…',
      channelOk: '已连通',
      channelFail: '连接失败',
      dirLabel: '记忆目录',
      filesLabel: '个文件',
      configLabel: '配置文件',
      configCreated: '刚按默认生成',
      configExisting: '已加载',
      conflictsLabel: '冲突',
      conflictsValue: '{pending} 待确认 · {superseded} 已替代',
      configDetail: '默认 {defaults} 项 · 未知 {unknown} 项',
      saveTitle: '保存会话',
      saveHint: '选一个会话。每次保存都生成新的 Markdown 文件，不会覆盖旧的。',
      searchTitle: '检索记忆',
      searchPlaceholder: '关键词、实体或主题',
      searchButton: '检索',
      searching: '检索中…',
      noMemory: '无可用记忆。',
      results: '{count} 条命中 · 扫描 {files} 个文件 / {entries} 条记忆 · {ms} ms',
      freshnessFresh: '新鲜',
      freshnessAging: '渐旧',
      freshnessStale: '过时',
      freshnessUnknown: '时间未知',
      freshnessAnomaly: '时间异常',
      loading: '加载中…',
      empty: '还没有会话。',
      truncated: '共 {total} 个，显示最近 {shown} 个',
      messages: '条消息',
      lastActive: '最后活动',
      confirmTitle: '将写入',
      confirmNote: '内容不出设备：摘要在本地抽取生成。',
      workConfirmNote: '逐字保存全部消息，diff 单独成条；体积大时自动分卷。',
      confirm: '保存记忆',
      modeChat: '聊天记忆',
      modeWork: '工作记忆',
      modeChatHint: '抽取摘要，会衰减',
      modeWorkHint: '逐字保存，自动分卷',
      volumes: '卷',
      diffs: '处变更',
      transferTitle: '导入 / 导出',
      exportAll: '导出全部',
      exporting: '导出中…',
      importFile: '导入文件',
      importing: '导入中…',
      importReport: '接受 {accepted} · 跳过 {skipped} · 冲突 {conflicts} · 拒绝 {rejected} · 失败 {failed}',
      exportDone: '已导出 {entries} 条',
      indexLabel: '启动包',
      indexValue: '{tokens} tokens · {entries} 条',
      maintainLabel: '整理记忆',
      maintaining: '整理中…',
      maintainResult: '重新加权 {reweighted} 条 · 回收 {purged} 条 · 改写 {rewritten} 个文件 · 索引 {indexTokens} tokens',
      conflictsTitle: '待确认冲突',
      acceptNew: '采用新值',
      keepOld: '保留旧值',
      noConflicts: '没有待确认的冲突。',
      resolvedOk: '已解决',
      proposalsTitle: '待确认提案',
      noProposals: '没有待确认的提案。',
      accept: '采纳',
      reject: '拒绝',
      workspaceLabel: '记忆库',
      settingsTitle: '设置',
      saveSettings: '保存设置',
      savingSettings: '保存中…',
      settingsSaved: '已保存',
      saving: '保存中…',
      cancel: '取消',
      resultOk: '已保存',
      resultFail: '保存失败',
      entries: '条目',
      summaryLabel: '摘要',
      conflicts: '冲突',
      carriedFrom: '承接自 {id}',
      reload: '刷新',
      note: '当前只做聊天记忆：一条摘要条目 + 文件级索引。工作记忆、检索、冲突与导入导出在后面。',
      hintChannel: '这个页面能不能连上插件宿主（连不上时按钮都不会动）',
      hintDir: '记忆 Markdown 文件实际存放的文件夹',
      hintConfig: '配置文件 _config.md，所有设置都存在这里',
      hintConflicts: '等你决定的记忆：模型提议或冲突，确认后才生效',
      hintIndex: '每一步都会带进模型的记忆索引，越短越省 token',
      hintWorkspace: '切换到另一个工作区的记忆库（切换后整个页面数据都变）',
      hintExport: '把全部记忆导出成一个可重新导入的 Markdown 文件',
      hintImport: '导入之前导出的 Markdown 文件（不会覆盖已有记忆）',
      hintMaintain: '重算权重、回收过期明细、合并重复条目、重建索引',
      hintRefresh: '从宿主重新读取一次数据',
      hintAccept: '采纳这条提议，正式成为长期记忆',
      hintReject: '拒绝这条提议；条目保留但标记为已弃用',
      settingsHint: '高级参数，默认值适合大多数人；把鼠标停在字段上能看到说明',
      version: 'v0.1.0',
    };

    const COLORS = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    let translate = (key) => (Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key);

    /**
     * 绑到 locale 服务后，取不到文案会返回空串——那样整块 UI 就只剩边框。
     * 所以任何情况下都回退到内置中文，绝不渲染空白。
     */
    function bindLocale(ctx) {
      const bound = ctx.locale.bind(NS);
      return (key) => {
        let value;
        try {
          value = bound(key);
        } catch {
          value = undefined;
        }
        if (value) return value;
        if (Object.prototype.hasOwnProperty.call(ZH, key)) return ZH[key];
        return key;
      };
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function shortTime(iso) {
      if (!iso) return '—';
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
      if (!match) return iso;
      return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
    }

    function useFetchJson(url, options) {
      const opts = options || {};
      const [state, setState] = React.useState({ loading: true });
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        if (!url) {
          setState({ loading: false, data: null });
          return undefined;
        }
        let alive = true;
        setState((previous) => ({ loading: true, data: previous.data }));
        const init = opts.method
          ? { method: opts.method, headers: { 'content-type': 'application/json' }, body: opts.body }
          : { headers: { accept: 'application/json' } };
        fetch(url, init)
          .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
          .then(({ ok, body }) => {
            if (!alive) return;
            setState({ loading: false, data: body, error: ok && body && body.ok === false ? (body.error || 'request failed') : undefined });
          })
          .catch((error) => {
            if (alive) setState({ loading: false, error: String((error && error.message) || error) });
          });
        return () => { alive = false; };
      }, [url, tick]);

      return { ...state, reload: () => setTick((value) => value + 1) };
    }


    const TUTORIAL = [
      ['这东西是什么', [
        '每次保存会把一个会话写成一份 Markdown，存在工作区的「记忆」文件夹里。',
        '下次开新会话时，插件会把一份很短的索引带进上下文，我就能想起之前的事。',
        '中文摘要和检索都在本机完成，不上传。',
        '聊天记忆会存两份：总结版 (ZJB) 进启动包；完整版 (full) 只在需要回查细节时读取。',
        '所以回忆起一件事的顺序是：先看要点 → 不够再搜原文，和人回想差不多。',
      ]],
      ['① 保存会话（最常用）', [
        '在「保存会话」列表里点一个会话。',
        '确认条会显示将写入的文件名、会话名、消息数。',
        '「文件夹」默认是会话名，可改成任何名字（改了就会新建文件夹）。',
        '选模式：聊天记忆＝抽取摘要、会衰减；工作记忆＝逐字原文、不衰减、自动分卷。',
        '点「保存记忆」，结果里会显示路径、条目数、摘要状态。',
      ]],
      ['② 检索', [
        '在「检索记忆」里输关键词（中文词会自动拆成二元组，所以「记忆的权重」也能搜到）。',
        '结果显示类型、时间、时效、得分与摘录；工作记忆命中会直接返回全文。',
        '命中 (full) 或工作记忆时返回的是原文，不是摘录，可以直接核对细节。',
        '没有结果显示「无可用记忆」——那是我真的没记过，不是坏了。',
      ]],
      ['③ 整理（已收起）', [
        '整理与归档按钮暂时从界面移除，保存时会自动重建索引。',
        '需要重算权重或回收明细时，叫我用接口跑一次即可。',
      ]],
      ['④ 导出提示词（重要）', [
        '保存记忆时会自动在同一个会话文件夹里生成提示词：聊天记忆是「提示词.md」，工作记忆是「工作流程提示词.md」。',
        '「下载提示词」先在保存会话里选一个会话，再点它，就会下载那个会话的提示词。',
        '提示词里会写明：索引里没有记忆时，去读同目录最新的 (ZJB) 总结版；还不够再读 (full) 完整版。',
        '用户只需要导入这一个提示词文件，其余记忆文件让 AI 自己去读。',
      ]],
      ['⑤ 提案 / 冲突', [
        '你说「记住…/以后都…/不要…」这类要求时，我会提议一条记忆；要你点「采纳」才生效。',
        '同一条记忆出现两种说法时进「冲突」，选「采用新值」或「保留旧值」；被替换的条目保留原文。',
      ]],
      ['文件都在哪', [
        '记忆根目录：页面顶部「记忆目录」那一行显示的就是。',
        '每个会话一个文件夹，文件名是保存时间（YYYY-MM-DD_HHmmss）。',
        '_系统/ 里是 _config.md（设置）、_index.md（索引缓存）、_audit.md（审计）；别删。',
        '「提案」和「导入」是两类特殊文件夹，放模型提议和外部导入的条目。',
      ]],
      ['文件名怎么区分', [
        '结尾 (ZJB) = 聊天记忆（总结版）：要点、增量、承接，进启动包。',
        '结尾 (full) = 同一会话的完整逐字版：每条消息原文，只供回查细节，不进启动包。',
        '不带后缀 = 工作记忆（逐字原文）；多卷时加 _2、_3。',
        '(diff) = 工作记忆里的代码变更：一个文件一条，正文是 @@ 差异块。',
        '同一秒重复保存会加序号：xxx(ZJB)_2.md、xxx(diff)_2.md。',
      ]],
      ['diff 怎么排查', [
        '打开 记忆/会话名/时间戳(diff).md，搜 - file_path: 看改了哪些文件。',
        '每条带 added/deleted 行数，正文是标准 diff hunk，可对照 git diff。',
        'diff 为空说明这次会话没有可记录的写入，见下一条。',
      ]],
      ['为什么 diff 有时是空的', [
        '只有我（模型）用文件写入/编辑工具改的文件才会被记录。',
        '命令行改的（Set-Content、git apply 等）不在工作区变更记录里。',
        '旧会话重新保存时，差异快照可能已被回收，只剩逐字原文。',
      ]],
      ['报错怎么办', [
        '页面全 404 / 工具消失 → 插件没激活；重启 DSH 一次。',
        '顶部状态行出现红色 → 看插件目录下 apply-error.log。',
        '文件写不进去 → 检查记忆目录是不是在沙箱允许的范围内。',
        '保存报「同名文件过多」→ 同一秒保存太频繁，等一秒再点。',
        '检索不到刚存的内容 → 点「整理记忆」重建索引，再搜一次。',
      ]],
    ];

    function MemoryIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3.25, y: 4.25, width: 17.5, height: 15.5, rx: 3.5, stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.45 }),
        h('path', { d: 'M7.5 9h9M7.5 12.5h9M7.5 16h5.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('circle', { cx: 17, cy: 16, r: 1.75, fill: 'currentColor' }),
      );
    }

    function Row(props) {
      return h(
        'div',
        {
          title: props.hint || undefined,
          style: {
            display: 'flex', alignItems: 'baseline', gap: 10,
            border: `1px solid ${COLORS.border}`, borderRadius: 10,
            background: COLORS.layer, padding: '10px 14px', fontSize: 12.5,
          },
        },
        props.dot ? h('span', {
          style: { width: 8, height: 8, borderRadius: '50%', background: props.dot, flex: '0 0 auto', transform: 'translateY(-1px)' },
        }) : null,
        h('span', { style: { color: COLORS.text, fontWeight: 600, whiteSpace: 'nowrap' } }, props.label),
        h('span', {
          style: { color: COLORS.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', unicodeBidi: 'plaintext' },
        }, props.primary),
        props.secondary ? h('span', {
          style: { color: COLORS.muted, opacity: 0.75, marginLeft: 'auto', whiteSpace: 'nowrap' },
        }, props.secondary) : null,
      );
    }

    function SessionRow(props) {
      const [hover, setHover] = React.useState(false);
      const active = props.active;
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex', flexDirection: 'column', gap: 4, width: '100%',
            textAlign: 'left', cursor: 'pointer', font: 'inherit',
            padding: '10px 12px', borderRadius: 9,
            border: `1px solid ${active ? COLORS.brand : COLORS.border}`,
            background: active ? COLORS.layer2 : hover ? COLORS.layer2 : 'transparent',
            transition: 'background 120ms ease',
          },
        },
        h('span', { style: { fontSize: 13, fontWeight: 600, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.title),
        h('span', { style: { fontSize: 11.5, color: COLORS.muted, display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('span', null, `${props.session.messageCount} ${translate('messages')}`),
          h('span', null, `${translate('lastActive')} ${shortTime(props.session.endsAt)}`),
          props.session.live ? h('span', { style: { color: COLORS.ok } }, 'live') : null,
        ),
      );
    }

    function MemoryPanel() {
      const t = translate;
      const host = useFetchJson('/memory/api/state');
      const sessions = useFetchJson('/memory/api/sessions');
      const [selected, setSelected] = React.useState(null);
      const [manualId, setManualId] = React.useState('');
      const [folderDraft, setFolderDraft] = React.useState(null);
      const [library, setLibrary] = React.useState({ loading: true, folders: [], error: '' });
      const [openFile, setOpenFile] = React.useState(null);
      const [picked, setPicked] = React.useState(() => new Set());
      const [deleting, setDeleting] = React.useState(false);
      const [expandedFolders, setExpandedFolders] = React.useState(() => new Set());
      const [saving, setSaving] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [submitted, setSubmitted] = React.useState('');
      const [mode, setMode] = React.useState('chat');
      const [transfer, setTransfer] = React.useState({ busy: '', report: null });

      // 挂载时读一次记忆库（loadLibrary 是函数声明，会提升）
      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const response = await fetch('/memory/api/library');
            const body = await response.json();
            if (!alive) return;
            setLibrary({
              loading: false,
              folders: body.folders || [],
              error: body.ok ? '' : String(body.error || `HTTP ${response.status}`),
            });
          } catch (error) {
            if (alive) setLibrary({ loading: false, folders: [], error: String((error && error.message) || error) });
          }
        })();
        return () => { alive = false; };
      }, []);

      const search = useFetchJson(submitted ? `/memory/api/search?q=${encodeURIComponent(submitted)}` : null);
      const conflicts = useFetchJson('/memory/api/conflicts');
      const proposals = useFetchJson('/memory/api/proposals');
      const workspaces = useFetchJson('/memory/api/workspaces');
      const settings = useFetchJson('/memory/api/settings');
      const [draft, setDraft] = React.useState(null);
      const [settingsBusy, setSettingsBusy] = React.useState(false);

      const settingsValues = draft || (settings.data && settings.data.values) || null;

      async function switchWorkspace(path) {
        try {
          const response = await fetch('/memory/api/workspace', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || 'switch failed');
          for (const hook of [workspaces, host, sessions, conflicts, proposals, settings]) hook.reload();
          setDraft(null);
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function saveSettings() {
        if (!draft || settingsBusy) return;
        setSettingsBusy(true);
        try {
          const patch = {};
          for (const key of ['summary_char_budget', 'startup_token_budget', 'full_weight_days', 'half_life_days', 'purge_after_days']) {
            if (draft[key] !== undefined) patch[key] = Number(draft[key]);
          }
          const response = await fetch('/memory/api/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || 'save failed');
          setDraft(null);
          for (const hook of [settings, host]) hook.reload();
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        } finally {
          setSettingsBusy(false);
        }
      }

      async function confirmProposal(id, action) {
        try {
          const response = await fetch('/memory/api/confirm', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [id], action }),
          });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || 'confirm failed');
          proposals.reload();
          conflicts.reload();
          host.reload();
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function resolveConflict(id, action) {
        try {
          const response = await fetch('/memory/api/resolve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, action }),
          });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || 'resolve failed');
          conflicts.reload();
          host.reload();
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }
      const FRESH_LABEL = {
        fresh: '新鲜',
        aging: '渐旧',
        stale: '过时',
        unknown: '时间未知',
        anomaly: '时间异常',
      };

      const effectiveId = selected || manualId.trim();
      const preview = useFetchJson(effectiveId ? `/memory/api/preview?sessionId=${encodeURIComponent(effectiveId)}` : null);

      const data = host.data;
      const list = (sessions.data && sessions.data.sessions) || [];
      const channelDot = host.error ? COLORS.error : data ? COLORS.ok : COLORS.idle;
      const channelPrimary = host.error ? '连接失败' : data ? '已连通' : '检测中…';

      async function save() {
        const targetId = selected || manualId.trim();
        if (!targetId || saving) return;
        setSaving(true);
        setResult(null);
        try {
          const response = await fetch('/memory/api/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: targetId, memoryClass: mode, folder: folderDraft || (preview.data ? preview.data.folder : undefined) }),
          });
          const body = await response.json();
          setResult(body);
          if (body && body.ok) host.reload();
        } catch (error) {
          setResult({ ok: false, error: String((error && error.message) || error) });
        } finally {
          setSaving(false);
        }
      }

      function choose(sessionId) {
        setSelected((current) => (current === sessionId ? null : sessionId));
        setResult(null);
        setFolderDraft(null);
      }

      async function exportAll() {
        if (transfer.busy) return;
        setTransfer({ busy: 'export', report: null });
        try {
          const response = await fetch('/memory/api/export?scope=all');
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || 'export failed');
          const blob = new Blob([body.text], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `dsh-memory-export-${String(body.exportedAt).replace(/[^0-9]/g, '').slice(0, 14)}.md`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          setTransfer({ busy: '', report: { ok: true, entries: body.entries } });
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function downloadPrompt() {
        if (transfer.busy) return;
        if (!selected) {
          setTransfer({ busy: '', report: { ok: false, error: '先在「保存会话」里选一个会话，再点下载提示词' } });
          return;
        }
        setTransfer({ busy: 'prompt', report: null });
        try {
          const response = await fetch(`/memory/api/prompt?sessionId=${encodeURIComponent(selected)}`);
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || '没有找到提示词');
          const file = body.files[0];
          const blob = new Blob([file.text], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = file.name.split('/').pop();
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          setTransfer({ busy: '', report: { ok: true, entries: body.files.length, prompt: file.name } });
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function emptyTrash() {
        if (transfer.busy) return;
        const typed = window.prompt('清空回收站会永久删除里面的文件。\n输入 清空 两个字确认：', '');
        if (typed === null || typed.trim() !== '清空') return;
        setTransfer({ busy: 'trash', report: null });
        try {
          const response = await fetch('/memory/api/trash/empty', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || '清空失败');
          setTransfer({ busy: '', report: { ok: true, trashed: body.removed } });
          await loadLibrary();
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function rebuildPrompts() {
        if (transfer.busy) return;
        setTransfer({ busy: 'rebuild', report: null });
        try {
          const response = await fetch('/memory/api/prompt/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || '补生成失败');
          setTransfer({ busy: '', report: { ok: true, rebuilt: (body.written || []).length } });
          await loadLibrary();
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function pruneEmpty() {
        if (transfer.busy) return;
        setTransfer({ busy: 'prune', report: null });
        try {
          const response = await fetch('/memory/api/prune-empty', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || '清理失败');
          setTransfer({ busy: '', report: { ok: true, pruned: (body.removed || []).length } });
          await loadLibrary();
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function maintain() {
        if (transfer.busy) return;
        setTransfer({ busy: 'maintain', report: null });
        try {
          const response = await fetch('/memory/api/maintain', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          const body = await response.json();
          setTransfer({ busy: '', report: body.ok ? { ok: true, maintain: body } : { ok: false, error: body.error } });
          if (body.ok) { host.reload(); sessions.reload(); }
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function archiveLoose() {
        if (transfer.busy) return;
        setTransfer({ busy: 'archive', report: null });
        try {
          const response = await fetch('/memory/api/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || 'archive failed');
          setTransfer({ busy: '', report: { ok: true, archive: body } });
          host.reload();
          sessions.reload();
        } catch (error) {
          setTransfer({ busy: '', report: { ok: false, error: String((error && error.message) || error) } });
        }
      }

      async function loadLibrary() {
        setLibrary((prev) => ({ ...prev, loading: true, error: '' }));
        try {
          const response = await fetch('/memory/api/library');
          const body = await response.json();
          setLibrary({ loading: false, folders: body.folders || [], error: body.ok ? '' : String(body.error || '读取失败') });
        } catch (error) {
          setLibrary({ loading: false, folders: [], error: String((error && error.message) || error) });
        }
      }

      async function openMemoryFile(filePath) {
        if (openFile && openFile.path === filePath) {
          setOpenFile(null);
          return;
        }
        setOpenFile({ path: filePath, loading: true, entries: [] });
        try {
          const response = await fetch(`/memory/api/read?path=${encodeURIComponent(filePath)}`);
          const body = await response.json();
          setOpenFile({ path: filePath, loading: false, entries: body.entries || [], error: body.ok ? '' : String(body.error || '') });
        } catch (error) {
          setOpenFile({ path: filePath, loading: false, entries: [], error: String((error && error.message) || error) });
        }
      }

      function togglePick(filePath) {
        setPicked((previous) => {
          const next = new Set(previous);
          if (next.has(filePath)) next.delete(filePath);
          else next.add(filePath);
          return next;
        });
      }

      async function deletePicked() {
        if (picked.size === 0 || deleting) return;
        const list = [...picked];
        const shown = list.slice(0, 5).join('\n') + (list.length > 5 ? `\n…共 ${list.length} 个` : '');
        const typed = window.prompt(
          `将把 ${list.length} 个文件移到「记忆/_回收站」，可再清空回收站彻底删除。\n\n${shown}\n\n输入 删除 两个字确认：`,
          '',
        );
        if (typed === null || typed.trim() !== '删除') {
          setTransfer((previous) => ({ ...previous, report: { ok: false, error: '已取消：需要输入「删除」两个字才执行' } }));
          return;
        }
        setDeleting(true);
        try {
          const response = await fetch('/memory/api/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paths: list, confirmAll: list.length > 10 }),
          });
          const body = await response.json();
          if (!body.ok) throw new Error(body.error || '删除失败');
          setPicked(new Set());
          setOpenFile(null);
          await loadLibrary();
          if (window.host && typeof window.host.reload === 'function') window.host.reload();
        } catch (error) {
          setLibrary((prev) => ({ ...prev, error: String((error && error.message) || error) }));
        } finally {
          setDeleting(false);
        }
      }

      const smallButton = {
        cursor: 'pointer', font: 'inherit', fontSize: 12.5, padding: '6px 14px',
        borderRadius: 8, border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text,
      };
      return h(
        'div',
        {
          style: {
            height: '100%', overflow: 'auto', padding: '28px 32px 48px',
            color: COLORS.text, boxSizing: 'border-box',
          },
        },
        h('div', { style: { display: 'flex', gap: 24, alignItems: 'flex-start', maxWidth: 1360, margin: '0 auto', flexWrap: 'wrap' } },
          h('aside', {
            style: {
              flex: '0 0 300px', minWidth: 260, position: 'sticky', top: 0,
              maxHeight: 'calc(100vh - 120px)', overflow: 'auto',
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('div', { style: { fontSize: 13.5, fontWeight: 600 } }, '使用教程'),
            ...TUTORIAL.map(([title, lines]) => h('div', { key: title, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, color: COLORS.text } }, title),
              ...lines.map((line, index) => h('div', {
                key: index,
                style: { fontSize: 11.5, lineHeight: 1.6, color: COLORS.muted },
              }, `· ${line}`)),
            )),
          ),
          h('div', { style: { flex: '1 1 620px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 } },

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            h('div', {
              style: {
                width: 34, height: 34, borderRadius: 10, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                background: COLORS.layer2, color: COLORS.brand, flex: '0 0 auto',
              },
            }, h(MemoryIcon, { size: 19 })),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('h1', { style: { margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: 0.2 } }, '记忆'),
              h('span', {
                style: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${COLORS.border}`, color: COLORS.muted },
              }, '可保存'),
            ),
          ),
          h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.7, color: COLORS.muted } }, '长期记忆插件 · 本地 Markdown · 不向云端发送任何内容'),

          h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('div', {
              style: {
                display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5, lineHeight: 1.65,
                color: COLORS.muted, borderBottom: `1px dashed ${COLORS.border}`, paddingBottom: 8,
              },
            },
              h('div', { style: { fontWeight: 600, color: COLORS.text } }, '导出'),
              h('div', null, '① 在下面「保存会话」里选一个会话 → ② 点「保存记忆」 → ③ 回到「③ 导出提示词」点「下载提示词」。'),
              h('div', null, '保存时会自动在 记忆/<会话名>/ 里生成 提示词.md（聊天记忆）或 工作流程提示词.md（工作记忆）。'),
              h('div', { style: { fontWeight: 600, color: COLORS.text, marginTop: 6 } }, '导入'),
              h('div', null, '① 打开工作区里的「记忆」文件夹 → ② 找到名字和这个会话一致的子文件夹 → ③ 找到 提示词.md（聊天记忆）或 工作流程提示词.md（工作记忆）。'),
              h('div', null, '④ **不用打开它**，直接右键复制这个文件 → ⑤ 粘贴到新会话的聊天框 → ⑥ 发送消息。'),
              h('div', null, '只需要这一个文件；(ZJB) 总结版、(full) 完整版、(diff) 变更、逐字卷都不用动，提示词里已经让 AI 自己去读。'),
            ),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, '已保存的记忆'),
              h('span', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('button', {
                  type: 'button', onClick: loadLibrary, style: smallButton, title: '重新扫描记忆目录',
                }, library.loading ? '读取中…' : '刷新列表'),
                h('button', {
                  type: 'button',
                  disabled: deleting || library.folders.length === 0,
                  onClick: () => {
                    const all = library.folders.flatMap((group) => group.files.map((file) => file.path));
                    const everything = all.length > 0 && all.every((item) => picked.has(item));
                    setPicked(everything ? new Set() : new Set(all));
                  },
                  style: smallButton,
                  title: '全选 / 取消全选当前列表里的记忆文件',
                }, library.folders.length > 0 && library.folders.flatMap((g) => g.files).every((f) => picked.has(f.path)) ? '取消全选' : '全选'),
                h('button', {
                  type: 'button',
                  disabled: deleting || picked.size === 0,
                  onClick: deletePicked,
                  style: {
                    ...smallButton,
                    borderColor: picked.size === 0 ? COLORS.border : '#e06c6c',
                    color: picked.size === 0 ? COLORS.muted : '#e06c6c',
                  },
                  title: '删除勾选的记忆文件（会二次确认，删掉后不可恢复）',
                }, deleting ? '删除中…' : `移到回收站${picked.size ? ` (${picked.size})` : ''}`),
                h('button', {
                  type: 'button', onClick: emptyTrash, disabled: Boolean(transfer.busy), style: smallButton,
                  title: '永久删除 _回收站 里的文件（这一步之后不可恢复）',
                }, transfer.busy === 'trash' ? '清空中…' : '清空回收站'),
              ),
            ),
            library.error
              ? h('div', { style: { fontSize: 12, color: '#e06c6c' } }, `读取失败：${library.error}`)
              : library.folders.length === 0
                ? h('div', { style: { fontSize: 12, color: COLORS.muted } }, '还没有保存过记忆。先在下面「保存会话」里保存一个。')
                : library.folders.map((group) => h('div', {
                    key: group.folder, style: { display: 'flex', flexDirection: 'column', gap: 4 },
                  },
                    h('button', {
                      type: 'button',
                      onClick: () => setExpandedFolders((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.folder)) next.delete(group.folder);
                        else next.add(group.folder);
                        return next;
                      }),
                      title: '展开 / 收起这个文件夹',
                      style: {
                        cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 600, textAlign: 'left',
                        marginTop: 4, padding: '3px 6px', borderRadius: 6, display: 'flex', gap: 6, alignItems: 'center',
                        border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text,
                      },
                    },
                      h('span', { style: { width: 10, display: 'inline-block' } }, expandedFolders.has(group.folder) ? '▾' : '▸'),
                      h('span', null, `${group.folder} · ${group.count} 个文件`),
                    ),
                    ...(expandedFolders.has(group.folder) ? group.files.map((file) => h('div', { key: file.path, style: { display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 14 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        h('input', {
                          type: 'checkbox',
                          checked: picked.has(file.path),
                          onChange: () => togglePick(file.path),
                          title: '勾选后可批量删除',
                          style: { flex: '0 0 auto', cursor: 'pointer', width: 13, height: 13, accentColor: '#e06c6c' },
                        }),
                      h('button', {
                        type: 'button',
                        onClick: () => openMemoryFile(file.path),
                        title: '点开查看这个文件里的条目',
                        style: {
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                          font: 'inherit', fontSize: 11.5, textAlign: 'left', cursor: 'pointer',
                          padding: '5px 8px', borderRadius: 8, flex: 1, minWidth: 0,
                          border: `1px solid ${openFile && openFile.path === file.path ? COLORS.brand : COLORS.border}`,
                          background: 'transparent', color: COLORS.text,
                        },
                      },
                        h('span', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 } },
                          h('span', {
                            style: {
                              flex: '0 0 auto', fontSize: 10, padding: '0 5px', borderRadius: 4,
                              border: `1px solid ${COLORS.border}`, color: COLORS.muted,
                            },
                          }, file.tag),
                          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file.name),
                        ),
                        h('span', { style: { flex: '0 0 auto', fontSize: 11, color: COLORS.muted } }, `${file.entries} 条 · ${formatBytes(file.size)}`),
                      )),
                      openFile && openFile.path === file.path
                        ? h('div', {
                            style: {
                              display: 'flex', flexDirection: 'column', gap: 6, margin: '2px 0 6px 12px',
                              paddingLeft: 10, borderLeft: `2px solid ${COLORS.border}`,
                            },
                          },
                            openFile.loading
                              ? h('div', { style: { fontSize: 11.5, color: COLORS.muted } }, '读取中…')
                              : openFile.error
                                ? h('div', { style: { fontSize: 11.5, color: '#e06c6c' } }, openFile.error)
                                : openFile.entries.map((entry) => h('div', { key: entry.id, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                                    h('div', { style: { fontSize: 11.5, fontWeight: 600 } }, `${entry.id} · ${entry.type || '-'}`),
                                    h('div', { style: { fontSize: 11, color: COLORS.muted, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' } },
                                      (entry.body || '').slice(0, 600)),
                                  )),
                          )
                        : null,
                    )) : []),
                  )),
          ),
          h('div', { style: { display: 'grid', gap: 8 } },
            h(Row, { hint: '这个页面能不能连上插件宿主（连不上时按钮都不会动）', label: '宿主通道', primary: channelPrimary, secondary: data ? `pid ${data.pid} · ${data.version}` : '', dot: channelDot }),
            data ? h(Row, {
              hint: '记忆 Markdown 文件实际存放的文件夹',
              label: '记忆目录',
              primary: data.memoryRoot,
              secondary: `${data.fileCount} ${'个文件'} · ${formatBytes(data.bytes)}`,
            }) : null,
            data ? h(Row, {
              hint: '配置文件 _config.md，所有设置都存在这里',
              label: '配置文件',
              primary: data.config.created ? '刚按默认生成' : '已加载',
              secondary: fill('默认 {defaults} 项 · 未知 {unknown} 项', { defaults: data.config.defaultsUsed, unknown: data.config.unknownKeys.length }),
            }) : null,
            workspaces.data ? h(Row, {
            hint: '切换到另一个工作区的记忆库（切换后整个页面数据都变）',
            label: '记忆库',
            primary: h('select', {
              value: workspaces.data.active,
              onChange: (event) => switchWorkspace(event.target.value),
              style: {
                font: 'inherit', fontSize: 12.5, padding: '3px 8px', borderRadius: 6,
                border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text,
              },
            }, workspaces.data.workspaces.map((ws) => h('option', {
              key: ws.path,
              value: ws.path,
            }, `${ws.title}${ws.hasMemory ? ` · ${ws.fileCount}` : ''}`))),
            secondary: workspaces.data.workspaces.length > 1 ? `${workspaces.data.workspaces.length} 个工作区` : '',
          }) : null,

          data && data.conflicts ? h(Row, {
              hint: '等你决定的记忆：模型提议或冲突，确认后才生效',
              label: '冲突',
              primary: fill('{pending} 待确认 · {superseded} 已替代', { pending: data.conflicts.pending, superseded: data.conflicts.superseded }),
              secondary: data.conflicts.conflictBlocks > 0 ? `${data.conflicts.conflictBlocks} [!conflict]` : '',
            }) : null,
            data && data.index ? h(Row, {
              hint: '每一步都会带进模型的记忆索引，越短越省 token',
              label: '启动包',
              primary: data.index.exists ? fill('{tokens} tokens · {entries} 条', { tokens: data.index.tokens, entries: data.index.entries }) : '—',
              secondary: data.index.generatedAt ? shortTime(data.index.generatedAt) : '',
            }) : null,
          ),

          h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, '① 检索记忆'),
            h('div', { style: { fontSize: 11.5, color: COLORS.muted } }, '在已保存的记忆里查关键词；没有结果就是「无可用记忆」，不会编造。'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                type: 'search',
                value: query,
                placeholder: '关键词、实体或主题',
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') setSubmitted(query.trim()); },
                style: {
                  flex: '1 1 auto', font: 'inherit', fontSize: 12.5, padding: '7px 10px',
                  borderRadius: 8, border: `1px solid ${COLORS.border}`,
                  background: COLORS.layer2, color: COLORS.text, outline: 'none',
                },
              }),
              h('button', {
                type: 'button',
                onClick: () => setSubmitted(query.trim()),
                disabled: search.loading,
                style: {
                  cursor: 'pointer', font: 'inherit', fontSize: 12.5, padding: '7px 14px',
                  borderRadius: 8, border: `1px solid ${COLORS.border}`,
                  background: 'transparent', color: COLORS.text,
                },
              }, search.loading ? '检索中…' : '检索'),
            ),

            search.data && search.data.hits ? h('div', { style: { fontSize: 11.5, color: COLORS.muted } },
              fill('{count} 条命中 · 扫描 {files} 个文件 / {entries} 条记忆 · {ms} ms', {
                count: search.data.hits.length,
                files: search.data.scanned ? search.data.scanned.files : 0,
                entries: search.data.scanned ? search.data.scanned.entries : 0,
                ms: search.data.tookMs ?? 0,
              })) : null,

            search.data
              ? (search.data.hits && search.data.hits.length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      search.data.hits.map((hit) => h('div', {
                        key: `${hit.file}:${hit.id}`,
                        style: {
                          border: `1px solid ${COLORS.border}`, borderRadius: 9,
                          background: COLORS.layer2, padding: '9px 12px',
                          display: 'flex', flexDirection: 'column', gap: 4,
                        },
                      },
                        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                          h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, hit.title),
                          h('span', { style: { fontSize: 11, color: COLORS.muted } },
                            `${hit.type} · ${shortTime(hit.eventTime)} · ${FRESH_LABEL[hit.freshness] || hit.freshness} · ${hit.score}`),
                        ),
                        h('div', { style: { fontSize: 12, color: COLORS.muted, lineHeight: 1.65 } }, hit.snippet),
                        h('div', { style: { fontSize: 10.5, color: COLORS.muted, opacity: 0.7 } }, `${hit.file} · ${hit.id}`),
                      )),
                    )
                  : h('div', { style: { fontSize: 12.5, color: COLORS.muted, padding: '4px 2px' } }, '无可用记忆。'))
              : null,
          ),

          h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
              h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, '② 保存会话'),
              h('span', { style: { fontSize: 12, color: COLORS.muted } },
                sessions.data ? fill('共 {total} 个，显示最近 {shown} 个', { shown: list.length, total: sessions.data.total }) : ''),
            ),
            h('div', { style: { fontSize: 12, color: COLORS.muted, lineHeight: 1.6 } }, '选一个会话。每次保存都生成新的 Markdown 文件，不会覆盖旧的。'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, color: COLORS.muted, flexWrap: 'wrap' } },
              h('span', null, '或粘贴会话 ID'),
              h('input', {
                value: manualId,
                onChange: (event) => setManualId(event.target.value),
                placeholder: 'session-xxxxxxxx-…',
                title: '会话列表取不到时，直接从侧边栏复制会话 ID 粘进来',
                style: {
                  font: 'inherit', fontSize: 11.5, padding: '3px 8px', borderRadius: 6, width: 280,
                  border: `1px solid ${COLORS.border}`, background: COLORS.layer, color: COLORS.text,
                },
              }),
            ),

            sessions.loading
              ? h('div', { style: { fontSize: 12.5, color: COLORS.muted, padding: '10px 2px' } }, '加载中…')
              : list.length === 0
                ? h('div', { style: { fontSize: 12.5, color: COLORS.muted, padding: '10px 2px' } }, '还没有会话。')
                : h('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflow: 'auto', paddingRight: 4 },
                  },
                    list.map((session) => h(SessionRow, {
                      key: session.sessionId,
                      session,
                      title: session.title,
                      active: selected === session.sessionId,
                      onClick: () => choose(session.sessionId),
                    })),
                  ),
          ),

          settingsValues ? h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
              h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, '④ 设置'),
              h('span', { style: { fontSize: 11.5, color: COLORS.muted } }, settings.data ? settings.data.memoryRoot : ''),
            ),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 } },
              [
                ['summary_char_budget', '摘要长度上限', '每条会话摘要最多这么多字符；越大越详细，也越费 token。默认 600。'],
                ['startup_token_budget', '启动包预算', '每轮自动带进模型的记忆索引上限（tokens）。默认 800。'],
                ['full_weight_days', '满权天数', '记忆在这段时间内权重最高、最优先被载入。默认 20 天。'],
                ['half_life_days', '半衰期', '超过满权期后权重衰减的速度（天）；越大淡得越慢。默认 30。'],
                ['purge_after_days', '明细回收天数', '超过后清掉「增量」明细，只留要点与源文件指针。默认 20 天。'],
              ].map(([key, label, hint]) => h('label', {
                key,
                title: hint,
                style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5, color: COLORS.muted },
              },
                h('span', { style: { fontSize: 12.5, color: COLORS.text } }, label),
                h('span', { style: { fontSize: 10.5, opacity: 0.7 } }, key),
                h('input', {
                  type: 'number',
                  title: hint,
                  value: settingsValues[key] ?? '',
                  onChange: (event) => setDraft({ ...settingsValues, [key]: event.target.value }),
                  style: {
                    font: 'inherit', fontSize: 12.5, padding: '5px 8px', borderRadius: 6,
                    border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text,
                  },
                }),
              )),
            ),
            h('div', { style: { fontSize: 11.5, color: COLORS.muted } }, '高级参数，默认值适合大多数人；把鼠标停在字段上能看到说明'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', {
                type: 'button', onClick: saveSettings, disabled: !draft || settingsBusy, style: smallButton,
              }, settingsBusy ? '保存中…' : '保存设置'),
              draft ? h('span', { style: { fontSize: 11.5, color: COLORS.muted } }, '●') : null,
            ),
          ) : null,

          proposals.data ? h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, '⑤ 待确认提案'),
            h('div', { style: { fontSize: 11.5, color: COLORS.muted } }, '模型从你的原话里提议的长期记忆，采纳后才会生效；拒绝只是标记弃用，不删内容。'),
            proposals.data.total === 0
              ? h('div', { style: { fontSize: 12.5, color: COLORS.muted } }, '没有待确认的提案。')
              : proposals.data.proposals.map((item) => h('div', {
                  key: item.id,
                  style: {
                    border: `1px solid ${COLORS.border}`, borderRadius: 9, background: COLORS.layer2,
                    padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
                  },
                },
                  h('div', { style: { fontSize: 12, color: COLORS.muted } }, `${item.kind} · ${shortTime(item.eventTime)}`),
                  h('div', { style: { fontSize: 12.5, lineHeight: 1.65 } }, item.value),
                  h('div', { style: { display: 'flex', gap: 8 } },
                    h('button', {
                      type: 'button', onClick: () => confirmProposal(item.id, 'accept'), style: smallButton, title: '采纳这条提议，正式成为长期记忆',
                    }, '采纳'),
                    h('button', {
                      type: 'button', onClick: () => confirmProposal(item.id, 'reject'), style: smallButton, title: '拒绝这条提议；条目保留但标记为已弃用',
                    }, '拒绝'),
                  ),
                )),
          ) : null,

          conflicts.data ? h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, '⑥ 待确认冲突'),
            h('div', { style: { fontSize: 11.5, color: COLORS.muted } }, '同一类记忆出现两种说法，需要你选一个；选新值会把旧条目标记为「已被取代」，原文保留。'),
            conflicts.data.total === 0
              ? h('div', { style: { fontSize: 12.5, color: COLORS.muted } }, '没有待确认的冲突。')
              : conflicts.data.pending.map((item) => h('div', {
                  key: item.id,
                  style: {
                    border: `1px solid ${COLORS.border}`, borderRadius: 9, background: COLORS.layer2,
                    padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
                  },
                },
                  h('div', { style: { fontSize: 12, color: COLORS.muted } }, `${item.kindType} · ${item.kind} · ${shortTime(item.eventTime)}`),
                  h('div', { style: { fontSize: 12.5, lineHeight: 1.65 } },
                    h('div', { style: { opacity: 0.7 } }, `旧：${item.oldValue}`),
                    h('div', { style: { color: COLORS.text, fontWeight: 600 } }, `新：${item.newValue}`),
                  ),
                  h('div', { style: { display: 'flex', gap: 8 } },
                    h('button', {
                      type: 'button', onClick: () => resolveConflict(item.id, 'accept_new'), style: smallButton,
                    }, '采用新值'),
                    h('button', {
                      type: 'button', onClick: () => resolveConflict(item.id, 'keep_old'), style: smallButton,
                    }, '保留旧值'),
                  ),
                )),
          ) : null,

          h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 12, background: COLORS.layer,
              padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
            },
          },
            h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, '③ 导出提示词'),
            h('div', { style: { fontSize: 11.5, color: COLORS.muted } }, '保存记忆时会自动生成提示词；这里下载选中会话的那一份，导入它就能让 AI 自己去找同目录的记忆。'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', {
                type: 'button', onClick: downloadPrompt, disabled: Boolean(transfer.busy),
                style: smallButton,
                title: '下载选中会话的记忆恢复提示词：导入这一个文件，AI 就会按它去读同目录的总结版与完整版',
              }, transfer.busy === 'prompt' ? '生成中…' : '下载提示词'),
              h('button', {
                type: 'button', onClick: rebuildPrompts, disabled: Boolean(transfer.busy), style: smallButton,
                title: '给所有历史会话文件夹补生成提示词（老记忆保存时还没有这个功能）',
              }, transfer.busy === 'rebuild' ? '补生成中…' : '补生成提示词'),
              h('button', {
                type: 'button', onClick: maintain, disabled: Boolean(transfer.busy), style: smallButton,
                title: '重算权重、回收超过 20 天的明细、合并重复条目、重建索引',
              }, transfer.busy === 'maintain' ? '整理中…' : '整理记忆'),
              h('button', {
                type: 'button', onClick: archiveLoose, disabled: Boolean(transfer.busy), style: smallButton,
                title: '把根目录里散落的记忆文件按会话名移动进各自文件夹，不覆盖、重名加序号',
              }, transfer.busy === 'archive' ? '归档中…' : '按会话归档'),
              h('button', {
                type: 'button', onClick: pruneEmpty, disabled: Boolean(transfer.busy), style: smallButton,
                title: '删掉里面已经没有任何文件的空文件夹',
              }, transfer.busy === 'prune' ? '清理中…' : '清理空文件夹'),
            ),
            transfer.report
              ? h('div', {
                  style: {
                    fontSize: 12, lineHeight: 1.7,
                    color: transfer.report.ok ? COLORS.muted : COLORS.error,
                  },
                },
                  transfer.report.ok
                    ? (transfer.report.maintain
                        ? `整理完成：重算 ${transfer.report.maintain.reweighted} · 回收 ${transfer.report.maintain.purged} · 去重 ${transfer.report.maintain.deduped}`
                        : transfer.report.archive
                          ? `已归档 ${transfer.report.archive.moved} 个文件`
                          : transfer.report.rebuilt !== undefined
                            ? `已补生成 ${transfer.report.rebuilt} 份提示词`
                            : transfer.report.trashed !== undefined
                            ? `已清空回收站：${transfer.report.trashed} 个文件`
                          : transfer.report.pruned !== undefined
                              ? `已清理 ${transfer.report.pruned} 个空文件夹`
                              : transfer.report.prompt
                                ? `已下载 ${transfer.report.prompt}`
                                : '完成')
                    : String(transfer.report.error || ''),
                )
              : null,
          ),

          selected ? h('div', {
            style: {
              border: `1px solid ${COLORS.brand}`, borderRadius: 12, background: COLORS.layer2,
              padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 12, color: COLORS.muted } }, '将写入'),
              h('code', {
                style: { fontSize: 12.5, color: COLORS.text, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
              }, preview.data ? preview.data.fileName : '…'),
              h('span', { style: { fontSize: 12, color: COLORS.muted } },
                preview.data ? `${preview.data.sessionName} · ${preview.data.messageCount} ${'条消息'}` : ''),
            ),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: 11.5, color: COLORS.muted } }, '文件夹'),
              h('input', {
                value: folderDraft ?? (preview.data ? preview.data.folder : ''),
                onChange: (event) => setFolderDraft(event.target.value),
                placeholder: '例如 作业1',
                list: 'dsh-memory-folders',
                title: '记忆文件会存到 记忆/这个文件夹/ 下面；可以写新的名字直接创建',
                style: {
                  font: 'inherit', fontSize: 12, padding: '4px 8px', borderRadius: 6, width: 180,
                  border: `1px solid ${COLORS.border}`, background: COLORS.layer, color: COLORS.text,
                },
              }),
              h('datalist', { id: 'dsh-memory-folders' },
                (preview.data && preview.data.folders ? preview.data.folders : []).map((name) => h('option', { key: name, value: name }))),
            ),
            h('div', { style: { fontSize: 11.5, color: COLORS.muted } }, mode === 'work' ? '逐字保存全部消息，diff 单独成条；体积大时自动分卷。' : '内容不出设备：摘要在本地抽取生成。'),
            h('div', { style: { display: 'flex', gap: 8 } },
              ['chat', 'work'].map((value) => h('button', {
                key: value,
                type: 'button',
                onClick: () => setMode(value),
                style: {
                  cursor: 'pointer', font: 'inherit', textAlign: 'left',
                  padding: '6px 12px', borderRadius: 8,
                  border: `1px solid ${mode === value ? COLORS.brand : COLORS.border}`,
                  background: mode === value ? COLORS.layer : 'transparent',
                  color: COLORS.text, display: 'flex', flexDirection: 'column', gap: 2,
                },
              },
                h('span', { style: { fontSize: 12, fontWeight: 600 } }, value === 'chat' ? '聊天记忆' : '工作记忆'),
                h('span', { style: { fontSize: 10.5, color: COLORS.muted } }, value === 'chat' ? '抽取摘要，会衰减' : '逐字保存，自动分卷'),
              )),
            ),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('button', {
                type: 'button', onClick: save, disabled: saving || !preview.data,
                style: {
                  cursor: saving ? 'default' : 'pointer', font: 'inherit', fontSize: 12.5,
                  padding: '6px 14px', borderRadius: 8, border: 'none',
                  background: COLORS.brand, color: 'var(--dsw-alias-bg-base, #101010)', opacity: saving ? 0.7 : 1,
                },
              }, saving ? '保存中…' : '保存记忆'),
              h('button', {
                type: 'button', onClick: () => setSelected(null),
                style: {
                  cursor: 'pointer', font: 'inherit', fontSize: 12.5, padding: '6px 14px',
                  borderRadius: 8, border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text,
                },
              }, '取消'),
            ),
          ) : null,

          result ? h('div', {
            style: {
              border: `1px solid ${result.ok ? COLORS.border : COLORS.error}`,
              borderRadius: 12, background: COLORS.layer, padding: '12px 16px',
              display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 } },
              h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: result.ok ? COLORS.ok : COLORS.error } }),
              h('span', null, result.ok ? '已保存' : '保存失败'),
            ),
            result.ok
              ? h('div', { style: { color: COLORS.muted, lineHeight: 1.7 } },
                  h('div', null, result.files && result.files.length > 1
                    ? result.files.map((file) => file.name).join(' · ')
                    : result.path),
                  h('div', null, `${result.entries} ${'条目'} · ` +
                    (result.memoryClass === 'work'
                      ? `${result.volumes} ${'卷'} · ${result.diffs} ${'处变更'}`
                      : `${'摘要'} ${result.summaryStatus}`) +
                    ` · ${'冲突'} ${result.conflicts}` +
                    (result.carriedFrom ? ` · ${fill('承接自 {id}', { id: result.carriedFrom })}` : '')),
                )
              : h('div', { style: { color: COLORS.error } }, String(result.error || '')),
          ) : null,

          h('div', {
            style: {
              border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.layer2,
              padding: '12px 14px', fontSize: 12.5, lineHeight: 1.75, color: COLORS.muted,
            },
          }, '记忆保存在工作区下的「记忆」文件夹里：每次保存生成一个 Markdown 文件，不覆盖旧的；检索、冲突、导入导出都在本页操作。当前版本 v0.1.0。'),

          h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: COLORS.muted, opacity: 0.8 } },
            h('span', null, 'v0.1.0'),
            h('button', {
              type: 'button',
              onClick: () => { sessions.reload(); host.reload(); },
              style: {
                cursor: 'pointer', font: 'inherit', fontSize: 11.5, padding: '2px 8px',
                borderRadius: 6, border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.muted,
              },
            }, '刷新'),
          ),
        ),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-memory: dictionaries');
      // 界面文案一律走内置中文表：locale 绑定取不到值时会返回空串，
      // 那样卡片只剩边框、按钮变成空方块。宁可固定中文，也不要空白。

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, MemoryPanel));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 0.5,
        locale: NS,
        label: () => translate('panel'),
      }, MemoryIcon));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
