/**
 * 可选的诊断日志：只写一行启动记录，用于**首次安装/升级验证**。
 *
 * 默认关闭（配置 `diagnostics.logFile` 为空）。写失败绝不抛错、绝不影响插件装载；
 * 不写消息正文、不写记忆内容。
 */

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_VERSION = '0.1.2';

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

export function startupLine({
  adapterKind = 'unknown',
  mode = 'unknown',
  hostVersion = 'unknown',
  backendVersion = 'unknown',
  memoryRoot = '',
  compactionService = 'unknown',
  perception = 'unknown',
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
    `memory=${memoryRoot}`,
    ...(warning === '' ? [] : [`warning=${warning}`]),
  ].join(' ');
}
