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
