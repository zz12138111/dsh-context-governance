/**
 * 根标识与路径归一（P1 / 需求「多根通用性」第 1、7、9 条）。
 *
 * 三层身份：
 * - `canonicalRoot`：realpath（存在时）+ Windows 盘符大写 + UNC/`\\?\` 前缀归一；
 * - `platformFold`：Windows 小写、POSIX 原样（比较/hash 用）；
 * - `rootId`：`sha256(platformFold(canonicalRoot)).slice(0, 16)`，**根的唯一标识**；
 *   `name`/`project` 只做展示，不用于区分（防两个 `tools` 目录撞账本/记忆）。
 *
 * 本模块只读文件系统（existsSync/realpathSync），**不写、不扫描目录**。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** rootId 默认十六进制长度（64 bit）；碰撞时按 ROOT_ID_HEX_LENGTHS 递增。 */
export const ROOT_ID_HEX = 16;
export const ROOT_ID_HEX_LENGTHS = Object.freeze([16, 20, 24, 32, 64]);

/** 去掉 Windows 长路径/UNC 前缀：`\\?\C:\x` → `C:\x`，`\\?\UNC\srv\share` → `\\srv\share`。 */
export function stripLongPathPrefix(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\/i.test(value)) return value.slice(4);
  return value;
}

/**
 * 绝对路径归一：resolve → realpath（存在时）→ 盘符大写。
 * 非法/空返回 null（不抛错）。
 */
export function normalizeRootPath(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (trimmed === '') return null;
  let resolved;
  try {
    resolved = path.resolve(stripLongPathPrefix(trimmed));
  } catch {
    return null;
  }
  if (!path.isAbsolute(resolved)) return null;
  try {
    if (fs.existsSync(resolved)) resolved = stripLongPathPrefix(fs.realpathSync.native(resolved));
  } catch {
    /* 保留 resolve 结果 */
  }
  if (!path.isAbsolute(resolved)) return null;
  if (process.platform === 'win32' && /^[a-z]:/.test(resolved)) {
    resolved = `${resolved[0].toUpperCase()}${resolved.slice(1)}`;
  }
  return resolved;
}

/** 平台折叠：Windows 小写；POSIX 原样。 */
export function platformFold(value) {
  if (typeof value !== 'string') return '';
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** 默认 hash：SHA-256 十六进制。测试可注入短 hash 模拟碰撞。 */
export function defaultRootHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** rootId = path hash；不以路径串做键（需求 :472）。 */
export function rootIdOf(canonicalRoot, { length = ROOT_ID_HEX, hashFn = defaultRootHash } = {}) {
  if (typeof canonicalRoot !== 'string' || canonicalRoot.trim() === '') return '';
  const digest = hashFn(platformFold(canonicalRoot));
  if (typeof digest !== 'string' || digest.length === 0) return '';
  const size = Math.min(Math.max(Number(length) || ROOT_ID_HEX, 4), digest.length);
  return digest.slice(0, size);
}

/** 展示名：basename；盘符根 `C:\` → `C:`，UNC 根取 share 名。 */
export function rootNameOf(canonicalRoot) {
  if (typeof canonicalRoot !== 'string' || canonicalRoot === '') return '';
  const base = path.basename(canonicalRoot);
  if (base !== '') return base;
  if (/^[A-Za-z]:[\\/]?$/.test(canonicalRoot)) return canonicalRoot.slice(0, 2).toUpperCase();
  const parts = canonicalRoot.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : canonicalRoot;
}

/** 路径相等（Windows 大小写不敏感）。 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let a;
  let b;
  try {
    a = platformFold(path.resolve(left));
    b = platformFold(path.resolve(right));
  } catch {
    return false;
  }
  return a === b;
}

/** child 是否等于 parent 或位于 parent 之下（大小写按平台归一）。 */
export function isWithin(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  let a;
  let b;
  try {
    a = platformFold(path.resolve(parent));
    b = platformFold(path.resolve(child));
  } catch {
    return false;
  }
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
}

/** cwd 是否等于根或位于根之下。 */
export function cwdWithinRoot(cwd, root) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return false;
  return isWithin(root, cwd);
}

/**
 * 按会话 cwd 上溯最近的含 `.git` 祖先（`.git` 文件或目录都算，worktree 兼容）。
 * cwd 先 realpath（符号链接/junction 按真实路径判根）；结果再过 normalizeRootPath。
 * 找不到/结果落在 exclude（DSH home）内返回 null。
 *
 * @param {string} cwd
 * @param {{exclude?: string|null}} [options]
 */
export function inferRootFromCwd(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const exclude = typeof options?.exclude === 'string' && options.exclude.trim() !== ''
    ? options.exclude.trim()
    : null;
  let current;
  try {
    current = path.resolve(stripLongPathPrefix(cwd.trim()));
  } catch {
    return null;
  }
  try {
    if (fs.existsSync(current)) current = stripLongPathPrefix(fs.realpathSync.native(current));
  } catch {
    /* 用 resolve 结果继续上溯 */
  }
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        const root = normalizeRootPath(current);
        if (root === null) return null;
        if (exclude !== null && isWithin(exclude, root)) return null;
        return root;
      }
    } catch {
      /* 不是 git 根，继续上溯 */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
