/**
 * C38 ③：会话记忆审计的**共享去重器**。
 *
 * 背景（rc.10 必闭）：`mem_*` 与 header 注入走 `auditMemoryEvent`（按 `sessionId|id|reason` 去重），
 * 但 `/cg memory show` 自带一套直写 `audit.append` → 同一条指针同一原因会写两行
 * （真机 `03:24:28` / `03:25:03` 两条 `body-missing`）。去重器必须只有一份，所有路径共用。
 *
 * 语义：
 * - 只对 `dedupeEvents`（默认 `memory-pointer-miss`）去重；其它事件原样透传；
 * - 去重键 = `sessionId|id|reason`（reason 缺省为空串）；
 * - 有界：超过 `limit` 按插入顺序淘汰最旧的键，避免长期运行无界增长；
 * - 审计失败绝不影响业务流程（内部 try/catch）。
 */

export const MEMORY_MISS_EVENT = 'memory-pointer-miss';
export const DEFAULT_DEDUPE_LIMIT = 2000;

/**
 * @param {{sink?: (event: string, details: object) => void, limit?: number,
 *   dedupeEvents?: string[], seen?: Set<string>}} options
 * @returns {(event: string, details?: object) => void}
 */
export function createDedupedMemoryAudit({
  sink = null,
  limit = DEFAULT_DEDUPE_LIMIT,
  dedupeEvents = [MEMORY_MISS_EVENT],
  seen = new Set(),
} = {}) {
  const events = new Set(dedupeEvents);
  const max = Math.max(Number(limit) || DEFAULT_DEDUPE_LIMIT, 1);
  return (event, details = {}) => {
    if (events.has(event)) {
      const key = `${details?.sessionId ?? ''}|${details?.id ?? ''}|${details?.reason ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > max) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    }
    try {
      sink?.(event, details);
    } catch {
      /* 审计失败不影响记忆读写 */
    }
  };
}

/**
 * P3（rc.11）：命令面/工具面记忆审计**按会话根路由**（G 不落 D）。
 *
 * rc.10 缺陷：`/cg memory show`、`mem_*`、header 注入的审计一律写主根 `audit.jsonl`；
 * 会话实际受治根是 G 时，这些行落在 D 的审计里 → 回溯该根时看不到自己的 miss/截断。
 *
 * 路由顺序（每行只落一处）：
 *   ① 该会话根已打开（guard 已建）→ 用它的审计；
 *   ② 否则按 registry 解析该会话根的 entry，**根目录仍存在**才为它开审计（按 rootId 缓存成功实例）；
 *   ③ 都取不到 → `fallback`（主根审计）。
 *
 * P4 联动：② 里根目录不存在时**不建目录、不写**（不得伪造根），直接走 fallback；
 * 失败不缓存，用户把根恢复后下一行会落到正确位置。
 *
 * @param {{
 *   auditForSessionId?: (sessionId: string) => ({append?: Function}|null),
 *   resolveEntry?: (sessionId: string) => ({root?: string, rootId?: string}|null),
 *   openRootAudit?: (entry: object) => ({append?: Function}|null),
 *   fallback?: ({append?: Function}|null), limit?: number, dedupeEvents?: string[],
 * }} options
 * @returns {(event: string, details?: object) => void}
 */
export function createRootRoutedMemoryAudit({
  auditForSessionId = () => null,
  resolveEntry = () => null,
  openRootAudit = () => null,
  fallback = null,
  limit = DEFAULT_DEDUPE_LIMIT,
  dedupeEvents = [MEMORY_MISS_EVENT],
} = {}) {
  const opened = new Map();
  const routed = (event, details = {}) => {
    const sessionId = typeof details?.sessionId === 'string' ? details.sessionId : '';
    let target = null;
    if (sessionId !== '') {
      try { target = auditForSessionId(sessionId) ?? null; } catch { target = null; }
      if (target === null) {
        let entry = null;
        try { entry = resolveEntry(sessionId) ?? null; } catch { entry = null; }
        const rootId = typeof entry?.rootId === 'string' ? entry.rootId : '';
        if (rootId !== '') {
          if (!opened.has(rootId)) {
            let created = null;
            try { created = openRootAudit(entry) ?? null; } catch { created = null; }
            // 只缓存成功实例：根暂时不在时下一行会重试，恢复后能落到正确根。
            if (created !== null) opened.set(rootId, created);
          }
          target = opened.get(rootId) ?? null;
        }
      }
    }
    try {
      const sink = target ?? fallback;
      sink?.append?.(event, details);
    } catch {
      /* 审计失败不影响记忆读写 */
    }
  };
  return createDedupedMemoryAudit({ sink: routed, limit, dedupeEvents });
}
