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
import { identityDiagnostic, inferRootFromCwd, loadStateV2, resolvePersistenceIdentity, samePath, sessionCwd } from './root-state.js';
import { MEMORY_ROOT_REL, memoryRootFor, resolveDiagnosticsPath, userLevelDir } from './roots/paths.js';
import { RootRegistry } from './roots/registry.js';
import { RootStorePool } from './roots/store-pool.js';
import { POLICY_FILE_MAX_BYTES, WINDOW_USABLE_MARGIN, atExceedsUsableWindow, nativeFromWindow, nativeRatio, profileLayer, resolvePolicy, shortSessionId, usableAtCeiling, validateLayer } from './policy.js';
import { detectHostVersion, normalizeBackendVersion } from './compress/adapters.js';
import { CompressionGuard } from './compress/runtime.js';
import { RootGuardPool } from './compress/root-guards.js';
import { wireEarlyCompaction } from './compress/early-wiring.js';
import { formatCapability, probeCapability } from './capabilities.js';
import { DEFAULT_AUDIT_MAX_BYTES, MAX_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES, AuditLog, createRootAudit } from './audit.js';
import { appendDiagnosticLine, capabilityLine, PLUGIN_VERSION, registerDiagnosticPath, startupLine } from './diagnostics.js';
import { DEFAULT_MEMORY_DIR, MemoryStore, MemoryStoreError } from './memory/store.js';
import { registerMemoryHeader } from './memory/header.js';
import { SCOPE_SKIP, resolveScope } from './scope.js';
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
  // P1：目录固定（需求授权边界）；非 memory/governance 的相对值在 attach 时该根 fail-closed。
  memoryRoot: MEMORY_ROOT_REL,
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
  // 1.0 #8：非空 logFile 必须是绝对路径；相对路径会落到进程 cwd（app 安装目录），
  // 既可写坏发行目录，也不符合“包内 0 绝对路径/空或显式”的安装契约。
  const diagnosticsLogFile = config.diagnostics.logFile.trim();
  if (diagnosticsLogFile !== '' && !path.isAbsolute(diagnosticsLogFile)) {
    throw new MemoryStoreError(
      'CONFIG',
      'diagnostics.logFile must be empty or an absolute path (relative paths would resolve to the process cwd)',
    );
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
  // 2a：未配置 = 根未知（不回落 process.cwd）；由持久化或首次推断决定。
  const projectRoot = config.projectRoot.trim() === '' ? '' : path.resolve(config.projectRoot);
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
    memoryRoot: projectRoot === '' ? '' : path.resolve(projectRoot, config.memoryRoot),
    memoryRootRel: config.memoryRoot,
    project: config.project.trim() === '' ? (projectRoot === '' ? '' : path.basename(projectRoot)) : config.project.trim(),
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
      logFile: diagnosticsLogFile,
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
  // 1a：会话层按 sessionId 分桶（进程内存；重启清空）。读不建桶、写才建桶。
  // 1b：同一 registry 条目扩为 { values, profile }，不另起存储。
  const sessionLayers = new Map();
  const EMPTY_SESSION_VALUES = Object.freeze({});
  const ensureSessionEntry = (sessionId, { create = false } = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    let entry = sessionLayers.get(sessionId);
    if (entry === undefined && create) {
      entry = { values: {}, profile: null };
      sessionLayers.set(sessionId, entry);
    }
    return entry ?? null;
  };
  const sessionValuesFor = (sessionId, { create = false } = {}) => {
    const entry = ensureSessionEntry(sessionId, { create });
    return entry?.values ?? EMPTY_SESSION_VALUES;
  };
  const sessionProfileFor = (sessionId) => ensureSessionEntry(sessionId)?.profile ?? null;
  const setSessionProfile = (sessionId, profile) => {
    const entry = ensureSessionEntry(sessionId, { create: true });
    if (entry === null) return false;
    entry.profile = typeof profile === 'string' && profile !== '' ? profile : null;
    return true;
  };
  // 0.2.1（DEC-20261025-66 / 68）：窗口由运行时观察；每次 resolve 现算 native（不锁 apply）。
  // P2-3：`/cg set` 被拒的 transient（每 episode 去重；窗口恢复时清空），不写进 build 期的 state.invalid。
  const transientRejections = [];
  let windowProvider = () => null;
  const resolveWithWindow = (sessionId = null) => {
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
    // 1b：profile 按会话解析（会话覆盖 > 配置 > 无）；替换构建期写入的全局 profile 层。
    const sessionProfile = sessionProfileFor(sessionId);
    const effectiveProfile = sessionProfile ?? config.policy.profile;
    const effectiveProfileLayer = profileLayer(effectiveProfile);
    const baseLayers = layers.filter((layer) => !String(layer.source).startsWith('profile='));
    const sessionLayer = { source: 'session', values: sessionValuesFor(sessionId) };
    const filtered = [
      ...(effectiveProfileLayer === null ? [] : [effectiveProfileLayer]),
      ...baseLayers,
      sessionLayer,
    ].map((layer) => {
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
        } else if (atExceedsUsableWindow(at, checkNative)) {
          // 1.0 #4：窗口收缩后 at 落入非可用区间 [native−0.02, native] → 该层自动失效。
          runtimeInvalid.push({
            source: layer.source,
            key: 'compact.at',
            reason: 'window-shrunk',
            detail: `at=${at} 落入非可用区间（native=${checkNative}, 上界=${usableAtCeiling(checkNative)}）` +
              (conservative === null ? '' : `（保守窗口 ${conservative.tokens}）`),
          });
          delete values['compact.at'];
        }
      }
      return { source: layer.source, values };
    });
    const resolved = resolvePolicy(filtered, { native: currentInfo.native });
    // P2-3：拒绝项只放 transient（每 episode 去重；窗口恢复即清），绝不 push 进 state.invalid（那是构建期的静态记录）。
    // 1.0 #4：非退化时也只清“窗口已变宽”的旧拒绝；同一 native 下保留，保证 /cg set 被拒后 status 仍可见。
    if (!degenerate) {
      for (let index = transientRejections.length - 1; index >= 0; index -= 1) {
        const entry = transientRejections[index];
        const entryNative = Number.isFinite(entry?.native) ? entry.native : null;
        if (entryNative === null || checkNative > entryNative + 1e-9) transientRejections.splice(index, 1);
      }
    }
    // 成功设置更小的 at 后（同一 native 下），旧的 transient 不再成立 → 清掉，恢复 P3-2 的“恢复后消失”。
    for (let index = transientRejections.length - 1; index >= 0; index -= 1) {
      const entry = transientRejections[index];
      if ((entry.sessionId ?? null) !== (sessionId ?? null)) continue;
      if (Number.isFinite(entry.at) && !atExceedsUsableWindow(entry.at, checkNative)) {
        transientRejections.splice(index, 1);
      }
    }
    // P3-3：层被拒后回落到 builtin 的 at 仍可能落在非可用区间，必须显式提示且不得显示 early=on。
    if (!degenerate && Number.isFinite(checkNative) && atExceedsUsableWindow(resolved.values['compact.at'], checkNative)) {
      runtimeInvalid.push({
        source: 'builtin',
        key: 'compact.at',
        reason: 'fallback-over-native',
        detail: `falls back to at=${resolved.values['compact.at']}，落入非可用区间（native=${checkNative}, ` +
          `上界=${usableAtCeiling(checkNative)}）` +
          (conservative === null ? '' : `（保守窗口 ${conservative.tokens}）`),
      });
    }
    const effectiveAt = resolved.values['compact.at'];
    const usable = !degenerate && Number.isFinite(checkNative) && !atExceedsUsableWindow(effectiveAt, checkNative);
    const shrunk = conservative !== null && conservative.tokens < configWindow;
    const earlyWindow = {
      usable,
      reason: usable
        ? null
        : (degenerate ? 'native-uncomputable' : (shrunk ? 'window-shrunk' : 'above-effective-window')),
      at: Number.isFinite(effectiveAt) ? effectiveAt : null,
      native: degenerate ? null : checkNative,
      ceiling: degenerate ? null : usableAtCeiling(checkNative),
      margin: WINDOW_USABLE_MARGIN,
    };
    return {
      ...resolved,
      earlyWindow,
      invalid: [
        ...invalid,
        ...runtimeInvalid,
        ...resolved.invalid,
        // 1a：transient 拒绝只对本会话可见（不跨会话串）。
        ...transientRejections.filter((item) => (item.sessionId ?? null) === (sessionId ?? null)),
      ],
      window: {
        currentTokens: win?.current ? currentTokens : null,
        configTokens: configWindow,
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
    /** 1a：按会话读取覆盖值（create=false 不建桶；命令写入时 create=true）。 */
    sessionValues: sessionValuesFor,
    /** 1a：按会话取“会话层”形状（供 resolve/展示复用）。 */
    sessionLayerFor: (sessionId) => ({ source: 'session', values: sessionValuesFor(sessionId) }),
    /** 1b：按会话 profile 覆盖值（无则 null；不读全局）。 */
    sessionProfileFor,
    /** 1b：写会话 profile（null/'' = 清除；重启不持久）。 */
    setSessionProfile,
    /** 1b：本会话生效 profile 与来源（session > config > default）。 */
    profileInfo: (sessionId) => {
      const sessionProfile = sessionProfileFor(sessionId);
      const name = sessionProfile ?? (config.policy.profile ?? '');
      const source = sessionProfile !== null ? 'session' : (name === '' ? 'default' : 'config');
      return { profile: name, source };
    },
    /** 1a：当前进程内已有覆盖的会话（只读快照，供测试/诊断）。 */
    sessionIds: () => [...sessionLayers.keys()],
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
    /**
     * 记录一次“会话层设置被拒”（按 sessionId+source+key+reason 去重；窗口恢复/成功设置时清）。
     * 1a 之后会话级已成立：transient 必须带 sessionId，不能跨会话串。
     */
    rejectSessionSet(entry) {
      if (entry === null || typeof entry !== 'object') return false;
      const sessionId = typeof entry.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : null;
      const normalized = { ...entry, sessionId };
      const key = `${sessionId ?? ''}|${normalized.source}|${normalized.key}|${normalized.reason}`;
      if (transientRejections.some((item) =>
        `${item.sessionId ?? ''}|${item.source}|${item.key}|${item.reason}` === key)) return false;
      transientRejections.push(normalized);
      return true;
    },
    /** 当前 episode 的 transient 拒绝（只读快照；传 sessionId 只返回该会话）。 */
    sessionRejections(sessionId = undefined) {
      const source = sessionId === undefined
        ? transientRejections
        : transientRejections.filter((item) => (item.sessionId ?? null) === (sessionId ?? null));
      return source.map((item) => ({ ...item }));
    },
    /** 成功写入/清空会话层后，删除该会话（可再限定 key）的 transient 拒绝。 */
    clearSessionRejections(sessionId, key = null) {
      for (let index = transientRejections.length - 1; index >= 0; index -= 1) {
        const item = transientRejections[index];
        if ((item.sessionId ?? null) !== (sessionId ?? null)) continue;
        if (key !== null && item.key !== key) continue;
        transientRejections.splice(index, 1);
      }
    },
    resolve: resolveWithWindow,
  };
}

