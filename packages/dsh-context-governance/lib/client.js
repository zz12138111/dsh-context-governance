/**
 * dsh-context-governance · 浏览器半侧（1.1.0 D2，入口形态 A + U1-U12 交互标准）
 *
 * 格式：手写 `window.__ModuleLoader__.load({ id, factory })`（与宿主已装插件 cost-meter / dsh-context 同形；
 * 本仓不引打包器，此文件即产物，审核按本注释与文件本体核对）。
 * id：`dsh-context-governance`（= 宿主 settings 命名空间 = Cordis 条目 id，见 cordis.patch.yml）。
 *
 * 入口：`conversation.composer.dock`（chip `压 65%`）/ `conversation.input.overlay`（气泡）/ `settings.section`（设置页卡片）。
 * 依赖共享模块（factory 的 require 形参解析）：`react`；注入客户端服务：`slots`/`locale`/`configForms`。
 * 只读数据：同源 `GET /context-governance/policy-snapshot`（字段含 at/source/sessionOverride/effectiveAt/native/defaultAt）。
 * 写：chip/气泡 = 本会话层（`POST /context-governance/session-policy`，落 session:A2，重启保留）；
 *   设置页 = 全局 plugin 层（宿主 configForms）。C11③：主入口绝不写 plugin/project。
 * C8/C11/C32 文案：生命周期随 source 派生；四层标签用固定表（与 src/ui-labels.js 同字面，禁别名）。
 * U1-U12：打开聚焦并全选、层级/大号数值、输入清洗、失焦或保存才校验、成功「已保存」1.5s、恢复默认只填值、Esc/外点/再点 chip 关闭并重置、
 *   不可用态（读取中/暂不可用/重试、保存禁用）、深浅色用 `var(--…, fallback)`、只用内联样式、禁 alert/prompt/confirm 与滑块。
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-governance',
  factory: (require) => {
    console.info('[context-governance] client module materialized');
    const react = require('react');

    const ENTRY_ID = 'dsh-context-governance';
    const SNAPSHOT_PATH = '/context-governance/policy-snapshot';
    const SESSION_POLICY_PATH = '/context-governance/session-policy';
    const PLUGIN_POLICY_PATH = '/context-governance/plugin-policy';
    const AT_MIN = 0.2;
    const LOW_THRESHOLD_ACK_MIN = 0.3;
    const PROJECT_AT_MIN = 0.45;
    const USABLE_MARGIN = 0.02;
    const FALLBACK_DEFAULT_AT = 0.6;
    const LABELS = {
      zh: {
        sectionLabel: '上下文治理', title: '压缩触发阈值', current: '当前生效', source: '来源层', when: '生效时点',
        writeLayer: '本次修改写入：全局（plugin 层，影响所有会话）',
        writeLayerSession: '本次修改写入：本会话（session:A2，重启保留）',
        writeLayerGlobal: '本次修改写入：全局（plugin 层，影响所有会话）',
        overrideNote: '本会话已自定义，全局修改不影响本会话（清除用 /cg set reset）',
        noSession: '无会话标识：会话级保存不可用（不会退化为全局写入）',
        percent: '触发百分比', unit: '%', save: '保存到本会话', saveGlobal: '保存为全局', saving: '保存中…',
        saved: '已保存', restore: '恢复默认', retry: '重试', loading: '读取中…', unavailable: '暂不可用', invalid: '输入无效',
        openSettings: '打开设置页', chipUnknown: '压 —', chip: (t) => `压 ${t}`,
      },
      en: {
        sectionLabel: 'Context governance', title: 'Compaction threshold', current: 'Effective', source: 'Source layer', when: 'Takes effect',
        writeLayer: 'Writes to: global (plugin layer, affects all sessions)',
        writeLayerSession: 'Writes to: this session (session:A2, survives restart)',
        writeLayerGlobal: 'Writes to: global (plugin layer, affects all sessions)',
        overrideNote: 'This session is customized; global changes do not affect it (clear with /cg set reset)',
        noSession: 'No session id: session-level save unavailable (never falls back to global)',
        percent: 'Trigger percent', unit: '%', save: 'Save to this session', saveGlobal: 'Save globally', saving: 'Saving…',
        saved: 'Saved', restore: 'Restore default', retry: 'Retry', loading: 'Loading…', unavailable: 'Unavailable', invalid: 'Invalid input',
        openSettings: 'Open settings', chipUnknown: 'At —', chip: (t) => `At ${t}`,
      },
    };
    /**
     * C32：来源层的用户可见标签（唯一映射、禁别名）。与 `src/ui-labels.js` 同字面，
     * `test/d2-ui-labels.test.mjs` 逐项比对两侧（浏览器侧不能 import 宿主源码）。
     */
    const LAYER_LABELS = {
      'session:A1': '本会话·临时（重启失效）',
      'session:A2': '本会话·已保存（重启保留）',
      project: '项目模板（可选）',
      plugin: '全局（影响所有会话）',
      builtin: '内置默认',
    };
    const layerLabel = (source) => {
      const key = String(source ?? '');
      if (key === '') return '未知来源';
      if (key === 'session') return LAYER_LABELS['session:A1'];
      if (key.startsWith('profile=')) return `配置 profile=${key.slice('profile='.length)}`;
      return LAYER_LABELS[key] ?? key;
    };

    /** 百分比（0–100 整数）→ 比例；非法 → null。 */
    const toRatio = (raw) => {
      const text = normalizePercentInput(raw);
      if (text === '' || !/^\d+(\.\d+)?$/.test(text)) return null;
      const value = Number(text);
      if (!Number.isFinite(value) || value < 0 || value > 100) return null;
      return Math.round(value) / 100;
    };

    /** U3 输入清洗：全角→半角、去 `%`/空格/非数字字符；只保留数字与小数点。 */
    const normalizePercentInput = (raw) => {
      const text = String(raw ?? '')
        .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/[．。]/g, '.')
        .replace(/[％%]/g, '')
        .replace(/\s+/g, '');
      const cleaned = text.replace(/[^\d.]/g, '');
      const [head, ...rest] = cleaned.split('.');
      return rest.length === 0 ? head : `${head}.${rest.join('').slice(0, 2)}`;
    };

    const toPercentText = (at) => (Number.isFinite(at) ? `${Math.round(Number(at) * 100)}%` : '—');

    /** C8：生命周期文案随来源派生（禁一句常量盖所有来源）。 */
    const effectiveTextFor = (source) => {
      const key = String(source ?? '');
      if (key === 'session:A2') return '本会话已保存，重启保留';
      if (key === 'session' || key === 'session:A1') return '本会话有效，重启后失效';
      return '保存后生效、重启仍有效';
    };
    /** C11①/C11③：写层文案按入口区分——主入口写本会话（A2），设置页写全局（plugin）。 */
    const writeLayerTextFor = (entry = 'session') => (entry === 'global'
      ? LABELS.zh.writeLayerGlobal
      : LABELS.zh.writeLayerSession);
    /** 兼容旧导出名：默认按主入口（会话级）口径。 */
    const WRITE_LAYER = LABELS.zh.writeLayerSession;

    /** 默认值单一来源 = 快照 `defaultAt`；缺字段才 fallback 并 **只 warn 一次**（模块级 flag，防刷屏）。 */
    let warnedDefaultAt = false;
    const defaultRatioFor = (snapshot, warn = console.warn) => {
      if (Number.isFinite(snapshot?.defaultAt)) return Number(snapshot.defaultAt);
      if (warnedDefaultAt !== true) {
        warnedDefaultAt = true;
        warn('[context-governance] snapshot missing defaultAt; falling back to 0.6');
      }
      return FALLBACK_DEFAULT_AT;
    };
    const defaultPercentFor = (snapshot, warn) => Math.round(defaultRatioFor(snapshot, warn) * 100);

    /** 校验（与 `/cg set` 同源规则）。 */
    const validateRatio = (ratio, { projectLayer = false, native = null } = {}) => {
      if (ratio === null) return '请输入 0–100 的百分比';
      const min = projectLayer ? PROJECT_AT_MIN : AT_MIN;
      if (ratio < min) return `compact.at 下限 ${min}`;
      if (ratio < LOW_THRESHOLD_ACK_MIN) return 'compact.at<0.30 需 compact.lowThresholdAck=true';
      if (Number.isFinite(native) && ratio > native - USABLE_MARGIN) return `compact.at 不能超过宿主可用上限 ${(native - USABLE_MARGIN).toFixed(2)}`;
      return null;
    };

    const computeSave = (raw, snapshot = {}) => {
      const ratio = toRatio(raw);
      const reason = validateRatio(ratio, {
        projectLayer: snapshot?.source === 'project',
        native: Number.isFinite(snapshot?.native) ? snapshot.native : null,
      });
      return reason === null ? { ok: true, ratio } : { ok: false, reason };
    };

    /** C21/C22：保存尝试（非法值不发请求；失败保留输入）；返回 requestSent 供用例断言。 */
    const saveAttempt = async ({ raw, snapshot, configForms } = {}) => {
      const result = computeSave(raw, snapshot ?? {});
      if (result.ok !== true) return { ok: false, ratio: null, error: result.reason, requestSent: false };
      const form = configForms?.get?.(ENTRY_ID);
      if (form === undefined || form === null) return { ok: false, ratio: result.ratio, error: '当前不可保存', requestSent: false };
      try {
        if (typeof form.set === 'function') await form.set('policy.at', result.ratio);
        else if (typeof form.mutate === 'function') await form.mutate([{ path: 'policy.at', value: result.ratio }], form.revision);
        else return { ok: false, ratio: result.ratio, error: '当前不可保存', requestSent: false };
        return { ok: true, ratio: result.ratio, error: null, requestSent: true };
      } catch (error) {
        return { ok: false, ratio: result.ratio, error: String(error?.message ?? error), requestSent: true };
      }
    };

    /** C11③：把比例写到该会话（A1 即时 + A2 持久，同一命令链）。返回 requestSent 供用例断言。 */
    const postSessionAt = async ({ sessionId, at, fetchImpl = globalThis.fetch } = {}) => {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'no-session', requestSent: false };
      if (typeof fetchImpl !== 'function') return { ok: false, error: 'no-fetch', requestSent: false };
      try {
        const response = await fetchImpl(SESSION_POLICY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, at }),
        });
        if (response && response.ok === true) return { ok: true, error: null, requestSent: true };
        let error = response ? `HTTP ${response.status}` : 'no-response';
        try {
          const body = await response.json();
          if (typeof body?.error === 'string') error = body.error;
          if (typeof body?.detail === 'string' && body.detail !== '') error = `${error}: ${body.detail}`;
        } catch { /* 非 JSON 响应按状态码报 */ }
        return { ok: false, error, requestSent: true };
      } catch (failure) {
        return { ok: false, error: String(failure?.message ?? failure), requestSent: true };
      }
    };

    /** C11③：主入口（chip/气泡）保存 = 会话级。非法值不发请求；失败保留输入。 */
    const saveSessionAt = async ({ raw, snapshot, sessionId, fetchImpl } = {}) => {
      const result = computeSave(raw, snapshot ?? {});
      if (result.ok !== true) return { ok: false, ratio: null, error: result.reason, requestSent: false };
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, ratio: result.ratio, error: LABELS.zh.noSession, requestSent: false };
      }
      const posted = await postSessionAt({ sessionId, at: result.ratio, fetchImpl });
      if (posted.ok === true) return { ok: true, ratio: result.ratio, error: null, requestSent: true };
      return { ok: false, ratio: result.ratio, error: posted.error, requestSent: posted.requestSent };
    };

    /**
     * C11②：设置页保存 = plugin 全局层，且**插件自持久化**（服务端写 `plugin-policy.json`），
     * 不依赖宿主 volatile 字段是否跨进程保留。宿主表单（configForms）只做尽力同步，失败不回滚。
     */
    const savePluginAt = async ({ raw, snapshot, fetchImpl = globalThis.fetch, configForms } = {}) => {
      const result = computeSave(raw, snapshot ?? {});
      if (result.ok !== true) return { ok: false, ratio: null, error: result.reason, requestSent: false };
      if (typeof fetchImpl !== 'function') return { ok: false, ratio: result.ratio, error: 'no-fetch', requestSent: false };
      let posted;
      try {
        const response = await fetchImpl(PLUGIN_POLICY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ at: result.ratio }),
        });
        if (response && response.ok === true) {
          posted = { ok: true, requestSent: true };
        } else {
          let error = response ? `HTTP ${response.status}` : 'no-response';
          try {
            const body = await response.json();
            if (typeof body?.error === 'string') error = body.error;
            if (typeof body?.detail === 'string' && body.detail !== '') error = `${error}: ${body.detail}`;
          } catch { /* 非 JSON 响应按状态码报 */ }
          posted = { ok: false, error, requestSent: true };
        }
      } catch (failure) {
        posted = { ok: false, error: String(failure?.message ?? failure), requestSent: true };
      }
      if (posted.ok !== true) return { ok: false, ratio: result.ratio, error: posted.error, requestSent: posted.requestSent };
      // 宿主 volatile 表单同步（只影响设置页显示；持久化已由插件文件保证）。
      try {
        const form = configForms?.get?.(ENTRY_ID);
        if (typeof form?.set === 'function') await form.set('policy.at', result.ratio);
        else if (typeof form?.mutate === 'function') await form.mutate([{ path: 'policy.at', value: result.ratio }], form.revision);
      } catch { /* 表单同步失败不影响已落盘的持久值 */ }
      return { ok: true, ratio: result.ratio, error: null, requestSent: true };
    };

    /** U2 结构 / U8 不可用态：气泡与设置页共用同一视图模型。 */
    const bubbleView = (snapshot) => {
      const ready = snapshot !== null && snapshot !== undefined;
      return {
        ready,
        title: LABELS.zh.title,
        percentText: ready ? toPercentText(snapshot.at) : '—',
        fields: [
          `${LABELS.zh.source}：${ready ? `${layerLabel(snapshot.source)} (source=${snapshot.source ?? 'unknown'})` : '—'}`,
          `${LABELS.zh.when}：${ready ? effectiveTextFor(snapshot.source) : '—'}`,
          writeLayerTextFor('session'),
        ],
        canSave: ready,
        statusText: ready ? '' : LABELS.zh.loading,
        defaultPercent: ready ? defaultPercentFor(snapshot) : 60,
      };
    };

    /** U7 关闭判定：Esc / 外部点击 / 再点 chip 均关闭并重置草稿。 */
    const closeDecision = (reason) => reason === 'escape' || reason === 'outside' || reason === 'chip' || reason === 'saved';

    /** U7：pointerdown 外部判定——点在气泡内或 chip 上都**不**算关闭（chip 由点击切换自己处理）。 */
    const outsidePointerDecision = ({ inside = false, onChip = false } = {}) => inside !== true && onChip !== true;

    const chipLabel = (snapshot, lang = 'zh') => {
      const labels = LABELS[lang] ?? LABELS.zh;
      if (!snapshot || !Number.isFinite(snapshot.at)) return labels.chipUnknown;
      return labels.chip(toPercentText(snapshot.at));
    };

    /**
     * 气泡/设置页信息行（C8/C11/C32/C28）：生效值 / 来源层（固定标签 + 原始键）/ 生命周期 / 写入层，
     * 全局入口在多会话已自定义时追加「不受全局修改影响」提示。
     * @param {object} snapshot
     * @param {object} labels
     * @param {{entry?: 'session'|'global'}} options
     */
    const renderBubbleText = (snapshot = {}, labels = LABELS.zh, { entry = 'session' } = {}) => {
      const source = snapshot.source ?? 'unknown';
      const sessionCustomized = /^session(:|$)/.test(String(source));
      return [
        `${labels.current}: ${toPercentText(snapshot.at)}`,
        `${labels.source}: ${layerLabel(source)} (source=${source})`,
        `${labels.when}: ${effectiveTextFor(source)}`,
        writeLayerTextFor(entry),
        ...(entry === 'global' && sessionCustomized ? [labels.overrideNote ?? LABELS.zh.overrideNote] : []),
      ].join('\n');
    };

    /** 拉取快照：失败 warn + 3 次退避（C19）；导出供假 fetch 序列单测。 */
    const fetchSnapshotWithRetry = async (fetchImpl = globalThis.fetch, { attempts = 3, delays = [300, 1000], warn = console.warn } = {}) => {
      if (typeof fetchImpl !== 'function') {
        warn('[context-governance] snapshot fetch unavailable: fetch missing');
        return null;
      }
      let reason = 'unknown';
      for (let index = 0; index < attempts; index += 1) {
        try {
          const response = await fetchImpl(SNAPSHOT_PATH, { method: 'GET', headers: { accept: 'application/json' } });
          if (response && response.ok === true) return await response.json();
          reason = response ? `HTTP ${response.status}` : 'no response';
          warn(`[context-governance] snapshot fetch failed: ${reason} (attempt ${index + 1}/${attempts})`);
        } catch (error) {
          reason = String(error?.message ?? error);
          warn(`[context-governance] snapshot fetch failed: ${reason} (attempt ${index + 1}/${attempts})`);
        }
        if (index < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delays[Math.min(index, delays.length - 1)]));
      }
      warn(`[context-governance] snapshot fetch failed after ${attempts} attempts: ${reason}`);
      return null;
    };
    const fetchSnapshot = (fetchImpl = globalThis.fetch) => fetchSnapshotWithRetry(fetchImpl);

    const h = react.createElement;
    const createViewState = () => ({ open: false, snapshot: null, listeners: new Set() });
    const createStore = (state) => ({
      set(next) { Object.assign(state, next); for (const listener of state.listeners) listener(state); },
      subscribe(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
    });
    const pickLabels = (ctx) => ((ctx?.locale?.language ?? 'zh').startsWith('zh') ? LABELS.zh : LABELS.en);

    // U10：主题用变量 + fallback，不写死背景。
    const S = {
      chip: { background: 'var(--dsh-bg-secondary, #2b2b2b)', color: 'var(--dsh-fg, #e6e6e6)', border: '1px solid var(--dsh-border, #444)', borderRadius: 999, padding: '2px 10px', fontSize: 12, cursor: 'pointer', fontVariantNumeric: 'tabular-nums' },
      dialog: { background: 'var(--dsh-bg-elevated, #252525)', color: 'var(--dsh-fg, #e6e6e6)', border: '1px solid var(--dsh-border, #444)', borderRadius: 12, padding: 16, width: 280, boxShadow: '0 8px 28px #0006', display: 'flex', flexDirection: 'column', gap: 10, position: 'relative', zIndex: 40 },
      title: { fontSize: 13, fontWeight: 600, color: 'var(--dsh-fg-secondary, #bdbdbd)' },
      big: { fontSize: 32, fontWeight: 700, lineHeight: '1.1', fontVariantNumeric: 'tabular-nums' },
      metaLine: { fontSize: 12, color: 'var(--dsh-fg-secondary, #bdbdbd)' },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      input: { flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 14, borderRadius: 8, border: '1px solid var(--dsh-border, #444)', background: 'var(--dsh-bg, #1e1e1e)', color: 'var(--dsh-fg, #e6e6e6)' },
      inputError: { borderColor: 'var(--dsh-red, #e05252)' },
      error: { fontSize: 12, color: 'var(--dsh-red, #e05252)', minHeight: 16 },
      actions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
      button: { padding: '6px 12px', fontSize: 13, borderRadius: 8, border: '1px solid var(--dsh-border, #444)', background: 'var(--dsh-bg-secondary, #2b2b2b)', color: 'var(--dsh-fg, #e6e6e6)', cursor: 'pointer' },
      buttonPrimary: { background: 'var(--dsh-accent, #3b82f6)', borderColor: 'var(--dsh-accent, #3b82f6)', color: '#fff' },
      buttonDisabled: { opacity: 0.55, cursor: 'not-allowed' },
    };

    /**
     * C23：真正的 React 错误边界（class + getDerivedStateFromError + componentDidCatch）。
     * 函数内 try/catch 拦不住子组件渲染期/hooks 抛错，所以每个入口包一层该边界。
     * 另外：**不向宿主 ctx 读浏览器原生的 fetch**（`ctx.fetch` 引用必须为 0；未注入属性 getter 会抛）。
     */
    const ReactComponent = react.Component ?? class {};
    class EntryBoundary extends ReactComponent {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) {
        console.warn(`[context-governance] entry crashed: ${String(this.props?.slot ?? 'unknown')} — ${String(error?.message ?? error)}`);
      }
      render() {
        if (this.state?.failed === true) return this.props?.fallback ?? null;
        return this.props?.children ?? null;
      }
    }

    /** 把入口组件包进边界：children 是**元素**（惰性渲染），子组件抛错由 React 交给 EntryBoundary。 */
    const boundedEntry = (slot, Component, fallback = null) => (props) => h(EntryBoundary, { slot, fallback }, h(Component, props));

    /** chip（composer.dock）。 */
    const createChip = (state, store, pluginCtx = null) => (props) => {
      const ctx = pluginCtx ?? props?.ctx ?? props;
      const labels = pickLabels(ctx);
      const [view, setView] = react.useState(state.snapshot);
      const [open, setOpen] = react.useState(state.open);
      react.useEffect(() => store.subscribe((next) => { setView(next.snapshot); setOpen(next.open); }), [store]);
      react.useEffect(() => {
        let alive = true;
        const refresh = () => { fetchSnapshot(globalThis.fetch).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); }); };
        refresh();
        const focusTarget = globalThis.window ?? globalThis;
        if (typeof focusTarget?.addEventListener === 'function') {
          focusTarget.addEventListener('focus', refresh);
          return () => { alive = false; focusTarget.removeEventListener?.('focus', refresh); };
        }
        return () => { alive = false; };
      }, [ctx, store]);
      return h('button', {
        type: 'button',
        'data-cg-chip': 'true',
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': labels.percent,
        style: S.chip,
        onClick: () => store.set({ open: closeDecision('chip') ? !state.open : true }),
        onKeyDown: (event) => {
          if (event?.key === 'Enter' || event?.key === ' ') { event.preventDefault?.(); store.set({ open: true }); }
          else if (event?.key === 'Escape') { store.set({ open: false }); }
        },
      }, chipLabel(view, ctx?.locale?.language?.startsWith('zh') === false ? 'en' : 'zh'));
    };

    /** 会话 id：宿主给 session 作用域 slot 的 `sessionId` prop（拿不到就明确不可用，绝不退化写全局）。 */
    const sessionIdOf = (props, ctx) => {
      const fromProps = props?.sessionId;
      if (typeof fromProps === 'string' && fromProps !== '') return fromProps;
      const fromCtx = ctx?.sessionId;
      return typeof fromCtx === 'string' && fromCtx !== '' ? fromCtx : null;
    };

    /** 气泡（conversation.input.overlay）：U1-U12 交互标准；保存写本会话（C11③）。 */
    const createBubble = (state, store, pluginCtx = null) => (props) => {
      const ctx = pluginCtx ?? props?.ctx ?? props;
      const sessionId = sessionIdOf(props, ctx);
      const labels = pickLabels(ctx);
      const [view, setView] = react.useState(state.snapshot);
      const [open, setOpen] = react.useState(state.open);
      const [draft, setDraft] = react.useState('');
      const [error, setError] = react.useState('');
      const [saving, setSaving] = react.useState(false);
      const [saved, setSaved] = react.useState(false);
      const inputRef = react.useRef(null);
      const dialogRef = react.useRef(null);
      react.useEffect(() => store.subscribe((next) => { setView(next.snapshot); setOpen(next.open); }), [store]);
      // U1/U7：打开即聚焦并全选；重开回到当前生效值（不保留草稿）。
      react.useEffect(() => {
        if (!open) { setDraft(''); setError(''); setSaved(false); return; }
        setDraft(Number.isFinite(view?.at) ? String(Math.round(view.at * 100)) : '');
        setError('');
        setSaved(false);
        try { inputRef.current?.focus?.(); inputRef.current?.select?.(); } catch { /* ignore */ }
      }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
      // U7：点外部（含空白背景，relatedTarget=null）关闭——document/window 级 pointerdown capture，
      // 只有命中气泡外且不是 chip 自身才关；关闭即移除监听。
      react.useEffect(() => {
        if (!open) return undefined;
        const target = globalThis.document ?? globalThis.window ?? globalThis;
        if (typeof target?.addEventListener !== 'function') return undefined;
        const onPointerDown = (event) => {
          let inside = false;
          try { inside = dialogRef.current?.contains?.(event?.target) === true; } catch { inside = false; }
          let onChip = false;
          try { onChip = event?.target?.closest?.('[data-cg-chip]') != null; } catch { onChip = false; }
          if (outsidePointerDecision({ inside, onChip })) store.set({ open: false });
        };
        target.addEventListener('pointerdown', onPointerDown, true);
        return () => { try { target.removeEventListener('pointerdown', onPointerDown, true); } catch { /* ignore */ } };
      }, [open, store]);
      // C19③：打开时重取。
      react.useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        fetchSnapshot(globalThis.fetch).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); });
        return () => { alive = false; };
      }, [open, ctx, store]);
      const close = () => { if (closeDecision('escape')) store.set({ open: false }); };
      if (!open) return null;
      const model = bubbleView(view ?? null);
      // C11③：主入口保存写本会话（A2）；无会话标识时明确不可保存，绝不退化写全局。
      const canSaveSession = model.canSave && sessionId !== null;
      const save = async () => {
        setSaving(true);
        const result = await saveSessionAt({ raw: draft, snapshot: view ?? {}, sessionId });
        setSaving(false);
        if (result.ok !== true) { setError(result.error); return; }
        setError('');
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        const next = await fetchSnapshot(globalThis.fetch);
        store.set(next ? { snapshot: next } : {});
      };
      const onBlurField = () => {
        const result = computeSave(draft, view ?? {});
        setError(result.ok === true ? '' : result.reason);
      };
      const restoreDefault = () => { setDraft(String(defaultPercentFor(view ?? null))); setError(''); };
      const retry = () => { fetchSnapshot(globalThis.fetch).then((snapshot) => { if (snapshot) store.set({ snapshot }); }); };
      return h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': model.title, ref: dialogRef, style: S.dialog,
        tabIndex: -1,
        onKeyDown: (event) => { if (event?.key === 'Escape') { event.stopPropagation?.(); close(); } },
        onBlur: (event) => { const next = event?.relatedTarget; if (next !== null && next !== undefined && !event.currentTarget?.contains?.(next)) close(); },
      },
        h('div', { style: S.title }, model.title),
        h('div', { style: S.big, 'data-role': 'current-percent' }, model.percentText),
        ...renderBubbleText(view ?? {}, labels, { entry: 'session' }).split('\n').slice(1).map((line, index) => h('div', { key: index, style: S.metaLine }, line)),
        sessionId === null ? h('div', { style: S.error }, labels.noSession ?? LABELS.zh.noSession) : null,
        h('div', { style: S.row },
          h('input', {
            ref: inputRef, type: 'text', inputMode: 'numeric', value: draft, 'aria-label': labels.percent,
            'aria-invalid': error === '' ? 'false' : 'true',
            style: error === '' ? S.input : { ...S.input, ...S.inputError },
            onChange: (event) => { setDraft(normalizePercentInput(event.target.value)); setSaved(false); },
            onBlur: onBlurField,
            onKeyDown: (event) => { if (event?.key === 'Enter') { event.preventDefault?.(); save(); } if (event?.key === 'Escape') { close(); } },
          }),
          h('span', { style: S.metaLine }, labels.unit)),
        h('div', { role: 'alert', 'aria-live': 'polite', style: S.error }, error),
        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.button, onClick: restoreDefault, disabled: !canSaveSession }, `${labels.restore} ${model.defaultPercent}%`),
          model.ready ? null : h('button', { type: 'button', style: S.button, onClick: retry }, labels.retry),
          h('button', {
            type: 'button',
            style: canSaveSession && !saving ? { ...S.button, ...S.buttonPrimary } : { ...S.button, ...S.buttonPrimary, ...S.buttonDisabled },
            onClick: save,
            disabled: !canSaveSession || saving,
          }, saving ? labels.saving : saved ? labels.saved : labels.save),
          h('button', { type: 'button', className: 'cg-at-settings-link', style: S.button, onClick: () => { try { ctx?.openSettings?.(); } catch { /* ignore */ } } }, labels.openSettings),
        ),
      );
    };

    /** 设置页卡片：**只写全局 plugin 层**（C11③/C28），与气泡的会话级写入明确分开。 */
    const createSettingsCard = (state, store, pluginCtx = null) => (props) => {
      const ctx = pluginCtx ?? props?.ctx ?? props;
      const labels = pickLabels(ctx);
      const [view, setView] = react.useState(state.snapshot);
      const [draft, setDraft] = react.useState('');
      const [error, setError] = react.useState('');
      const [saved, setSaved] = react.useState(false);
      react.useEffect(() => store.subscribe((next) => { setView(next.snapshot); }), [store]);
      react.useEffect(() => {
        let alive = true;
        fetchSnapshot(globalThis.fetch).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); });
        return () => { alive = false; };
      }, [ctx, store]);
      const model = bubbleView(view ?? null);
      // 设置页＝全局入口：写 plugin 层（插件自持久化 + 宿主 volatile 表单尽力同步）。
      const save = async () => {
        const result = await savePluginAt({ raw: draft, snapshot: view ?? {}, configForms: ctx?.configForms });
        if (result.ok !== true) { setError(result.error); return; }
        setError('');
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        const next = await fetchSnapshot(globalThis.fetch);
        if (next) store.set({ snapshot: next });
      };
      return h('div', { style: { ...S.dialog, width: 'auto', boxShadow: 'none' } },
        h('div', { style: S.title }, model.title),
        h('div', { style: S.big, 'data-role': 'current-percent' }, model.percentText),
        ...renderBubbleText(view ?? {}, labels, { entry: 'global' }).split('\n').slice(1).map((line, index) => h('div', { key: index, style: S.metaLine }, line)),
        h('div', { style: S.row },
          h('input', {
            type: 'text', inputMode: 'numeric', value: draft, 'aria-label': labels.percent,
            'aria-invalid': error === '' ? 'false' : 'true',
            style: error === '' ? S.input : { ...S.input, ...S.inputError },
            onChange: (event) => setDraft(normalizePercentInput(event.target.value)),
            onBlur: () => { const result = computeSave(draft, view ?? {}); setError(result.ok === true ? '' : result.reason); },
          }),
          h('span', { style: S.metaLine }, labels.unit)),
        h('div', { role: 'alert', 'aria-live': 'polite', style: S.error }, error),
        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.button, onClick: () => setDraft(String(defaultPercentFor(view ?? null))) }, `${labels.restore} ${model.defaultPercent}%`),
          h('button', { type: 'button', style: S.buttonPrimary, onClick: save, disabled: !model.canSave }, saved ? labels.saved : (labels.saveGlobal ?? labels.save)),
        ));
    };

    const inject = ['slots', 'locale', 'configForms'];

    const registrationPlan = () => [
      { slot: 'conversation.composer.dock', id: 'context-governance.at', order: 6, component: 'chip' },
      { slot: 'conversation.input.overlay', id: 'context-governance.overlay', order: 60, component: 'bubble' },
      { slot: 'settings.section', id: 'context-governance', order: 60, component: 'section' },
    ];

    const apply = (ctx) => {
      const state = createViewState();
      const store = createStore(state);
      // C23：三处入口各包一层 React 错误边界；chip fallback 必须是**可点击的「压 —」按钮**。
      const chipFallback = h('button', { type: 'button', style: S.chip, 'aria-haspopup': 'dialog' }, LABELS.zh.chipUnknown);
      const components = {
        chip: boundedEntry('conversation.composer.dock', createChip(state, store, ctx), chipFallback),
        bubble: boundedEntry('conversation.input.overlay', createBubble(state, store, ctx)),
        section: boundedEntry('settings.section', createSettingsCard(state, store, ctx)),
      };
      const labels = pickLabels(ctx);
      console.info('[context-governance] client apply', {
        slots: typeof ctx?.slots?.inject === 'function' && typeof ctx?.slots?.register === 'function',
        configForms: typeof ctx?.get === 'function' && ctx.get('configForms') !== undefined,
        locale: typeof ctx?.locale?.language === 'string',
      });
      const slots = ctx?.slots;
      if (slots === undefined || slots === null || typeof slots.register !== 'function') {
        console.warn('[context-governance] client apply: slots service unavailable; composer chip / overlay / settings section not registered');
        return;
      }
      const canInject = typeof slots.inject === 'function';
      for (const entry of registrationPlan()) {
        const register = () => {
          try {
            const registered = slots.register({ name: entry.slot, id: entry.id, order: entry.order, label: () => labels.sectionLabel, inject: () => inject }, components[entry.component]);
            console.info('[context-governance] slot registered', entry.slot);
            return registered;
          } catch (error) {
            console.warn('[context-governance] slot register failed', entry.slot, String(error?.message ?? error));
            return undefined;
          }
        };
        if (!canInject) {
          // 只给 register 的 slots 属失真契约（真实宿主恒有 inject）：不直注册，warn 留证据。
          console.warn('[context-governance] client apply: slots service unavailable (inject missing); entries not registered');
          continue;
        }
        try {
          const dispose = slots.inject(entry.slot, register);
          if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => () => { try { dispose(); } catch { /* ignore */ } }, `context-governance: slot ${entry.slot}`);
          }
          console.info('[context-governance] slot watched', entry.slot);
        } catch (error) {
          console.warn('[context-governance] slot inject failed', entry.slot, String(error?.message ?? error));
        }
      }
    };

    return {
      apply,
      inject,
      registrationPlan,
      chipLabel,
      renderBubbleText,
      computeSave,
      saveAttempt,
      bubbleView,
      closeDecision,
      outsidePointerDecision,
      EntryBoundary,
      boundedEntry,
      normalizePercentInput,
      defaultRatioFor,
      defaultPercentFor,
      effectiveTextFor,
      WRITE_LAYER,
      LAYER_LABELS,
      layerLabel,
      writeLayerTextFor,
      saveSessionAt,
      postSessionAt,
      savePluginAt,
      PLUGIN_POLICY_PATH,
      sessionIdOf,
      SESSION_POLICY_PATH,
      toPercentText,
      toRatio,
      validateRatio,
      fetchSnapshot,
      fetchSnapshotWithRetry,
      createChip,
      createBubble,
      createSettingsCard,
    };
  },
});








