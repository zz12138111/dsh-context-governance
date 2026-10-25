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

  constructor({ file, now = () => new Date() } = {}) {
    this.#file = typeof file === 'string' && file.trim() !== '' ? path.resolve(file) : null;
    this.#now = now;
    this.#ensureFile();
  }

  get file() { return this.#file; }

  /** 插件装载时就把审计文件建出来（T5 要求：apply 即落文件，便于确认路径与写入时机）。 */
  #ensureFile() {
    if (this.#file === null) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.appendFileSync(this.#file, '');
    } catch {
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
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.appendFileSync(this.#file, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch {
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
