/**
 * 压缩后端适配器：行为契约（架构 §6.2）+ 运行时识别 + 契约自检。
 *
 * 设计约束：
 * - **不替换 `ctx.compaction`**。治理层只读取引擎、订阅会话事件；后端切换需要人工操作。
 * - 本文件不 import 任何 `@deepseek-ai/*` 包；宿主信息全部由调用方探测后传入。
 * - 识别是“行为标记 + 类名”启发式：未知时一律降级为 observe-only，不猜。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

export const ADAPTER_KINDS = Object.freeze(['host-basic', 'context-zip', 'unknown', 'none']);
export const CONTROL_KINDS = Object.freeze(['host-pressure', 'governed', 'model-tool', 'mixed', 'unknown']);
export const PERCEPTION_LEVELS = Object.freeze(['event', 'tool', 'state', 'none']);
export const SUMMARY_AUTHORITIES = Object.freeze(['exclusive', 'shared', 'unknown']);
export const SUMMARY_READABILITY = Object.freeze(['readable', 'partial', 'unreadable', 'unknown']);
export const SUMMARY_STYLES = Object.freeze(['five-section', 'free-form', 'unknown']);
/** 事件形态推断的后端种类（0.1.15；只用于展示/归因，功能路径不读）。 */
export const INFERENCE_KINDS = Object.freeze(['host-basic', 'context-zip', 'unknown', 'mixed']);
export const REWRITE_BOUNDARIES = Object.freeze(['replace-span', 'append-checkpoint', 'unknown']);
export const PROTECTION_ROLES = Object.freeze(['enforcer', 'validator', 'observer', 'unknown']);

/**
 * E1 实测过的组合。宿主按“同 rc 线区间”匹配，避免每次小版本升级就降级：
 *   `>=0.2.1-rc.2 <0.2.2-0` → 接受 0.2.1-rc.2 及更高 rc、0.2.1 稳定版；
 *   拒绝 0.2.2-rc.1、0.1.9。
 * context-zip 仍按已知版本枚举；`unknown` 只告警、不降级（引擎标记已能识别）。
 */
export const DEFAULT_MATRIX = Object.freeze({
  host: Object.freeze(['>=0.2.1-rc.2 <0.2.2-0']),
  contextZip: Object.freeze(['0.1.10']),
});

export function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else {
      const diff = a.localeCompare(b);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
  }
  return left.length === right.length ? 0 : left.length > right.length ? 1 : -1;
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null || b === null) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** 支持空格分隔的 `>=X <Y`（semver 子集，够本机矩阵用）。 */
export function satisfiesRange(version, range) {
  const parsed = parseSemver(version);
  if (parsed === null) return false;
  const tokens = String(range ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    if (token === '*') return true;
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
    if (match === null) return false;
    const comparator = match[1] ?? '=';
    const target = match[2];
    const diff = compareSemver(version, target);
    if (diff === null) return false;
    switch (comparator) {
      case '>=': return diff >= 0;
      case '<=': return diff <= 0;
      case '>': return diff > 0;
      case '<': return diff < 0;
      default: return diff === 0;
    }
  });
}

function matrixStatus(kind, version, matrix) {
  if (version === undefined || version === null || version === 'unknown') return 'unknown';
  const entries = matrix !== null && matrix !== undefined && Array.isArray(matrix[kind]) ? matrix[kind] : [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    if (entry === version) return 'in';
    if (entry === '*' || entry.includes(' ') || /^[<>]=?/.test(entry)) {
      if (satisfiesRange(version, entry)) return 'in';
    }
  }
  return 'out';
}

export class AdapterContractError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'AdapterContractError';
    this.code = code;
  }
}

function assertEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new AdapterContractError('ADAPTER_FIELD', `${field} must be one of ${allowed.join('/')}`);
  }
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdapterContractError('ADAPTER_FIELD', `${field} must be a non-empty string`);
  }
}

/**
 * 校验一个适配器对象是否完整表达架构 §6.2 的九件事。
 * @param {object} adapter
 * @returns {object} 原对象
 */
