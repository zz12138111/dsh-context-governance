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
import { checkWriteTarget } from './roots/containment.js';
import { isUserLevelPath, rootAuditFile, userLevelDir } from './roots/paths.js';

const MAX_MEMORY_ENTRIES = 200;

/** 审计单文件默认上限：8 MiB（一次压缩通常只写几条，够跑很久）。 */
export const DEFAULT_AUDIT_MAX_BYTES = 8 * 1024 * 1024;
export const MIN_AUDIT_MAX_BYTES = 64 * 1024;
export const MAX_AUDIT_MAX_BYTES = 1024 * 1024 * 1024;

/** 允许出现在审计里的字段（白名单）。`ts`/`event` 由 AuditLog 生成。 */
export const AUDIT_FIELD_WHITELIST = Object.freeze({
  sessionId: 'id',
  sessionShortId: 'id',
  root: 'text',
  rootId: 'text',
  rootCount: 'number',
  managed: 'boolean',
  fromVersion: 'number',
  toVersion: 'number',
  backupPath: 'text',
  violation: 'text',
  target: 'text',
  subagent: 'boolean',
  name: 'text',
  dir: 'text',
  home: 'text',
  anchor: 'text',
  path: 'text',
  inferredFromCwd: 'text',
  from: 'text',
  to: 'text',
  compactionId: 'id',
  /** S1.3：迟到回填的审计字段——短 id 与延迟毫秒（需求 2026-10-27 一致性审：缺白名单会静默丢弃）。 */
  compactionShortId: 'id',
  reconcileDelayMs: 'number',
  cycle: 'id',
  /** D-MGMT-021：surface-rebuild-skipped 与 rule-injection fail 的对账键（session seq）。 */
  ruleSeq: 'number',
  /** 被跳过的/丢失的规则形态（system-prompt / agent-instructions / skill-catalog…）。 */
  kind: 'text',
  /** D-MGMT-021 分型 loss：system-prompt-skip / user-rule-loss / b-class-loss。 */
  lossClass: 'text',
  /** 分型结论：accepted（允许丢，仅记录）/ unacceptable（必须报警）。 */
  disposition: 'text',
  /** 分型规则版本（当前 v1），供后续口径变更时区分历史行。 */
  dispositionRule: 'text',
  /** accepted 汇总计数（不逐条报警）。 */
  acceptedCount: 'number',
  /** accepted 汇总 seq 列表（number-array，上限 30）。 */
  acceptedSeqs: 'number-array',
  /** 审核签发 v4：baseline digest 观察结论——match / mismatch / unreadable（文本，不参与判定）。 */
  hashMatch: 'text',
  /** 审核签发 v4：宿主节点 digest 与读盘复算 digest（sha1(raw content)）。 */
  expected: 'text',
  actual: 'text',
  /** D-MGMT-021 v3b：pending 对账字段。 */
  contentSha256: 'text',
  match: 'text',
  windowTurnId: 'nullable-number',
  status: 'text',
  matchedSeq: 'number',
  scanFrom: 'text',
  scanTo: 'text',
  lines: 'number',
  rotated: 'boolean',
  /** rc.2：陈旧写者锁回收（pid/锁龄/探测结果/原 startedAt）。 */
  pid: 'number',
  lockProbe: 'text',
  lockAgeMs: 'number',
  startedAt: 'text',
  /** C35③：自愈节点观察字段（来源 kind/form/plugin、宿主给或不给的 digest）。 */
  form: 'text',
  plugin: 'text',
  digest: 'text',
  /** C35③：digest 分档（event-level）——复算用的展示路径已在上方 `path` 定义，不重复声明。 */
  mode: 'text',
  manual: 'boolean',
  count: 'number',
  moved: 'number',
  seq: 'number',
  ids: 'id-array',
  /** D-MGMT-023：同标题重复、只回注不落盘的条 id；以及可解析性对账的缺条 id。 */
  dedupedIds: 'id-array',
  missingIds: 'id-array',
  requested: 'number',
  missing: 'number',
  kinds: 'text-array',
  reason: 'text',
  detail: 'text',
  source: 'text',
  code: 'text',
  durationMs: 'number',
  failures: 'text-array',
  names: 'text-array',
  /** 0.1.15：推断类字段必须显式标注 inferred，避免下游当实测值解析（cost-v1.3）。 */
  inferred: 'boolean',
  entries: 'number',
  omitted: 'number',
  lines: 'number',
  /** 0.2.2：header 注入审计的可复核字段（不记裸 messages.length，不写正文）。 */
  injected: 'number',
  messagesBefore: 'number',
  messagesAfter: 'number',
  /** 0.2.2 第 5 步：early-* 审计（接线路由，不记正文）。 */
  action: 'text',
  effective: 'number',
  threshold: 'number',
  native: 'number',
  compaction: 'text',
  protection: 'text',
  reinjected: 'boolean',
  accepted: 'boolean',
  delayMs: 'number',
  /** S1.1：early 等本 cycle 报告的实际耗时（毫秒整数，只作诊断）。 */
  waitedMs: 'number',
  phase: 'text',
  materialized: 'boolean',
  late: 'boolean',
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
  // T8-2 成本归属（REQUIREMENTS A）：只记 token，不记金额。
  project: 'text',
  model: 'text',
  trigger: 'text',
  occurredAt: 'text',
  tokensBefore: 'nullable-number',
  tokensAfter: 'nullable-number',
  tokensBeforeSource: 'text',
  tokensAfterSource: 'text',
  tokensBeforeParts: 'usage',
  tokensAfterParts: 'usage',
  tokensShadowed: 'nullable-number',
  tokensSummary: 'nullable-number',
  tokensInjected: 'nullable-number',
  injectedEntries: 'number',
  tokensDropped: 'number',
  tokensPruned: 'nullable-number',
  pruneCount: 'number',
  pruneTools: 'text-array',
  shadowedStart: 'nullable-number',
  shadowedEnd: 'nullable-number',
  shadowedTokenCount: 'nullable-number',
  replacementSeq: 'nullable-number',
  tool: 'text',
  backendUsage: 'usage',
  backendCostSource: 'text',
  backendInferred: 'boolean',
  backendKind: 'text',
  backendLabel: 'text',
  governanceCostSource: 'text',
  estimateMethod: 'text',
  auditVersion: 'text',
  // 0.2.0：`/cg set` 会话层覆盖（只记键与字面值，不记消息）。
  key: 'text',
  value: 'text',
  // M1.2：能力探测双行只记服务名/类型，不记值。
  probe: 'text-array',
});

