/**
 * 1.1.0 D2：设置页 → 策略的纯函数层（可单测，无副作用、不引宿主依赖）。
 *
 * 数据来源：Schemastery `.volatile()` 字段 `config.policy.at`（0–1 比例；设置页按 0–100 百分比输入）。
 * 约束：`.volatile()` 只允许固定路径，而 `policy.values['compact.at']` 是 dict 动态键，
 * 所以 D2 新增固定字段 `policy.at`，由 `mergeSettingsAt()` 合入 plugin 层 values。
 */

/**
 * 生命周期文案（C8，随 source 派生）：
 * - `session` 层：本会话有效，重启后失效；
 * - 持久层（plugin/profile/project/builtin）：保存后生效、重启仍有效。
 * 降级开关：R7 若确认热更新实际未生效，只改 `PERSISTENT_LIFECYCLE_TEXT` 这一串（不动派生逻辑）。
 */
export const PERSISTENT_LIFECYCLE_TEXT = '保存后生效、重启仍有效';
export const SESSION_LIFECYCLE_TEXT = '本会话有效，重启后失效';

/** 按来源层派生生命周期文案。 */
export function lifecycleText(source) {
  return source === 'session' ? SESSION_LIFECYCLE_TEXT : PERSISTENT_LIFECYCLE_TEXT;
}

/** 写入层静态文案（C11）：UI 只有一个写入口（profile Cordis patch → plugin 配置层）。 */
export const WRITE_LAYER_TEXT = '本次修改写入：plugin 层（profile patch）';

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
    effectiveAt: lifecycleText(source),
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

/**
 * 只读快照 HTTP handler（C10 单测直接调用；index 只负责注册）。
 * 仅 GET；非 GET → 405。只写阈值/来源 JSON，无记忆内容、无本机路径。
 * @param {{getPolicy: () => object, getNative: () => number|null}} deps
 */
export function createSnapshotHandler({ getPolicy, getNative }) {
  return (req, res) => {
    if (req?.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end();
      return;
    }
    try {
      const view = policySnapshot(getPolicy(), { native: typeof getNative === 'function' ? getNative() : null });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(view));
    } catch {
      res.writeHead(500);
      res.end();
    }
  };
}
