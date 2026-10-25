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

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 校验单层配置。未知键/未知类型/越界 → 整层拒绝（返回 invalid 列表）。
 * @param {object} raw
 * @param {{source: string, native: number, sessionLayer?: boolean}} options
 */
export function validateLayer(raw, { source = 'builtin', native = NATIVE_DEFAULT_RATIO, sessionLayer = false } = {}) {
  const invalid = [];
  const values = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { values: {}, invalid: [{ source, key: '*', reason: 'layer-must-be-object' }] };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!POLICY_KEYS.includes(key)) {
      invalid.push({ source, key, reason: 'unknown-key' });
      continue;
    }
    if (sessionLayer && !SESSION_KEYS.includes(key)) {
      invalid.push({ source, key, reason: 'config-only' });
      continue;
    }
    switch (key) {
      case 'compact.at': {
        if (typeof value !== 'number' || !Number.isFinite(value)) { invalid.push({ source, key, reason: 'not-number' }); break; }
        if (value < 0.2) { invalid.push({ source, key, reason: 'below-min', detail: 'compact.at 下限 0.20' }); break; }
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
  return `compact.at=${at.toFixed(2)} (source=${source}) native=${policy.native} early=${policy.early ? 'ready' : 'off'}`;
}

/** 四层来源逐键展开（供 /cg policy show）。 */
export function policyTable(policy) {
  return POLICY_KEYS.map((key) => {
    const value = policy.values[key];
    const text = value === null ? 'null' : String(value);
    return `${key}=${text} (source=${policy.sources[key]})`;
  });
}
