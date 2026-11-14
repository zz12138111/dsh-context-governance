/**
 * 1.1.0 D2：设置页 → 策略的纯函数层（可单测，无副作用、不引宿主依赖）。
 *
 * 数据来源：Schemastery `.volatile()` 字段 `config.policy.at`（0–1 比例；设置页按 0–100 百分比输入）。
 * 约束：`.volatile()` 只允许固定路径，而 `policy.values['compact.at']` 是 dict 动态键，
 * 所以 D2 新增固定字段 `policy.at`，由 `mergeSettingsAt()` 合入 plugin 层 values。
 */

/** 生效时点文案（C11 钉死位置：R7 若确认热更新未生效，只改这一句）。 */
export const EFFECTIVE_AT_TEXT = '立即生效（保存后重新加载配置）';

/** 读 volatile 引用（`.get()`）或普通数字；非法/缺失 → null。 */
export function readVolatileAt(config) {
  try {
    const raw = config?.policy?.at;
    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
    return Number.isFinite(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

/**
 * 把设置页字段合并进 plugin 层 values（不改原对象）。
 * `policy.at` 缺省/非法时原样返回 config（不影响既有配置行为）。
 */
export function mergeSettingsAt(config, at = readVolatileAt(config)) {
  if (config === null || typeof config !== 'object') return config;
  if (!Number.isFinite(at)) return config;
  const values = { ...(config.policy?.values ?? {}), 'compact.at': Number(at) };
  return { ...config, policy: { ...config.policy, values } };
}

/**
 * 快照视图（GET 路由与 client 渲染共用口径）：只出阈值/来源信息。
 * @param {{values:object, sources:object}} policy `policy.resolve()` 结果
 * @param {{native?:number|null}} extra
 */
export function policySnapshot(policy, { native = null } = {}) {
  const values = policy?.values ?? {};
  const sources = policy?.sources ?? {};
  const at = Number.isFinite(values['compact.at']) ? values['compact.at'] : null;
  const source = typeof sources['compact.at'] === 'string' ? sources['compact.at'] : 'builtin';
  return {
    at,
    source,
    sessionOverride: source === 'session' && at !== null ? at : null,
    effectiveAt: EFFECTIVE_AT_TEXT,
    native: Number.isFinite(native) ? Number(native) : null,
  };
}

/** 百分比（0–100）→ 比例；非法返回 null。 */
export function percentToRatio(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value) / 100;
}

/** 比例 → 百分比文本（整数，如 0.6 → "60%"）。 */
export function ratioToPercentText(at) {
  return Number.isFinite(at) ? `${Math.round(Number(at) * 100)}%` : '—';
}
