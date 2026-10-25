/**
 * M2 策略层（REQ-20261025-09 T1/T2，0.2.0）。
 *
 * 纯函数模块：四层配置合并、范围校验、native 计算与展示辅助。
 * 不做提前压、不调用宿主引擎、不读写会话；只产出“生效值 + 来源链”。
 *
 * 合成顺序（低 → 高）：内置 → 标签层（profile 预设）→ 插件配置 → 项目 .cg-policy.json → 会话 /cg set。
 * 显式层（会话 > 项目 > 插件）> 标签层 > 内置默认（与 REQ-20261025-09 一致）。
 */

export const POLICY_DEFAULTS = Object.freeze({
  'compact.at': 0.60,
  'compact.early': true,
  'compact.cooldownMin': 10,
  'compact.minDeltaTokens': 20000,
  'compact.estimateSafety': 1.35,
  'compact.lowThresholdAck': false,
  'cost.remainingTurns': null,
});

export const POLICY_KEYS = Object.freeze(Object.keys(POLICY_DEFAULTS));

/** 允许 `/cg set` 的键；其余只能从配置文件读。 */
export const SESSION_KEYS = Object.freeze([
  'compact.at',
  'compact.early',
  'compact.cooldownMin',
  'compact.minDeltaTokens',
  'cost.remainingTurns',
]);

export const CONFIG_ONLY_KEYS = Object.freeze([
  'compact.estimateSafety',
  'compact.lowThresholdAck',
]);

/** profile 预设（按会话打标；research 默认关闭提前压）。 */
export const PROFILE_PRESETS = Object.freeze({
  batch: Object.freeze({ 'compact.at': 0.45 }),
  coding: Object.freeze({}),
  review: Object.freeze({ 'compact.at': 0.55 }),
  research: Object.freeze({ 'compact.early': false }),
});

export const NATIVE_DEFAULT_RATIO = 0.6785;
export const NATIVE_HEADROOM_TOKENS = 65536;
export const NATIVE_RATIO_CAP = 0.8;

/** `compact.at` 绝对下限（任何层）。 */
export const AT_MIN = 0.2;
/** 项目层下限：仓库自带的 `.cg-policy.json` 不能把阈值压得过低。 */
export const PROJECT_AT_MIN = 0.45;
/** 项目文件大小上限（防巨型文件拖慢 apply 时的同步读）。 */
export const POLICY_FILE_MAX_BYTES = 64 * 1024;

/**
 * 计算宿主原生触发点比例：
 *   native = floor(min(W × 0.8, W − O − 65536)) / W
 * 1M 窗口 + 256k 输出预留 ≈ 67.85%。
 */
export function nativeRatio({ windowTokens, reservedTokens } = {}) {
  const window = Number(windowTokens);
  const reserved = Number.isFinite(Number(reservedTokens)) ? Number(reservedTokens) : 0;
  if (!Number.isFinite(window) || window <= 0) return NATIVE_DEFAULT_RATIO;
  const tokens = Math.floor(Math.min(window * NATIVE_RATIO_CAP, window - reserved - NATIVE_HEADROOM_TOKENS));
  if (!Number.isFinite(tokens) || tokens <= 0) return NATIVE_DEFAULT_RATIO;
  return Math.round((tokens / window) * 10000) / 10000;
}

/**
 * 观测窗口（0.2.1，DEC-20261025-66 + DEC-20261025-68 退化口径 A）的 native：
 *   - W 非法（非正整数）→ { native: null, reason: 'window-invalid' }（unknown，回退配置）
 *   - W ≤ O + 65536（预留比窗口还大）→ { native: null, reason: 'degenerate' }（**不造 0、不造 0.6785**）
 *   - 否则 floor(min(W×0.8, W−O−65536))/W
 * 退化时 native 不可计算：任何设置 at 的层都必须拒绝（调用方负责）。
 */
export function nativeFromWindow({ windowTokens, reservedTokens } = {}) {
  const window = Number(windowTokens);
  if (!Number.isInteger(window) || window <= 0) return { native: null, reason: 'window-invalid' };
  const reserved = Number.isFinite(Number(reservedTokens)) ? Number(reservedTokens) : 0;
  const headroom = Math.min(window * NATIVE_RATIO_CAP, window - reserved - NATIVE_HEADROOM_TOKENS);
  if (!(headroom > 0)) return { native: null, reason: 'degenerate' };
  return { native: Math.round((Math.floor(headroom) / window) * 10000) / 10000, reason: null };
}

/** 短 session id（DEC-66：window= 后面必须带）。 */
export function shortSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return '-';
  const raw = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  return raw.slice(0, 8);
}