export function validateAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') {
    throw new AdapterContractError('ADAPTER_TYPE', 'adapter must be an object');
  }
  assertEnum(adapter.kind, 'kind', ADAPTER_KINDS);
  assertString(adapter.label, 'label');
  assertEnum(adapter.control, 'control', CONTROL_KINDS);
  assertEnum(adapter.perception, 'perception', PERCEPTION_LEVELS);
  if (!Array.isArray(adapter.triggers) || adapter.triggers.length === 0) {
    throw new AdapterContractError('ADAPTER_FIELD', 'triggers must be a non-empty array');
  }
  for (const trigger of adapter.triggers) {
    assertEnum(trigger, 'triggers[]', ['compaction-event', 'command', 'tool-call', 'engine-call']);
  }
  if (adapter.hooks === null || typeof adapter.hooks !== 'object') {
    throw new AdapterContractError('ADAPTER_FIELD', 'hooks must be an object');
  }
  assertEnum(adapter.hooks.before, 'hooks.before', ['supported', 'best-effort', 'none']);
  assertEnum(adapter.hooks.after, 'hooks.after', ['supported', 'event', 'best-effort', 'none']);
  if (adapter.summary === null || typeof adapter.summary !== 'object') {
    throw new AdapterContractError('ADAPTER_FIELD', 'summary must be an object');
  }
  assertEnum(adapter.summary.authority, 'summary.authority', SUMMARY_AUTHORITIES);
  assertEnum(adapter.summary.readability, 'summary.readability', SUMMARY_READABILITY);
  assertEnum(adapter.summary.style, 'summary.style', SUMMARY_STYLES);
  if (adapter.rewrite === null || typeof adapter.rewrite !== 'object') {
    throw new AdapterContractError('ADAPTER_FIELD', 'rewrite must be an object');
  }
  assertEnum(adapter.rewrite.boundary, 'rewrite.boundary', REWRITE_BOUNDARIES);
  assertEnum(adapter.rewrite.maintainsToolPairing, 'rewrite.maintainsToolPairing', ['host', 'backend', 'governance', 'unknown']);
  assertEnum(adapter.protectionRole, 'protectionRole', PROTECTION_ROLES);
  if (adapter.observability === null || typeof adapter.observability !== 'object') {
    throw new AdapterContractError('ADAPTER_FIELD', 'observability must be an object');
  }
  for (const key of ['usage', 'range', 'artifact']) {
    if (typeof adapter.observability[key] !== 'boolean') {
      throw new AdapterContractError('ADAPTER_FIELD', `observability.${key} must be a boolean`);
    }
  }
  if (adapter.versions === undefined || adapter.versions === null || typeof adapter.versions !== 'object') {
    throw new AdapterContractError('ADAPTER_FIELD', 'versions must be an object');
  }
  assertString(adapter.versions.host, 'versions.host');
  assertString(adapter.versions.backend, 'versions.backend');
  if (adapter.selfCheck === undefined || adapter.selfCheck === null || typeof adapter.selfCheck !== 'object') {
    throw new AdapterContractError('ADAPTER_FIELD', 'selfCheck must be an object');
  }
  assertEnum(adapter.selfCheck.state, 'selfCheck.state', ['pending', 'pass', 'fail']);
  if (!Array.isArray(adapter.selfCheck.checks)) {
    throw new AdapterContractError('ADAPTER_FIELD', 'selfCheck.checks must be an array');
  }
  if (adapter.inference !== undefined) {
    if (adapter.inference === null || typeof adapter.inference !== 'object') {
      throw new AdapterContractError('ADAPTER_FIELD', 'inference must be an object');
    }
    assertEnum(adapter.inference.kind, 'inference.kind', INFERENCE_KINDS);
    assertString(adapter.inference.label, 'inference.label');
    if (typeof adapter.inference.inferred !== 'boolean') {
      throw new AdapterContractError('ADAPTER_FIELD', 'inference.inferred must be a boolean');
    }
    if (!Array.isArray(adapter.inference.styles)) {
      throw new AdapterContractError('ADAPTER_FIELD', 'inference.styles must be an array');
    }
  }
  return adapter;
}

