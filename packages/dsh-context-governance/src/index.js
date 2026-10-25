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

import fs from 'node:fs';
import path from 'node:path';

import { registerStatusCommand } from './commands/cg-status.js';
import { POLICY_FILE_MAX_BYTES, nativeFromWindow, nativeRatio, profileLayer, resolvePolicy, validateLayer } from './policy.js';
import { detectHostVersion, normalizeBackendVersion } from './compress/adapters.js';
import { CompressionGuard } from './compress/runtime.js';
import { wireEarlyCompaction } from './compress/early-wiring.js';
import { formatCapability, probeCapability } from './capabilities.js';
import { DEFAULT_AUDIT_MAX_BYTES, MAX_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES } from './audit.js';
import { appendDiagnosticLine, capabilityLine, PLUGIN_VERSION, startupLine } from './diagnostics.js';
import { DEFAULT_MEMORY_DIR, MemoryStore, MemoryStoreError } from './memory/store.js';
import { registerMemoryHeader } from './memory/header.js';
import { MEM_QUERY_NAME, MEM_WRITE_NAME, registerMemoryTools } from './tools/mem-tools.js';

export const name = 'dsh-context-governance';

/**
 * 只把 `tools` 作为硬依赖：记忆工具必须有工具面。
 * `commands` 仅用于 `/cg status`，走可选探测（`ctx.get('commands')`）——缺它时插件照常 apply，
 * 只是不注册命令、留一条 warn（SPEC-05：硬 inject 会让插件直接 inactive）。
 */