/** `/cg status` 的 window 行（current / conservative / 来源 / 时间 / 校验口径）。 */
export function summarizeWindow(window) {
  const fmtWindow = (tokens, sessionId) => (tokens === null || tokens === undefined
    ? 'unknown'
    : `${formatWindow(tokens)} (session ${shortSessionId(sessionId)})`);
  const current = window === null || window === undefined
    ? 'window: current=unknown'
    : `window: current=${fmtWindow(window.currentTokens, window.currentSessionId)}` +
      (window.currentObservedAt === null || window.currentObservedAt === undefined ? '' : ` observed ${window.currentObservedAt}`) +
      ` source=${window.currentSource}` +
      (window.removed === true ? ' (removed by request/context)' : '');
  if (window === null || window === undefined) {
    return `${current} conservative=unknown native-current=- (config-fallback)`;
  }
  const conservative = window.conservativeTokens === null || window.conservativeTokens === undefined
    ? 'unknown'
    : `${formatWindow(window.conservativeTokens)} (session ${shortSessionId(window.conservativeSessionId)})`;
  // 退化（DEC-20261025-68 A）：native 不可计算，显示 unknown (degenerate: W=… O=…)，不造数。
  const degenerate = window.degenerate === true;
  const degenerateDetail = degenerate
    ? `unknown (degenerate: W=${formatWindow(window.degenerateWindowTokens)} O=${formatWindow(window.reservedTokens)})`
    : null;
  const nativeCurrent = degenerate
    ? degenerateDetail
    : (window.native === null || window.native === undefined ? '-' : Number(window.native).toFixed(4));
  const nativeConservative = degenerate
    ? degenerateDetail
    : (window.nativeConservative === null || window.nativeConservative === undefined
      ? '-'
      : Number(window.nativeConservative).toFixed(4));
  const validated = degenerate
    ? 'unverified-degenerate'
    : (window.validated === true ? 'validated' : 'unvalidated (at 允许但未经保守窗口校验)');
  const mismatch = window.conservativeTokens !== null && window.conservativeTokens !== window.currentTokens
    ? ' 校验按 conservative'
    : '';
  const nativeSource = String(window.currentSource).startsWith('projection') ? 'projection' : 'config-fallback';
  return `${current} conservative=${conservative} native-current=${nativeCurrent}(${nativeSource}) ` +
    `native-conservative=${nativeConservative} ${validated}${mismatch}`;
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 校验单层配置。未知键/未知类型/越界/该层不允许的键 → 整层拒绝（返回 invalid 列表）。
 *
 * `sessionLayer`：只允许 `/cg set` 子集（安全参数只能从配置文件改）。
 * `projectLayer`：仓库自带文件是新输入面——禁改安全参数，且 `compact.at` 有更高下限。
 *
 * @param {object} raw
 * @param {{source: string, native: number, sessionLayer?: boolean, projectLayer?: boolean}} options
 */
export function validateLayer(raw, { source = 'builtin', native = NATIVE_DEFAULT_RATIO, sessionLayer = false, projectLayer = false } = {}) {
  const invalid = [];
  const values = {};
  const atMin = projectLayer ? PROJECT_AT_MIN : AT_MIN;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { values: {}, invalid: [{ source, key: '*', reason: 'layer-must-be-object' }] };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!POLICY_KEYS.includes(key)) {
      invalid.push({ source, key, reason: 'unknown-key' });
      continue;
    }
    if ((sessionLayer || projectLayer) && !SESSION_KEYS.includes(key)) {
      // 项目层与 /cg set 都不得改 estimateSafety / lowThresholdAck（防仓库自盖确认）。
      invalid.push({
        source,
        key,
        reason: projectLayer ? 'project-denied' : 'config-only',
        detail: projectLayer ? '项目层禁改安全参数' : undefined,
      });
      continue;
    }
    switch (key) {
      case 'compact.at': {
        if (typeof value !== 'number' || !Number.isFinite(value)) { invalid.push({ source, key, reason: 'not-number' }); break; }
        if (value < atMin) {
          invalid.push({
            source,
            key,
            reason: 'below-min',
            detail: projectLayer ? `项目层 compact.at 下限 ${PROJECT_AT_MIN}` : `compact.at 下限 ${AT_MIN}`,
          });
          break;
        }
        if (value > native + 1e-9) {
          invalid.push({ source, key, reason: 'over-native', detail: '超过宿主原生触发点，M2 不支持推迟' });
          break;
        }
        values[key] = value;
        break;
      }
      case 'compact.early': {
        if (typeof value !== 'boolean') { invalid.push({ source, key, reason: 'not-boolean' }); break; }
        values[key] = value;
        break;
      }
      case 'compact.cooldownMin': {
        if (!isInteger(value) || value < 1) { invalid.push({ source, key, reason: 'invalid-range', detail: 'cooldownMin 需 ≥1 整数' }); break; }
        values[key] = value;
        break;
      }
      case 'compact.minDeltaTokens': {
        if (!isInteger(value) || value < 0) { invalid.push({ source, key, reason: 'invalid-range', detail: 'minDeltaTokens 需 ≥0 整数' }); break; }
        values[key] = value;
        break;
      }
      case 'compact.estimateSafety': {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1.6) {
          invalid.push({ source, key, reason: 'invalid-range', detail: 'estimateSafety 需 1.0–1.6' });
          break;
        }
        values[key] = value;
        break;
      }
      case 'compact.lowThresholdAck': {
        if (typeof value !== 'boolean') { invalid.push({ source, key, reason: 'not-boolean' }); break; }
        values[key] = value;
        break;
      }
      case 'cost.remainingTurns': {
        if (value !== null && (!isInteger(value) || value < 0)) {
          invalid.push({ source, key, reason: 'invalid-range', detail: 'remainingTurns 需 null 或 ≥0 整数' });
          break;
        }
        values[key] = value;
        break;
      }
      default:
        invalid.push({ source, key, reason: 'unknown-key' });
    }
  }
  // 项目层按不可信输入处理：任一键被拒 → 整层拒绝（不逐键降级），退回下一层生效。
  if (projectLayer && invalid.length > 0) return { values: {}, invalid };
  return { values, invalid };
}

