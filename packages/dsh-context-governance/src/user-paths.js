/**
 * C39 ④⑤：用户级落盘的**唯一基座推导**（可移植性）。
 *
 * 目标：换机器、换用户名、换盘符、换 DSH home、换 profile 都不改变"能跑"这件事；
 * 且所有用户级文件都在同一个 `<DSH home>/context-governance/` 下（此前会话记忆在
 * `~/context-governance/`，A2/plugin-policy 在 `~/.dsh/context-governance/`，两处基座不一致）。
 *
 * 优先级：
 * 1. `ctx.get('profileContext').home`（宿主启动数据，通常是用户的 DSH home 目录）；
 * 2. 环境变量 `USERPROFILE`/`HOME` + `.dsh`（CLI/无 profileContext 时）；
 * 3. 无可用 home → `null`（调用方按"用户级不可用"显式退化，绝不猜路径）。
 */

/** 用户级目录名（与 root-state / root-audit 同目录）。 */
export const USER_DATA_DIRNAME = 'context-governance';

/** 历史会话记忆基座名（rc.9 及以前：用户主目录下、无 `.dsh`），只用于兼容读取。 */
export const LEGACY_SESSION_DIRNAME = 'context-governance';

/**
 * 解析 DSH home（= 用户级 context-governance 的父目录）。
 * @param {{ok?: boolean, home?: string|null}|null} identity `resolvePersistenceIdentity()` 结果
 * @param {NodeJS.ProcessEnv} env
 * @returns {{home: string|null, source: 'profileContext'|'env'|'unavailable'}}
 */
export function resolveUserHome(identity = null, env = process.env) {
  if (identity !== null && identity !== undefined && identity.ok === true
    && typeof identity.home === 'string' && identity.home.trim() !== '') {
    return { home: identity.home.trim(), source: 'profileContext' };
  }
  const rawProfile = env?.USERPROFILE ?? env?.HOME ?? '';
  const raw = typeof rawProfile === 'string' ? rawProfile.trim() : '';
  if (raw === '') return { home: null, source: 'unavailable' };
  return { home: `${raw.replace(/[\\/]+$/, '')}/.dsh`, source: 'env' };
}

/** 历史（rc.9 及以前）会话记忆基座：`<用户主目录>/context-governance`；不可用 → null。 */
export function legacySessionBase(env = process.env) {
  const rawProfile = env?.USERPROFILE ?? env?.HOME ?? '';
  const raw = typeof rawProfile === 'string' ? rawProfile.trim() : '';
  if (raw === '') return null;
  return `${raw.replace(/[\\/]+$/, '')}/${LEGACY_SESSION_DIRNAME}`;
}

/** `<home>/context-governance`；home 不可用 → null。 */
export function userDataDir(home) {
  if (typeof home !== 'string' || home.trim() === '') return null;
  return `${home.replace(/[\\/]+$/, '')}/${USER_DATA_DIRNAME}`;
}
