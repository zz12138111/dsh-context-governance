/**
 * 两类固定写入位置的守卫（需求授权边界）：用户级 `<home>/context-governance/`
 * 与每根 `<root>/memory/governance/`。纯只读校验，不创建目录。
 */
import fs from 'node:fs';
import path from 'node:path';

import { checkWriteTarget } from './containment.js';
import { isWithin, samePath } from './identity.js';

/** 根内唯一写入目录（目录固定，不接受自定义）。 */
export const MEMORY_ROOT_REL = 'memory/governance';

/** profile 名安全化：只留字母数字 . _ -，避免路径分隔符与保留字符。 */
export function safeProfileName(name) {
  const cleaned = String(name ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned === '' ? 'profile' : cleaned.slice(0, 80);
}

/** 相对路径归一：`\` → `/`，去首 `./` 与尾 `/`。 */
export function normalizeRelPath(rel) {
  if (typeof rel !== 'string') return '';
  return rel.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * 解析某根的记忆目录（固定 `memory/governance`）。
 *
 * @param {string} root 规范根（绝对路径）
 * @param {string} [rel] 配置值（只允许 `memory/governance`）
 * @returns {{ok:true, memoryRoot:string, rel:string} | {ok:false, reason:string}}
 */
export function memoryRootFor(root, rel = MEMORY_ROOT_REL) {
  if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) {
    return { ok: false, reason: 'root-invalid' };
  }
  if (typeof rel !== 'string' || rel.trim() === '') {
    return { ok: false, reason: 'memory-root-invalid' };
  }
  const raw = rel.trim();
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { ok: false, reason: 'memory-root-absolute' };
  }
  const normalized = normalizeRelPath(raw);
  if (normalized === '' || normalized.split('/').includes('..')) {
    return { ok: false, reason: 'memory-root-escape' };
  }
  if (normalized !== MEMORY_ROOT_REL) {
    // 需求「目录固定」：只认 memory/governance；其他相对值同样 fail-closed。
    return { ok: false, reason: 'memory-root-not-fixed' };
  }
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, MEMORY_ROOT_REL);
  if (samePath(rootResolved, target) || !isWithin(rootResolved, target)) {
    return { ok: false, reason: 'memory-root-escape' };
  }
  // 已存在的目标必须 realpath 后仍在（realpath 后的）根内，防 junction 逃逸。
  let realRoot = rootResolved;
  try {
    realRoot = fs.realpathSync.native(rootResolved);
  } catch {
    /* 根不存在时用 resolve 结果 */
  }
  try {
    if (fs.existsSync(target)) {
      const realTarget = fs.realpathSync.native(target);
      if (samePath(realRoot, realTarget) || !isWithin(realRoot, realTarget)) {
        return { ok: false, reason: 'memory-root-symlink-escape' };
      }
    }
  } catch {
    return { ok: false, reason: 'memory-root-symlink-escape' };
  }
  return { ok: true, memoryRoot: target, rel: MEMORY_ROOT_REL };
}

/**
 * 用户级目录（`root-state-<profile>.json` 的父目录）。
 * 只接受名字为 `context-governance` 的目录，防身份字段被改成任意路径。
 */
export function userLevelDir(identity) {
  if (identity === null || typeof identity !== 'object' || identity.ok !== true) return null;
  if (typeof identity.stateFile !== 'string' || identity.stateFile === '') return null;
  const file = path.resolve(identity.stateFile);
  if (!path.isAbsolute(file)) return null;
  const dir = path.dirname(file);
  if (path.basename(dir) !== 'context-governance') return null;
  return dir;
}

/** 根级审计文件：与 state 文件同目录同 profile（`root-state-X.json` → `root-audit-X.jsonl`）。 */
export function rootAuditFile(identity) {
  const dir = userLevelDir(identity);
  if (dir === null) return null;
  const base = path.basename(path.resolve(identity.stateFile));
  const name = base.replace(/^root-state/, 'root-audit').replace(/\.json$/i, '.jsonl');
  return path.join(dir, name);
}

/** 用户级文件名白名单（状态/审计/备份/损坏/轮转/原子写临时文件）。 */
export function isUserLevelPath(identity, file) {
  const dir = userLevelDir(identity);
  if (dir === null || typeof file !== 'string' || file === '') return false;
  const resolved = path.resolve(file);
  if (!samePath(path.dirname(resolved), dir)) return false;
  const name = path.basename(resolved);
  const patterns = [
    /^root-state(?:-[A-Za-z0-9._-]+)?\.json$/,
    /^root-audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/,
    /^root-state(?:-[A-Za-z0-9._-]+)?\.v1\.bak$/,
    /^root-state(?:-[A-Za-z0-9._-]+)?\.v1-[0-9TZ]+\.bak$/,
    /^root-state(?:-[A-Za-z0-9._-]+)?\.corrupt-[0-9TZ]+\.json$/,
    /^audit-\d{8}(?:-\d+)?\.jsonl$/,
    /^root-(?:state|audit).*\.tmp$/,
  ];
  return patterns.some((pattern) => pattern.test(name));
}

/**
 * v3：诊断日志路径白名单（**两处**）：
 * - `<home>/context-governance/`（默认且多根唯一安全）；
 * - 该根 `<root>/memory/governance/`（只能作 per-root sink，不能当多根全局日志）。
 * `logs/` 不在白名单。未配置时默认用户级 `logs/governance.log`。
 * 返回的 `bases` 供实际写入前兜底校验。
 *
 * @returns {{ok:true, file:string, bases:string[]} | {ok:false, reason:string}}
 */
export function resolveDiagnosticsPath({ identity = null, root = null, memoryRoot = null, logFile = '' } = {}) {
  const bases = [];
  const userDir = userLevelDir(identity);
  if (userDir !== null) bases.push(userDir);
  if (typeof memoryRoot === 'string' && memoryRoot !== '') {
    bases.push(memoryRoot);
  } else if (typeof root === 'string' && root !== '') {
    const memory = memoryRootFor(root);
    if (memory.ok) bases.push(memory.memoryRoot);
  }
  const requested = typeof logFile === 'string' ? logFile.trim() : '';
  if (requested === '') {
    // 身份不可用 = 没有用户级目录可落默认诊断；不阻断装载，只是不写诊断。
    if (userDir === null) return { ok: true, file: '', bases };
    return { ok: true, file: path.join(userDir, 'logs', 'governance.log'), bases };
  }
  if (!path.isAbsolute(requested)) return { ok: false, reason: 'log-file-relative' };
  for (const base of bases) {
    if (checkWriteTarget(base, requested).ok === true) {
      return { ok: true, file: path.resolve(requested), bases };
    }
  }
  return { ok: false, reason: 'log-file-outside-whitelist' };
}
