/**
 * 进程间写者锁（M1 只做"检测与提示"，不承诺跨进程合并）。
 *
 * 语义：
 * - 同一项目同一时间只允许一个活跃写者（README 明确"多会话同项目显式提示"）。
 * - 锁文件 `.writer.json` 记录 pid / 起始时间 / project。
 * - 持有者进程存活 → 本次 open 只读并返回 holder，由上层告警。
 * - 持有者已死或锁文件损坏 → 视为陈旧锁，原子覆盖。
 * - release 只删自己写入的那把锁（pid + startedAt 都匹配）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, readTextIfExists } from './atomic.js';

export const LOCK_FILE_NAME = '.writer.json';

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
 * @param {{project:string, pid?:number, now?:()=>Date}} options
 * @returns {Promise<{ok:boolean, holder?:object, release?:() => Promise<void>}>}
 */
export async function acquireWriterLock(rootDir, { project, pid = process.pid, now = () => new Date() }) {
  await fs.mkdir(rootDir, { recursive: true });
  const { file, lock, corrupt } = await readWriterLock(rootDir);
  // 同一进程内也视为冲突：一个进程只允许一个 store 写同一项目，
  // 否则两个独立队列会绕过"单写者"语义。
  if (lock !== null && isPidAlive(lock.pid)) {
    return { ok: false, holder: lock };
  }
  const startedAt = now().toISOString();
  const mine = { pid, startedAt, project, version: 1 };
  if (corrupt) {
    // 损坏的锁不阻塞启动；覆盖前留一份 .bak 便于排查。
    await fs.copyFile(file, `${file}.bak`).catch(() => {});
  }
  await atomicWriteFile(file, JSON.stringify(mine, null, 2) + '\n', { backup: false });
  const release = async () => {
    const current = await readWriterLock(rootDir);
    if (current.lock === null) return;
    if (current.lock.pid !== pid || current.lock.startedAt !== startedAt) return;
    await fs.rm(file, { force: true });
  };
  return { ok: true, lock: mine, release };
}
