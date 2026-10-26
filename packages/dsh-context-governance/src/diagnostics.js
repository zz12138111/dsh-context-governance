/**
 * 可选的诊断日志：写启动记录与能力探测行，用于**首次安装/升级验证**。
 *
 * v3：诊断路径由 apply 校验为两类白名单之一（用户级 / 该根 memory/governance），
 * 并在每次实际写入前用 realpath containment 复核；未显式配置时默认用户级
 * `<home>/context-governance/logs/governance.log`。写失败绝不抛错、绝不影响插件装载；
 * 不写消息正文、不写记忆内容、不写任何服务实例或其字段值。
 */

import fs from 'node:fs';
import path from 'node:path';

import { checkWriteTarget } from './roots/containment.js';

/** 已校验路径 → 允许基目录（apply 注册；同一进程多个 target 分开存）。 */
const registeredBases = new Map();

/**
 * 注册诊断文件的允许基目录（apply 在通过 v3 白名单校验后调用）。
 * @param {string} file
 * @param {string[]} bases
 */
export function registerDiagnosticPath(file, bases) {
  if (typeof file !== 'string' || file.trim() === '') return;
  const list = Array.isArray(bases) ? bases.filter((base) => typeof base === 'string' && base !== '') : [];
  registeredBases.set(path.resolve(file), list);
}

/**
 * 版本单一来源：**只**从本包 `package.json` 读，代码里不再手写版本号。
 * 读不到（例如被打包器重排路径）时降级为 `unknown`，启动行仍可写。
 */
export function readPackageVersion() {
  try {
    const file = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() !== '' ? pkg.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const PLUGIN_VERSION = readPackageVersion();

export function appendDiagnosticLine(file, line, { allowedBases = null } = {}) {
  if (typeof file !== 'string' || file.trim() === '') return false;
  // 1.0 #8：绝不对相对路径做 path.resolve（会落到进程 cwd）。非绝对路径直接拒绝。
  const trimmed = file.trim();
  if (!path.isAbsolute(trimmed)) return false;
  const target = path.resolve(trimmed);
  // v3：实际写入前按“已注册的允许基目录”做 realpath containment（无注册 = 兼容旧单测）。
  const bases = Array.isArray(allowedBases)
    ? allowedBases
    : (registeredBases.get(target) ?? []);
  if (Array.isArray(bases) && bases.length > 0) {
    const allowed = bases.some((base) => checkWriteTarget(base, target).ok === true);
    if (!allowed) return false;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 能力探测行（v0.1.3；M1.2 起分 `@apply` / `@ready` 两行）。
 *
 * 形如：
 * `... governance capability@apply version=0.1.11 pid=1 probe=on=fn,events=obj(dispatch=fn),...,get.sessions=absent,root=self`
 *
 * @param {Array<[string, string]>} entries `name=类型标记` 列表
 * @param {'apply'|'ready'} [phase] 探测时点；apply=装载时，ready=首个会话事件后
 */
export function capabilityLine(entries = [], phase = 'apply') {
  return [
    new Date().toISOString(),
    'governance',
    `capability@${phase}`,
    `version=${PLUGIN_VERSION}`,
    `pid=${process.pid}`,
    `probe=${entries.map(([name, value]) => `${name}=${value}`).join(',')}`,
  ].join(' ');
}

export function startupLine({
  adapterKind = 'unknown',
  mode = 'unknown',
  hostVersion = 'unknown',
  backendVersion = 'unknown',
  memoryRoot = '',
  compactionService = 'unknown',
  perception = 'unknown',
  eventApi = 'unknown',
  auditFile = '',
  readOnly = '',
  warning = '',
} = {}) {
  return [
    new Date().toISOString(),
    'governance',
    'apply',
    `version=${PLUGIN_VERSION}`,
    `pid=${process.pid}`,
    `adapter=${adapterKind}`,
    `mode=${mode}`,
    `host=${hostVersion}`,
    `backend=${backendVersion}`,
    `compaction-service=${compactionService}(token=compaction)`,
    `perception=${perception}`,
    `event-api=${eventApi}`,
    ...(auditFile === '' ? [] : [`audit=${auditFile}`]),
    ...(readOnly === '' ? [] : [`memory-read-only=${readOnly}`]),
    `memory=${memoryRoot}`,
    ...(warning === '' ? [] : [`warning=${warning}`]),
  ].join(' ');
}
