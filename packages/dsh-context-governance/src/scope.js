/**
 * 1.0 #1（B-1）：会话作用域判定（单根模型）。
 *
 * 纯函数、只读、无副作用：给 `early-wiring` 的提前压触发、`runtime` 的观测/保护、
 * `header` 注入与命令面提供**同一份**判定，避免各处各写一套 cwd 比较。
 *
 * 术语：
 * - `governed`：该会话是否在唯一项目根内 → 观测/保护/回注/记忆写只对 governed 为真；
 * - `skipReason`：**提前压触发**的跳过原因，三枚举互斥（`foreign-session` /
 *   `no-project-root` / `out-of-scope`）；`governed=true` 且 `skipReason=out-of-scope`
 *   表示“根内但策略层关掉了提前压”，保护/观测照常。
 * - cwd 为空：无法归属，按旧行为放行（`unattributed=true`），不误判为外部会话。
 */
import path from 'node:path';

export const SCOPE_MODE = Object.freeze({
  SINGLE_ROOT: 'single-root',
  UNRESOLVED: 'unresolved',
});

export const SCOPE_SKIP = Object.freeze({
  FOREIGN: 'foreign-session',
  NO_ROOT: 'no-project-root',
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
 * @param {string|null} [input.root] 唯一项目根（null/'' = 根未确定）
 * @param {string} [input.cwd] 会话 cwd
 * @param {boolean} [input.earlyEnabled] 策略层是否允许提前压（`compact.early`）
 * @returns {{mode:string, root:string|null, cwd:string, governed:boolean,
 *   skipReason:string|null, unattributed:boolean}}
 */
export function resolveScope({ root = null, cwd = '', earlyEnabled = true } = {}) {
  const normalizedRoot = normalizeRoot(root);
  const normalizedCwd = typeof cwd === 'string' ? cwd.trim() : '';
  const rootKnown = normalizedRoot !== null;
  const unattributed = rootKnown && normalizedCwd === '';
  const inside = rootKnown && (unattributed || cwdWithinRoot(normalizedCwd, normalizedRoot));
  // 三枚举互斥：策略层禁用与位置无关；根未知优先于“外部”。
  const skipReason = earlyEnabled === false
    ? SCOPE_SKIP.OUT_OF_SCOPE
    : (rootKnown ? (inside ? null : SCOPE_SKIP.FOREIGN) : SCOPE_SKIP.NO_ROOT);
  return {
    mode: rootKnown ? SCOPE_MODE.SINGLE_ROOT : SCOPE_MODE.UNRESOLVED,
    root: normalizedRoot,
    cwd: normalizedCwd,
    governed: inside,
    skipReason,
    unattributed,
  };
}