/** 已知审计事件（T5 正式化清单；未知事件仍记录，但只能带白名单字段）。 */
export const AUDIT_EVENTS = Object.freeze([
  'apply',
  'capability@apply',
  'capability@ready',
  'adapter-inferred',
  'policy-invalid',
  'policy-set',
  'header-injected',
  'protection-write',
  'protection-write-failed',
  'protection-write-skipped',
  'protection-materialized',
  /** D-MGMT-023：保护指针在对账时缺失（记了 id 却没落盘）。 */
  'protection-entry-missing',
  'protection-materialize-failed',
  'protection-materialize-skipped',
  'b1-host-native-unprotected',
  'protection-skip',
  'reinjection',
  'reinjection-skipped',
  'reinjection-failed',
  'reinjection-budget',
  'reinjection-shadowed',
  'reinjection-recovered',
  'reinjection-degraded',
  'compaction-cost',
  'compaction-loss',
  /** D-MGMT-021：accept 类损失汇总（不逐条报警，判据只读 compaction-loss）。 */
  'compaction-loss-accepted',
  /** D-MMGT-021 v3b：A 形态跳过 system/message 重建（**历史**：用户 A 后不再新写，仅旧审计可读）。 */
  'surface-rebuild-skipped',
  /** D-MGMT-021 v3b：pending 终态（accepted/unacceptable）；现只由启动扫描为旧审计行补写。 */
  'surface-rebuild-resolved',
  /** D-MGMT-021 v3b：重启恢复扫描盲区（可能存在未结算 pending；旧审计行）。 */
  'surface-rebuild-recovery-incomplete',
  /** C35③：宿主下个 pre-step 自愈窗口（pending/verified/unverified/missing 三态+校验）。 */
  'self-heal-pending',
  'self-heal-verified',
  'self-heal-unverified',
  /** 审核签发 v4：digest 观察为 mismatch 的 suspect warn（不判 fail）。 */
  'self-heal-suspect',
  'self-heal-missing',
  /** rc.2：启动时回收了陈旧写者锁（不静默）。 */
  'stale-lock-reclaimed',
  /** D-MGMT-021 回滚开关：protection.rebuild.enabled=false 时整段跳过。 */
  'surface-rebuild-disabled',
  'prune-observed',
  // 历史别名：只读兼容，不再新写。
  'manual-compaction-loss',
  'duplicate-cycle-start',
  'cycle-interrupted',
  'cycle-abandoned',
  'early-decision',
  'early-skipped',
  'early-forced',
  'early-aborted',
  'early-failed',
  // S1.1：early 等本 cycle 报告未命中时的诊断行（reason=timeout|mismatch|error）。
  'early-report-wait',
  // S1.3：报告晚到后按同 session+cycle 追加的回填行（不改写 early-forced 主记录）。
  'early-forced-reconciled',
  'early-start-timeout',
  'early-start-reused',
  'early-start-missing',
  'early-armed',
  'early-disarmed',
  'persistence-identity',
  'project-root-changed',
  'inferred-fresh',
  'no-project-root',
  // P1：根 registry / 审计双通道（root audit）；单根会话事件仍写 per-root audit。
  'root-registered',
  'root-migrated',
  'root-state-corrupt',
  'root-state-write-failed',
  'root-state-unsupported-version',
  'root-entry-invalid',
  'root-id-collision',
  'root-fail-closed',
  'root-limit-warn',
  'root-audit-unavailable',
  'containment-violation',
  'root-unmanaged',
  'root-drift',
  // P3：每根 guard 生命周期/路由错误。
  'root-guard-created',
  'root-guard-disposed',
  'root-guard-error',
  'root-guard-limit-warn',
  // P2 预留：mem_* 根路由拒绝 / 每根 store 池。
  'memory-tool-rejected',
  'memory-store-open',
  'memory-store-close',
  'memory-store-readonly',
  'memory-store-pool-warn',
  'memory-store-open-failed',
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
    case 'nullable-number':
      if (value === null) return null;
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'usage': {
      // 只保留已知的 token 计数字段，逐个校验非负有限数；对象结构固定，不接收任意键。
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const out = {};
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) out[key] = value[key];
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
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
    case 'number-array':
      return Array.isArray(value)
        ? value.filter((item) => typeof item === 'number' && Number.isFinite(item)).slice(0, 30)
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

export class AuditLog {  #file;
  #now;
  #memory = [];
  #maxBytes;
  #sizeBytes = null;
  #rotations = 0;
  #writeFailures = 0;
  #lastError = null;
  #allowedBase = null;
  #closed = false;

  /**
   * @param {object} options
   * @param {string} options.file 审计文件（`<memoryRoot>/audit.jsonl` 或用户级 root audit）
   * @param {() => Date} [options.now]
   * @param {number} [options.maxBytes] 单文件上限，超出后轮转（默认 8 MiB）
   * @param {string} [options.allowedBase] v3：实际写入 containment 的允许基目录
   */
  constructor({ file, now = () => new Date(), maxBytes = DEFAULT_AUDIT_MAX_BYTES, allowedBase = null } = {}) {
    this.#file = typeof file === 'string' && file.trim() !== '' ? path.resolve(file) : null;
    this.#now = now;
    this.#maxBytes = Math.min(Math.max(Number(maxBytes) || DEFAULT_AUDIT_MAX_BYTES, MIN_AUDIT_MAX_BYTES), MAX_AUDIT_MAX_BYTES);
    this.#allowedBase = typeof allowedBase === 'string' && allowedBase.trim() !== '' ? allowedBase.trim() : null;
    if (this.#file !== null && this.#allowedBase !== null) {
      const check = checkWriteTarget(this.#allowedBase, this.#file);
      if (check.ok !== true) throw new Error(`audit file outside allowed base: ${check.reason}`);
    }
    this.#ensureFile();
  }

  get file() { return this.#file; }
  get maxBytes() { return this.#maxBytes; }
  get rotations() { return this.#rotations; }
  get writeFailures() { return this.#writeFailures; }
  get lastError() { return this.#lastError; }
  get closed() { return this.#closed; }

  /** P2：池 dispose 时丢弃内存态；之后 append 不再写盘。 */
  close() {
    this.#closed = true;
    this.#memory.length = 0;
  }

  /** v3：实际写入前 containment 复核（无 allowedBase 时兼容旧单测/无守卫构造）。 */
  #guard(target = this.#file) {
    if (this.#allowedBase === null || target === null) return true;
    const check = checkWriteTarget(this.#allowedBase, target);
    if (check.ok === true) return true;
    this.#writeFailures += 1;
    this.#lastError = `containment:${check.reason}`;
    return false;
  }

  /** 当前审计文件字节数（真实 stat；读不到时按 0；不抛错）。 */
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
    if (!this.#guard(target) || !this.#guard(this.#file)) return false;
    try {
      fs.renameSync(this.#file, target);
      // P3-8：轮转后当前文件由下一次 append 重建；大小留给 getter 重新 stat。
      this.#sizeBytes = null;
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
    if (!this.#guard(this.#file)) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.appendFileSync(this.#file, '');
      // P3-8：既有文件（历史进程写的 42 行/15KB 之类）必须计入真实大小，
      // 不能从 0 起算——否则 /cg status 的 size= 失真、轮转也会超上限。
      this.#sizeBytes = null;
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
    if (this.#closed) return false;
    const record = {
      ts: this.#now().toISOString(),
      event: redactText(String(event)).slice(0, 80),
      ...sanitizeAuditDetails(details),
    };
    this.#memory.push(record);
    if (this.#memory.length > MAX_MEMORY_ENTRIES) this.#memory.shift();
    if (this.#file === null) return true;
    if (!this.#guard(this.#file)) return false;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      this.#rotateIfNeeded(bytes);
      fs.appendFileSync(this.#file, line, 'utf8');
      // P3-8：sizeBytes 必须是真实文件大小——外部进程也可能写/轮转，写后不靠自增计数。
      this.#sizeBytes = null;
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

/**
 * P1：创建 profile 级 root audit（用户级 `root-audit-<profile>.jsonl`）。
 * 身份不可用/路径不在白名单 → null（调用方降级到 logger）。
 */
export function createRootAudit(identity, { maxBytes, now } = {}) {
  if (identity === null || typeof identity !== 'object' || identity.ok !== true) return null;
  const file = rootAuditFile(identity);
  if (file === null || !isUserLevelPath(identity, file)) return null;
  const allowedBase = userLevelDir(identity);
  if (allowedBase === null) return null;
  try {
    return new AuditLog({
      file,
      allowedBase,
      ...(Number.isFinite(maxBytes) ? { maxBytes } : {}),
      ...(typeof now === 'function' ? { now } : {}),
    });
  } catch {
    return null;
  }
}



