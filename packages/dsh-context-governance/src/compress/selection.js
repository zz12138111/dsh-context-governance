/**
 * 后端选择与降级判定（架构 §6.7 / §6.8）。
 *
 * M1 的“回退”不是替用户换引擎——插件不拥有 `ctx.compaction`，
 * 换后端必须由人改 profile 并重启。这里的“选择”只决定**治理层自己**以什么模式工作：
 *
 *   full                     事件级感知 + 摘要可读 → 保护校验 + （T4）回注
 *   degraded-summary-unreadable  摘要不可读 → 只放 ID+状态；保护校验降为“尽力”
 *   observe-only             后端未知/自检失败/版本出矩阵 → 只做观测与审计，不干预
 *   disabled                 配置关闭
 *
 * 同时输出“建议人工回退”的信息，供 `/cg status` 与审计使用。
 */

export const MODES = Object.freeze([
  'full',
  'event-level',
  'degraded-summary-unreadable',
  'degraded-protection',
  'observe-only',
  'disabled',
]);

const CONFLICT_DEFS = Object.freeze({
  'no-compaction-service': 'warning',
  'unknown-provider': 'warning',
  'event-api-unavailable': 'error',
  'self-check-failed': 'error',
  'host-version-unverified': 'warning',
  'host-version-out-of-matrix': 'error',
  'backend-version-unverified': 'warning',
  'backend-version-out-of-matrix': 'error',
  'summary-provider-drift': 'warning',
});

/**
 * 从适配器自检结果收集冲突项；不抛错。
 *
 * @param {{adapter:object, eventApi?:boolean}} options
 * @returns {Array<{code:string, severity:string, message:string}>}
 */
export function detectConflicts({ adapter, eventApi = true } = {}) {
  const conflicts = [];
  const add = (code, message) => {
    conflicts.push({ code, severity: CONFLICT_DEFS[code] ?? 'warning', message });
  };
  if (adapter === null || typeof adapter !== 'object') {
    add('unknown-provider', 'adapter is missing');
    return conflicts;
  }
  if (adapter.kind === 'none') add('no-compaction-service', 'ctx.compaction is not mounted; governance can only observe sessions');
  if (adapter.kind === 'unknown') add('unknown-provider', `${adapter.label} is not a verified compaction backend`);
  if (eventApi !== true) add('event-api-unavailable', 'ctx.on is unavailable; compaction/* events cannot be observed');
  for (const item of adapter.selfCheck?.checks ?? []) {
    if (item.id === 'host-version' && item.status === 'warn') add('host-version-unverified', item.detail);
    if (item.id === 'host-version' && item.status === 'fail') add('host-version-out-of-matrix', item.detail);
    if (item.id === 'backend-version' && item.status === 'warn') add('backend-version-unverified', item.detail);
    if (item.id === 'backend-version' && item.status === 'fail') add('backend-version-out-of-matrix', item.detail);
    if (item.status === 'fail' && item.id !== 'host-version' && item.id !== 'backend-version') {
      add('self-check-failed', `${item.id}: ${item.detail}`);
    }
  }
  if (adapter.kind === 'host-basic' && adapter.summary.style === 'five-section') {
    add('summary-provider-drift', 'host-basic adapter observed a five-section summary; the provider may have changed after startup');
  }
  if (adapter.kind === 'context-zip' && adapter.summary.style === 'free-form') {
    add('summary-provider-drift', 'context-zip adapter observed a free-form summary; the takeover may be stale or session mode=default');
  }
  return conflicts;
}

/**
 * 选择治理层工作模式。
 *
 * @param {object} options
 * @param {object} options.adapter
 * @param {boolean} [options.eventApi]
 * @param {boolean} [options.enabled]
 * @param {'readable'|'partial'|'unreadable'|'unknown'} [options.summaryReadability]
 * @param {object} [options.matrix]
 */
export function selectMode({
  adapter,
  eventApi = true,
  enabled = true,
  summaryReadability = adapter?.summary?.readability ?? 'unknown',
} = {}) {
  if (enabled === false) {
    return {
      mode: 'disabled',
      reasons: ['config-disabled'],
      conflicts: detectConflicts({ adapter, eventApi }),
      fallback: null,
    };
  }
  const conflicts = detectConflicts({ adapter, eventApi });
  if (adapter === null || adapter.kind === 'none') {
    // provider 拿不到时仍可用 E1 验证过的事件级感知（session/event 里的 compaction/*）。
    if (eventApi) {
      return {
        mode: 'event-level',
        reasons: ['no-compaction-service', 'event-perception-only'],
        conflicts,
        fallback: null,
      };
    }
    return {
      mode: 'observe-only',
      reasons: ['no-compaction-service', 'event-api-unavailable'],
      conflicts,
      fallback: null,
    };
  }
  const hard = conflicts.filter((conflict) => conflict.severity === 'error');
  if (adapter.kind === 'unknown' || hard.length > 0) {
    return {
      mode: 'observe-only',
      reasons: conflicts.map((conflict) => conflict.code),
      conflicts,
      fallback: adapter?.kind === 'context-zip'
        ? {
          recommended: 'host-default',
          manual: true,
          note: 'context-zip 自检失败：由人改 profile 回到宿主默认压缩并重启；治理层不替换 provider',
        }
        : null,
    };
  }
  if (summaryReadability === 'unreadable') {
    return {
      mode: 'degraded-summary-unreadable',
      reasons: ['summary-unreadable'],
      conflicts,
      fallback: null,
    };
  }
  return {
    mode: 'full',
    reasons: [],
    conflicts,
    fallback: null,
  };
}