/**
 * 合并层并产出“生效值 + 每键来源”。
 * @param {Array<{source: string, values: object}>} layers 低 → 高。
 * @param {{native: number}} options
 */
export function resolvePolicy(layers = [], { native = NATIVE_DEFAULT_RATIO } = {}) {
  const values = { ...POLICY_DEFAULTS };
  const sources = {};
  for (const key of POLICY_KEYS) sources[key] = 'builtin';
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values ?? {})) {
      if (!POLICY_KEYS.includes(key)) continue;
      values[key] = value;
      sources[key] = layer.source;
    }
  }
  // <0.30 需要显式确认（lowThresholdAck），否则该键退回上一层：这里直接拒绝并回退内置值。
  const invalid = [];
  if (values['compact.at'] < 0.30 && values['compact.lowThresholdAck'] !== true) {
    invalid.push({
      source: sources['compact.at'],
      key: 'compact.at',
      reason: 'low-threshold-unacked',
      detail: 'compact.at<0.30 需 compact.lowThresholdAck=true',
    });
    values['compact.at'] = POLICY_DEFAULTS['compact.at'];
    sources['compact.at'] = 'builtin';
  }
  return {
    values,
    sources,
    invalid,
    native,
    early: values['compact.early'] === true,
  };
}

/** profile 标签层的值（未知 profile 返回空层）。 */
export function profileLayer(profileName) {
  if (typeof profileName !== 'string' || profileName === '') return null;
  const preset = PROFILE_PRESETS[profileName];
  if (preset === undefined) return null;
  return { source: `profile=${profileName}`, values: { ...preset } };
}

/** `/cg policy show` 与 `/cg status` 共用的一行式摘要。 */
export function summarizePolicy(policy) {
  const at = policy.values['compact.at'];
  const source = policy.sources['compact.at'];
  // 0.2.1：有窗口观测时 native 用现算值，并标来源（config-fallback 必须可辨）。
  const window = policy.window ?? null;
  const nativeValue = window?.native ?? policy.native;
  const nativeText = window === null || window === undefined
    ? String(nativeValue)
    : window.degenerate === true
      ? 'unknown (degenerate)'
      : `${nativeValue === null ? '-' : nativeValue} (${String(window.currentSource).startsWith('projection') ? window.currentSource : 'config-fallback'})`;
  return `compact.at=${at.toFixed(2)} (source=${source}) native=${nativeText} early=${policy.early ? 'on' : 'off'}`;
}

/** 四层来源逐键展开（供 /cg policy show）。 */
export function policyTable(policy) {
  return POLICY_KEYS.map((key) => {
    const value = policy.values[key];
    const text = value === null ? 'null' : String(value);
    return `${key}=${text} (source=${policy.sources[key]})`;
  });
}

/**
 * 合并两类 invalid（层校验拒绝 + resolve 回退去重），供 `/cg status`、`/cg policy show` 共用。
 * @param {{invalid?: Array<object>}|null} policyState buildPolicyState 的结果
 * @param {{invalid?: Array<object>}|null} resolved resolve() 的结果
 */
