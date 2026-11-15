/**
 * C36 ④：A2 持久会话层（每会话压缩比，重启可读回）。
 *
 * 存 `~/.dsh/context-governance/session-policy.json`（用户级，不写项目根），
 * 键 = 完整 session id，值 = `{at, source:'session:A2', updatedAt, version:1}`。
 *
 * 约束（REQUIREMENTS C24–C30/C36④）：
 * - 重启可读回；UI 保存与 `/cg set` 写入（A1 运行时同时生效，A1 > A2）；
 * - 不得无界累积：maxEntries（默认 500）+ ttlDays（默认 90 天）兜底淘汰，淘汰写 `a2-evicted`；
 * - 损坏/未知版本按“无 A2”处理并写 `a2-load-failed`，不抛错；
 * - 不含凭据/正文。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_A2_MAX_ENTRIES = 500;
export const DEFAULT_A2_TTL_DAYS = 90;
export const A2_SOURCE = 'session:A2';

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * @param {{file:string, now?:()=>Date, maxEntries?:number, ttlDays?:number,
 *   audit?:(event:string, details:object)=>void, logger?:object}} options
 */
export function createA2Store({
  file,
  now = () => new Date(),
  maxEntries = DEFAULT_A2_MAX_ENTRIES,
  ttlDays = DEFAULT_A2_TTL_DAYS,
  audit = null,
  logger = null,
  pins = [],
  isActive = null,
} = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('A2 store needs a file path');
  const limit = Math.max(Number(maxEntries) || DEFAULT_A2_MAX_ENTRIES, 1);
  const ttlMs = Math.max(Number(ttlDays) || DEFAULT_A2_TTL_DAYS, 1) * 24 * 60 * 60 * 1000;
  const sessions = new Map();
  // 裁定 3：活跃保护——显式 pin 永不清；isActive(sessionId) 为真的会话不被 TTL/LRU 清掉。
  const pinned = new Set(Array.isArray(pins) ? pins.filter((id) => typeof id === 'string' && id !== '') : []);
  const protectedNow = () => {
    const set = new Set(pinned);
    if (typeof isActive === 'function') {
      for (const sessionId of sessions.keys()) {
        try {
          if (isActive(sessionId) === true) set.add(sessionId);
        } catch {
          /* 活跃探测失败按不保护处理 */
        }
      }
    }
    return set;
  };
  const emit = (event, details) => {
    try {
      audit?.(event, details);
    } catch {
      /* 审计失败不影响策略读写 */
    }
  };

  // 启动装载：损坏/未知版本 → 视为无 A2，只留审计。
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.version !== 1 || typeof raw?.sessions !== 'object' || raw.sessions === null) {
        emit('a2-load-failed', { reason: 'unknown-version', file });
      } else {
        for (const [sessionId, value] of Object.entries(raw.sessions)) {
          if (typeof sessionId !== 'string' || sessionId === '') continue;
          if (!Number.isFinite(value?.at)) continue;
          sessions.set(sessionId, {
            at: Number(value.at),
            source: A2_SOURCE,
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now().toISOString(),
            version: 1,
          });
        }
      }
    }
  } catch (error) {
    emit('a2-load-failed', { reason: String(error?.message ?? error).slice(0, 200), file });
    logger?.warn?.(`[context-governance] A2 store unreadable (${String(error?.message ?? error)}); treating as empty`);
  }

  const persist = () => {
    const data = { version: 1, sessions: {} };
    for (const [sessionId, value] of sessions.entries()) data.sessions[sessionId] = value;
    try {
      atomicWriteJson(file, data);
      return true;
    } catch (error) {
      logger?.warn?.(`[context-governance] A2 store write failed: ${String(error?.message ?? error)}`);
      return false;
    }
  };

  const evict = () => {
    const nowMs = now().getTime();
    const guarded = protectedNow();
    const removed = [];
    for (const [sessionId, value] of [...sessions.entries()]) {
      if (guarded.has(sessionId)) continue;
      const updated = Date.parse(value.updatedAt);
      if (Number.isFinite(updated) && nowMs - updated > ttlMs) {
        sessions.delete(sessionId);
        removed.push(sessionId);
      }
    }
    if (removed.length > 0) {
      emit('a2-evicted', { count: removed.length, reason: 'ttl-expired', sessionIds: removed });
    }
    let dropped = [];
    if (sessions.size > limit) {
      const candidate = [...sessions.entries()]
        .filter(([sessionId]) => !guarded.has(sessionId))
        .sort((left, right) => (Date.parse(left[1].updatedAt) || 0) - (Date.parse(right[1].updatedAt) || 0));
      for (const [sessionId] of candidate) {
        if (sessions.size <= limit) break;
        sessions.delete(sessionId);
        dropped.push(sessionId);
      }
      if (dropped.length > 0) {
        emit('a2-evicted', { count: dropped.length, reason: 'max-entries', sessionIds: dropped });
      }
    }
    return removed.length + dropped.length;
  };
  return {
    file,
    /** 读该会话的 A2（无/过期 → null）。 */
    read(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const value = sessions.get(sessionId);
      if (value === undefined) return null;
      const updated = Date.parse(value.updatedAt);
      if (Number.isFinite(updated) && now().getTime() - updated > ttlMs) {
        // 裁定 3：read 不静默删；过期只返回 null，统一由 evict（带审计、保护活跃）处理。
        return null;
      }
      return { ...value };
    },
    /** 写该会话的 A2（UI 保存/`/cg set`）。 */
    write(sessionId, at, { source = A2_SOURCE } = {}) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      if (!Number.isFinite(at)) return false;
      sessions.set(sessionId, { at: Number(at), source, updatedAt: now().toISOString(), version: 1 });
      evict();
      persist();
      return true;
    },
    /** 清除该会话的 A2（恢复全局）。 */
    clear(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      if (!sessions.has(sessionId)) return true;
      sessions.delete(sessionId);
      persist();
      return true;
    },
    size: () => sessions.size,
    snapshot: () => Object.fromEntries([...sessions.entries()].map(([key, value]) => [key, { ...value }])),
  };
}
