/**
 * 可选的诊断日志：写启动记录与能力探测行，用于**首次安装/升级验证**。
 *
 * 默认关闭（配置 `diagnostics.logFile` 为空）。写失败绝不抛错、绝不影响插件装载；
 * 不写消息正文、不写记忆内容、不写任何服务实例或其字段值。
 */

import fs from 'node:fs';
import path from 'node:path';

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

export function appendDiagnosticLine(file, line) {
  if (typeof file !== 'string' || file.trim() === '') return false;
  try {
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 能力探测行（v0.1.3）：一行列清事件面相关 API 是否存在。
 *
 * 形如：
 * `... governance capability version=0.1.3 pid=1 probe=on=fn,events=obj(dispatch=fn),...,get.sessions=absent,root=self`
 *
 * @param {Array<[string, string]>} entries `name=类型标记` 列表
 */
export function capabilityLine(entries = []) {
  return [
    new Date().toISOString(),
    'governance',
    'capability',
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