function baseAdapter(kind, { hostVersion = 'unknown', backendVersion = 'unknown', matrix = DEFAULT_MATRIX } = {}) {
  const hostIn = matrixStatus('host', hostVersion, matrix);
  const backendIn = kind === 'host-basic'
    ? hostIn
    : kind === 'context-zip'
      ? matrixStatus('contextZip', backendVersion, matrix)
      : 'unknown';
  return {
    kind,
    label: kind,
    versions: { host: hostVersion, backend: backendVersion },
    control: 'host-pressure',
    perception: kind === 'unknown' || kind === 'none' ? 'none' : 'event',
    triggers: kind === 'unknown' || kind === 'none' ? ['compaction-event'] : ['compaction-event', 'command'],
    hooks: { before: 'best-effort', after: 'event' },
    summary: { authority: 'exclusive', readability: 'unknown', style: 'unknown' },
    rewrite: { boundary: 'replace-span', maintainsToolPairing: 'host' },
    protectionRole: 'validator',
    observability: { usage: true, range: true, artifact: true },
    matrix: { host: hostIn, backend: backendIn },
    selfCheck: { state: 'pending', checks: [] },
    inference: { kind: 'unknown', label: 'unknown', inferred: false, styles: [] },
    notes: [],
  };
}

/** 宿主默认压缩（compaction-basic 行）。 */
export function createHostBasicAdapter(options = {}) {
  return validateAdapter({
    ...baseAdapter('host-basic', options),
    label: 'host-default:compaction-basic',
  });
}

/**
 * context-zip（接管 compaction-basic 行）。
 * 版本在运行时拿不到包元数据时用 `unknown`，只影响矩阵标注，不影响事件级能力。
 */
export function createContextZipAdapter(options = {}) {
  const adapter = {
    ...baseAdapter('context-zip', options),
    label: 'context-zip',
    summary: { authority: 'exclusive', readability: 'readable', style: 'five-section' },
  };
  return validateAdapter(adapter);
}

function looksLikeContextZip(engine) {
  if (engine === null || typeof engine !== 'object') return false;
  if (typeof engine.undoManualSeat === 'function') return true;
  if (Object.hasOwn(engine, 'declaredConfig')) return true;
  const name = engine.constructor?.name ?? '';
  return name === 'ContextZipEngine';
}

function looksLikeHostBasic(engine) {
  if (engine === null || typeof engine !== 'object') return false;
  const name = engine.constructor?.name ?? '';
  return name === 'BasicCompactionEngine' || typeof engine.compactIfNeeded === 'function';
}

/**
 * 识别当前压缩后端。
 *
 * @param {object} options
 * @param {object|null} options.compaction `ctx.compaction` 服务实例（缺失传 null）。
 * @param {string} [options.hostVersion] 宿主版本；未知传 'unknown'。
 * @param {string} [options.backendVersion] 后端版本（可选，通常 unknown）。
 * @param {object} [options.matrix]
 * @returns {object} 已校验适配器。
 */
export function detectAdapter({ compaction = null, hostVersion = 'unknown', backendVersion = 'unknown', matrix = DEFAULT_MATRIX } = {}) {
  if (compaction === null || typeof compaction !== 'object') {
    return validateAdapter({
      ...baseAdapter('none', { hostVersion, backendVersion, matrix }),
      label: 'no-compaction-service',
      control: 'unknown',
    });
  }
  const hasServiceApi = typeof compaction.compactNow === 'function';
  if (!hasServiceApi) {
    return validateAdapter({
      ...baseAdapter('unknown', { hostVersion, backendVersion, matrix }),
      label: 'unknown-provider',
      control: 'unknown',
      notes: ['ctx.compaction exists but does not expose compactNow()'],
    });
  }
  if (looksLikeContextZip(compaction)) {
    return createContextZipAdapter({ hostVersion, backendVersion, matrix });
  }
  if (looksLikeHostBasic(compaction)) {
    return createHostBasicAdapter({ hostVersion, backendVersion, matrix });
  }
  return validateAdapter({
    ...baseAdapter('unknown', { hostVersion, backendVersion, matrix }),
    label: 'unknown-provider',
    control: 'unknown',
    notes: ['ctx.compaction is present but matches neither known backend marker'],
  });
}

