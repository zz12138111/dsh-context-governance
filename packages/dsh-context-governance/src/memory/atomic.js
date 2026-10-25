/**
 * 原子写与内容指纹。
 *
 * 写路径固定为：同目录临时文件 → 完整写入并 fsync → （旧文件存在时留一份 .bak）
 * → rename 覆盖。rename 在同一卷上是原子的，读侧永远看不到半个文件；
 * 进程在 rename 前崩溃只会留下一个 `.tmp-*` 垃圾文件，不影响主题文件。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

/** SHA-256；文件不存在返回 null。 */
export async function hashFile(file) {
  try {
    const data = await fs.readFile(file);
    return createHash('sha256').update(data).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/** stat 摘要；文件不存在返回 null。 */
export async function fileStamp(file) {
  try {
    const stat = await fs.stat(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 原子写一个文本文件。
 *
 * @param {string} file 目标绝对路径。
 * @param {string} data 内容。
 * @param {{backup?:boolean, fsyncDir?:boolean}} [options]
 */
export async function atomicWriteFile(file, data, { backup = true } = {}) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const name = path.basename(file);
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.${counter++}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, 'wx');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    if (backup) {
      // 只留一代备份：覆盖前把旧文件复制为 <name>.bak。
      try {
        await fs.copyFile(file, `${file}.bak`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** 读文本；不存在返回 null。 */
export async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
