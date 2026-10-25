/**
 * dsh-context-governance — 上下文治理插件（M1）。
 *
 * T2 范围：内置最小记忆文件存储 + `mem_write` / `mem_query` 两个工具。
 * 压缩适配、回注、状态命令、审计在 T3–T6 接入；本文件的 `apply` 只负责
 * “校验配置 → 打开记忆库 → 注册工具 → 关闭时释放锁”，失败时不改写任何宿主状态。
 *
 * 注意：本文件刻意不 import 任何 `@deepseek-ai/*` 包，纯 ESM + Node 内置模块；
 * 宿主侧包装（defineTool、Schemastery 表单、workspace 根解析）留到 T3。
 */

import path from 'node:path';

import { registerStatusCommand } from './commands/cg-status.js';
import { detectHostVersion, normalizeBackendVersion } from './compress/adapters.js';
import { CompressionGuard } from './compress/runtime.js';
import { formatCapability, probeCapability } from './capabilities.js';
import { appendDiagnosticLine, capabilityLine, PLUGIN_VERSION, startupLine } from './diagnostics.js';
import { DEFAULT_MEMORY_DIR, MemoryStore, MemoryStoreError } from './memory/store.js';
import { MEM_QUERY_NAME, MEM_WRITE_NAME, registerMemoryTools } from './tools/mem-tools.js';

export const name = 'dsh-context-governance';

/** 本插件消费宿主工具面与命令面；压缩服务不可作为硬依赖（本机实测会 pending）。 */
export const inject = ['tools', 'commands'];

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  projectRoot: '',
  memoryRoot: DEFAULT_MEMORY_DIR,
  project: '',
  readOnly: false,
  indexMaxChars: 64_000,
  compression: Object.freeze({
    enabled: true,
    hostVersion: '',
    backendVersion: '',
  }),
  diagnostics: Object.freeze({
    logFile: '',
  }),
});

/**
 * 校验并填充配置。非法配置抛错 → 插件不加载，DSH 继续用默认行为（架构 §9.3）。
 *
 * @param {object} [raw]
 * @returns {object}
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MemoryStoreError('CONFIG', 'context-governance config must be an object');
  }
  const config = { ...DEFAULT_CONFIG, ...raw };
  if (typeof config.enabled !== 'boolean') throw new MemoryStoreError('CONFIG', 'enabled must be a boolean');
  if (typeof config.projectRoot !== 'string') throw new MemoryStoreError('CONFIG', 'projectRoot must be a string');
  if (typeof config.memoryRoot !== 'string' || config.memoryRoot.trim() === '') {
    throw new MemoryStoreError('CONFIG', 'memoryRoot must be a non-empty string');
  }
  if (typeof config.project !== 'string') throw new MemoryStoreError('CONFIG', 'project must be a string');
  if (typeof config.readOnly !== 'boolean') throw new MemoryStoreError('CONFIG', 'readOnly must be a boolean');
  if (!Number.isInteger(config.indexMaxChars) || config.indexMaxChars < 1_000 || config.indexMaxChars > 200_000) {
    throw new MemoryStoreError('CONFIG', 'indexMaxChars must be an integer in [1000, 200000]');
  }
  if (config.compression === null || typeof config.compression !== 'object' || Array.isArray(config.compression)) {
    throw new MemoryStoreError('CONFIG', 'compression must be an object');
  }
  const compression = { ...DEFAULT_CONFIG.compression, ...config.compression };
  if (typeof compression.enabled !== 'boolean') {
    throw new MemoryStoreError('CONFIG', 'compression.enabled must be a boolean');
  }
  if (typeof compression.hostVersion !== 'string' || typeof compression.backendVersion !== 'string') {
    throw new MemoryStoreError('CONFIG', 'compression.hostVersion/backendVersion must be strings');
  }
  if (config.diagnostics === null || typeof config.diagnostics !== 'object' || Array.isArray(config.diagnostics)) {
    throw new MemoryStoreError('CONFIG', 'diagnostics must be an object');
  }
  if (typeof config.diagnostics.logFile !== 'string') {
    throw new MemoryStoreError('CONFIG', 'diagnostics.logFile must be a string');
  }
  const projectRoot = path.resolve(config.projectRoot === '' ? process.cwd() : config.projectRoot);
  return {
    enabled: config.enabled,
    projectRoot,
    memoryRoot: path.resolve(projectRoot, config.memoryRoot),
    project: config.project.trim() === '' ? path.basename(projectRoot) : config.project.trim(),
    readOnly: config.readOnly,
    indexMaxChars: config.indexMaxChars,
    compression: {
      enabled: compression.enabled,
      hostVersion: compression.hostVersion.trim(),
      backendVersion: compression.backendVersion.trim(),
    },
    diagnostics: {
      logFile: config.diagnostics.logFile.trim(),
    },
  };
}

/**
 * 打开插件配置对应的记忆库（供 apply 与测试共用）。
 * @param {object} config resolveConfig 的结果。
 * @param {{now?: () => Date}} [options]
 */
export async function openStore(config, options = {}) {
  return MemoryStore.open({
    rootDir: config.memoryRoot,
    project: config.project,
    readOnly: config.readOnly,
    indexMaxChars: config.indexMaxChars,
    now: options.now,
  });
}

