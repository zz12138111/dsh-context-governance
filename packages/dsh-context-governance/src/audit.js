/**
 * 审计日志（T4 起，T5 正式化）。
 *
 * - JSONL，**同步追加**：写保护条目失败/回注失败必须当场留痕，不能等异步落盘；
 * - **显式字段白名单**：只允许下表字段进入审计，未知字段直接丢弃；
 * - 只写元数据（时间、事件、session/cycle、计数/原因），不写消息正文、摘要正文、标题；
 * - 字符串字段做敏感形态检测，命中即替换为 `[redacted:<kind>]`；
 * - 审计本身写失败不抛错，由调用方降级到 logger。
 */

import fs from 'node:fs';
import path from 'node:path';

import { detectSensitive } from './memory/contract.js';

const MAX_MEMORY_ENTRIES = 200;

/** 审计单文件默认上限：8 MiB（一次压缩通常只写几条，够跑很久）。 */
export const DEFAULT_AUDIT_MAX_BYTES = 8 * 1024 * 1024;
export const MIN_AUDIT_MAX_BYTES = 64 * 1024;
export const MAX_AUDIT_MAX_BYTES = 1024 * 1024 * 1024;

/** 允许出现在审计里的字段（白名单）。`ts`/`event` 由 AuditLog 生成。 */
export const AUDIT_FIELD_WHITELIST = Object.freeze({
  sessionId: 'id',
  compactionId: 'id',
  cycle: 'id',
  manual: 'boolean',
  count: 'number',
  moved: 'number',
  seq: 'number',
  ids: 'id-array',
  kinds: 'text-array',
  reason: 'text',
  code: 'text',
  durationMs: 'number',
  failures: 'text-array',
  entries: 'number',
  omitted: 'number',
  lines: 'number',
  mode: 'text',
  adapter: 'text',
  backend: 'text',
  host: 'text',
  version: 'text',
  perception: 'text',
  eventApi: 'boolean',
  readOnly: 'boolean',
  status: 'text',
  window: 'number',
});

/** 已知审计事件（T5 正式化清单；未知事件仍记录，但只能带白名单字段）。 */
export const AUDIT_EVENTS = Object.freeze([
  'apply',
  'protection-write',
  'protection-write-failed',
  'protection-write-skipped',
  'protection-materialized',
  'protection-materialize-failed',
  'reinjection',
  'reinjection-skipped',
  'reinjection-failed',
  'reinjection-budget',
  'manual-compaction-loss',
  'duplicate-cycle-start',
  'cycle-interrupted',
  'cycle-abandoned',
]);

function redactText(value) {
  if (typeof value !== 'string') return '';
  const hit = detectSensitive(value);
  if (hit !== null) return `[redacted:${hit}]`;
  return value.slice(0, 300);
}

function sanitizeValue(key, value) {
  const kind = AUDIT_FIELD_WHITELIST[key];
  if (kind === undefined) return undefined;
  switch (kind) {
    case 'id':
      return typeof value === 'string' ? value.slice(0, 120) : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'text':
      return typeof value === 'string' ? redactText(value) : undefined;
    case 'id-array':
      return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string').slice(0, 30).map((item) => item.slice(0, 120))
        : undefined;
    case 'text-array':
      return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string').slice(0, 30).map(redactText)
        : undefined;
    default:
      return undefined;
  }
}

