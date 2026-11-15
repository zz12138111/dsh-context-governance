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
    /**
     * B6（rc.14）：气泡必须 portal 到 `document.body` 再定位。
     * 在 `conversation.input.overlay` 的容器里用 `position: fixed`，会被宿主祖先链上的
     * `transform/filter/contain` 劫持成"相对该容器"定位（真机：面板跑右下角、被裁切），
     * 容器自身若铺满且不透明还会整块盖住对话区。portal 只挪**单个面板节点**，
     * 不把入口组件整体搬走（`dsh-doc`：不要往 body 追加第二个应用）。
     */
    const reactDom = (() => {
      try { return require('react-dom'); } catch { return null; }
    })();
    const portalToBody = (node) => {
      if (reactDom === null || reactDom === undefined || typeof reactDom.createPortal !== 'function') return null;
      const doc = globalThis.document ?? null;
      if (doc === null || doc.body === null || doc.body === undefined) return null;
      try { return reactDom.createPortal(node, doc.body); } catch { return null; }
    };
    let portalWarned = false;
    /** B6：portal 不可用只告警一次；不渲染（绝不退回 slot 开在错误位置）。 */
    const warnPortalMissingOnce = () => {
      if (portalWarned) return;
      portalWarned = true;
      try { console.warn('[context-governance] portal unavailable; popover hidden'); } catch { /* ignore */ }
    };

    const ENTRY_ID = 'dsh-context-governance';
    const SNAPSHOT_PATH = '/context-governance/policy-snapshot';
    /** rc.9：快照必须带会话上下文；设置页显式要全局。 */
    const SNAPSHOT_PATH_SESSION = '/context-governance/policy-snapshot?session=';
    const SNAPSHOT_PATH_GLOBAL = '/context-governance/policy-snapshot?scope=global';
    /** P5：写请求的同源凭据头（token 由快照下发；外部脚本不可知）。 */
    const CSRF_HEADER = 'x-context-governance-csrf';
    let csrfToken = null;
    const SESSION_POLICY_PATH = '/context-governance/session-policy';
    const PLUGIN_POLICY_PATH = '/context-governance/plugin-policy';
    const AT_MIN = 0.2;
    const LOW_THRESHOLD_ACK_MIN = 0.3;
    const PROJECT_AT_MIN = 0.45;
    const USABLE_MARGIN = 0.02;
    const FALLBACK_DEFAULT_AT = 0.6;
    const LABELS = {
      zh: {
        sectionLabel: '上下文治理', title: '压缩触发阈值', current: '当前生效', source: '来源层', when: '生效时点', note: '备注',
        writeLayer: '本次修改写入：全局（plugin 层，影响所有会话）',
        writeLayerSession: '本次修改写入：本会话（session:A2，重启保留）',
        // B1（rc.12 · 用户拍板「必须修」）：A1 生效不得与"重启失效"并列——主标签按**已保存**口径，
        // 附注交代"当前进程内即时生效；重启后从已保存值读回"，写入层与主标签同口径。
        writeLayerSessionA1: '本次修改写入：本会话（已落 A2，重启保留；当前进程内即时生效）',
        writeLayerSessionIdle: '本次修改写入：本会话（保存后即时生效并落 A2，重启保留）',
        // B1 不变式：写入层一旦说「重启保留」，生命周期就必须是「已保存」；纯 session 层不落此坑。
        writeLayerSessionVolatile: '本次修改写入：本会话（保存后即时生效并落 A2，重启后从 A2 读回）',
        // B2（rc.12）：reset 成功后写入层必须换口径，不能还挂着上一次的 A2 完成时文案。
        writeLayerReset: (layer = '全局/项目层') => `本次修改写入：已清除本会话覆盖（A1+A2），当前生效来自${layer}`,
        writeLayerGlobal: '本次修改写入：全局（plugin 层，影响所有会话）',
        overrideNote: '本会话已自定义，全局修改不影响本会话（清除用 /cg set reset）',
        noSession: '无会话标识：会话级保存不可用（不会退化为全局写入）',
        percent: '触发百分比', unit: '%', save: '保存到本会话', saveGlobal: '保存为全局', saving: '保存中…',
        saved: '已保存', restore: '恢复默认', resetGlobal: '恢复全局设置', retry: '重试', loading: '读取中…', unavailable: '暂不可用', invalid: '输入无效',
        openSettings: '打开设置页', chipUnknown: '压 —', chip: (t) => `压 ${t}`,
      },
      en: {
        sectionLabel: 'Context governance', title: 'Compaction threshold', current: 'Effective', source: 'Source layer', when: 'Takes effect', note: 'Note',
        writeLayer: 'Writes to: global (plugin layer, affects all sessions)',
        writeLayerSession: 'Writes to: this session (session:A2, survives restart)',
        writeLayerSessionA1: 'Writes to: this session (already persisted to A2, survives restart; immediate in this process)',
        writeLayerSessionIdle: 'Writes to: this session (takes effect immediately and persists to A2, survives restart)',
        writeLayerReset: (layer = 'global/project layer') => `Writes to: session override cleared (A1+A2); current value comes from ${layer}`,
        writeLayerGlobal: 'Writes to: global (plugin layer, affects all sessions)',
        overrideNote: 'This session is customized; global changes do not affect it (clear with /cg set reset)',
        noSession: 'No session id: session-level save unavailable (never falls back to global)',
        percent: 'Trigger percent', unit: '%', save: 'Save to this session', saveGlobal: 'Save globally', saving: 'Saving…',
        saved: 'Saved', restore: 'Restore default', resetGlobal: 'Reset to global', retry: 'Retry', loading: 'Loading…', unavailable: 'Unavailable', invalid: 'Invalid input',
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
    /**
     * B1（rc.12 · 用户拍板必须修）：**展示层来源**。
     *
     * 保存链路同时写 A1（进程内即时值）与 A2（落盘值），宿主解析时优先报 `session:A1`；
     * 于是气泡出现「来源层·临时（重启失效）」与「写入层·A2（重启保留）」并列，用户读成保存无效。
     * 展示口径改为：A1 一律按**已保存**（`session:A2`）呈现，另以附注交代"当前进程内即时生效"，
     * 原始键仍留在附注里（`source=session:A1`）供诊断；生效时点行同步成"已保存，重启保留"。
     * 断言这层不变式：**任何"已保存/重启保留"标签旁边不得出现"重启后失效"**。
     */
    const displaySourceFor = (source) => {
      const key = String(source ?? 'unknown');
      if (key === 'session:A1') {
        return {
          labelKey: 'session:A2',
          note: '当前进程内即时生效（原始层 source=session:A1）；重启后从已保存值读回',
        };
      }
      return { labelKey: key, note: null };
    };
    /**
     * C40 / B3（rc.12）：chip 弹层几何——**默认向上**，仅上方空间不足（< 面板高 + 16）时翻下方；
     * 不做左右翻转；水平中心对齐 chip（偏差 ≤8，必要时整体平移贴边）。
     *
     * 硬线（需求 C40 §4/§5）：
     * - 上弹：底边 ≤ 输入框顶 − 4；下弹：顶边 ≥ 输入框底 + 4；与输入框交集必须为 0；
     * - 任意边距视口 ≥ 8px；宽 ≤ min(360, 视口宽 − 16)；高 ≤ 260（内部滚动）。
     *
     * 入参 rect 均按 `{x, y, width, height}`（与 `getBoundingClientRect()` 同形，DOM 侧取回后直接传）。
     * @returns {{x:number, y:number, left:number, top:number, width:number, height:number,
     *   placement:'up'|'down'}}
     */
    const computePopoverRect = ({ chip = {}, panel = {}, viewport = {}, input = null } = {}) => {
      const EDGE = 8;
      const GAP = 16;        // 与 chip 的间距（下弹时贴 chip 下沿 + 16）
      const INPUT_GAP = 4;   // 输入框硬线间距
      const viewportWidth = Number(viewport.width ?? 0) || 1024;
      const viewportHeight = Number(viewport.height ?? 0) || 768;
      const width = Math.max(120, Math.min(Number(panel.width ?? 320), 360, viewportWidth - 2 * EDGE));
      const wanted = Math.max(80, Math.min(Number(panel.height ?? 240), 260));
      const chipX = Number(chip.x ?? 0);
      const chipY = Number(chip.y ?? 0);
      const chipW = Number(chip.width ?? 0);
      const chipH = Number(chip.height ?? 0);
      const chipCenter = chipX + chipW / 2;
      const chipTop = chipY;
      const chipBottom = chipY + chipH;
      const inputTop = input === null || input === undefined ? null : Number(input.y ?? 0);
      const inputBottom = inputTop === null ? null : inputTop + Number(input.height ?? 0);
      let height = wanted;
      // ① 先定方向：上方够 → 向上；否则向下（先定方向再出现，不跳位）。
      let placement = chipTop >= height + GAP ? 'up' : 'down';
      let top = placement === 'up' ? chipTop - height : chipBottom + GAP;
      if (placement === 'down' && top + height > viewportHeight - EDGE) {
        // 下方也放不下：允许压缩高度（内部滚动），但既不越界也不盖输入框。
        height = Math.max(80, viewportHeight - EDGE - top);
      }
      // ② 输入框硬线避让（上弹压底边、下弹抬顶边）。
      if (inputTop !== null && placement === 'up') top = Math.min(top, inputTop - INPUT_GAP - height);
      if (inputBottom !== null && placement === 'down') top = Math.max(top, inputBottom + INPUT_GAP);
      // ③ 视口垂直 clamp（必要时换向，仍满足步 ②）。
      if (top < EDGE) {
        placement = 'down';
        const downTop = Math.max(chipBottom + GAP, inputBottom === null ? 0 : inputBottom + INPUT_GAP);
        height = Math.min(height, Math.max(80, viewportHeight - EDGE - downTop));
        top = downTop;
      }
      if (top + height > viewportHeight - EDGE) height = Math.max(80, viewportHeight - EDGE - top);
      // ④ 水平：中心对齐 chip，再整体平移到边距内（不做左右翻转）。
      let left = Math.round(chipCenter - width / 2);
      left = Math.max(EDGE, Math.min(left, viewportWidth - width - EDGE));
      return { x: left, y: Math.round(top), left, top: Math.round(top), width, height, placement };
    };
    /**
     * B6（rc.14）：把"写进 style 的坐标"与"实际渲染出来的矩形"对齐。
     *
     * 真机 rc.13 现象：面板出现在窗口右下角、脱离 chip 且被裁切。根因是 `position: fixed` 的
     * **包含块不是视口**——overlay 宿主的祖先链若有 `transform/filter/contain`，fixed 会退化成
     * 相对该宿主定位，于是"视口坐标"被叠加到宿主原点上，面板整体偏移并越界。
     *
     * 做法：应用一次坐标后量一次真实矩形，把差值反补进 left/top（`measured - intended` 的负值），
     * 再按视口夹紧到 8px 边距内。差值 ≤1px 视为已对齐（返回 null，避免来回抖动）。
     */
    const correctPopoverRect = ({ intended = {}, measured = {}, viewport = {}, margin = 8 } = {}) => {
      const intendedLeft = Number(intended.left ?? intended.x);
      const intendedTop = Number(intended.top ?? intended.y);
      const measuredLeft = Number(measured.left ?? measured.x);
      const measuredTop = Number(measured.top ?? measured.y);
      if (![intendedLeft, intendedTop, measuredLeft, measuredTop].every((value) => Number.isFinite(value))) return null;
      const dx = measuredLeft - intendedLeft;
      const dy = measuredTop - intendedTop;
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return null;
      const width = Number(measured.width ?? intended.width ?? 320);
      const height = Number(measured.height ?? intended.height ?? 240);
      const viewportWidth = Number(viewport.width ?? 0) || 1024;
      const viewportHeight = Number(viewport.height ?? 0) || 768;
      let left = Math.round(intendedLeft - dx);
      let top = Math.round(intendedTop - dy);
      left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
      top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
      return { left, top, x: left, y: top, width, height, placement: intended.placement ?? 'up' };
    };

    const compactBubbleLines = (snapshot = null, { lastAction = null } = {}) => {
      const ready = snapshot !== null && snapshot !== undefined;
      if (!ready) return ['—', '读取中…', ''];
      const source = String(snapshot.source ?? 'unknown');
      const percent = toPercentText(snapshot.at);
      let state;
      let effect;
      if (lastAction === 'reset') {
        state = '已清除本会话覆盖';
        effect = '重启后仍生效';
      } else if (lastAction === 'save' && source === 'session:A1') {
        state = '本会话·已保存（重启保留）';
        effect = '重启后从已保存值读回';
      } else if (source === 'session:A2') {
        state = '本会话·已保存（重启保留）';
        effect = '重启后仍生效';
      } else if (source === 'session:A1' || source === 'session') {
        state = '本会话·临时（重启失效）';
        effect = '重启后失效';
      } else if (source === 'session') {
        state = '本会话·临时（重启失效）';
        effect = '重启后失效';
      } else {
        state = layerLabel(source);
        effect = '重启后仍生效';
      }
      return [percent, state, effect].filter((line) => line !== '');
    };


    const writeLayerTextFor = (entry = 'session', { source = null, lastAction = null } = {}) => {
      if (lastAction === 'reset') {
        const layer = String(source ?? '') === 'unknown' ? '全局/项目层' : layerLabel(source);
        return LABELS.zh.writeLayerReset(layer);
      }
      if (entry === 'global') return LABELS.zh.writeLayerGlobal;
      const key = String(source ?? '');
      // B1：A1 生效时按"已保存"口径说（禁止与"重启后失效"并列）；其它来源保持原口径。
      if (key === 'session:A1') return LABELS.zh.writeLayerSessionA1;
      // 纯 `session` 层（保守口径：只保证进程内）不再声称"重启保留"，避免与生命周期行打架。
      if (key === 'session') return LABELS.zh.writeLayerSessionVolatile;
      return LABELS.zh.writeLayerSession;
    };
    /** reset 成功后需要回填的 UI 状态：输入框跟随生效值、写层换口径（B2，单测直接断言它）。 */
    const stateAfterReset = (snapshot = null) => ({
      lastAction: 'reset',
      draft: Number.isFinite(snapshot?.at) ? String(Math.round(snapshot.at * 100)) : null,
      source: typeof snapshot?.source === 'string' ? snapshot.source : null,
    });
    /** 保存成功后：写层回到"本会话"口径（清掉 reset 残留）。 */
    const stateAfterSave = (snapshot = null) => ({
      lastAction: 'save',
      draft: Number.isFinite(snapshot?.at) ? String(Math.round(snapshot.at * 100)) : null,
      source: typeof snapshot?.source === 'string' ? snapshot.source : null,
    });
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
      if (csrfToken === null) { try { await fetchSnapshot(fetchImpl, { sessionId }); } catch { /* 取不到 token 时写请求会 403 并显示原因 */ } }
      try {
        const response = await fetchImpl(SESSION_POLICY_PATH, {
          method: 'POST',
          headers: writeHeaders(),
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

    /**
     * C29：恢复全局设置——清掉本会话覆盖（A1+A2 同清），与服务端 `/cg set reset` 同一条链路。
     * 成功后 chip/气泡回落到项目模板/plugin（快照按 ?session= 重取）。
     */
    const resetSessionAt = async ({ sessionId, fetchImpl = globalThis.fetch } = {}) => {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: LABELS.zh.noSession, requestSent: false };
      if (typeof fetchImpl !== 'function') return { ok: false, error: 'no-fetch', requestSent: false };
      if (csrfToken === null) { try { await fetchSnapshot(fetchImpl, { sessionId }); } catch { /* ignore */ } }
      try {
        const response = await fetchImpl(SESSION_POLICY_PATH, {
          method: 'POST',
          headers: writeHeaders(),
          body: JSON.stringify({ sessionId, reset: true }),
        });
        if (response && response.ok === true) return { ok: true, requestSent: true };
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
          headers: writeHeaders(),
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
    const bubbleView = (snapshot, { lastAction = null } = {}) => {
      const ready = snapshot !== null && snapshot !== undefined;
      const display = displaySourceFor(ready ? snapshot.source : null);
      return {
        ready,
        title: LABELS.zh.title,
        percentText: ready ? toPercentText(snapshot.at) : '—',
        fields: [
          `${LABELS.zh.source}：${ready ? `${layerLabel(display.labelKey)} (source=${display.labelKey})` : '—'}`,
          `${LABELS.zh.when}：${ready ? effectiveTextFor(display.labelKey) : '—'}`,
          // B1：A1 生效时补一行附注，交代"进程内即时 / 重启读回"，原始键留在附注里。
          ...(ready && display.note !== null ? [`备注：${display.note}`] : []),
          writeLayerTextFor('session', { source: ready ? snapshot.source : null, lastAction }),
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
    /** C40 §3：技术细节只在二级/设置页（带 `source=`、层级代码、写入层；**不进主视图**）。 */
    const renderBubbleDetail = (snapshot = {}, labels = LABELS.zh, { entry = 'session', lastAction = null } = {}) => {
      const rawSource = snapshot.source;
      const display = displaySourceFor(rawSource ?? 'unknown');
      const source = display.labelKey;
      const sessionCustomized = /^session(:|$)/.test(String(source));
      return [
        `${labels.current}: ${toPercentText(snapshot.at)}`,
        `${labels.source}: ${layerLabel(source)} (source=${source})`,
        `${labels.when}: ${effectiveTextFor(source)}`,
        ...(display.note !== null ? [`${labels.note ?? '备注'}: ${display.note}`] : []),
        writeLayerTextFor(entry, { source: rawSource ?? null, lastAction }),
        ...(entry === 'global' && sessionCustomized ? [labels.overrideNote ?? LABELS.zh.overrideNote] : []),
      ].join('\n');
    };
    /**
     * B11（rc.17）硬优先级：**控件不可裁 > 内容区保底**。
     *
     * 极端窄面板下 footer 可能到 5 排（≈182px）。若内容区仍死守 96，则 96+182+44=322 > 260 → 溢出被裁。
     * 规则：内容区保底随 footer 增大而让位——
     *   `available = 260 − footer − chrome`；`bodyFloor = min(96, max(0, available))`；
     *   `height = min(260, max(bodyScroll, bodyFloor) + footer + chrome)`。
     * 结果：footer 永远完整、面板永不溢出、内容区负责滚动。
     */
    const computeBodyFloor = ({ footerHeight = 0, chrome = 44, maxHeight = 260, minContent = 96 } = {}) => (
      Math.min(minContent, Math.max(0, maxHeight - (Number(footerHeight) || 0) - (Number(chrome) || 0)))
    );
    const computePopoverHeight = ({ bodyScroll = 0, footerHeight = 0, chrome = 44, minContent = 96, maxHeight = 260 } = {}) => {
      const footer = Number(footerHeight) || 0;
      const framed = Number(chrome) || 0;
      const bodyFloor = computeBodyFloor({ footerHeight: footer, chrome: framed, maxHeight, minContent });
      const content = Math.max(Number(bodyScroll) || 0, bodyFloor);
      return Math.min(maxHeight, Math.ceil(content + footer + framed));
    };
    /**
     * B10（rc.16）：校正环保护——两个矩形"够近"就视为同一个，返回 true 让调用方保留旧对象
     * （`setLayout(prev => same ? prev : next)`），避免每次都给新对象触发无意义重渲染。
     */
    const samePopoverRect = (a, b) => {
      if (a === null || a === undefined || b === null || b === undefined) return false;
      const parts = ['left', 'top', 'width', 'height'];
      return parts.every((key) => Math.abs(Number(a[key] ?? 0) - Number(b[key] ?? 0)) <= 1)
        && String(a.placement ?? '') === String(b.placement ?? '');
    };
    /** C40 §2：**主视图**（气泡）= 至多三行短句，禁技术字段；细节走 enderBubbleDetail。 */


    const renderBubbleText = (snapshot = {}, labels = LABELS.zh, options = {}) => (
      compactBubbleLines(snapshot, options).join('\n')
    );

    /**
     * rc.9：快照 URL 必须带会话上下文——chip/气泡显示的是**本会话**生效值，
     * 设置页卡片显式要全局（`scope=global`），否则三处都只能看"最近一次任意会话/全局"。
     */
    const snapshotUrl = ({ sessionId = null, scope = null } = {}) => {
      if (typeof sessionId === 'string' && sessionId !== '') return `${SNAPSHOT_PATH_SESSION}${encodeURIComponent(sessionId)}`;
      if (scope === 'global') return SNAPSHOT_PATH_GLOBAL;
      return SNAPSHOT_PATH;
    };

    const writeHeaders = () => ({
      'content-type': 'application/json',
      accept: 'application/json',
      ...(csrfToken === null ? {} : { [CSRF_HEADER]: csrfToken }),
    });

    /** 拉取快照：失败 warn + 3 次退避（C19）；导出供假 fetch 序列单测。 */
    const fetchSnapshotWithRetry = async (
      fetchImpl = globalThis.fetch,
      { attempts = 3, delays = [300, 1000], warn = console.warn, sessionId = null, scope = null } = {},
    ) => {
      if (typeof fetchImpl !== 'function') {
        warn('[context-governance] snapshot fetch unavailable: fetch missing');
        return null;
      }
      const url = snapshotUrl({ sessionId, scope });
      let reason = 'unknown';
      for (let index = 0; index < attempts; index += 1) {
        try {
          const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
          if (response && response.ok === true) {
            const body = await response.json();
            if (body !== null && typeof body === 'object' && typeof body.csrfToken === 'string' && body.csrfToken !== '') csrfToken = body.csrfToken;
            return body;
          }
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
    const fetchSnapshot = (fetchImpl = globalThis.fetch, options = undefined) => fetchSnapshotWithRetry(fetchImpl, options);

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
      // B8：内容区独立滚动（minHeight:0 是 flex 子项能滚动的前提），footer 不参与滚动。
      // B9：内容区至少保留 96px（低于此优先压内容区滚动，绝不再压 footer）。
      // B11：内容区保底**不写死**——由 computeBodyFloor 按 footer 实际高度动态给（footer 越大让位越多）。
      popoverBody: { display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
      // B9：操作区两排（输入行 + 按钮行），总高 ≤88px，常驻不滚。
      // B11：单行优先——窄输入框放最左，四按钮各自 flexShrink:0（**按钮永不被裁**，不够就换行）。
      // B11（审核裁决 A）：**不设 maxHeight / overflow:hidden**——宁可 footer 高一点也不能裁控件。
      // 最坏 3 排 ≈106px，面板预算 96 + 106 + 44 = 246 ≤ 260 仍成立；高度由实测 effect 吸收。
      popoverFooter: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flex: '0 0 auto', flexShrink: 0 },
      popoverFooterInput: { width: 56, minWidth: 56, flex: '0 0 56px', padding: '6px 8px', fontSize: 14, borderRadius: 8, border: '1px solid var(--dsh-border, #444)', background: 'var(--dsh-bg, #1e1e1e)', color: 'var(--dsh-fg, #e6e6e6)', textAlign: 'right' },
      popoverFooterButton: { flex: '0 0 auto', flexShrink: 0, whiteSpace: 'nowrap' },
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
        const refresh = () => { fetchSnapshot(globalThis.fetch, { sessionId: sessionIdOf(props, ctx) }).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); }); };
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
        onClick: (event) => {
          // B6：在自己被点击的这一刻量 rect（同文档坐标），供气泡定位；不依赖跨 slot 的 querySelector。
          let anchor = null;
          try {
            const rect = event?.currentTarget?.getBoundingClientRect?.();
            if (rect) anchor = { x: rect.x ?? rect.left, y: rect.y ?? rect.top, width: rect.width, height: rect.height };
          } catch { anchor = null; }
          store.set({ open: closeDecision('chip') ? !state.open : true, ...(anchor === null ? {} : { anchor }) });
        },
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
      // B2（rc.12）：记录最近一次动作——'reset' → 写层说"已清除覆盖"；'save' → 回会话口径。
      const [lastAction, setLastAction] = react.useState(null);
      // C40：技术细节默认收起（主视图只三行短句），一键展开。
      const [showDetail, setShowDetail] = react.useState(false);
      const inputRef = react.useRef(null);
      const dialogRef = react.useRef(null);
      const bodyRef = react.useRef(null);
      const footerRef = react.useRef(null);
      // C40 §4：切会话自动关（弹层只对当前会话有意义，切走后必须收起，避免误写错会话）。
      const lastSessionRef = react.useRef(sessionId);
      react.useEffect(() => {
        const previous = lastSessionRef.current;
        lastSessionRef.current = sessionId;
        if (previous !== sessionId && open === true) store.set({ open: false });
      }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
      react.useEffect(() => store.subscribe((next) => { setView(next.snapshot); setOpen(next.open); }), [store]);
      // U1/U7：打开即聚焦并全选；重开回到当前生效值（不保留草稿）。
      react.useEffect(() => {
        if (!open) { setDraft(''); setError(''); setSaved(false); setLastAction(null); return; }
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
        fetchSnapshot(globalThis.fetch, { sessionId }).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); });
        return () => { alive = false; };
      }, [open, ctx, store]);
      const close = () => {
        if (!closeDecision('escape')) return;
        store.set({ open: false });
        // C40 §4：关闭后焦点回到 chip（键盘用户不丢位置）。
        try { globalThis.document?.querySelector?.('[data-cg-chip]')?.focus?.(); } catch { /* ignore */ }
      };
      /**
       * C40：打开时按 chip / 输入框的真实 `getBoundingClientRect()` 定位——
       * 向上默认，上方不足才翻下，四边贴边 clamp，绝不遮输入框；面板 ≤min(360,视口−16)×260。
       * 先定方向再出现（`visibility` 在拿到 rect 前保持 hidden，避免跳位）。
       *
       * ⚠️ B5（rc.12a）：**hook 必须放在 `if (!open) return null` 之前**——
       * 放到早退之后会让"关闭→打开"的 hook 数量从 14 变 16，React 抛
       * "Rendered more hooks than during the previous render"，整个气泡崩掉（真机 chip/气泡齐哑）。
       */
      const [layout, setLayout] = react.useState(null);
      // B11：内容区动态保底（默认 96；footer 变大时自动让位，避免顶穿面板）。
      const [bodyMin, setBodyMin] = react.useState(96);
      const viewportRef = react.useRef(null);
      const chipRectRef = react.useRef(null);
      // B10：每次打开只允许校正一次（否则测量持续失配会无限重渲染）。
      const correctedOnceRef = react.useRef(false);
      const composerRectRef = react.useRef(null);
      react.useEffect(() => {
        correctedOnceRef.current = false;
        if (!open) { setLayout(null); return; }
        const doc = globalThis.document ?? null;
        const toRect = (element) => {
          try {
            const rect = element?.getBoundingClientRect?.();
            return rect === undefined || rect === null
              ? null
              : { x: rect.x ?? rect.left, y: rect.y ?? rect.top, width: rect.width, height: rect.height };
          } catch { return null; }
        };
        // B6：锚点优先用 chip 点击时**自己量到的** rect（同文档坐标，绕开 shadow/宿主差异）；
        // 拿不到再查 DOM；**都不猜角落**（rc.13 的右下角面板就是猜 (innerWidth-120, innerHeight-120) 的结果）。
        const anchorFromStore = (() => {
          try { return store?.get?.()?.anchor ?? null; } catch { return null; }
        })();
        const chipRect = (anchorFromStore !== null && Number.isFinite(anchorFromStore?.width)
          ? anchorFromStore
          : toRect(doc?.querySelector?.('[data-cg-chip]')));
        if (chipRect === null) {
          setLayout(null);
          return;
        }
        const inputRect = toRect(doc?.querySelector?.('[data-cg-composer]'))
          ?? toRect(doc?.querySelector?.('textarea'))
          ?? null;
        const viewport = {
          width: globalThis.innerWidth ?? doc?.documentElement?.clientWidth ?? 1024,
          height: globalThis.innerHeight ?? doc?.documentElement?.clientHeight ?? 768,
        };
        viewportRef.current = viewport;
        chipRectRef.current = chipRect;
        composerRectRef.current = inputRect;
        const lines = compactBubbleLines(view ?? null, { lastAction });
        // B10：第一趟也走统一算法（不带旧的 96+行数*22+64 猜测式）：footer 先按上限 88 估，
        // 第二趟再用实测覆盖。
        const desired = computePopoverHeight({ bodyScroll: 0, footerHeight: 88, chrome: 44 });
        setLayout(computePopoverRect({ chip: chipRect, panel: { width: 320, height: desired }, viewport, input: inputRect }));
      }, [open, lastAction, view?.at, view?.source]);
      /**
       * B6 第二趟：`position: fixed` 的包含块可能不是视口（祖先有 transform/filter/contain），
       * 于是写进去的视口坐标会被宿主原点再叠加一次 → 面板跑到右下角并被裁。
       * 这里量一次真实矩形，把差值反补回去（只做一趟，差值 ≤1px 不动作，避免抖动）。
       */
      react.useEffect(() => {
        if (open !== true || layout === null) return;
        // B10 ①：每次打开**只校正一次**（关闭/重开由首趟 effect 重置），否则偏移仍在时会无限重渲染。
        if (correctedOnceRef.current === true) return;
        try {
          const rect = dialogRef.current?.getBoundingClientRect?.();
          if (rect === undefined || rect === null) return;
          // B10 ②：**不可测就不校正**。元素未布局/隐藏（0×0）时校正只会把布局推到 0，进而无限循环。
          if (Number(rect.width) < 1 || Number(rect.height) < 1) return;
          const corrected = correctPopoverRect({
            intended: layout,
            measured: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            viewport: viewportRef.current ?? {},
          });
          correctedOnceRef.current = true;
          // B6 诊断（只 info 一行，便于下次截图取证）：portal 生效后仍需要 >1px 校正，
          // 说明还有别的 containing block 在劫持，记下来别当遮羞布。
          try {
            console.info('[context-governance] popover-rect ' + JSON.stringify({
              placement: layout.placement,
              intended: { left: layout.left, top: layout.top, width: layout.width, height: layout.height },
              measured: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
              corrected: corrected === null ? null : { left: corrected.left, top: corrected.top },
              portaled: true,
            }));
          } catch { /* 诊断失败不影响定位 */ }
          // B10 ③：同值返回 prev，避免新对象触发无意义重渲染。
          if (corrected !== null) setLayout((prev) => (samePopoverRect(prev, corrected) ? prev : corrected));
        } catch { /* 量不到就保持第一趟结果 */ }
      }, [layout, open]);
      /**
       * B8：高度**用实测**，不再猜 96+行数*22+64。
       * 读内容区 `scrollHeight` + footer 实际高度 + padding/border，`min(260, 实测)` 重算一次几何；
       * 与当前高度差 ≤1px 就停——避免与 `correctPopoverRect` 互相推动形成校正环。
       * `showDetail` 变化也要重算（展开详情会改变内容高度，否则又会出界）。
       */
      react.useEffect(() => {
        if (open !== true || layout === null) return;
        try {
          const panelEl = dialogRef.current;
          const bodyEl = bodyRef.current;
          const footerEl = footerRef.current;
          const footerHeight = Number(footerEl?.getBoundingClientRect?.().height ?? 0);
          const bodyScroll = Number(bodyEl?.scrollHeight ?? 0);
          if (!(bodyScroll > 0) && !(footerHeight > 0)) return;
          // B9：不再硬编码 `+34`。padding/border/flex gap 全部从**面板实算样式**读，
          // 免得漏算 gap（B8 那条 10px 洞）或 footer 内部新增的两排 gap。
          let chrome = 44; // 兜底：padding 16×2 + border 1×2 + gap 10
          try {
            const cs = globalThis.getComputedStyle?.(panelEl) ?? null;
            if (cs !== null) {
              const px = (value) => { const n = Number.parseFloat(String(value ?? '')); return Number.isFinite(n) ? n : 0; };
              chrome = px(cs.paddingTop) + px(cs.paddingBottom)
                + px(cs.borderTopWidth) + px(cs.borderBottomWidth)
                + px(cs.rowGap === 'normal' ? cs.gap : cs.rowGap);
            }
          } catch { /* 拿不到 computed 就用兜底 */ }
          // B9：走带**下限**的统一算法（内容区 96 保底 + footer + chrome），避免内容少时裁掉 footer。
          const floor = computeBodyFloor({ footerHeight, chrome });
          setBodyMin((prev) => (prev === floor ? prev : floor));
          const desired = computePopoverHeight({ bodyScroll, footerHeight, chrome });
          if (Math.abs(desired - layout.height) <= 1) return;
          const chip = chipRectRef.current;
          const viewport = viewportRef.current;
          if (chip === null || viewport === null) return;
          setLayout((prev) => (prev === null ? prev : computePopoverRect({
            chip,
            panel: { width: prev.width, height: desired },
            viewport,
            input: composerRectRef.current,
          })));
        } catch { /* 量不到就用第一趟几何 */ }
      }, [open, showDetail, layout?.height, view?.at, lastAction]);
      if (!open) return null;
      const model = bubbleView(view ?? null, { lastAction });
      // B6：portal 后 wrapper 负责定位（fixed 相对视口），只让面板吃指针事件。
      const popoverStyle = layout === null
        ? { ...S.dialog, visibility: 'hidden' }
        : {
          position: 'fixed',
          left: `${layout.left}px`,
          top: `${layout.top}px`,
          width: `${layout.width}px`,
          // B8：**确定高度**（px）。只给 maxHeight 时，面板的 `maxHeight:100%` 会解析为 none，
          // 面板按自然高度长并穿过窗口下沿被裁（rc.14 真机按钮不可见的根因）。
          height: `${layout.height}px`,
          overflow: 'hidden',
          // wrapper 透明、且不吃指针：对话区在它下面仍然可见/可滚/可点（B6 第二条判据）。
          pointerEvents: 'none',
          background: 'transparent',
          boxSizing: 'border-box',
          // 层级用 10000 量级：盖住 composer，但不压住宿主 modal/menu/toast（审核口径）。
          zIndex: 10000,
        };
      const panelStyle = layout === null
        ? { ...S.dialog, visibility: 'hidden' }
        : {
          ...S.dialog,
          // 面板 = flex 列：内容区滚动，footer 常驻（B8）。
          pointerEvents: 'auto',
          width: '100%',
          height: '100%',
          maxHeight: '100%',
          overflow: 'hidden',
          boxSizing: 'border-box',
        };
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
        const next = await fetchSnapshot(globalThis.fetch, { sessionId });
        // B1/B2：保存成功也走同一刷新路径——输入框跟随生效值、写层回会话口径。
        const state2 = stateAfterSave(next);
        if (state2.draft !== null) setDraft(state2.draft);
        setLastAction('save');
        store.set(next ? { snapshot: next } : {});
      };
      const onBlurField = () => {
        const result = computeSave(draft, view ?? {});
        setError(result.ok === true ? '' : result.reason);
      };
      // C29：恢复全局设置（清本会话 A1+A2 → 回落 project/plugin），与服务端 /cg set reset 同一链路。
      const resetToGlobal = async () => {
        const result = await resetSessionAt({ sessionId });
        if (result.ok !== true) { setError(result.error); return; }
        setError('');
        const next = await fetchSnapshot(globalThis.fetch, { sessionId });
        // B2（rc.12）：成功后必须同步刷新值/来源层/生命周期/写入层——不能只换快照、留着旧输入与旧写层。
        const state2 = stateAfterReset(next);
        if (state2.draft !== null) setDraft(state2.draft);
        setLastAction('reset');
        setSaved(false);
        store.set(next ? { snapshot: next } : {});
      };
      const retry = () => { fetchSnapshot(globalThis.fetch, { sessionId }).then((snapshot) => { if (snapshot) store.set({ snapshot }); }); };
      const dialogNode = h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': model.title,
        'data-cg-panel': '1', ref: dialogRef, style: panelStyle,
        tabIndex: -1,
        onKeyDown: (event) => { if (event?.key === 'Escape') { event.stopPropagation?.(); close(); } },
        onBlur: (event) => { const next = event?.relatedTarget; if (next !== null && next !== undefined && !event.currentTarget?.contains?.(next)) close(); },
      },
        // B8：**内容区可滚、footer 常驻**——按钮行永远在滚动区外，用户不需要滚动就能点。
        h('div', {
          key: 'body',
          'data-cg-body': '1',
          ref: bodyRef,
          style: { ...S.popoverBody, minHeight: bodyMin },
        },
          h('div', { style: { ...S.title, flexShrink: 0 } }, model.title),
          h('div', { style: { ...S.big, flexShrink: 0 }, 'data-role': 'current-percent' }, model.percentText),
          // C40：主视图只三行短句；技术细节进「详情」（默认收起，仍可一键展开）。
          ...compactBubbleLines(view ?? {}, { lastAction }).map((line, index) => h('div', { key: `main${index}`, style: { ...S.metaLine, flexShrink: 0 } }, line)),
          h('div', { key: 'detail', 'data-role': 'detail', style: showDetail ? undefined : { display: 'none' } },
            ...renderBubbleDetail(view ?? {}, labels, { entry: 'session', lastAction }).split('\n').map((line, index) => h('div', { key: `detail${index}`, style: S.metaLine }, line))),
          h('button', { key: 'detail-toggle', type: 'button', className: 'cg-detail-toggle', style: { ...S.button, flexShrink: 0 }, onClick: () => setShowDetail(showDetail !== true) }, showDetail === true ? labels.hideDetail : labels.detail),
          sessionId === null ? h('div', { style: S.error }, labels.noSession ?? LABELS.zh.noSession) : null,
          h('div', { role: 'alert', 'aria-live': 'polite', style: { ...S.error, flexShrink: 0 } }, error),
        ),
        // footer：**不在滚动区内**（flex:0 0 auto）。B9/B11：窄输入框放在按钮行**左侧同一排**，
        // 四个按钮各自 flexShrink:0 —— 宽度不够时**只让输入框换行/压缩，绝不裁按钮**。
        h('div', { key: 'footer', 'data-cg-footer': '1', ref: footerRef, style: S.popoverFooter },
          h('input', {
            key: 'footer-input',
            ref: inputRef, type: 'text', inputMode: 'numeric', value: draft, 'aria-label': labels.percent,
            'aria-invalid': error === '' ? 'false' : 'true',
            'data-cg-footer-input': '1',
            style: error === '' ? S.popoverFooterInput : { ...S.popoverFooterInput, ...S.inputError },
            onChange: (event) => { setDraft(normalizePercentInput(event.target.value)); setSaved(false); },
            onBlur: onBlurField,
            onKeyDown: (event) => { if (event?.key === 'Enter') { event.preventDefault?.(); save(); } if (event?.key === 'Escape') { close(); } },
          }),
          h('span', { key: 'footer-unit', style: { ...S.metaLine, flexShrink: 0 } }, labels.unit),
          h('button', {
            key: 'footer-reset-global',
            type: 'button',
            className: 'cg-reset-global',
            style: { ...(canSaveSession ? S.button : { ...S.button, ...S.buttonDisabled }), ...S.popoverFooterButton },
            onClick: resetToGlobal,
            disabled: !canSaveSession,
          }, labels.resetGlobal ?? '恢复全局设置'),
          model.ready ? null : h('button', { key: 'footer-retry', type: 'button', style: { ...S.button, ...S.popoverFooterButton }, onClick: retry }, labels.retry),
          h('button', {
            key: 'footer-save',
            type: 'button',
            style: { ...(canSaveSession && !saving ? { ...S.button, ...S.buttonPrimary } : { ...S.button, ...S.buttonPrimary, ...S.buttonDisabled }), ...S.popoverFooterButton },
            onClick: save,
            disabled: !canSaveSession || saving,
          }, saving ? labels.saving : saved ? labels.saved : labels.save),
        ),
      );
      // B6：portal 到 body 后 fixed 的包含块才是视口。只 portal **这一个面板节点**（不搬入口组件）。
      // 拿不到 react-dom → **不渲染 + warn**（宁可不开，也绝不退回 slot 里开在错位置）。
      const wrapper = h('div', {
        'data-cg-popover': '1',
        'data-cg-portaled': '1',
        style: popoverStyle,
      }, dialogNode);
      const portaled = portalToBody(wrapper);
      if (portaled === null) {
        warnPortalMissingOnce();
        return null;
      }
      return portaled;
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
        fetchSnapshot(globalThis.fetch, { scope: 'global' }).then((snapshot) => { if (alive && snapshot) store.set({ snapshot }); });
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
        const next = await fetchSnapshot(globalThis.fetch, { scope: 'global' });
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
      displaySourceFor,
      computePopoverRect,
      computePopoverHeight,
      computeBodyFloor,
      correctPopoverRect,
      samePopoverRect,
      compactBubbleLines,
      renderBubbleDetail,
      stateAfterReset,
      stateAfterSave,
      saveSessionAt,
      resetSessionAt,
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
      CSRF_HEADER,
      csrfTokenValue: () => csrfToken,
      createChip,
      createBubble,
      createSettingsCard,
    };
  },
});








