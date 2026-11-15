/**
 * 进程间写者锁（M1 只做"检测与提示"，不承诺跨进程合并）。
 *
 * 语义：
 * - 同一项目同一时间只允许一个活跃写者（README 明确"多会话同项目显式提示"）。
 * - 锁文件 `.writer.json` 记录 pid / 起始时间 / project / 心跳（`heartbeatAt`）。
 * - 持有者进程存活 + 心跳新鲜 → 本次 open 只读并返回 holder，由上层告警。
 * - 陈旧锁（持有者已死 / 无法探测且超龄 / 心跳停摆且超龄）→ 留 `.stale.bak` 后原子覆盖，
 *   并把 `reclaimed` 交给上层记审计/诊断（不静默）。
 * - release 只删自己写入的那把锁（pid + startedAt 都匹配）。
 *
 * 为什么不是"pid 不在 DSH 进程组就回收"：插件跑在宿主进程内，没有不启动子进程就能
 * 枚举进程组的跨平台办法；改用心跳（严格更强的存活信号）+ 超龄探测。rc.2 口径：
 * `process.kill(pid,0)` 得 EPERM 且锁龄超阈值，或可探测存活但心跳停摆且超龄，均回收。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, readTextIfExists } from './atomic.js';
import { checkWriteTarget } from '../roots/containment.js';

export const LOCK_FILE_NAME = '.writer.json';

/** rc.2：锁龄/心跳超过该阈值才可能被判陈旧（默认 10 分钟）。 */
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
/** rc.2：持锁者心跳间隔（默认 45 秒，约为阈值 1/13）。 */
export const LOCK_HEARTBEAT_MS = 45 * 1000;

/** v3：锁文件写入目标 containment（实际路径）。 */
function lockContainment(rootDir, file) {
  const check = checkWriteTarget(rootDir, file);
  return check.ok ? null : `containment:writer-lock:${check.reason}`;
}

/** 进程是否存活；EPERM 视为存活（存在但无权限发信号）。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * rc.2：三态探测。`denied`（EPERM）说明进程可能存在但不是我们可验证的写者，
 * 只有配合超龄才回收。
 */
export function probePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'EPERM' ? 'denied' : 'dead';
  }
}

