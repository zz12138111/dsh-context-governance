/**
 * 任务态记忆契约（v1）。
 *
 * 只定义"条目长什么样、哪些转换合法、回注一行长什么样"；不碰文件系统。
 * 字段与状态取自 `docs/上下文治理插件-架构说明-v1.0.md` §5.3 / §9.3。
 *
 * 设计约束：
 * - 条目里不放原始对话；`source` / `evidence` 是**指针**，不是原文。
 * - `writer=model` 或 `risk=high` 的条目一律先落 `proposed`，执行前必须确认。
 * - 回注行永远不含 `detail`（架构不变量 5）。
 */

export const ENTRY_TYPES = Object.freeze([
  'decision',
  'preference',
  'todo',
  'progress',
  'fact',
  'criterion',
  'anchor',
]);

export const ENTRY_STATUSES = Object.freeze([
  'proposed',
  'active',
  'superseded',
  'expired',
]);

export const WRITERS = Object.freeze(['user', 'rule', 'model']);
export const RISKS = Object.freeze(['low', 'high']);

/** status → 中文短标签；回注行只允许用这些表。 */
export const STATUS_LABELS = Object.freeze({
  proposed: '待确认',
  active: '仍生效',
  superseded: '已被取代',
  expired: '已过期',
});

export const ID_PATTERN = /^MEM-\d{8}-\d{3,}$/;
const DATE_ID_PATTERN = /^MEM-(\d{8})-(\d{3,})$/;

const LIMITS = Object.freeze({
  titleChars: 200,
  detailChars: 8000,
  pointerChars: 500,
  projectChars: 120,
});

/** 契约错误：`code` 稳定，便于工具层和测试断言。 */
export class MemoryContractError extends Error {
  constructor(code, message, details) {
    super(`[${code}] ${message}`);
    this.name = 'MemoryContractError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const SENSITIVE_PATTERNS = Object.freeze([
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['aws-secret', /\baws_secret_access_key\b/i],
  ['credential-assignment', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{6,}/i],
]);

/** 返回命中的敏感类别；未命中返回 null。 */
export function detectSensitive(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const [name, pattern] of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

function requireString(value, field, { min = 1, max = LIMITS.pointerChars } = {}) {
  if (typeof value !== 'string') {
    throw new MemoryContractError('FIELD_TYPE', `${field} must be a string`, { field, value });
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new MemoryContractError('FIELD_EMPTY', `${field} must not be empty`, { field });
  }
  if (trimmed.length > max) {
    throw new MemoryContractError('FIELD_TOO_LONG', `${field} exceeds ${max} characters`, {
      field,
      length: trimmed.length,
      max,
    });
  }
  if (/[\r\n]/.test(trimmed) && field !== 'detail') {
    throw new MemoryContractError('FIELD_MULTILINE', `${field} must be a single line`, { field });
  }
  return trimmed;
}

function optionalString(value, field, max = LIMITS.pointerChars) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field, { min: 1, max });
}

function requireEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new MemoryContractError('FIELD_ENUM', `${field} must be one of ${allowed.join('/')}`, {
      field,
      value,
      allowed: [...allowed],
    });
  }
  return value;
}

function requireConfidence(value, field = 'confidence') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryContractError('FIELD_CONFIDENCE', `${field} must be a number in [0, 1]`, {
      field,
      value,
    });
  }
  return value;
}

function checkSensitive(fields) {
  for (const [field, value] of Object.entries(fields)) {
    const hit = detectSensitive(value);
    if (hit !== null) {
      throw new MemoryContractError('SENSITIVE_CONTENT', `${field} looks like ${hit}; memory never stores credentials`, {
        field,
        kind: hit,
      });
    }
  }
}