/**
 * Cordis plugin entry。
 *
 * @param {object} ctx 宿主插件上下文。
 * @param {object} [rawConfig]
 */
export async function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    ctx.logger?.info?.('[context-governance] disabled by config');
    return;
  }
  const store = await openStore(config);
  const definitionWrapper = typeof rawConfig.defineTool === 'function'
    ? rawConfig.defineTool
    : (definition) => definition;
  const registration = registerMemoryTools(ctx, store, { defineTool: definitionWrapper });
  for (const failure of registration.failures) {
    ctx.logger?.warn?.(`[context-governance] tool ${failure.name} was not registered: ${failure.message}`);
  }
  ctx.logger?.info?.(
    `[context-governance] memory store ready at ${config.memoryRoot} ` +
    `(project=${config.project}, writers=${registration.registered.join(',') || 'none'}); ` +
    `entries=${store.status.counts.active + store.status.counts.proposed} active/proposed`,
  );
  for (const warning of store.warnings) ctx.logger?.warn?.(`[context-governance] ${warning}`);

  // T3：压缩观测 + 保护校验。失败只降级/告警，不影响已注册的工具与记忆库。
  const hostVersion = config.compression.hostVersion === ''
    ? detectHostVersion()
    : config.compression.hostVersion;
  const backendVersion = normalizeBackendVersion(config.compression.backendVersion);
  // v0.1.3：先把事件面能力 dump 出来（只记类型），再决定感知层级。
  const capability = probeCapability(ctx);
  if (config.diagnostics.logFile !== '') {
    const ok = appendDiagnosticLine(config.diagnostics.logFile, capabilityLine(capability.entries));
    if (!ok) ctx.logger?.warn?.(`[context-governance] diagnostics log is not writable: ${config.diagnostics.logFile}`);
  }
  let compactionProbe = null;
  try {
    compactionProbe = ctx.compaction ??
      (typeof ctx.get === 'function' ? ctx.get('compaction') : null) ??
      null;
  } catch {
    compactionProbe = null;
  }
  const compactionService = compactionProbe === null ? 'absent' : 'present';
  if (config.compression.enabled && compactionService === 'absent') {
    ctx.logger?.warn?.(
      '[context-governance] compaction service not mounted/visible (token="compaction"); ' +
      'provider path unavailable, event-level perception via session/event remains active',
    );
  }
  if (config.compression.enabled && !capability.eventApi) {
    ctx.logger?.warn?.(
      '[context-governance] ctx.on is unavailable; compaction observation disabled (perception=none). ' +
      `capability probe: ${formatCapability(capability.entries)}`,
    );
  }
  let guard = null;
  if (config.compression.enabled) {
    try {
      guard = new CompressionGuard({
        ctx,
        hostVersion,
        backendVersion,
        logger: ctx.logger,
        store,
      });
      guard.start();
      const status = guard.status;
      ctx.logger?.info?.(
        `[context-governance] compression observer: adapter=${status.adapter.kind} ` +
        `mode=${status.mode} perception=${status.perception} host=${hostVersion} ` +
        `backend=${status.adapter.versions.backend} compaction-service=${compactionService}`,
      );
      for (const conflict of status.conflicts) {
        const log = conflict.severity === 'error' ? 'warn' : 'info';
        ctx.logger?.[log]?.(`[context-governance] compression conflict ${conflict.code}: ${conflict.message}`);
      }
      guard.auditLog?.append?.('apply', {
        status: 'applied',
        version: PLUGIN_VERSION,
        mode: status.mode,
        adapter: status.adapter.kind,
        host: hostVersion,
        backend: status.adapter.versions.backend,
        perception: status.perception,
        eventApi: status.eventApi,
      });
    } catch (error) {
      ctx.logger?.warn?.(`[context-governance] compression observer failed to start: ${String(error?.message ?? error)}`);
      guard = null;
    }
  }

  if (config.diagnostics.logFile !== '') {
    const ok = appendDiagnosticLine(config.diagnostics.logFile, startupLine({
      adapterKind: guard?.adapter.kind ?? 'disabled',
      mode: guard?.mode ?? 'disabled',
      hostVersion,
      backendVersion,
      memoryRoot: config.memoryRoot,
      compactionService,
      perception: guard?.perception ?? 'none',
      eventApi: capability.eventApi ? 'on' : 'off',
      auditFile: guard?.auditLog?.file ?? '',
      warning: compactionService === 'absent' && config.compression.enabled ? 'provider-unavailable' : '',
    }));
    if (!ok) ctx.logger?.warn?.(`[context-governance] diagnostics log is not writable: ${config.diagnostics.logFile}`);
  }

  // T5：/cg status（只读；不依赖压缩服务是否可用）。
  const command = registerStatusCommand(ctx, {
    store,
    getGuard: () => guard,
    audit: guard?.auditLog ?? null,
  });
  if (!command.registered) {
    ctx.logger?.warn?.(`[context-governance] /cg status was not registered: ${command.reason}`);
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      command.dispose?.();
      guard?.stop();
      await store.close();
    }, 'context-governance cleanup');
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      command.dispose?.();
      guard?.stop();
      store.close().catch(() => {});
    });
  }
}

export {
  DEFAULT_MEMORY_DIR,
  MEM_QUERY_NAME,
  MEM_WRITE_NAME,
  MemoryStore,
  MemoryStoreError,
};
