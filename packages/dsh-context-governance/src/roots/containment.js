/**
 * 写入侧 containment（v3 冻结口径）：校验**实际写入目标路径**，不是配置值。
 *
 * 规则：目标路径先 `path.resolve`（消 `..`）→ 最近存在祖先 `realpath`（消符号链接/
 * junction）→ 平台大小写/盘符/UNC 归一 → 必须严格位于允许基目录内；已存在的目标本身
 * 是符号链接 → 拒绝。不读取/不创建任何目录。
 */
import fs from 'node:fs';
import path from 'node:path';

import { isWithin, samePath, stripLongPathPrefix } from './identity.js';

/** 解析出“真实路径”：最近存在祖先 realpath + 尚不存在的尾段。 */
export function realishPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return null;
  let resolved;
  try {
    resolved = path.resolve(stripLongPathPrefix(target.trim()));
  } catch {
    return null;
  }
  if (!path.isAbsolute(resolved)) return null;
  const missing = [];
  let current = resolved;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = stripLongPathPrefix(fs.realpathSync.native(current));
      return path.join(real, ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  return resolved;
}

/**
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function checkWriteTarget(allowedBase, target) {
  if (typeof allowedBase !== 'string' || allowedBase.trim() === '') return { ok: true };
  if (typeof target !== 'string' || target.trim() === '') return { ok: false, reason: 'target-invalid' };
  const base = realishPath(allowedBase);
  const dest = realishPath(target);
  if (base === null || dest === null) return { ok: false, reason: 'path-invalid' };
  if (samePath(base, dest) || !isWithin(base, dest)) return { ok: false, reason: 'outside-base' };
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return { ok: false, reason: 'symlink-target' };
  } catch {
    /* 目标尚不存在：允许（父路径已 realpath 校验） */
  }
  return { ok: true };
}

/** 失败抛错（调用方转 fail-closed/只读）。 */
export function assertWriteTarget(allowedBase, target) {
  const result = checkWriteTarget(allowedBase, target);
  if (result.ok !== true) {
    throw new Error(`write target outside allowed base: ${result.reason} (${target})`);
  }
  return true;
}