/** 本地日期 YYYYMMDD（记忆 ID 用本地自然日，便于人读）。 */
export function localDateId(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 在已有条目里为今天找下一个序号；稳定、不依赖时钟回拨。 */
export function nextEntryId(existingIds, now = new Date()) {
  const date = localDateId(now);
  let max = 0;
  for (const id of existingIds) {
    const match = DATE_ID_PATTERN.exec(String(id));
    if (match === null || match[1] !== date) continue;
    max = Math.max(max, Number(match[2]));
  }
  return `MEM-${date}-${String(max + 1).padStart(3, '0')}`;
}

/**
 * 校验并规范化一次"新建/取代"的输入。
 *
 * @param {object} input 模型或用户给的原始字段。
 * @param {object} [options]
 * @param {string} [options.project] 缺省的 project（存储根已有归属时）。
 * @param {() => Date} [options.now] 注入时钟，测试用。
 * @returns {object} 不含 id、不含时间的规范化草稿。
 */
export function normalizeDraft(input, { project, now = () => new Date() } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MemoryContractError('DRAFT_TYPE', 'memory entry must be an object');
  }
  const type = requireEnum(input.type, 'type', ENTRY_TYPES);
  const title = requireString(input.title, 'title', { min: 1, max: LIMITS.titleChars });
  const detail = input.detail === undefined || input.detail === null
    ? ''
    : requireString(input.detail, 'detail', { min: 0, max: LIMITS.detailChars });
  if (detail.includes('<!--')) {
    throw new MemoryContractError('DETAIL_MARKER', 'detail must not contain an entry marker', { field: 'detail' });
  }
  const projectValue = input.project ?? project;
  if (projectValue === undefined || projectValue === null) {
    throw new MemoryContractError('FIELD_EMPTY', 'project is required for a memory entry', { field: 'project' });
  }
  const resolvedProject = requireString(
    projectValue,
    'project',
    { min: 1, max: LIMITS.projectChars },
  );
  const writer = requireEnum(input.writer, 'writer', WRITERS);
  const confidenceInput = input.confidence;
  let confidence;
  if (confidenceInput === undefined || confidenceInput === null) {
    if (writer === 'model') {
      throw new MemoryContractError('CONFIDENCE_REQUIRED', 'model-written entries must carry confidence', {
        field: 'confidence',
      });
    }
    confidence = writer === 'user' ? 1 : 0.9;
  } else {
    confidence = requireConfidence(confidenceInput);
  }
  const risk = input.risk === undefined || input.risk === null
    ? 'low'
    : requireEnum(input.risk, 'risk', RISKS);

  // 默认状态（架构 §5.4）：
  // - 用户写入、低风险 → active；
  // - 规则提取、低风险且是进度/事实 → active（批次计数这类"可直接生效"）；
  // - 模型写入、高风险、其余情况 → proposed。
  const ruleDirect = writer === 'rule' && risk === 'low' && (type === 'progress' || type === 'fact');
  const defaultStatus = (writer === 'user' && risk === 'low') || ruleDirect ? 'active' : 'proposed';
  const status = input.status === undefined || input.status === null
    ? defaultStatus
    : requireEnum(input.status, 'status', ENTRY_STATUSES);
  if (status === 'superseded') {
    throw new MemoryContractError('STATUS_RESERVED', 'superseded is only produced by the supersede operation', {
      field: 'status',
    });
  }
  // 硬规则：只有"用户直写 + 低风险"与"规则提取的进度/事实"能直接落 active；
  // 模型写入、高风险项必须先进 proposed，由 confirm 显式确认。
  if (status === 'active' && !((writer === 'user' && risk === 'low') || ruleDirect)) {
    throw new MemoryContractError(
      'CONFIRMATION_REQUIRED',
      'model-written or high-risk entries cannot become active without user confirmation',
      { writer, risk },
    );
  }

  const source = optionalString(input.source, 'source');
  const evidence = optionalString(input.evidence, 'evidence');
  const supersedes = input.supersedes === undefined || input.supersedes === null || input.supersedes === ''
    ? null
    : requireString(input.supersedes, 'supersedes', { min: 1, max: 64 });
  if (supersedes !== null && !ID_PATTERN.test(supersedes)) {
    throw new MemoryContractError('FIELD_ID', 'supersedes must be a memory id', { field: 'supersedes' });
  }

  checkSensitive({
    title,
    detail,
    project: resolvedProject,
    ...(source === null ? {} : { source }),
    ...(evidence === null ? {} : { evidence }),
  });

  const createdAt = now().toISOString();
  return {
    id: null,
    title,
    type,
    status,
    project: resolvedProject,
    writer,
    confidence,
    risk,
    createdAt,
    updatedAt: createdAt,
    supersedes,
    supersededBy: null,
    source,
    evidence,
    detail,
  };
}

