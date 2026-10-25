/**
 * cg-stub —— 最小装载探针（不是产品，验证完就删/替换）。
 *
 * `apply()` 只做两件事：
 *   1. 往 logs/cg-stub.log 追加一行启动记录（版本 / pid / 时间 / 观察器状态）；
 *   2. 注册一个 `session/event` 观察器，**只把事件数记在内存里**；不读摘要、
 *      不写记忆、不注册工具、不改任何配置、不发网络请求、不产生额外日志。
 *
 * 加载失败时的排查重点因此只有一个：**宿主能不能装这个包、读到 bundle patch、
 * 执行 apply()**；不掺杂宿主包解析（本文件不 import 任何 @deepseek-ai 包）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'cg-stub';
export const VERSION = '0.0.1';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
// 仓库布局：packages/cg-stub/index.mjs → 上两级是工作区根。
const workspaceRoot = path.resolve(packageDir, '..', '..');
const DEFAULT_LOG = path.join(workspaceRoot, 'logs', 'cg-stub.log');

function appendLine(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function stamp() {
  return new Date().toISOString();
}

/**
 * Cordis plugin entry.
 *
 * @param {object} ctx 宿主插件上下文（只用到 `on`）。
 * @param {{enabled?:boolean, logFile?:string}} [config] 来自 bundle patch 的 config。
 */
export function apply(ctx, config = {}) {
  const enabled = config?.enabled !== false;
  const logFile = typeof config?.logFile === 'string' && config.logFile.trim() !== ''
    ? path.resolve(config.logFile)
    : DEFAULT_LOG;

  let observed = 0;
  let observer = 'skipped(enabled=false)';
  if (enabled) {
    try {
      if (typeof ctx?.on === 'function') {
        ctx.on('session/event', () => {
          // 只计数：不读 session、不读摘要、不落任何副作用。
          observed += 1;
        });
        observer = 'registered(count-only)';
      } else {
        observer = 'unavailable(no ctx.on)';
      }
    } catch (error) {
      observer = `error:${String(error?.message ?? error).slice(0, 120)}`;
    }
  }

  // 启动行：这是“装载成功”的唯一判据。
  const line = [
    stamp(),
    'cg-stub',
    'apply',
    `version=${VERSION}`,
    `pid=${process.pid}`,
    `enabled=${enabled}`,
    `observer=${observer}`,
    `cwd=${process.cwd()}`,
    `log=${logFile}`,
  ].join(' ');
  if (!appendLine(logFile, line)) {
    // 工作区不可写时退到临时目录；这不代表装载失败。
    try {
      fs.appendFileSync(path.join(process.env.TEMP ?? '.', 'cg-stub.log'), `${line} [fallback]\n`, 'utf8');
    } catch {
      /* 日志写失败也不能让宿主加载失败 */
    }
  }
}

export default { name, apply };
