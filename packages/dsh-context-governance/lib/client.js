/**
 * dsh-context-governance · 浏览器半侧（1.1.0 D2，入口形态 A）
 *
 * 格式：手写 `window.__ModuleLoader__.load({ id, factory })`（与宿主已装插件 cost-meter / dsh-context 同形；
 * 本仓不引打包器，此文件即产物，审核按本注释与文件本体核对）。
 * id：`dsh-context-governance`（= 宿主 settings 命名空间 = Cordis 条目 id，见 cordis.patch.yml）。
 *
 * 入口：
 *   1. `conversation.composer.dock` → 条目标签 `压 65%`（快照 at；取不到 → `压 —`），点击/Enter 展开气泡；
 *   2. `conversation.input.overlay` → 输入框锚点气泡（百分比输入 + 当前生效值/来源层/生效时点 + 打开设置页）；
 *   3. `settings.section` → 完整设置页卡片（保留，同一份数据、同一写入口）。
 *
 * 依赖的共享模块（由 factory 的 require 形参从宿主模块表解析，不随包发布）：`react`
 * 注入的客户端服务：`slots`（注册三处入口）、`locale`、`configForms`（读写 profile 条目 `dsh-context-governance`）；
 * 只读数据：同源 `GET /context-governance/policy-snapshot`（宿主侧已实现的只读路由，本文件不新增接口）。
 * 安全边界：只暴露 `compact.at`（百分比 0–100，内部 /100）；estimateSafety/lowThresholdAck/armed 无入口。
 * C8/C11 文案来源：生命周期文案由 `source` 派生（session → 本会话有效，重启后失效；持久层 → 保存后生效、重启仍有效），
 *   与 host 侧 `src/settings-policy.js` 的 `lifecycleText()` 同一映射；「本次修改写入：plugin 层（profile patch）」为静态文案。
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-governance',
  factory: (require) => {
    const react = require('react');

    const ENTRY_ID = 'dsh-context-governance';
    const SNAPSHOT_PATH = '/context-governance/policy-snapshot';
    const AT_MIN = 0.2;
    const LOW_THRESHOLD_ACK_MIN = 0.3;
    const PROJECT_AT_MIN = 0.45;
    const USABLE_MARGIN = 0.02;
    const LABELS = {
      zh: {
        sectionLabel: '上下文治理', title: '压缩触发阈值', percent: '触发百分比（0–100）', save: '保存', effective: '当前生效', source: '来源层', when: '生效时点', writeLayer: '写入层', invalid: '输入无效', openSettings: '打开设置页', chipUnknown: '压 —', chip: (t) => `压 ${t}`,
      },
      en: {
        sectionLabel: 'Context governance', title: 'Compaction threshold', percent: 'Trigger percent (0–100)', save: 'Save', effective: 'Effective', source: 'Source layer', when: 'Takes effect', writeLayer: 'Writes to', invalid: 'Invalid input', openSettings: 'Open settings', chipUnknown: 'At —', chip: (t) => `At ${t}`,
      },
    };

    /** 与 host 侧 `lifecycleText()` 保持同一映射（C8）：session 只在本会话有效，持久层重启仍有效。 */
    const effectiveTextFor = (source) => (source === 'session' ? '本会话有效，重启后失效' : '保存后生效、重启仍有效');
    /** 写入层静态文案（C11）：UI 唯一写入口 = profile Cordis patch → plugin 配置层。 */
    const WRITE_LAYER = '本次修改写入：plugin 层（profile patch）';

    /** 比例 → 百分比文本；非数字 → '—'。 */
    const toPercentText = (at) => (Number.isFinite(at) ? `${Math.round(Number(at) * 100)}%` : '—');

    /** 百分比输入 → 比例（0–1，整数百分比）；非法 → null。 */
    const toRatio = (raw) => {
      const value = Number(String(raw ?? '').trim());
      if (!Number.isFinite(value) || value < 0 || value > 100) return null;
      return Math.round(value) / 100;
    };

    /** 校验（与 `/cg set` 同源规则；返回 null 表示通过，否则原因文本）。 */
    const validateRatio = (ratio, { projectLayer = false, native = null } = {}) => {
      if (ratio === null) return '请输入 0–100 的百分比';
      const min = projectLayer ? PROJECT_AT_MIN : AT_MIN;
      if (ratio < min) return `compact.at 下限 ${min}`;
      if (ratio < LOW_THRESHOLD_ACK_MIN) return 'compact.at<0.30 需 compact.lowThresholdAck=true';
      if (Number.isFinite(native) && ratio > native - USABLE_MARGIN) return `compact.at 不能超过宿主可用上限 ${(native - USABLE_MARGIN).toFixed(2)}`;
      return null;
    };

    /** dock 条目标签：`压 65%`；快照缺失 → `压 —`（不抛错）。 */
    const chipLabel = (snapshot, lang = 'zh') => {
      const labels = LABELS[lang] ?? LABELS.zh;
      if (!snapshot || !Number.isFinite(snapshot.at)) return labels.chipUnknown;
      return labels.chip(toPercentText(snapshot.at));
    };

    /** 气泡四行文本（C8/C11/C13）：当前生效 / 来源层 / 生命周期（随 source 派生）/ 写入层（静态）。 */
    const renderBubbleText = (snapshot = {}, labels = LABELS.zh) => {
      const source = snapshot.source ?? 'unknown';
      const line1 = `${labels.effective}: ${toPercentText(snapshot.at)}`;
      const line2 = `${labels.source}: ${source}`;
      const line3 = `${labels.when}: ${effectiveTextFor(source)}`;
      const line4 = WRITE_LAYER;
      return [line1, line2, line3, line4].join('\n');
    };

    /** 保存前计算：返回 {ok, ratio} 或 {ok:false, reason}（C14 拒绝理由同源）。 */
    const computeSave = (raw, snapshot = {}) => {
      const ratio = toRatio(raw);
      const reason = validateRatio(ratio, {
        projectLayer: snapshot?.source === 'project',
        native: Number.isFinite(snapshot?.native) ? snapshot.native : null,
      });
      return reason === null ? { ok: true, ratio } : { ok: false, reason };
    };

    /** 拉取同源快照（只读 GET）；失败返回 null（不抛错）。 */
    const fetchSnapshot = async (fetchImpl = globalThis.fetch) => {
      if (typeof fetchImpl !== 'function') return null;
      try {
        const response = await fetchImpl(SNAPSHOT_PATH, { method: 'GET', headers: { accept: 'application/json' } });
        if (!response || response.ok !== true) return null;
        return await response.json();
      } catch {
        return null;
      }
    };

    const h = react.createElement;

    /** 三处入口共享的视图状态（open + 快照读到的值）。 */
    const createViewState = () => ({ open: false, snapshot: null, listeners: new Set() });
    const createStore = (state) => ({
      set(next) { Object.assign(state, next); for (const listener of state.listeners) listener(state); },
      subscribe(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
    });

    const pickLabels = (ctx) => ((ctx?.locale?.language ?? 'zh').startsWith('zh') ? LABELS.zh : LABELS.en);

    /** 保存 policy.at（同一写入口；失败只提示，不抛）。 */
    const saveRatio = async (ctx, ratio) => {
      try {
        const form = ctx?.configForms?.get?.(ENTRY_ID);
        if (form && typeof form.set === 'function') { await form.set('policy.at', ratio); return true; }
        if (form && typeof form.mutate === 'function') { await form.mutate([{ path: 'policy.at', value: ratio }], form.revision); return true; }
        return false;
      } catch {
        return false;
      }
    };

    /** chip 组件（composer.dock）：按钮 + Tab/Enter/Esc；点击切换气泡。 */
    const createChip = (state, store) => (props) => {
      const ctx = props?.ctx ?? props;
      const labels = pickLabels(ctx);
      const [view, setView] = react.useState(state.snapshot);
      react.useEffect(() => store.subscribe((next) => setView(next.snapshot))(), [store]);
      react.useEffect(() => {
        let alive = true;
        fetchSnapshot(ctx?.fetch ?? globalThis.fetch).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); });
        return () => { alive = false; };
      }, [ctx, store]);
      return h('button', {
        type: 'button',
        className: 'cg-at-chip',
        'aria-haspopup': 'dialog',
        'aria-expanded': state.open ? 'true' : 'false',
        'aria-label': labels.percent,
        onClick: () => store.set({ open: !state.open }),
        onKeyDown: (event) => {
          if (event?.key === 'Enter' || event?.key === ' ') { event.preventDefault?.(); store.set({ open: true }); }
          else if (event?.key === 'Escape') { store.set({ open: false }); }
        },
      }, chipLabel(view, ctx?.locale?.language?.startsWith('zh') === false ? 'en' : 'zh'));
    };

    /** 气泡组件（conversation.input.overlay）：百分比输入 + 三行 + 保存 + 去设置页。 */
    const createBubble = (state, store) => (props) => {
      const ctx = props?.ctx ?? props;
      const labels = pickLabels(ctx);
      const [view, setView] = react.useState(state.snapshot);
      const [draft, setDraft] = react.useState('');
      const [error, setError] = react.useState('');
      react.useEffect(() => store.subscribe((next) => setView(next.snapshot))(), [store]);
      if (!state.open) return null;
      const save = async () => {
        const result = computeSave(draft, view ?? {});
        if (result.ok !== true) { setError(result.reason); return; }
        const ok = await saveRatio(ctx, result.ratio);
        if (!ok) { setError(labels.invalid); return; }
        setError('');
        const next = await fetchSnapshot(ctx?.fetch ?? globalThis.fetch);
        if (next) store.set({ snapshot: next, open: false });
      };
      return h('div', { className: 'cg-at-bubble', role: 'dialog', 'aria-label': labels.title, onKeyDown: (event) => { if (event?.key === 'Escape') store.set({ open: false }); } },
        h('div', { className: 'cg-at-title' }, labels.title),
        h('label', { className: 'cg-at-row' }, labels.percent,
          h('input', {
            type: 'number', min: 0, max: 100, step: 1, value: draft, 'aria-label': labels.percent,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event?.key === 'Enter') save(); },
          })),
        h('div', { className: 'cg-at-info' }, renderBubbleText(view ?? {}, labels)),
        error === '' ? null : h('div', { className: 'cg-at-error', role: 'alert' }, `${labels.invalid}: ${error}`),
        h('button', { type: 'button', className: 'cg-at-save', onClick: save }, labels.save),
        h('button', { type: 'button', className: 'cg-at-settings-link', onClick: () => { try { ctx?.openSettings?.(); } catch { /* ignore */ } } }, labels.openSettings),
      );
    };

    /** 设置页卡片（保留 `20bf20d` 的 settings.section；同一份数据/写入口）。 */
    const createSettingsCard = (state, store) => (props) => {
      const ctx = props?.ctx ?? props;
      const labels = pickLabels(ctx);
      const [view, setView] = react.useState(state.snapshot);
      const [draft, setDraft] = react.useState('');
      const [error, setError] = react.useState('');
      react.useEffect(() => store.subscribe((next) => setView(next.snapshot))(), [store]);
      react.useEffect(() => {
        let alive = true;
        fetchSnapshot(ctx?.fetch ?? globalThis.fetch).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); });
        return () => { alive = false; };
      }, [ctx, store]);
      const save = async () => {
        const result = computeSave(draft, view ?? {});
        if (result.ok !== true) { setError(result.reason); return; }
        const ok = await saveRatio(ctx, result.ratio);
        if (!ok) { setError(labels.invalid); return; }
        setError('');
        const next = await fetchSnapshot(ctx?.fetch ?? globalThis.fetch);
        if (next) store.set({ snapshot: next });
      };
      return h('div', { className: 'cg-settings-card' },
        h('div', { className: 'cg-settings-title' }, labels.title),
        h('label', { className: 'cg-settings-row' }, labels.percent,
          h('input', { type: 'number', min: 0, max: 100, step: 1, value: draft, 'aria-label': labels.percent, onChange: (event) => setDraft(event.target.value) })),
        h('div', { className: 'cg-settings-info' }, renderBubbleText(view ?? {}, labels)),
        error === '' ? null : h('div', { className: 'cg-settings-error', role: 'alert' }, `${labels.invalid}: ${error}`),
        h('button', { type: 'button', className: 'cg-settings-save', onClick: save }, labels.save));
    };

    const inject = ['slots', 'locale', 'configForms'];

    /** 注册三处入口（C12：dock id/order；C15：slot 缺失时逐个 try，不崩）。 */
    const registrationPlan = (state) => [
      { slot: 'conversation.composer.dock', id: 'context-governance.at', order: 6, component: 'chip' },
      { slot: 'conversation.input.overlay', id: 'context-governance.overlay', order: 60, component: 'bubble' },
      { slot: 'settings.section', id: 'context-governance', order: 60, component: 'section' },
    ];

    const apply = (ctx) => {
      const state = createViewState();
      const store = createStore(state);
      const components = { chip: createChip(state, store), bubble: createBubble(state, store), section: createSettingsCard(state, store) };
      const labels = pickLabels(ctx);
      // 一次性诊断（低噪）：下次真机预验据此区分"没加载 / 加载了没挂上 / slot 名不对"。
      console.info('[context-governance] client apply', {
        slots: typeof ctx?.slots?.inject === 'function' && typeof ctx?.slots?.register === 'function',
        configForms: typeof ctx?.get === 'function' && ctx.get('configForms') !== undefined,
        locale: typeof ctx?.locale?.language === 'string',
      });
      const slots = ctx?.slots;
      if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        // 服务迟挂：宿主没给 slots 时只留 warn，不静默、也不抛（设置页仍可由宿主后续重试挂载）。
        console.warn('[context-governance] client apply: slots service unavailable; composer chip / overlay / settings section not registered');
        return;
      }
      for (const entry of registrationPlan(state)) {
        try {
          // 关键：slot 是按界面声明、可能"先无后有"；先 inject 等声明，再 register。
          // 声明后 register 仍可能抛（宿主契约不符）——必须 warn 带 slot 名，不许无痕吞。
          const dispose = slots.inject(entry.slot, () => {
            try {
              return slots.register({
                name: entry.slot,
                id: entry.id,
                order: entry.order,
                label: () => labels.sectionLabel,
                inject: () => inject,
              }, components[entry.component]);
            } catch (error) {
              console.warn('[context-governance] slot register failed', entry.slot, String(error?.message ?? error));
              return undefined;
            }
          });
          if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => () => { try { dispose(); } catch { /* ignore */ } }, `context-governance: slot ${entry.slot}`);
          }
          console.info('[context-governance] slot watched', entry.slot);
        } catch (error) {
          // C17：不许无痕吞错——带 slot 名与原因。
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
      saveRatio,
      effectiveTextFor,
      WRITE_LAYER,
      toPercentText,
      toRatio,
      validateRatio,
      fetchSnapshot,
    };
  },
});