/** 五段式标题（与 context-zip 0.1.10 一致）。 */
export const FIVE_SECTION_HEADINGS = Object.freeze([
  'Goal and intent', 'Decisions', 'Current state', 'Next steps', 'Anchors',
]);

export function classifySummaryText(summaryText) {
  const text = typeof summaryText === 'string' ? summaryText : '';
  if (text.trim().length === 0) {
    return { readability: 'unreadable', style: 'unknown', headings: 0 };
  }
  const headings = FIVE_SECTION_HEADINGS.filter((heading) => text.includes(heading)).length;
  return {
    // E1 实测：宿主/context-zip 的非空摘要都可读；`partial` 暂不启用（保留枚举给后续判据）。
    readability: 'readable',
    style: headings >= 4 ? 'five-section' : 'free-form',
    headings,
  };
}

/**
 * 事件形态推断（0.1.15，REQ-20261025-06 Q1=A）。
 *
 * 只用于展示与归因（`/cg status`/审计/`compaction-cost.backend`），**功能路径不得读取**：
 * - free-form（无五段标题）→ `host-basic`；
 * - five-section（命中≥4 个标题）→ `context-zip`；
 * - 两种都不像 → `unknown`；
 * - 同一组观察里同时出现两种形态 → `mixed`（`unverified`）。
 *
 * @param {string[]} styles 观察到的摘要形态（`classifySummaryText().style`）。
 * @returns {{kind: string, label: string, inferred: boolean, styles: string[]}}
 */
export function inferBackendFromStyles(styles = []) {
  const observed = [...new Set((styles ?? []).filter((style) => style === 'five-section' || style === 'free-form'))];
  if (observed.length === 0) return { kind: 'unknown', label: 'unknown', inferred: false, styles: [] };
  if (observed.length > 1) return { kind: 'mixed', label: 'mixed (unverified)', inferred: false, styles: observed };
  if (observed[0] === 'free-form') return { kind: 'host-basic', label: 'host-basic (inferred)', inferred: true, styles: observed };
  return { kind: 'context-zip', label: 'context-zip (inferred)', inferred: true, styles: observed };
}

/** 把推断挂到适配器上（不改 kind；kind 仍是实测探测结果）。 */
export function withInference(adapter, styles = []) {
  validateAdapter(adapter);
  return validateAdapter({ ...adapter, inference: inferBackendFromStyles(styles) });
}

/**
 * 成本行/状态命令共用的 backend 字段解析（0.1.18 单一来源）。
 * 规则：backend/backendKind 只写枚举（含 `none`）；实测 `none` 不折叠成 `unknown`；
 * `backendLabel` 才是展示串；`backendInferred` 仅当实测 kind 为 none/unknown 且由推断补位。
 *
 * @param {object} adapter
 * @returns {{backend: string, backendKind: string, backendLabel: string, backendInferred: boolean}}
 */
export function resolveBackendFields(adapter) {
  const inference = adapter?.inference ?? null;
  const measuredKind = typeof adapter?.kind === 'string' ? adapter.kind : 'unknown';
  const measuredEnum = measuredKind === 'host-basic' || measuredKind === 'context-zip' || measuredKind === 'none'
    ? measuredKind
    : 'unknown';
  const useInference = (measuredEnum === 'none' || measuredEnum === 'unknown')
    && inference !== null
    && inference.kind !== 'unknown';
  const backendKind = useInference ? (inference.kind === 'mixed' ? 'unknown' : inference.kind) : measuredEnum;
  const backendLabel = useInference ? inference.label : measuredEnum;
  return { backend: backendKind, backendKind, backendLabel, backendInferred: useInference };
}

/**
 * 用第一次真实摘要校准适配器（只读；不改宿主）。
 * @param {object} adapter
 * @param {string} summaryText
 * @returns {object} 新适配器对象（不修改入参）。
 */
export function applySummaryObservation(adapter, summaryText) {
  validateAdapter(adapter);
  const observed = classifySummaryText(summaryText);
  const notes = [...(adapter.notes ?? [])];
  if (adapter.kind === 'host-basic' && observed.style === 'five-section') {
    notes.push('observed five-section summary from a host-basic adapter: provider may have been taken over after startup');
  }
  if (adapter.kind === 'context-zip' && observed.style === 'free-form') {
    notes.push('observed free-form summary from a context-zip adapter: takeover may be stale or mode=default');
  }
  return validateAdapter({
    ...adapter,
    summary: {
      ...adapter.summary,
      readability: observed.readability,
      style: observed.style,
    },
    notes,
  });
}

