/**
 * S1.3（1.0.1 必做项）：`early-forced` 待回填登记的持久化——最小版。
 *
 * 为什么存在：`early-forced` 超窗写 `unknown` 后，`early-wiring` 在内存里登记待回填；
 * 进程重启即丢失，那条 `unknown` 永久闭合不了（`REQUIREMENTS.md:593` 已知缺口）。
 * 本模块只做一件事：把 `{cycle, sessionId, writtenAt}` 原子落盘 / 启动读回。
 *
 * 位置口径（不新造路径规则）：复用 `root-state.js` 的 `resolvePersistenceIdentity`——
 * `persistence-identity` 审计行打印的目录（`<home>/context-governance/` 或 profile `dir`），
 * 文件名 `pending-reconcile-<profile>[-<rootId>].json`；多根各持一份，互不覆盖。
 *
 * 内容口径：只有 `{cycle, sessionId, writtenAt}`——不存正文、不存摘要、不存审计对象。
 * 读回后的 `audit` 写入器由 wiring 用该根自己的 audit 补上（见 `early-wiring.js`）。
 *
 * 失败口径：文件不存在 = 首次运行，静默空表；损坏/不可读/不可写 = 一行 warn，空表继续，
 * 不抛错、不阻塞 turn、不影响压缩主流程。
 *
 * 为什么不加审计事件：本读回发生在插件加载期，只影响"以后还能不能补一条 reconciled"；
 * 闭合判定只看 `early-forced-reconciled` 是否存在，不看"恢复了几条"。加事件只会让每次重启
 * 多一行噪声，不增加任何证据力（`docs/T5-状态命令与审计.md` 因此只登记 reconciled 行）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { safeProfileName } from '../root-state.js';

export const RECONCILE_STORE_VERSION = 1;

function sameFileKey(value) {
  return String(value ?? '');
}

/**
 * 由持久化身份 + 根 id 推出待回填文件路径。
 * identity 不可用（没有 profileContext）时返回 null：不落盘，行为回到 1.0（跨重启丢登记）。
 */
export function reconcileStoreFile(identity, rootId = null) {
  if (identity === null || identity === undefined) return null;
  if (identity.ok !== true || typeof identity.stateFile !== 'string' || identity.stateFile === '') return null;
  let dir = '';
  try {
    dir = path.dirname(path.resolve(identity.stateFile));
  } catch {
    return null;
  }
  const profile = safeProfileName(identity.name);
  const suffix = typeof rootId === 'string' && rootId !== '' ? `-${safeProfileName(rootId)}` : '';
  return path.join(dir, `pending-reconcile-${profile}${suffix}.json`);
}

function warnOnce(logger, message) {
  try {
    logger?.warn?.(message);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 读取待回填条目；按 TTL 与上限裁剪（先丢过期，再丢最旧）。
 *
 * @param {string|null} file
 * @param {{now?: () => number, ttlMs?: number, max?: number, logger?: object|null}} [options]
 * @returns {Array<{cycle: string, sessionId: string|null, writtenAt: number}>}
 */
export function readReconcileStore(file, { now = () => Date.now(), ttlMs = 0, max = 0, logger = null } = {}) {
  if (typeof file !== 'string' || file === '') return [];
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // 首次运行没有文件是正常态；其它读失败（权限/是目录等）只 warn 一行。
    if (error?.code !== 'ENOENT') {
      warnOnce(logger, `[context-governance] reconcile store unreadable (${sameFileKey(file)}): ${String(error?.message ?? error)}; continuing with empty table`);
    }
    return [];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(logger, `[context-governance] reconcile store corrupt (${sameFileKey(file)}); continuing with empty table`);
    return [];
  }
  const list = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries) ? parsed.entries : null;
  if (list === null) {
    warnOnce(logger, `[context-governance] reconcile store invalid (${sameFileKey(file)}); continuing with empty table`);
    return [];
  }
  const nowMs = now();
  const byCycle = new Map();
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const cycle = item.cycle;
    if (typeof cycle !== 'string' || cycle === '') continue;
    const sessionId = item.sessionId ?? null;
    if (sessionId !== null && typeof sessionId !== 'string') continue;
    const writtenAt = Number(item.writtenAt);
    if (!Number.isFinite(writtenAt) || writtenAt <= 0) continue;
    // 过期条目加载即丢弃（与运行期 prune 同一 TTL 口径）。
    if (ttlMs > 0 && nowMs - writtenAt > ttlMs) continue;
    // 同 cycle 重复时保留最新一条，避免坏文件把表撑大。
    const existing = byCycle.get(cycle);
    if (existing !== undefined && existing.writtenAt >= writtenAt) continue;
    byCycle.set(cycle, { cycle, sessionId, writtenAt });
  }
  const entries = [...byCycle.values()].sort((left, right) => left.writtenAt - right.writtenAt);
  if (max > 0 && entries.length > max) entries.splice(0, entries.length - max);
  return entries;
}

/**
 * 原子写（tmp + rename）；只写 `{version, writtenAt, entries:[{cycle,sessionId,writtenAt}]}`。
 * 失败返回 false 并 warn 一行，不抛错。
 *
 * @param {string|null} file
 * @param {Array<{cycle: string, sessionId: string|null, writtenAt: number}>} entries
 * @param {{logger?: object|null}} [options]
 * @returns {boolean}
 */
export function writeReconcileStore(file, entries, { logger = null } = {}) {
  if (typeof file !== 'string' || file === '') return false;
  let target = '';
  try {
    target = path.resolve(file);
  } catch {
    return false;
  }
  const list = Array.isArray(entries) ? entries : [];
  const payload = {
    version: RECONCILE_STORE_VERSION,
    writtenAt: new Date().toISOString(),
    entries: list.map((entry) => ({
      cycle: entry.cycle,
      sessionId: entry.sessionId ?? null,
      writtenAt: entry.writtenAt,
    })),
  };
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.renameSync(temp, target);
    return true;
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* 清临时文件失败不影响结果 */
    }
    warnOnce(logger, `[context-governance] reconcile store write failed (${target}): ${String(error?.message ?? error)}; continuing in memory`);
    return false;
  }
}