export const inject = ['tools'];

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
  audit: Object.freeze({
    maxBytes: DEFAULT_AUDIT_MAX_BYTES,
  }),
  /** T8-1：连续回注失败阈值（达到后暂停一个周期保护写；1–20 夹取）。 */
  reinjection: Object.freeze({
    maxFailures: 3,
  }),
  memoryHeader: Object.freeze({
    // M3 T2（0.3.1）：默认开；`/cg header off`、项目/插件配置均可关。
    enabled: true,
    maxLines: 8,
    maxChars: 800,
    oldAgeDays: 14,
    oldLimit: 30,
  }),
  /** P2-1：只处理本项目（cwd 匹配 projectRoot）会话的压缩事件。 */
  onlyProject: true,
  /** P2-2：保护条目是否保留“首行摘要”（默认开；关=只存指针与通用标签）。 */
  captureTitle: true,
  diagnostics: Object.freeze({
    logFile: '',
  }),
  policy: Object.freeze({
    profile: '',
    windowTokens: 1_000_000,
    reservedTokens: 256_000,
    projectFile: '.cg-policy.json',
    values: Object.freeze({}),
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
  if (config.policy === null || typeof config.policy !== 'object' || Array.isArray(config.policy)) {
    throw new MemoryStoreError('CONFIG', 'policy must be an object');
  }
  const policy = { ...DEFAULT_CONFIG.policy, ...config.policy };
  if (typeof policy.profile !== 'string') throw new MemoryStoreError('CONFIG', 'policy.profile must be a string');
  if (!Number.isFinite(policy.windowTokens) || policy.windowTokens <= 0) {
    throw new MemoryStoreError('CONFIG', 'policy.windowTokens must be a positive number');
  }
  if (!Number.isFinite(policy.reservedTokens) || policy.reservedTokens < 0) {
    throw new MemoryStoreError('CONFIG', 'policy.reservedTokens must be a non-negative number');
  }
  if (policy.values === null || typeof policy.values !== 'object' || Array.isArray(policy.values)) {
    throw new MemoryStoreError('CONFIG', 'policy.values must be an object');
  }
  // 项目层文件名只允许项目内相对路径：拒绝绝对路径与 `..`（防逃出 projectRoot）。
  const projectFile = String(policy.projectFile ?? '.cg-policy.json').trim() || '.cg-policy.json';
  if (path.isAbsolute(projectFile) || /(^|[\\/])\.\.([\\/]|$)/.test(projectFile)) {
    throw new MemoryStoreError('CONFIG', 'policy.projectFile must be a relative path inside projectRoot');
  }
  // policyBlockValidated
  if (config.audit === null || typeof config.audit !== 'object' || Array.isArray(config.audit)) {
    throw new MemoryStoreError('CONFIG', 'audit must be an object');
  }
  const audit = { ...DEFAULT_CONFIG.audit, ...config.audit };
  if (!Number.isInteger(audit.maxBytes) || audit.maxBytes < MIN_AUDIT_MAX_BYTES || audit.maxBytes > MAX_AUDIT_MAX_BYTES) {
    throw new MemoryStoreError(
      'CONFIG',
      `audit.maxBytes must be an integer in [${MIN_AUDIT_MAX_BYTES}, ${MAX_AUDIT_MAX_BYTES}]`,
    );
  }
  const projectRoot = path.resolve(config.projectRoot === '' ? process.cwd() : config.projectRoot);
  if (config.memoryHeader === null || typeof config.memoryHeader !== 'object' || Array.isArray(config.memoryHeader)) {
    throw new MemoryStoreError('CONFIG', 'memoryHeader must be an object');
  }
  const memoryHeader = { ...DEFAULT_CONFIG.memoryHeader, ...config.memoryHeader };
  if (typeof memoryHeader.enabled !== 'boolean') {
    throw new MemoryStoreError('CONFIG', 'memoryHeader.enabled must be a boolean');
  }
  if (!Number.isInteger(memoryHeader.maxLines) || memoryHeader.maxLines < 1 || memoryHeader.maxLines > 20) {
    throw new MemoryStoreError('CONFIG', 'memoryHeader.maxLines must be an integer in [1, 20]');
  }
  if (!Number.isInteger(memoryHeader.maxChars) || memoryHeader.maxChars < 120 || memoryHeader.maxChars > 2000) {
    throw new MemoryStoreError('CONFIG', 'memoryHeader.maxChars must be an integer in [120, 2000]');
  }
  if (!Number.isInteger(memoryHeader.oldAgeDays) || memoryHeader.oldAgeDays < 0 || memoryHeader.oldAgeDays > 365) {
    throw new MemoryStoreError('CONFIG', 'memoryHeader.oldAgeDays must be an integer in [0, 365]');
  }
  if (!Number.isInteger(memoryHeader.oldLimit) || memoryHeader.oldLimit < 0 || memoryHeader.oldLimit > 100) {
    throw new MemoryStoreError('CONFIG', 'memoryHeader.oldLimit must be an integer in [0, 100]');
  }
  if (typeof config.onlyProject !== 'boolean') throw new MemoryStoreError('CONFIG', 'onlyProject must be a boolean');
  if (typeof config.captureTitle !== 'boolean') throw new MemoryStoreError('CONFIG', 'captureTitle must be a boolean');
  if (config.reinjection === null || typeof config.reinjection !== 'object' || Array.isArray(config.reinjection)) {
    throw new MemoryStoreError('CONFIG', 'reinjection must be an object');
  }
  const reinjection = { ...DEFAULT_CONFIG.reinjection, ...config.reinjection };
  if (!Number.isInteger(reinjection.maxFailures)) {
    throw new MemoryStoreError('CONFIG', 'reinjection.maxFailures must be an integer (clamped to [1, 20])');
  }
  reinjection.maxFailures = Math.min(Math.max(reinjection.maxFailures, 1), 20);
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
    audit: {
      maxBytes: audit.maxBytes,
    },
    reinjection: {
      maxFailures: reinjection.maxFailures,
    },
    memoryHeader: {
      enabled: memoryHeader.enabled,
      maxLines: memoryHeader.maxLines,
      maxChars: memoryHeader.maxChars,
      oldAgeDays: memoryHeader.oldAgeDays,
      oldLimit: memoryHeader.oldLimit,
    },
    onlyProject: config.onlyProject,
    captureTitle: config.captureTitle,
    diagnostics: {
      logFile: config.diagnostics.logFile.trim(),
    },
    policy: {
      profile: policy.profile,
      windowTokens: policy.windowTokens,
      reservedTokens: policy.reservedTokens,
      projectFile: String(policy.projectFile ?? '.cg-policy.json').trim() || '.cg-policy.json',
      values: policy.values,
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
/**
 * 构建策略状态（纯同步、可单测）：profile 标签层 → 插件层 → 项目 .cg-policy.json。
 * 读文件失败/非法 JSON/非法键/越界/超长 → 只记 invalid（由 apply 写 policy-invalid 审计），不抛错。
 *
 * 项目层是新输入面（仓库自带的文件）：路径必须在 projectRoot 内，大小受限，
 * 且只能设策略子集（禁 estimateSafety/lowThresholdAck，compact.at 下限 0.45）。
 *
 * @param {object} config resolveConfig 的结果。
 * @param {{readFile?: (file: string) => string, statSize?: (file: string) => number}} [deps]
 */
export function buildPolicyState(config, deps = {}) {
  const realFs = typeof deps.readFile !== 'function';
  const readFile = typeof deps.readFile === 'function' ? deps.readFile : (target) => fs.readFileSync(target, 'utf8');
  const statSize = typeof deps.statSize === 'function'
    ? deps.statSize
    : (realFs ? (target) => fs.statSync(target).size : null);
  const native = nativeRatio({ windowTokens: config.policy.windowTokens, reservedTokens: config.policy.reservedTokens });
  const layers = [];
  const invalid = [];
  const profilePreset = profileLayer(config.policy.profile);
  if (profilePreset !== null) layers.push({ source: profilePreset.source, values: profilePreset.values });
  const plugin = validateLayer(config.policy.values, { source: 'plugin', native });
  layers.push({ source: 'plugin', values: plugin.values });
  invalid.push(...plugin.invalid);
  const project = { source: 'project', values: {} };
  const root = path.resolve(config.projectRoot);
  const target = path.resolve(root, config.policy.projectFile);
  if (!(target === root || target.startsWith(root + path.sep))) {
    // 纵深防御：resolveConfig 已拒绝绝对路径与 `..`。
    invalid.push({ source: 'project', key: '*', reason: 'outside-project-root' });
  } else {
    try {
      const size = statSize === null ? null : statSize(target);
      if (size !== null && size > POLICY_FILE_MAX_BYTES) {
        invalid.push({ source: 'project', key: '*', reason: 'too-large', detail: `> ${POLICY_FILE_MAX_BYTES} bytes` });
      } else {
        const parsed = JSON.parse(String(readFile(target)));
        const validated = validateLayer(parsed, { source: 'project', native, projectLayer: true });
        project.values = validated.values;
        invalid.push(...validated.invalid);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        invalid.push({
          source: 'project',
          key: '*',
          reason: error instanceof SyntaxError ? 'invalid-json' : 'read-failed',
        });
      }
    }
  }
  layers.push(project);
  // 会话层（`/cg set`）：最高优先级；0.2.0 起为进程内覆盖，重启即失效。
  const sessionLayer = { source: 'session', values: {} };
  layers.push(sessionLayer);
  // 0.2.1（DEC-20261025-66 / 68）：窗口由运行时观察；每次 resolve 现算 native（不锁 apply）。
  // P2-3：`/cg set` 被拒的 transient（每 episode 去重；窗口恢复时清空），不写进 build 期的 state.invalid。
  const transientRejections = [];
  let windowProvider = () => null;
  const resolveWithWindow = () => {
    const win = windowProvider() ?? null;
    const configWindow = config.policy.windowTokens;
    const reservedTokens = config.policy.reservedTokens;
    const currentTokens = win?.current?.tokens ?? configWindow;
    const currentSource = win?.current
      ? (win.current.source === 'backfilled' ? 'projection(backfilled)' : 'projection')
      : 'config-fallback';
    const conservative = win?.conservative ?? null;
    const currentInfo = nativeFromWindow({ windowTokens: currentTokens, reservedTokens });
    const conservativeInfo = conservative === null
      ? null
      : nativeFromWindow({ windowTokens: conservative.tokens, reservedTokens });
    const configInfo = nativeFromWindow({ windowTokens: configWindow, reservedTokens });
    // 校验窗口：保守窗口优先；无观察用配置窗口。
    const validationInfo = conservativeInfo ?? configInfo;
    const checkNative = validationInfo.native;
    // DEC-20261025-68 A：native 不可计算（退化/非法）时，不造 0 也不造 0.6785；设置 at 的层一律拒绝。
    const degenerate = checkNative === null;
    const degenerateTokens = conservative?.tokens ?? configWindow;
    const runtimeInvalid = [];
    const filtered = layers.map((layer) => {
      const values = { ...layer.values };
      const at = values['compact.at'];
      if (at !== undefined) {
        if (degenerate) {
          runtimeInvalid.push({
            source: layer.source,
            key: 'compact.at',
            reason: 'native-uncomputable',
            detail: `W=${degenerateTokens} O=${reservedTokens}`,
          });
          delete values['compact.at'];
        } else if (at > checkNative + 1e-9) {
          runtimeInvalid.push({
            source: layer.source,
            key: 'compact.at',
            reason: 'over-native-runtime',
            detail: `at=${at} > native=${checkNative}` +
              (conservative === null ? '' : `（保守窗口 ${conservative.tokens}）`),
          });
          delete values['compact.at'];
        }
      }
      return { source: layer.source, values };
    });
    const resolved = resolvePolicy(filtered, { native: currentInfo.native });
    // P2-3：拒绝项只放 transient（每 episode 去重、窗口恢复即清），绝不 push 进 state.invalid（那是构建期的静态记录）。
    if (!degenerate) transientRejections.length = 0;
    // P3-3：层被拒后回落到 builtin 的 at 仍可能 > conservative（例如 0.60 > 0.375），必须显式提示，不能默默生效。
    if (!degenerate && checkNative !== null && resolved.values['compact.at'] > checkNative + 1e-9) {
      runtimeInvalid.push({
        source: 'builtin',
        key: 'compact.at',
        reason: 'fallback-over-native',
        detail: `falls back to at=${resolved.values['compact.at']} > native=${checkNative}` +
          (conservative === null ? '' : `（保守窗口 ${conservative.tokens}）`),
      });
    }
    return {
      ...resolved,
      invalid: [...invalid, ...runtimeInvalid, ...resolved.invalid, ...transientRejections],
      window: {
        currentTokens: win?.current ? currentTokens : null,
        currentSessionId: win?.current?.sessionId ?? null,
        currentObservedAt: win?.current?.observedAt ?? null,
        currentSource,
        conservativeTokens: conservative?.tokens ?? null,
        conservativeSessionId: conservative?.sessionId ?? null,
        conservativeObservedAt: conservative?.observedAt ?? null,
        native: currentInfo.native,
        nativeConservative: conservativeInfo?.native ?? null,
        validated: conservative !== null && conservativeInfo?.native !== null,
        degenerate,
        degenerateWindowTokens: degenerate ? degenerateTokens : null,
        reservedTokens,
        removed: win?.removed === true,
      },
    };
  };
  return {
    native,
    layers,
    invalid,
    sessionLayer,
    windowTokens: config.policy.windowTokens,
    reservedTokens: config.policy.reservedTokens,
    /** 由 apply 注入运行时的 windowState 读取器（guard 可能还不可用，故为惰性）。 */
    setWindowProvider(provider) {
      windowProvider = typeof provider === 'function' ? provider : () => null;
    },
    /** 校验用 native：有保守窗口用保守 native，否则用配置窗口；退化/不可计算返回 null（调用方拒绝设置）。 */
    validationNative() {
      const win = windowProvider() ?? null;
      const conservative = win?.conservative ?? null;
      const info = conservative === null
        ? nativeFromWindow({ windowTokens: config.policy.windowTokens, reservedTokens: config.policy.reservedTokens })
        : nativeFromWindow({ windowTokens: conservative.tokens, reservedTokens: config.policy.reservedTokens });
      return info.native;
    },
    windowState: () => windowProvider() ?? null,
    /** P2-3：记录一次“会话层设置被拒”（每 episode 去重；窗口恢复时清空）。返回是否新增。 */
    rejectSessionSet(entry) {
      if (entry === null || typeof entry !== 'object') return false;
      const key = `${entry.source}|${entry.key}|${entry.reason}`;
      if (transientRejections.some((item) => `${item.source}|${item.key}|${item.reason}` === key)) return false;
      transientRejections.push(entry);
      return true;
    },
    /** 当前 episode 的 transient 拒绝（只读快照）。 */
    sessionRejections() {
      return transientRejections.map((item) => ({ ...item }));
    },
    resolve: resolveWithWindow,
  };
}

export async function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  // 策略链只在这里算一次：profile 标签 → 插件配置 → 项目 .cg-policy.json（命令侧只读它）。
  const policyState = buildPolicyState(config);
  if (!config.enabled) {
    ctx.logger?.info?.('[context-governance] disabled by config');
    return;
  }
  const store = await openStore(config);
  const registration = registerMemoryTools(ctx, store);
  for (const failure of registration.failures) {
    ctx.logger?.warn?.(`[context-governance] tool ${failure.name} was not registered: ${failure.message}`);
  }
  ctx.logger?.info?.(
    `[context-governance] memory store ready at ${config.memoryRoot} ` +
    `(project=${config.project}, writers=${registration.registered.join(',') || 'none'}); ` +
    `entries=${store.status.counts.active + store.status.counts.proposed} active/proposed`,
  );
  for (const warning of store.warnings) ctx.logger?.warn?.(`[context-governance] ${warning}`);
  // M3 T2（0.3.1）：新会话记忆 header 默认开；注册放在 guard 之后（窗口检查回调先入，保持 session/event 优先的顺序）。
  const ruleFilePresent = ['AGENTS.md', 'CLAUDE.md']
    .some((fileName) => fs.existsSync(path.join(config.projectRoot, fileName)));
  const storeReadOnlyReason = store.status.readOnlyReason;
  if (storeReadOnlyReason !== null) {
    // T6 只读降级：明确写原因；读与回注仍可用，压缩不被阻断。
    ctx.logger?.warn?.(
      `[context-governance] memory read-only (${storeReadOnlyReason}); ` +
      'memory writes and audit appends are suspended, reads and reinjection remain available',
    );
  }

  // T3：压缩观测 + 保护校验。失败只降级/告警，不影响已注册的工具与记忆库。
  const hostVersion = config.compression.hostVersion === ''
    ? detectHostVersion()
    : config.compression.hostVersion;
  const backendVersion = normalizeBackendVersion(config.compression.backendVersion);
  // v0.1.3：先把事件面能力 dump 出来（只记类型），再决定感知层级。
  // M1.2：apply 记一行；首个会话事件后再记 @ready（服务可能晚注册）。
  const capability = probeCapability(ctx);
  if (config.diagnostics.logFile !== '') {
    const ok = appendDiagnosticLine(config.diagnostics.logFile, capabilityLine(capability.entries, 'apply'));
    if (!ok) ctx.logger?.warn?.(`[context-governance] diagnostics log is not writable: ${config.diagnostics.logFile}`);
  }
  const capabilityProbeEntries = capability.entries.map(([name, value]) => `${name}=${value}`);
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
  let earlyWiring = null;
  const probeReadyCapability = () => {
    const ready = probeCapability(ctx);
    const entries = ready.entries.map(([name, value]) => `${name}=${value}`);
    if (config.diagnostics.logFile !== '') {
      appendDiagnosticLine(config.diagnostics.logFile, capabilityLine(ready.entries, 'ready'));
    }
    if (guard?.readOnly !== true) {
      guard?.auditLog?.append?.('capability@ready', { probe: entries });
    }
    const find = (name) => ready.entries.find(([key]) => key === name)?.[1] ?? 'absent';
    ctx.logger?.info?.(
      `[context-governance] capability@ready compaction=${find('compaction')} ` +
      `get.compaction=${find('get.compaction')} tokenMeter=${find('tokenMeter')} ` +
      `get.tokenMeter=${find('get.tokenMeter')}`,
    );
  };
  if (config.compression.enabled) {
    try {
      guard = new CompressionGuard({
        ctx,
        hostVersion,
        backendVersion,
        logger: ctx.logger,
        diagnosticsLogFile: config.diagnostics.logFile,
        store,
        auditMaxBytes: config.audit.maxBytes,
        projectRoot: config.projectRoot,
        onlyProject: config.onlyProject,
        captureTitle: config.captureTitle,
        project: config.project,
        reinjection: { maxFailures: config.reinjection.maxFailures },
        onFirstEvent: probeReadyCapability,
      });
      guard.start();
      // 0.2.2 第 5 步：turn/end 门禁接线（armed=false：不审计、不取服务、不调用）。
      if (earlyWiring === null) {
        earlyWiring = wireEarlyCompaction({
          ctx,
          getGuard: () => guard,
          getPolicy: () => {
            try {
              return policyState.resolve();
            } catch {
              return null;
            }
          },
          getArmed: () => {
            try {
              return policyState.resolve().values['compact.early.armed'] === true;
            } catch {
              return false;
            }
          },
          audit: guard.auditLog ?? null,
          logger: ctx.logger,
        });
      }
      const status = guard.status;
      ctx.logger?.info?.(
        `[context-governance] compression observer: adapter=${status.adapter.kind} ` +
        `mode=${status.mode} perception=${status.perception} host=${hostVersion} ` +
        `backend=${status.adapter.versions.backend} compaction-service=${compactionService} ` +
        `only-project=${config.onlyProject} capture-title=${config.captureTitle}`,
      );
      for (const conflict of status.conflicts) {
        const log = conflict.severity === 'error' ? 'warn' : 'info';
        ctx.logger?.[log]?.(`[context-governance] compression conflict ${conflict.code}: ${conflict.message}`);
      }
      if (guard.readOnly !== true) {
        guard.auditLog?.append?.('apply', {
          status: 'applied',
          version: PLUGIN_VERSION,
          mode: status.mode,
          adapter: status.adapter.kind,
          host: hostVersion,
          backend: status.adapter.versions.backend,
          perception: status.perception,
          eventApi: status.eventApi,
          readOnly: false,
        });
        guard.auditLog?.append?.('capability@apply', { probe: capabilityProbeEntries });
      } else {
        ctx.logger?.warn?.(`[context-governance] audit not initialized: memory read-only (${guard.readOnlyReason ?? 'unknown'})`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`[context-governance] compression observer failed to start: ${String(error?.message ?? error)}`);
      guard = null;
    }
  }

  // 0.2.1（DEC-20261025-66）：窗口由运行时观察；每次 resolve 现算 native（不锁 apply）。
  if (typeof policyState.setWindowProvider === 'function') {
    policyState.setWindowProvider(() => guard?.windowState ?? null);
  }
  // 窗口变化导致 at 不可用：拒绝该层 + 审计一次（不静默降级、不每事件刷审计）。
  // 退化（DEC-20261025-68 A）reason 是 native-uncomputable，必须与 over-native-runtime 一样落审计。
  if (guard !== null && typeof guard.onWindowChange === 'function') {
    const windowViolations = new Set();
    const WINDOW_REJECT_REASONS = new Set(['over-native-runtime', 'native-uncomputable']);
    const checkWindowViolations = () => {
      try {
        const resolved = policyState.resolve();
        // P3-7/P2-3：窗口恢复（不再有窗口级拒绝）后清空去重 Set，下一 episode 能再写审计。
        const hasWindowReject = resolved.invalid.some((item) => WINDOW_REJECT_REASONS.has(item.reason));
        if (!hasWindowReject) windowViolations.clear();
        for (const item of resolved.invalid) {
          if (!WINDOW_REJECT_REASONS.has(item.reason)) continue;
          const key = `${item.source}|${item.key}|${item.reason}`;
          if (windowViolations.has(key)) continue;
          windowViolations.add(key);
          guard.auditLog?.append?.('policy-invalid', {
            source: item.source,
            reason: item.reason,
            code: item.key,
          });
          ctx.logger?.warn?.(
            `[context-governance] policy layer rejected at runtime: ${item.source}/${item.key}:${item.reason}` +
            `${item.detail === undefined ? '' : ` ${item.detail}`}`,
          );
        }
      } catch (error) {
        ctx.logger?.warn?.(`[context-governance] runtime window check failed: ${String(error?.message ?? error)}`);
      }
    };
    guard.onWindowChange(checkWindowViolations);
    checkWindowViolations();
  }

  // M3 T2（0.3.1）：新会话 header（默认开）。放在 guard 之后注册，保持 session/event 处理顺序稳定。
  const header = registerMemoryHeader(ctx, store, {
    enabled: config.memoryHeader.enabled,
    isEnabled: () => config.memoryHeader.enabled && policyState.resolve().values['header.enabled'] !== false,
    hasRuleFile: ruleFilePresent,
    maxLines: config.memoryHeader.maxLines,
    maxChars: config.memoryHeader.maxChars,
    oldAgeDays: config.memoryHeader.oldAgeDays,
    oldLimit: config.memoryHeader.oldLimit,
    onInjected: (built, injection = {}) => {
      guard?.auditLog?.append?.('header-injected', {
        count: built.count,
        lines: built.count,
        mode: built.mode,
        source: 'memory',
        tokensInjected: Math.ceil(built.text.length / 4),
        // 0.2.2：不记裸 messages.length（基线+1 会被误读成“注入 1 条”）；
        // 只记前后长度，由两值差得 injected（0/1）+ header 指纹。
        injected: Number.isFinite(injection.messagesAfter) && Number.isFinite(injection.messagesBefore)
          ? injection.messagesAfter - injection.messagesBefore
          : null,
        messagesBefore: injection.messagesBefore ?? null,
        messagesAfter: injection.messagesAfter ?? null,
        // 审核定论（2026-10-26）：不做 header hash（32 bit 指纹对低熵 header 不抗猜测；需公开比对时用 HMAC/加盐另立项）。
      });
    },
  });
  if (header.registered) {
    ctx.logger?.info?.(
      `[context-governance] memory header enabled for new sessions (first step only; rules=${ruleFilePresent ? 'present' : 'absent'})`,
    );
  } else if (config.memoryHeader.enabled) {
    ctx.logger?.warn?.(`[context-governance] memory header was not registered: ${header.reason}`);
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
      readOnly: guard?.readOnlyReason ?? storeReadOnlyReason ?? '',
      warning: compactionService === 'absent' && config.compression.enabled ? 'provider-unavailable' : '',
    }));
    if (!ok) ctx.logger?.warn?.(`[context-governance] diagnostics log is not writable: ${config.diagnostics.logFile}`);
  }

  // T5：/cg status（只读；不依赖压缩服务是否可用）。
  // P3-1（三轮复核）：commands 可能在治理插件之后挂载——首次失败不静默，`ctx.inject` 或下个 tick 重试一次。
  for (const invalid of policyState.invalid) {
    guard?.auditLog?.append?.('policy-invalid', {
      source: invalid.source,
      reason: invalid.reason,
      code: invalid.key,
    });
  }
  if (policyState.invalid.length > 0) {
    // 用户日常只看 /cg status：apply 时也留一行，别让被拒的层静默退回。
    const summary = policyState.invalid
      .slice(0, 5)
      .map((invalid) => `${invalid.source}/${invalid.key}:${invalid.reason}`)
      .join(', ');
    ctx.logger?.warn?.(
      `[context-governance] policy layer rejected (${policyState.invalid.length}): ${summary}` +
      `${policyState.invalid.length > 5 ? ', ...' : ''}`,
    );
  }
  const commandOptions = {
    store,
    getGuard: () => guard,
    audit: guard?.auditLog ?? null,
    policy: policyState,
    logger: ctx.logger,
    getEarlyStatus: () => (earlyWiring === null ? null : earlyWiring.getLast()),
  };
  const commandRef = { current: registerStatusCommand(ctx, commandOptions) };
  const retryStatusCommand = () => {
    if (commandRef.current.registered) return;
    const retried = registerStatusCommand(ctx, commandOptions);
    if (retried.registered) {
      commandRef.current = retried;
      ctx.logger?.info?.('[context-governance] /cg status registered after commands became available');
    }
  };
  if (!commandRef.current.registered) {
    ctx.logger?.warn?.(
      `[context-governance] /cg status was not registered: ${commandRef.current.reason}; ` +
      'will retry once when the commands service becomes available',
    );
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['commands'], retryStatusCommand);
      } catch {
        setTimeout(retryStatusCommand, 0);
      }
    } else {
      setTimeout(retryStatusCommand, 0);
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      commandRef.current.dispose?.();
      earlyWiring?.stop();
      guard?.stop();
      await store.close();
    }, 'context-governance cleanup');
  } else {
    // cordis 没有 `dispose` 事件（app.asar 全量扫描 0 命中），旧兜底是死代码。
    // 没有 effect 意味着宿主不支持按插件生命周期清理：明说，锁随进程退出释放。
    ctx.logger?.warn?.(
      '[context-governance] ctx.effect is unavailable; writer lock and subscriptions will only be released when the process exits',
    );
  }
}

export {
  DEFAULT_MEMORY_DIR,
  MEM_QUERY_NAME,
  MEM_WRITE_NAME,
  MemoryStore,
  MemoryStoreError,
};