function versionInMatrix(kind, version, matrix) {
  return matrixStatus(kind, version, matrix);
}

/**
 * 运行契约自检（初始化时）。不加载插件代码、不发请求。
 *
 * @param {object} options
 * @param {object} options.adapter detectAdapter 的结果。
 * @param {boolean} options.eventApi 插件是否拿到 `ctx.on`。
 * @param {object} [options.matrix]
 * @returns {object} 新适配器，selfCheck 已填充。
 */
export function runSelfCheck({ adapter, eventApi, matrix = DEFAULT_MATRIX }) {
  validateAdapter(adapter);
  const checks = [];
  const hasService = adapter.kind === 'host-basic' || adapter.kind === 'context-zip';
  checks.push({
    id: 'compaction-service',
    status: hasService ? 'pass' : 'fail',
    detail: hasService ? `${adapter.label} exposes the compaction service` : 'no usable ctx.compaction provider',
  });
  checks.push({
    id: 'event-api',
    status: eventApi === true ? 'pass' : 'fail',
    detail: eventApi === true ? 'ctx.on is available; compaction/* events can be observed' : 'ctx.on is unavailable',
  });
  const hostMatrix = adapter.versions.host === 'unknown'
    ? 'unknown'
    : versionInMatrix('host', adapter.versions.host, matrix);
  checks.push({
    id: 'host-version',
    status: hostMatrix === 'in' ? 'pass' : hostMatrix === 'unknown' ? 'warn' : 'fail',
    detail: `host ${adapter.versions.host} is ${hostMatrix} the verified matrix`,
  });
  const backendMatrix = adapter.kind === 'context-zip'
    ? versionInMatrix('contextZip', adapter.versions.backend, matrix)
    : adapter.kind === 'host-basic' ? hostMatrix : 'unknown';
  checks.push({
    id: 'backend-version',
    status: backendMatrix === 'in' ? 'pass' : backendMatrix === 'unknown' ? 'warn' : 'fail',
    detail: `backend ${adapter.versions.backend} (${adapter.kind}) is ${backendMatrix} the verified matrix`,
  });
  checks.push({
    id: 'summary-readability',
    status: adapter.summary.readability === 'unknown' ? 'pending' : 'pass',
    detail: adapter.summary.readability === 'unknown'
      ? 'waiting for the first compaction summary'
      : `summary readability=${adapter.summary.readability}, style=${adapter.summary.style}`,
  });
  const state = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.some((check) => check.status === 'pending') ? 'pending' : 'pass';
  return validateAdapter({ ...adapter, selfCheck: { state, checks } });
}

/**
 * 探测宿主版本：优先 Electron 的 `process.resourcesPath`（asar 布局），
 * 其次尝试从插件位置解析 `@deepseek-ai/dsh-app-boot/package.json`。
 * 全部失败返回 'unknown'（不猜版本）。
 */
export function detectHostVersion({
  resourcesPath = process.resourcesPath,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  resolvePackage = (specifier) => createRequire(import.meta.url).resolve(specifier),
} = {}) {
  const candidates = [];
  if (typeof resourcesPath === 'string' && resourcesPath.trim() !== '') {
    candidates.push(`${resourcesPath}/app.asar/dsh/package.json`, `${resourcesPath}/app/dsh/package.json`);
  }
  for (const file of candidates) {
    try {
      const manifest = JSON.parse(readFile(file));
      if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version;
    } catch {
      /* try next */
    }
  }
  try {
    const file = resolvePackage('@deepseek-ai/dsh-app-boot/package.json');
    const manifest = JSON.parse(readFile(file));
    if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version;
  } catch {
    /* unknown */
  }
  return 'unknown';
}

/**
 * 从运行中的实例读后端版本做不到时，允许配置显式覆盖；
 * 这个函数只做字符串清洗，不做猜测。
 */
export function normalizeBackendVersion(value) {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  return trimmed === '' ? 'unknown' : trimmed;
}