export async function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    ctx.logger?.info?.('[context-governance] disabled by config');
    return;
  }
  // 2a/P1：根来源 = 显式配置（仅优先匹配）> 持久化主根 > 首次推断（首个会话事件）。
  const identity = resolvePersistenceIdentity(ctx);
  const configuredRoot = config.projectRoot === '' ? null : config.projectRoot;
  // v3：logFile 白名单（用户级 / 该根 memory/governance）必须在任何写入前校验。
  // 预读不修复（repair:false）只为拿到持久化主根，避免校验前发生迁移写盘。
  const preload = identity.ok
    ? loadStateV2(identity.stateFile, { repair: false, profile: identity.name })
    : null;
  const preloadRoot = preload?.state?.primaryRootId !== null && preload?.state?.primaryRootId !== undefined
    ? (preload.state.roots[preload.state.primaryRootId]?.root ?? null)
    : null;
  const preAttachRoot = configuredRoot ?? preloadRoot;
  const diagnostics = resolveDiagnosticsPath({
    identity,
    root: preAttachRoot,
    logFile: config.diagnostics.logFile,
  });
  if (diagnostics.ok !== true) {
    const message = `[context-governance] diagnostics logFile rejected (${diagnostics.reason}): ` +
      `${config.diagnostics.logFile}; plugin will not load this profile`;
    ctx.logger?.error?.(message);
    ctx.logger?.warn?.(message);
    return;
  }
  config.diagnostics.logFile = diagnostics.file;
  if (diagnostics.file !== '') registerDiagnosticPath(diagnostics.file, diagnostics.bases);
  // P1：profile 级 root audit（用户级）。身份不可用 → 不写用户级文件（fail-closed）。
  const rootAudit = identity.ok ? createRootAudit(identity, { maxBytes: config.audit.maxBytes }) : null;
  const registry = identity.ok
    ? RootRegistry.load({
      stateFile: identity.stateFile,
      rootAudit,
      configRoot: configuredRoot,
      project: config.project,
      profile: identity.name,
      home: identity.home ?? identity.dir,
      logger: ctx.logger,
      // P3：所有 active 根各自纳管；P1/P2 单根契约仍由默认 false 保留给旧测试。
      manageAllRoots: true,
    })
    : null;
  const persistedRoot = registry?.primary?.root ?? null;
  // 根变化可见：config 覆盖持久化主根，或 config 移除后回落持久化主根。
  let changedFrom = null;
  if (configuredRoot !== null && persistedRoot !== null && !samePath(configuredRoot, persistedRoot)) {
    changedFrom = persistedRoot;
  } else if (configuredRoot === null && persistedRoot !== null
    && registry?.state?.configRoot !== null && registry?.state?.configRoot !== undefined
    && !samePath(registry.state.configRoot, persistedRoot)) {
    changedFrom = registry.state.configRoot;
  }
  const rootInfo = {
    root: configuredRoot ?? persistedRoot,
    source: configuredRoot !== null ? 'config' : (persistedRoot !== null ? 'persisted' : 'none'),
    identity,
    stateFile: identity.ok ? identity.stateFile : null,
    persistedRoot,
    configRootMirror: registry?.state?.configRoot ?? null,
    changedFrom,
    inferredFromCwd: null,
    statePersisted: null,
    failClosedReason: null,
    attemptedRoot: null,
    diagnosticsError: null,
  };

  // P1：身份事件写 root audit（不再写 per-root audit；见设计评审 §4.2）。
  try {
    rootAudit?.append?.('persistence-identity', {
      source: identity.ok ? 'profileContext' : 'unavailable',
      name: identity.name ?? null,
      dir: identity.dir ?? null,
      home: identity.home === null || identity.home === undefined ? 'absent' : 'present',
      anchor: identity.anchor ?? null,
      path: rootInfo.stateFile ?? null,
      reason: identity.reason ?? null,
    });
  } catch {
    /* 审计失败不影响主流程 */
  }

  const startRuntime = async (root, source) => {
    // 目录固定 + containment：memoryRoot 必须是 <root>/memory/governance，否则该根 fail-closed。
    const memory = memoryRootFor(root, config.memoryRootRel ?? config.memoryRoot);
    if (!memory.ok) {
      const entry = registry?.attach ?? registry?.primary ?? null;
      if (entry !== null) registry?.failClosed(entry.rootId, memory.reason);
      rootInfo.failClosedReason = memory.reason;
      rootInfo.attemptedRoot = root;
      rootInfo.root = null;
      rootInfo.source = 'none';
      ctx.logger?.warn?.(
        `[context-governance] root ${root} fail-closed: ${memory.reason} ` +
        `(memoryRoot=${config.memoryRootRel ?? config.memoryRoot}); no store/memory will be created`,
      );
      return false;
    }
    // v3：用实际 root/memoryRoot 再校验一次诊断路径（防预读根与实际 attach 根不一致）。
    const diag = resolveDiagnosticsPath({
      identity,
      root,
      memoryRoot: memory.memoryRoot,
      logFile: config.diagnostics.logFile,
    });
    if (diag.ok !== true) {
      rootInfo.diagnosticsError = diag.reason;
      rootInfo.root = null;
      rootInfo.source = 'none';
      ctx.logger?.error?.(
        `[context-governance] diagnostics logFile rejected at attach (${diag.reason}); ` +
        'plugin will not manage this root',
      );
      return false;
    }
    config.diagnostics.logFile = diag.file;
    if (diag.file !== '') registerDiagnosticPath(diag.file, diag.bases);
    rootInfo.root = root;
    rootInfo.source = source;
    rootInfo.failClosedReason = null;
    config.projectRoot = root;
    config.memoryRoot = memory.memoryRoot;
    const attachEntry = registry?.attach ?? null;
    if (config.project === '') config.project = attachEntry?.project ?? path.basename(root);
    // 策略链只在 attach 时算：profile 标签 → 插件配置 → 项目 .cg-policy.json（命令侧只读它）。
    const policyState = buildPolicyState(config);
    // P1：唯一归域入口 = registry（只主根 managed；其余 unmanaged/no-root 直接跳过）。
    const scopeOf = (session) => {
      if (registry === null) {
        return resolveScope({ root, cwd: sessionCwd(session), earlyEnabled: true });
      }
      const resolved = registry.resolveSessionRoot(session);
      if (resolved.status === 'managed') {
        return {
          mode: 'multi-root',
          root: resolved.entry.root,
          cwd: resolved.cwd,
          governed: true,
          skipReason: null,
          unattributed: false,
          isSubagent: resolved.isSubagent === true,
        };
      }
      return {
        mode: 'multi-root',
        root: resolved.entry === null ? null : resolved.entry.root,
        cwd: resolved.cwd,
        governed: false,
        skipReason: resolved.status === 'no-root' ? SCOPE_SKIP.NO_ROOT : SCOPE_SKIP.UNMANAGED,
        unattributed: false,
        isSubagent: resolved.isSubagent === true,
      };
    };

    const store = await openStore(config);
    // P2：主根 store 已打开并 seed 进池；其他根由池懒打开，mem_* 按会话根路由。
    const primaryAudit = new AuditLog({
      file: path.join(store.rootDir, 'audit.jsonl'),
      maxBytes: config.audit.maxBytes,
      allowedBase: store.rootDir,
    });
    const pool = registry === null
      ? null
      : new RootStorePool({
        registry,
        rootAudit,
        logger: ctx.logger,
        maxBytes: config.audit.maxBytes,
      });
    if (pool !== null) pool.seed(attachEntry, store, primaryAudit);
    const resolveStore = async (exec) => {
      if (pool === null || registry === null) {
        return {
          ok: false,
          code: 'ROOT_UNAVAILABLE',
          message: 'persistence identity unavailable; memory routing is fail-closed',
          reason: 'identity-unavailable',
        };
      }
      const session = exec?.agent?.session ?? null;
      const resolved = registry.resolveSessionRoot(session);
      if (resolved.status === 'no-root') {
        return {
          ok: false,
          code: 'NO_ROOT',
          message: 'no project root for this session',
          reason: resolved.reason ?? 'no-git-ancestor',
        };
      }
      const entry = resolved.entry;
      if (entry === null || entry === undefined) {
        return { ok: false, code: 'ROOT_UNAVAILABLE', message: 'session root is unavailable', reason: 'root-unavailable' };
      }
      if (entry.state === 'fail-closed') {
        return {
          ok: false,
          code: 'ROOT_FAIL_CLOSED',
          message: `root ${entry.root} is fail-closed: ${entry.failClosedReason ?? 'unknown'}`,
          reason: entry.failClosedReason ?? 'fail-closed',
          root: entry.root,
          rootId: entry.rootId,
        };
      }
      try {
        const opened = await pool.get(entry);
        return {
          ok: true,
          store: opened.store,
          audit: opened.audit,
          entry: opened.entry,
          project: opened.store?.status?.project ?? opened.entry?.project,
          release: opened.release,
        };
      } catch (error) {
        return {
          ok: false,
          code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'ROOT_UNAVAILABLE',
          message: String(error?.message ?? error),
          reason: error?.details?.reason ?? 'store-open-failed',
          root: error?.details?.root ?? entry.root,
          rootId: error?.details?.rootId ?? entry.rootId,
        };
      }
    };
    const registration = registerMemoryTools(ctx, null, { resolveStore, audit: rootAudit });
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
    let guardPool = null;
    let primaryEntry = attachEntry;
    const policyCache = new Map();
    // 主根 policy 复用 attach 时算好的链（含 /cg set 会话层与 window provider）。
    if (attachEntry !== null) policyCache.set(attachEntry.rootId, policyState);
    const policyForEntry = (entry) => {
      const key = entry?.rootId ?? null;
      if (key !== null && policyCache.has(key)) return policyCache.get(key);
      const root = entry?.root ?? config.projectRoot;
      const memory = memoryRootFor(root, config.memoryRootRel ?? config.memoryRoot);
      const rootConfig = {
        ...config,
        projectRoot: root,
        memoryRoot: memory.memoryRoot ?? config.memoryRoot,
        project: entry?.project ?? (samePath(root, config.projectRoot) ? config.project : path.basename(root)),
      };
      const state = buildPolicyState(rootConfig);
      if (key !== null) policyCache.set(key, state);
      return state;
    };
    const policyForSession = (session) => {
      if (guardPool !== null) {
        const policy = guardPool.policyForSession(session);
        if (policy !== null) return policy;
      }
      if (registry !== null) {
        const resolved = registry.resolveSessionRoot(session);
        if (resolved?.status === 'managed' && resolved.entry !== null) return policyForEntry(resolved.entry);
      }
      return policyState;
    };
    const ruleFileForRoot = (root) => ['AGENTS.md', 'CLAUDE.md']
      .some((fileName) => fs.existsSync(path.join(root, fileName)));
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
    const createGuardForRoot = async (entry, resources) => {
      const rootPolicy = policyForEntry(entry);
      const rootProject = entry.project ?? (samePath(entry.root, config.projectRoot) ? config.project : path.basename(entry.root));
      const rootGuard = new CompressionGuard({
        ctx,
        hostVersion,
        backendVersion,
        logger: ctx.logger,
        diagnosticsLogFile: config.diagnostics.logFile,
        store: resources.store,
        audit: resources.audit,
        rootAudit,
        rootId: entry.rootId,
        auditMaxBytes: config.audit.maxBytes,
        auditBase: resources.store.rootDir,
        projectRoot: entry.root,
        onlyProject: config.onlyProject,
        // 1.0 #1：观测/保护/回注与早压触发共用同一归域判定。
        resolveScope: scopeOf,
        captureTitle: config.captureTitle,
        project: rootProject,
        reinjection: { maxFailures: config.reinjection.maxFailures },
        startWaitMs: resources.startWaitMs,
      });
      // P3：订阅由 RootGuardPool 持有；guard 只初始化 tokenMeter/感知状态。
      rootGuard.start({ subscribe: false });
      rootPolicy.setWindowProvider(() => rootGuard.windowState ?? null);
      const windowViolations = new Set();
      const WINDOW_REJECT_REASONS = new Set(['window-shrunk', 'over-native-runtime', 'native-uncomputable']);
      const checkWindowViolations = () => {
        try {
          const sessionIds = typeof rootPolicy.sessionIds === 'function' ? rootPolicy.sessionIds() : [];
          const targets = [null, ...sessionIds];
          const seenThisPass = new Set();
          for (const target of targets) {
            const resolved = rootPolicy.resolve(target);
            for (const item of resolved.invalid) {
              if (!WINDOW_REJECT_REASONS.has(item.reason)) continue;
              const key = `${target ?? 'global'}|${item.source}|${item.key}|${item.reason}`;
              seenThisPass.add(key);
              if (windowViolations.has(key)) continue;
              windowViolations.add(key);
              resources.audit?.append?.('policy-invalid', {
                source: item.source,
                reason: item.reason,
                code: item.key,
                root: entry.root,
                rootId: entry.rootId,
                path: path.join(entry.root, config.policy.projectFile),
                ...(target === null ? {} : { sessionId: target, sessionShortId: shortSessionId(target) }),
              });
              ctx.logger?.warn?.(
                `[context-governance] policy layer rejected at runtime: ${item.source}/${item.key}:${item.reason}` +
                `${item.detail === undefined ? '' : ` ${item.detail}`} (root=${entry.root})`,
              );
            }
          }
          if (seenThisPass.size === 0) windowViolations.clear();
          else for (const key of [...windowViolations]) if (!seenThisPass.has(key)) windowViolations.delete(key);
        } catch (error) {
          ctx.logger?.warn?.(`[context-governance] runtime window check failed (${entry.root}): ${String(error?.message ?? error)}`);
        }
      };
      rootGuard.onWindowChange(checkWindowViolations);
      checkWindowViolations();
      for (const invalid of rootPolicy.invalid) {
        resources.audit?.append?.('policy-invalid', {
          source: invalid.source,
          reason: invalid.reason,
          code: invalid.key,
          root: entry.root,
          rootId: entry.rootId,
          path: path.join(entry.root, config.policy.projectFile),
        });
      }
      const early = wireEarlyCompaction({
        ctx,
        subscribe: false,
        getGuard: () => rootGuard,
        getPolicy: (session) => {
          try {
            return rootPolicy.resolve(session?.id ?? null);
          } catch {
            return null;
          }
        },
        getArmed: (session) => {
          try {
            return rootPolicy.resolve(session?.id ?? null).values['compact.early.armed'] === true;
          } catch {
            return false;
          }
        },
        getScope: scopeOf,
        audit: resources.audit,
        logger: ctx.logger,
      });
      return { guard: rootGuard, policy: rootPolicy, early };
    };
    if (config.compression.enabled) {
      try {
        // identity 不可用时没有 registry：保留单根观测（不是多根兜底），但订阅仍只由 pool 持有一份。
        let observedRegistry = registry;
        let observedStorePool = pool;
        if (observedRegistry === null) {
          const singleEntry = {
            rootId: 'single-root',
            root,
            project: config.project,
            state: 'active',
            origin: source === 'config' ? 'config' : 'inferred',
          };
          primaryEntry = singleEntry;
          observedRegistry = {
            resolveSessionRoot: (session) => {
              const scope = resolveScope({
                root,
                cwd: sessionCwd(session),
                earlyEnabled: true,
                managed: true,
              });
              return {
                status: scope.governed ? 'managed' : 'unmanaged',
                entry: singleEntry,
                source: null,
                isSubagent: scope.isSubagent === true,
                cwd: sessionCwd(session),
                skipReason: scope.skipReason ?? null,
              };
            },
          };
          observedStorePool = {
            async pin() {
              return {
                entry: singleEntry,
                store,
                audit: primaryAudit,
                release() {},
              };
            },
          };
        }
        guardPool = new RootGuardPool({
          ctx,
          registry: observedRegistry,
          storePool: observedStorePool,
          createGuard: createGuardForRoot,
          rootAudit,
          logger: ctx.logger,
          onFirstEvent: probeReadyCapability,
        });
        guardPool.start();
        // 主根先建（有 store seed）；其他根仍由首个会话事件懒创建。
        if (primaryEntry !== null) {
          const record = await guardPool.ensure(primaryEntry);
          guard = record?.guard ?? null;
          if (guard !== null && typeof policyState.setWindowProvider === 'function') {
            policyState.setWindowProvider(() => guard.windowState ?? null);
          }
        }
        if (guard !== null) {
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
        }
      } catch (error) {
        ctx.logger?.warn?.(`[context-governance] compression observer failed to start: ${String(error?.message ?? error)}`);
        guard = null;
      }
    }
    earlyWiring = null;

    // M3 T2（0.3.1）：新会话 header（默认开）。P3 按会话所属根取 store/audit。
    const header = registerMemoryHeader(ctx, null, {
      enabled: config.memoryHeader.enabled,
      isEnabled: (session) => {
        const scope = scopeOf(session);
        if (!config.memoryHeader.enabled || scope.isSubagent || !scope.governed) return false;
        try {
          return policyForSession(session).resolve(session?.id ?? null).values['header.enabled'] !== false;
        } catch {
          return false;
        }
      },
      resolveStore: async (session) => {
        if (guardPool === null) return store;
        const record = await guardPool.ensureForSession(session);
        return record?.handle?.store ?? null;
      },
      getHasRuleFile: (session) => {
        const scope = scopeOf(session);
        return scope.root === null || scope.root === undefined ? ruleFilePresent : ruleFileForRoot(scope.root);
      },
      maxLines: config.memoryHeader.maxLines,
      maxChars: config.memoryHeader.maxChars,
      oldAgeDays: config.memoryHeader.oldAgeDays,
      oldLimit: config.memoryHeader.oldLimit,
      onInjected: (built, injection = {}, info = {}) => {
        const auditForHeader = guardPool?.auditForSession(info.session) ?? primaryAudit;
        auditForHeader?.append?.('header-injected', {
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
      getGuard: (session) => (guardPool === null ? guard : guardPool.guardForSession(session)),
      audit: primaryAudit,
      getAuditForSession: (sessionId) => (guardPool === null ? primaryAudit : guardPool.auditForSessionId(sessionId)),
      rootAudit,
      policy: policyState,
      getPolicyForSession: (sessionId) => (guardPool === null ? policyState : (guardPool.policyForSessionId(sessionId) ?? policyState)),
      getStoreForSession: (sessionId) => (guardPool === null ? store : (guardPool.storeForSessionId(sessionId) ?? store)),
      logger: ctx.logger,
      getEarlyStatus: () => {
        if (guardPool !== null && guard !== null) {
          const record = guardPool.recordForEntry(primaryEntry);
          return record?.early?.getLast?.() ?? null;
        }
        return earlyWiring?.getLast?.() ?? null;
      },
      getEarlyStatusForSession: (sessionId) => {
        if (guardPool === null) return earlyWiring?.getLast?.() ?? null;
        const record = guardPool.recordForSessionId(sessionId);
        return record?.early?.getLast?.() ?? null;
      },
      // 2a：根来源与持久化身份在 status 中可见（运行期数值，用 getter 不复制快照）。
      getRootInfo: () => rootInfo,
      getPersistenceIdentity: () => identity,
      getRootsView: () => (registry === null ? null : registry.view()),
      getRootCounts: () => (registry === null ? null : registry.counts()),
      getPoolStats: () => (pool === null ? null : pool.stats()),
      getGuardPoolStats: () => (guardPool === null ? null : guardPool.stats()),
      getDiagnosticsLogFile: () => config.diagnostics.logFile,
      getDiagnosticsError: () => rootInfo.diagnosticsError,
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
        if (guardPool !== null) {
          await guardPool.closeAll('dispose');
        } else {
          earlyWiring?.stop();
          guard?.stop();
        }
        if (pool !== null) await pool.closeAll();
        else {
          await store.close();
          primaryAudit.close();
        }
      }, 'context-governance cleanup');
    } else {
      // cordis 没有 `dispose` 事件（app.asar 全量扫描 0 命中），旧兜底是死代码。
      // 没有 effect 意味着宿主不支持按插件生命周期清理：明说，锁随进程退出释放。
      ctx.logger?.warn?.(
        '[context-governance] ctx.effect is unavailable; writer lock and subscriptions will only be released when the process exits',
      );
    }

    // 2a：根变化留痕（P1 起身份/根生命周期事件写用户级 root audit；per-root 只留会话事件）。
    try {
      if (source === 'inferred') {
        rootAudit?.append?.('inferred-fresh', {
          root,
          path: rootInfo.stateFile ?? null,
          ...(rootInfo.inferredFromCwd === null ? {} : { inferredFromCwd: rootInfo.inferredFromCwd }),
          ...(rootInfo.statePersisted === false ? { reason: 'state-write-failed' } : {}),
        });
      }
      if (rootInfo.changedFrom !== null) {
        rootAudit?.append?.('project-root-changed', { from: rootInfo.changedFrom, to: root, source });
      }
    } catch {
      /* 审计失败不影响主流程 */
    }
    // P1：config 只写镜像（registry.state.configRoot），不改持久化 primaryRoot；移除配置后回落主根。
    if (registry !== null) {
      const mirrorRoot = configuredRoot !== null
        && (rootInfo.persistedRoot === null || !samePath(configuredRoot, rootInfo.persistedRoot))
        ? configuredRoot
        : null;
      registry.noteConfigRoot(mirrorRoot);
      rootInfo.configRootMirror = registry.state.configRoot;
    }
    if (config.diagnostics.logFile !== '') appendDiagnosticLine(config.diagnostics.logFile, identityDiagnostic(identity));
  };

  if (rootInfo.root !== null) {
    registry?.setAttachRoot(rootInfo.root, { origin: rootInfo.source === 'config' ? 'config' : 'persisted' });
    const started = await startRuntime(rootInfo.root, rootInfo.source);
    if (started !== false) return;
    // fail-closed（memoryRoot 非固定/逃逸）：不建 store；落到最小 status 路径并保留原因。
  }

  // 根未知（未配置且无持久化状态）：先不建 store/guard；注册最小状态命令，等首个带 cwd 的会话事件推断。
  // 推断失败 = 该会话 no-project-root skip，根保持未知；不盲猜路径、不换根。
  const diag = (line, level = 'info') => {
    if (config.diagnostics.logFile !== '') appendDiagnosticLine(config.diagnostics.logFile, line);
    const message = `[context-governance] ${line}`;
    if (level === 'warn') ctx.logger?.warn?.(message); else ctx.logger?.info?.(message);
  };
  diag(identityDiagnostic(identity), identity.ok ? 'info' : 'warn');
  diag('persistence: root=unknown (awaiting first inference)');
  const commandRef = { current: null };
  const registerMinimal = () => {
    commandRef.current = registerStatusCommand(ctx, {
      store: null,
      policy: null,
      getGuard: () => null,
      audit: null,
      rootAudit,
      getEarlyStatus: () => null,
      getRootInfo: () => rootInfo,
      getPersistenceIdentity: () => identity,
      getRootsView: () => (registry === null ? null : registry.view()),
      getRootCounts: () => (registry === null ? null : registry.counts()),
      getPoolStats: () => null,
      getDiagnosticsLogFile: () => config.diagnostics.logFile,
      getDiagnosticsError: () => rootInfo.diagnosticsError,
      logger: ctx.logger,
    });
  };
  registerMinimal();
  // 与正式路径一致：commands 可能晚挂载，首次失败不静默，注入后重试一次。
  const retryMinimalCommand = () => {
    if (commandRef.current?.registered) return;
    registerMinimal();
    if (commandRef.current?.registered) {
      ctx.logger?.info?.('[context-governance] /cg status registered after commands became available');
    }
  };
  if (!commandRef.current?.registered) {
    ctx.logger?.warn?.(
      `[context-governance] /cg status was not registered: ${commandRef.current?.reason ?? 'unknown'}; ` +
      'will retry once when the commands service becomes available',
    );
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['commands'], retryMinimalCommand);
      } catch {
        setTimeout(retryMinimalCommand, 0);
      }
    } else {
      setTimeout(retryMinimalCommand, 0);
    }
  }
  let watcherDispose = null;
  let attaching = false;
  let stopped = false;
  const noRootSeen = new Set();
  const watch = () => {
    if (typeof ctx.on !== 'function') {
      diag('persistence: ctx.on unavailable; first inference cannot start', 'warn');
      return;
    }
    try {
      // P3 例外：apply 时根未知，RootGuardPool 尚未建立；这份 watcher 只负责首个 cwd 推断，
      // 根确定后立即退订并进入 startRuntime 的 RootGuardPool（正常有根路径不再保留第二份订阅）。
      // 具名函数：测试据此断言“根已确定时没有挂首次推断 watcher”。
      const firstInferenceRootWatcher = (session) => attachFirst(session);
      watcherDispose = ctx.on('session/event', firstInferenceRootWatcher);
      diag('persistence: watching session/event for first cwd');
    } catch (error) {
      diag(`persistence: session/event subscription failed: ${String(error?.message ?? error)}`, 'warn');
    }
  };
  const attachFirst = (session) => {
    if (stopped || attaching || rootInfo.root !== null) return;
    const cwd = sessionCwd(session);
    // 结果 realpath + 盘符归一；不允许把 DSH 自己的 home 当项目根（§11.1-2）。
    const inferred = inferRootFromCwd(cwd, { exclude: identity.home ?? identity.dir });
    if (inferred === null) {
      // 同一 cwd 只报一次，避免每个事件刷日志；根保持未知。
      if (!noRootSeen.has(cwd)) {
        noRootSeen.add(cwd);
        const sessionId = typeof session?.id === 'string' ? session.id : 'unknown';
        diag(`persistence: no-project-root session=${sessionId} cwd=${cwd === '' ? 'unknown' : cwd}`, 'warn');
      }
      return;
    }
    attaching = true;
    try { watcherDispose?.(); } catch { /* ignore */ }
    try { commandRef.current?.dispose?.(); } catch { /* ignore */ }
    // 首推独占发布（link）：另一进程已写 → 采用既有主根，不覆盖。
    const entry = registry?.claimPrimary(inferred, { origin: 'inferred', inferredFromCwd: cwd }) ?? null;
    if (entry === null) {
      rootInfo.statePersisted = false;
      diag(`persistence: root state write failed path=${identity.stateFile}`, 'warn');
      attaching = false;
      if (!stopped) {
        registerMinimal();
        watch();
      }
      return;
    }
    rootInfo.statePersisted = registry?.writable !== false;
    const chosenRoot = entry.root;
    const attachSource = samePath(chosenRoot, inferred) ? 'inferred' : 'persisted';
    if (attachSource === 'inferred') rootInfo.inferredFromCwd = cwd;
    else diag(`persistence: another process already persisted root=${chosenRoot}; keeping it`, 'warn');
    void (async () => {
      registry?.setAttachRoot(chosenRoot, { origin: 'inferred' });
      const started = await startRuntime(chosenRoot, attachSource);
      if (started === false) {
        rootInfo.root = null;
        rootInfo.source = 'none';
        rootInfo.inferredFromCwd = null;
        attaching = false;
        if (stopped) return;
        registerMinimal();
        diag(`persistence: root ${chosenRoot} is fail-closed; staying on minimal status`, 'warn');
      }
    })().catch((error) => {
      // 挂载失败：回落到“根未知”，恢复最小命令并重新等下一次会话事件。
      rootInfo.root = null;
      rootInfo.source = 'none';
      rootInfo.inferredFromCwd = null;
      attaching = false;
      diag(`persistence: runtime attach failed root=${chosenRoot}: ${String(error?.message ?? error)}`, 'warn');
      if (stopped) return;
      registerMinimal();
      watch();
    });
  };
  // 身份不可用 = fail-closed：不写盘、不猜路径、根保持未知（status 明示 persistence-identity-unavailable）。
  if (identity.ok) watch();
  else diag('persistence: first inference disabled (persistence identity unavailable)', 'warn');
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      stopped = true;
      try { watcherDispose?.(); } catch { /* ignore */ }
      try { commandRef.current?.dispose?.(); } catch { /* ignore */ }
    }, 'context-governance deferred cleanup');
  }
}
export {
  DEFAULT_MEMORY_DIR,
  MEM_QUERY_NAME,
  MEM_WRITE_NAME,
  MemoryStore,
  MemoryStoreError,
};