/**
 * 校验一次"更新既有条目"的补丁；只允许可人工修订的字段。
 *
 * 状态变更走 `applyStatusTransition`，取代走 supersede 操作。
 */
export function normalizePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new MemoryContractError('PATCH_TYPE', 'memory patch must be an object');
  }
  const allowed = ['title', 'detail', 'source', 'evidence', 'confidence', 'risk', 'project', 'type'];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      throw new MemoryContractError('PATCH_FIELD', `field "${key}" cannot be patched`, { field: key });
    }
  }
  const out = {};
  if (patch.title !== undefined) out.title = requireString(patch.title, 'title', { min: 1, max: LIMITS.titleChars });
  if (patch.detail !== undefined) {
    out.detail = patch.detail === null ? '' : requireString(patch.detail, 'detail', { min: 0, max: LIMITS.detailChars });
    if (out.detail.includes('<!--')) {
      throw new MemoryContractError('DETAIL_MARKER', 'detail must not contain an entry marker', { field: 'detail' });
    }
  }
  if (patch.source !== undefined) out.source = optionalString(patch.source, 'source');
  if (patch.evidence !== undefined) out.evidence = optionalString(patch.evidence, 'evidence');
  if (patch.confidence !== undefined) out.confidence = requireConfidence(patch.confidence);
  if (patch.risk !== undefined) out.risk = requireEnum(patch.risk, 'risk', RISKS);
  if (patch.project !== undefined) {
    out.project = requireString(patch.project, 'project', { min: 1, max: LIMITS.projectChars });
  }
  if (patch.type !== undefined) out.type = requireEnum(patch.type, 'type', ENTRY_TYPES);
  checkSensitive({
    ...(out.title === undefined ? {} : { title: out.title }),
    ...(out.detail === undefined ? {} : { detail: out.detail }),
    ...(out.source === undefined || out.source === null ? {} : { source: out.source }),
    ...(out.evidence === undefined || out.evidence === null ? {} : { evidence: out.evidence }),
  });
  return out;
}

/** 允许的状态迁移（用户/规则侧；superseded 只能由 supersede 产生）。 */
const STATUS_TRANSITIONS = Object.freeze({
  proposed: new Set(['active', 'expired']),
  active: new Set(['expired']),
  superseded: new Set([]),
  expired: new Set([]),
});

export function assertStatusTransition(from, to) {
  if (!ENTRY_STATUSES.includes(to)) {
    throw new MemoryContractError('STATUS_ENUM', `unknown status "${to}"`, { status: to });
  }
  const allowed = STATUS_TRANSITIONS[from];
  if (allowed === undefined || !allowed.has(to)) {
    throw new MemoryContractError('STATUS_TRANSITION', `status cannot move ${from} → ${to}`, { from, to });
  }
}

/**
 * 生成一条回注指针（架构 §6.5）。
 *
 * @param {{id:string,status:string,title:string}} entry
 * @param {{includeTitle?:boolean, summaryReadable?:boolean}} [options]
 * @returns {string} 单行；永不包含 detail。
 */
export function formatPointer(entry, { includeTitle = false, summaryReadable = true } = {}) {
  if (entry === null || typeof entry !== 'object') {
    throw new MemoryContractError('ENTRY_TYPE', 'formatPointer needs an entry');
  }
  const label = STATUS_LABELS[entry.status];
  if (label === undefined) {
    throw new MemoryContractError('STATUS_ENUM', `unknown status "${entry.status}"`, { status: entry.status });
  }
  const id = String(entry.id ?? '');
  if (!ID_PATTERN.test(id)) {
    throw new MemoryContractError('FIELD_ID', 'formatPointer needs a memory id', { id });
  }
  if (summaryReadable === false) return `${id} ${label}（详情查记忆）`;
  if (includeTitle === true) {
    const title = String(entry.title ?? '').replace(/[\r\n]+/g, ' ').trim();
    return `${id} ${label}：${title}（见记忆）`;
  }
  return `${id} ${label}（见记忆）`;
}

export const MEMORY_LIMITS = LIMITS;