export function sanitizeAuditDetails(details) {
  const out = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (key === 'ts' || key === 'event') continue;
    const sanitized = sanitizeValue(key, value);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

export class AuditLog {
  #file;
  #now;
  #memory = [];
  #maxBytes;
  #sizeBytes = null;
  #rotations = 0;
  #writeFailures = 0;
  #lastError = null;

  /**
   * @param {object} options
   * @param {string} options.file 审计文件（`<memoryRoot>/audit.jsonl`）
   * @param {() => Date} [options.now]
   * @param {number} [options.maxBytes] 单文件上限，超出后轮转（默认 8 MiB）
   */
  constructor({ file, now = () => new Date(), maxBytes = DEFAULT_AUDIT_MAX_BYTES } = {}) {
    this.#file = typeof file === 'string' && file.trim() !== '' ? path.resolve(file) : null;
    this.#now = now;
    this.#maxBytes = Math.min(Math.max(Number(maxBytes) || DEFAULT_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES), MAX_AUDIT_MAX_BYTES);
    this.#ensureFile();
  }

  get file() { return this.#file; }
  get maxBytes() { return this.#maxBytes; }
  get rotations() { return this.#rotations; }
  get writeFailures() { return this.#writeFailures; }
  get lastError() { return this.#lastError; }

  /** 当前审计文件字节数（读不到时按 0；不抛错）。 */
  get sizeBytes() {
    if (this.#sizeBytes !== null) return this.#sizeBytes;
    if (this.#file === null) return 0;
    try {
      this.#sizeBytes = fs.statSync(this.#file).size;
    } catch {
      this.#sizeBytes = 0;
    }
    return this.#sizeBytes;
  }

  /**
   * 轮转文件名：`audit-YYYYMMDD.jsonl`；同一天已存在则加 `-2`、`-3`。
   * 只在当前文件确实有内容时调用。
   */
  #rotateTarget() {
    if (this.#file === null) return null;
    const date = this.#now().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.dirname(this.#file);
    for (let index = 1; index < 1000; index += 1) {
      const candidate = path.join(dir, index === 1 ? `audit-${date}.jsonl` : `audit-${date}-${index}.jsonl`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return path.join(dir, `audit-${date}-overflow.jsonl`);
  }

  /** 当前文件超限时轮转；失败返回 false（调用方仍尝试追加，绝不抛错）。 */
  #rotateIfNeeded(nextBytes) {
    if (this.#file === null) return true;
    const size = this.sizeBytes;
    if (size === 0 || size + nextBytes <= this.#maxBytes) return true;
    const target = this.#rotateTarget();
    if (target === null) return true;
    try {
      fs.renameSync(this.#file, target);
      this.#sizeBytes = 0;
      this.#rotations += 1;
      return true;
    } catch (error) {
      this.#lastError = `rotate:${error?.code ?? 'ERR'}`;
      return false;
    }
  }

  /** 插件装载时就把审计文件建出来（T5 要求：apply 即落文件，便于确认路径与写入时机）。 */
  #ensureFile() {
    if (this.#file === null) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.appendFileSync(this.#file, '');
      this.#sizeBytes = 0;
    } catch (error) {
      this.#lastError = `ensure:${error?.code ?? 'ERR'}`;
      /* 建不了文件不阻断；首次 append 会再试一次并回报失败 */
    }
  }

  /**
   * @param {string} event 事件名
   * @param {object} [details] 只允许白名单字段
   * @returns {boolean} 是否落盘成功（无文件时视为成功，只留内存）
   */
  append(event, details = {}) {
    const record = {
      ts: this.#now().toISOString(),
      event: redactText(String(event)).slice(0, 80),
      ...sanitizeAuditDetails(details),
    };
    this.#memory.push(record);
    if (this.#memory.length > MAX_MEMORY_ENTRIES) this.#memory.shift();
    if (this.#file === null) return true;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      this.#rotateIfNeeded(bytes);
      fs.appendFileSync(this.#file, line, 'utf8');
      this.#sizeBytes = (this.#sizeBytes ?? 0) + bytes;
      return true;
    } catch (error) {
      this.#writeFailures += 1;
      this.#lastError = `append:${error?.code ?? 'ERR'}`;
      this.#sizeBytes = null; // 下次重新 stat，避免脏值参与轮转判断
      return false;
    }
  }

  entries() {
    return this.#memory.map((record) => ({ ...record }));
  }

  /** 最近 N 条（默认 20），供 `/cg status` 读取。 */
  recent(limit = 20) {
    const count = Math.min(Math.max(Number(limit) || 20, 1), MAX_MEMORY_ENTRIES);
    return this.#memory.slice(-count).map((record) => ({ ...record }));
  }

  /** 保护写盘耗时的 p50/p95（基于进程内记录；重启后由 guard 的样本重新累计）。 */
  writeLatencyStats() {
    const samples = this.#memory
      .filter((record) => record.event === 'protection-write' && typeof record.durationMs === 'number')
      .map((record) => record.durationMs);
    if (samples.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null, minMs: null };
    const sorted = [...samples].sort((left, right) => left - right);
    const pick = (ratio) => sorted[Math.min(Math.max(Math.ceil(ratio * sorted.length) - 1, 0), sorted.length - 1)];
    return { count: sorted.length, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: sorted[sorted.length - 1], minMs: sorted[0] };
  }
}