function parseTimeMs(value) {
  if (typeof value !== 'string' || value === '') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * rc.2：判陈旧。返回 { stale, probe, reason, ageMs, heartbeatAgeMs }。
 *
 * - `dead` → 立即陈旧（`pid-dead`）。
 * - `denied`（EPERM）→ 锁龄或心跳任一超过 `staleMs` 才陈旧（`pid-unprobeable`）。
 * - `alive` → 只有"自己带了心跳且心跳停摆超阈值"才陈旧（`heartbeat-stale`，覆盖 pid 复用）；
 *   没有心跳的老格式锁一律按活写者处理（保守，避免把旧版本活进程的锁抢走）。
 */
export function evaluateLockStaleness(lock, { now = Date.now(), staleMs = DEFAULT_STALE_LOCK_MS, probe = probePid } = {}) {
  if (lock === null || lock === undefined) return { stale: false, probe: 'none', reason: null, ageMs: null, heartbeatAgeMs: null };
  const result = probe(lock.pid);
  const startedMs = parseTimeMs(lock.startedAt);
  const heartbeatMs = parseTimeMs(lock.heartbeatAt);
  const ageMs = Number.isFinite(startedMs) ? now - startedMs : Number.POSITIVE_INFINITY;
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? now - heartbeatMs : null;
  const silentMs = heartbeatAgeMs === null ? ageMs : Math.max(heartbeatAgeMs, 0);
  if (result === 'dead') return { stale: true, probe: result, reason: 'pid-dead', ageMs, heartbeatAgeMs };
  if (result === 'denied' && (silentMs > staleMs || ageMs > staleMs)) {
    return { stale: true, probe: result, reason: 'pid-unprobeable', ageMs, heartbeatAgeMs };
  }
  if (result === 'alive' && heartbeatAgeMs !== null && heartbeatAgeMs > staleMs && ageMs > staleMs) {
    return { stale: true, probe: result, reason: 'heartbeat-stale', ageMs, heartbeatAgeMs };
  }
  return { stale: false, probe: result, reason: null, ageMs, heartbeatAgeMs };
}

function staleDiagnostics(lock, verdict) {
  return {
    reason: verdict.reason,
    probe: verdict.probe,
    pid: Number.isInteger(lock?.pid) ? lock.pid : null,
    startedAt: typeof lock?.startedAt === 'string' ? lock.startedAt : null,
    lockAgeMs: Number.isFinite(verdict.ageMs) ? Math.max(0, Math.round(verdict.ageMs)) : null,
    heartbeatAgeMs: verdict.heartbeatAgeMs,
  };
}

export async function readWriterLock(rootDir) {
  const file = path.join(rootDir, LOCK_FILE_NAME);
  const text = await readTextIfExists(file);
  if (text === null) return { file, lock: null, corrupt: false };
  try {
    const lock = JSON.parse(text);
    if (!Number.isInteger(lock?.pid) || typeof lock?.startedAt !== 'string') {
      return { file, lock: null, corrupt: true, raw: text };
    }
    return { file, lock, corrupt: false };
  } catch {
    return { file, lock: null, corrupt: true, raw: text };
  }
}

/**
 * 尝试取得写者锁。
 *
 * @param {string} rootDir 记忆根目录。
 * @param {{project:string, pid?:number, now?:()=>Date, staleMs?:number, heartbeatMs?:number, probe?:(pid:number)=>string, heartbeat?:boolean}} options
 * @returns {Promise<{ok:boolean, holder?:object, release?:()=>Promise<void>, reclaimed?:object}>}
 */
export async function acquireWriterLock(rootDir, {
  project,
  pid = process.pid,
  now = () => new Date(),
  staleMs = DEFAULT_STALE_LOCK_MS,
  heartbeatMs = LOCK_HEARTBEAT_MS,
  probe = probePid,
  heartbeat = true,
} = {}) {
  const file = path.join(rootDir, LOCK_FILE_NAME);
  const violation = lockContainment(rootDir, file);
  if (violation !== null) return { ok: false, reason: violation };
  await fs.mkdir(rootDir, { recursive: true });
  const { lock, corrupt } = await readWriterLock(rootDir);
  let reclaimed = null;
  if (lock !== null) {
    const nowMs = now().getTime();
    const verdict = evaluateLockStaleness(lock, { now: nowMs, staleMs, probe });
    if (!verdict.stale) {
      // 同一进程内也视为冲突：一个进程只允许一个 store 写同一项目，
      // 否则两个独立队列会绕过"单写者"语义。
      return { ok: false, holder: lock };
    }
    reclaimed = staleDiagnostics(lock, verdict);
    // 陈旧锁不阻塞启动；覆盖前留一份 `.stale.bak` 便于排查（不复用 `.bak`，那是损坏锁的备份）。
    const staleBackup = `${file}.stale.bak`;
    if (checkWriteTarget(rootDir, staleBackup).ok === true) {
      await fs.copyFile(file, staleBackup).catch(() => {});
    }
  }
  const startedAt = now().toISOString();
  const mine = { pid, startedAt, project, version: 1, heartbeatAt: startedAt };
  if (corrupt) {
    // 损坏的锁不阻塞启动；覆盖前留一份 .bak 便于排查。
    const backup = `${file}.bak`;
    if (checkWriteTarget(rootDir, backup).ok === true) {
      await fs.copyFile(file, backup).catch(() => {});
    }
  }
  const writeViolation = lockContainment(rootDir, file);
  if (writeViolation !== null) return { ok: false, reason: writeViolation };
  await atomicWriteFile(file, JSON.stringify(mine, null, 2) + '\n', { backup: false });
  const touchLock = async () => {
    try {
      if (lockContainment(rootDir, file) !== null) return;
      const current = await readWriterLock(rootDir);
      if (current.lock === null) return;
      if (current.lock.pid !== pid || current.lock.startedAt !== startedAt) return;
      const next = { ...mine, heartbeatAt: now().toISOString() };
      await atomicWriteFile(file, JSON.stringify(next, null, 2) + '\n', { backup: false });
    } catch {
      /* 心跳失败不打断主流程；下一次心跳重试 */
    }
  };
  let timer = null;
  if (heartbeat === true) {
    timer = setInterval(() => { void touchLock(); }, heartbeatMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }
  const release = async () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (lockContainment(rootDir, file) !== null) return;
    const current = await readWriterLock(rootDir);
    if (current.lock === null) return;
    if (current.lock.pid !== pid || current.lock.startedAt !== startedAt) return;
    await fs.rm(file, { force: true });
  };
  return { ok: true, lock: mine, release, ...(reclaimed === null ? {} : { reclaimed }) };
}
