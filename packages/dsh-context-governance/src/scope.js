/**
 * P1：会话作用域判定（多根模型，B）。
 *
 * 纯函数、只读、无副作用。生产路径由 index 注入基于 `RootRegistry` 的 resolver
 * （直接返回 governed），本函数只作 `CompressionGuard` 直接构造时的根边界兜底：
 * - `root` 为空 → `no-project-root`（完全不碰）；
 * - `managed=false` → `unmanaged-root`（P1 非主根：不观测/不保护/不写）；
 * - `cwd` 为空 → `no-project-root`（fail-closed；子会话由 registry 继承父根后再入）；
 * - 根内 + 策略关闭 → `out-of-scope`（保护/观测照常，只是不提前压）。
 */
import path from 'node:path';

export const SCOPE_MODE = Object.freeze({
  SINGLE_ROOT: 'single-root',
  MULTI_ROOT: 'multi-root',
  UNRESOLVED: 'unresolved',
});

export const SCOPE_SKIP = Object.freeze({
  NO_ROOT: 'no-project-root',
  UNMANAGED: 'unmanaged-root',
  OUT_OF_SCOPE: 'out-of-scope',
});

/** 绝对路径归一（只做 resolve，不 realpath；调用方给的是已持久化的根）。 */
export function normalizeRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') return null;
  try {
    return path.resolve(root.trim());
  } catch {
    return null;
  }
}

/** cwd 是否等于根或位于根之下（Windows 大小写不敏感）。 */
export function cwdWithinRoot(cwd, root) {
  const normalizedRoot = normalizeRoot(root);
  if (normalizedRoot === null || typeof cwd !== 'string' || cwd.trim() === '') return false;
  let normalizedCwd;
  try {
    normalizedCwd = path.resolve(cwd.trim());
  } catch {
    return false;
  }
  const left = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
  const right = process.platform === 'win32' ? normalizedCwd.toLowerCase() : normalizedCwd;
  return right === left || right.startsWith(left.endsWith(path.sep) ? left : `${left}${path.sep}`);
}

/**
 * @param {object} input
 * @param {string|null} [input.root] 本会话根（null/'' = 无根）
 * @param {string} [input.cwd] 会话 cwd
 * @param {boolean} [input.managed] 该根是否纳管（P1 只有主根为 true）
 * @param {boolean} [input.earlyEnabled] 策略层是否允许提前压（`compact.early`）
 * @param {boolean} [input.isSubagent] 子会话（压缩/审计纳管、不写记忆；P1 只透传）
 */
export function resolveScope({
  root = null,
  cwd = '',
  managed = true,
  earlyEnabled = true,
  isSubagent = false,
} = {}) {
  const normalizedRoot = normalizeRoot(root);
  const normalizedCwd = typeof cwd === 'string' ? cwd.trim() : '';
  const rootKnown = normalizedRoot !== null;
  const missingCwd = rootKnown && normalizedCwd === '';
  const inside = rootKnown && !missingCwd && cwdWithinRoot(normalizedCwd, normalizedRoot);
  const governed = rootKnown && managed !== false && inside;
  const skipReason = earlyEnabled === false
    ? SCOPE_SKIP.OUT_OF_SCOPE
    : (!rootKnown || missingCwd)
      ? SCOPE_SKIP.NO_ROOT
      : managed === false
        ? SCOPE_SKIP.UNMANAGED
        : (inside ? null : SCOPE_SKIP.UNMANAGED);
  return {
    mode: rootKnown ? (managed === false ? SCOPE_MODE.MULTI_ROOT : SCOPE_MODE.SINGLE_ROOT) : SCOPE_MODE.UNRESOLVED,
    root: normalizedRoot,
    cwd: normalizedCwd,
    governed,
    skipReason,
    unattributed: missingCwd,
    isSubagent: isSubagent === true,
  };
}