export function collectInvalid(policyState = null, resolved = null) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (item === null || typeof item !== 'object') return;
    const key = `${item.source}|${item.key}|${item.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const item of policyState?.invalid ?? []) push(item);
  for (const item of resolved?.invalid ?? []) push(item);
  return items;
}

/** `source/key:reason` 单行摘要（截断到 max 条，余量写 +N）。 */
export function formatInvalid(items = [], max = 5) {
  const list = Array.isArray(items) ? items : [];
  const shown = list.slice(0, max).map((item) => `${item.source}/${item.key}:${item.reason}`);
  if (list.length > max) shown.push(`+${list.length - max}`);
  return shown.join(', ');
}

/** 层级链展示：空层标 `(empty)`，避免被误读成“该项目层已生效”。 */
export function layerChain(policy) {
  const layers = Array.isArray(policy?.layers) ? policy.layers : [];
  if (layers.length === 0) return 'builtin';
  return layers
    .map((layer) => {
      const values = layer?.values ?? {};
      const empty = Object.keys(values).length === 0;
      return empty ? `${layer.source} (empty)` : layer.source;
    })
    .join(' -> ');
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 运行时压力四段（0.2.0 只展示，不据此压缩）：
 *   measured  = 最近 assistant/message.usage 的上下文侧 token / window
 *   estimated = tokenMeter 估算 token / window
 *   adjusted  = estimated × estimateSafety
 *   effective = max(measured, adjusted)
 *   ratio     = measured / estimated（估算是不是偏低）
 *
 * 任一来源缺失保持 null（不伪造），effective 只取已知项的最大值。
 */
export function computePressure({
  measuredTokens = null,
  estimatedTokens = null,
  windowTokens,
  estimateSafety = POLICY_DEFAULTS['compact.estimateSafety'],
} = {}) {
  const window = Number(windowTokens);
  const validWindow = Number.isFinite(window) && window > 0;
  const ratioOf = (tokens) => (validWindow && Number.isFinite(tokens) && tokens >= 0 ? round3(tokens / window) : null);
  const measured = ratioOf(measuredTokens);
  const estimated = ratioOf(estimatedTokens);
  const safety = Number.isFinite(estimateSafety) ? estimateSafety : null;
  const adjusted = estimated === null || safety === null ? null : round3(estimated * safety);
  const known = [measured, adjusted].filter((value) => value !== null);
  const effective = known.length === 0 ? null : Math.max(...known);
  const ratio = measured === null || estimated === null || estimated === 0
    ? null
    : Math.round((measured / estimated) * 100) / 100;
  return {
    measured,
    estimated,
    adjusted,
    effective,
    ratio,
    safety,
    windowTokens: validWindow ? window : null,
  };
}

/** 窗口展示：1M / 128k / 256k（十进制优先，其次 2 的幂），否则 1.00M / 256k；P3-3：压力行必须能看出分母。 */
function formatWindow(value) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`;
  if (value >= 1024 * 1024 && value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}M`;
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024}k`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/** 压力行（`/cg status`）：缺失项写 `-` 并标原因，不写假数字。 */
export function summarizePressure(pressure, { at = null, sessionId = null, windowSource = null } = {}) {
  const known = pressure !== null && typeof pressure === 'object';
  const fmt = (value) => (value === null || value === undefined ? '-' : Number(value).toFixed(3));
  const safety = known && pressure.adjusted !== null && pressure.safety !== null ? `(×${pressure.safety})` : '';
  const ratio = known && pressure.ratio !== null ? pressure.ratio.toFixed(2) : '-';
  const windowValue = known ? formatWindow(pressure.windowTokens) : '-';
  // DEC-20261025-66：window= 后带 session 短 id；P3-1：无观察时标 config-fallback。
  let window;
  if (sessionId !== null && sessionId !== undefined) window = `window=${windowValue} (session ${shortSessionId(sessionId)})`;
  else if (windowSource === 'config-fallback') window = `window=${windowValue} (config-fallback)`;
  else window = `window=${windowValue}`;
  const head = `measured=${fmt(known ? pressure.measured : null)} ` +
    `estimated=${fmt(known ? pressure.estimated : null)} ` +
    `adjusted=${fmt(known ? pressure.adjusted : null)}${safety} ` +
    `effective=${fmt(known ? pressure.effective : null)} ratio=${ratio} ${window}`;
  if (!known || pressure.effective === null) return `pressure: ${head} (no usage/tokenMeter yet)`;
  const threshold = Number.isFinite(at) ? ` at=${Number(at).toFixed(2)} effective${pressure.effective >= at ? '>=' : '<'}at` : '';
  return `pressure: ${head}${threshold}`;
}
