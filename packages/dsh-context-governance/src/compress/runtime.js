/**
 * 压缩观测 + 保护固化/回注循环（T3 → T4）。
 *
 * 时序（宿主真实约束）：
 *   compaction/start  → 只读快照 → **同步**写保护 journal（唯一摘要生成前窗口）
 *   compaction/summary→ 校准摘要可读性/覆盖判断素材
 *   user/message      → 记录 checkpoint seq
 *   compaction/end    → 保护核对 + audit；随后 microtask 回注一次
 *
 * 为什么回注在 end 之后而不是 checkpoint 与 end 之间：
 *   checkpoint 的 append 仍处于发布期，`session.append()` 重入会被宿主拒绝
 *   （"session append cannot reenter while another append is being published"）；
 *   宿主在 commit 返回后立刻 append end，两者之间没有可插入的同步窗口。
 *   因此选择 end 发布后的首个 microtask：仍在同一 tick、下一轮模型调用之前，
 *   E2 已证实这种注入会在下一次压缩被吞，符合“每周期一次”。
 *
 * 永不：替换 provider、抛错给宿主、写消息正文到记忆/审计。
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AuditLog } from '../audit.js';
import { calculateLatencyStats } from '../metrics.js';
import {
  DEFAULT_MATRIX,
  applySummaryObservation,
  detectAdapter,
  runSelfCheck,
} from './adapters.js';
import { buildProtectionItems } from './protection-memory.js';
import { formatPointer } from '../memory/contract.js';
import { snapshotProtection, sourceKindOf, summaryTextOf, verifyProtection } from './protection.js';
import { selectMode } from './selection.js';

const MAX_REPORTS = 20;
const REINJECTION_SOURCE_KIND = 'plugin:context-governance';

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalized(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

/** 归一化会话 cwd 与项目根，用于归属比较（Windows 大小写不敏感）。 */
function sameDirectory(left, right) {
  if (typeof left !== 'string' || left.trim() === '' || typeof right !== 'string' || right.trim() === '') return false;
  const a = path.resolve(left.trim()).replace(/[\\/]+$/, '');
  const b = path.resolve(right.trim()).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function coveredBySummary(meta, summaryText) {
  if (summaryText.trim() === '') return false;
  const summary = normalized(summaryText);
  switch (meta.kind) {
    case 'latest-user':
      return meta.title.length > 0 && summary.includes(normalized(meta.title));
    case 'batch': {
      const ratios = (meta.ratios ?? []).map(normalized).filter(Boolean);
      const paths = (meta.paths ?? []).map(normalized).filter(Boolean);
      const ratioHit = ratios.length > 0 && ratios.every((ratio) => summary.includes(ratio));
      const pathHit = paths.some((file) => summary.includes(file));
      return ratioHit || pathHit;
    }
    case 'rollback': {
      const keywordHit = typeof meta.keyword === 'string' && summary.includes(normalized(meta.keyword));
      const paths = (meta.paths ?? []).map(normalized).filter(Boolean);
      return keywordHit && (paths.length === 0 || paths.some((file) => summary.includes(file)));
    }
    case 'rules': {
      const paths = (meta.paths ?? []).map(normalized).filter(Boolean);
      return paths.length > 0 && paths.some((file) => summary.includes(file));
    }
    case 'unpaired-calls': {
      const ids = (meta.callIds ?? []).map(normalized).filter(Boolean);
      return ids.length > 0 && ids.some((id) => summary.includes(id));
    }
    default:
      return false;
  }
}

/**
 * @typedef {object} CompressionGuardOptions
 * @property {object} ctx 宿主 plugin context（需要 `on`；可选 `get('compaction')`）。
 * @property {object} [adapter] 直接注入适配器（测试用；正常由 detectAdapter 识别）。
 * @property {string} [hostVersion]
 * @property {string} [backendVersion]
 * @property {object} [matrix]
 * @property {object} [logger]
 * @property {() => Date} [now]
 * @property {boolean} [enabled]
 * @property {object} [store] MemoryStore；缺省时只做 T3 观测，不做固化/回注。
 * @property {object} [audit] AuditLog；缺省时按 store.rootDir 创建。
 * @property {{enabled?:boolean,maxLines?:number,maxChars?:number}} [reinjection]
 */
export class CompressionGuard {
  #ctx;
  #logger;
  #now;
  #matrix;
  #hostVersion;
  #backendVersion;
  #enabled;
  #adapter;
  #selection;
  #store;
  #audit;
  #reinjection;
  #pending = new Map();
  #completedCycles = new Set();
  #completedOrder = [];
  #reports = [];
  #unsubscribe = null;
  #started = false;
  #eventApi = false;
  #reinjectionFailureStreak = 0;
  #maxReinjectionFailures = 3;
  #protectionSuspended = false;
  #skipProtectionThisCycle = false;
  #tokenMeter = null;
  #meterFiber = null;
  #lastUsage = new Map();
  #pendingCosts = new Map();
  #lastCost = null;
  #toolNames = new Map();
  #pendingPrune = null;
  #unassignedPrunes = new Map();
  #pruneSeen = new Set();
  #readyFired = false;
  #onFirstEvent = null;
  #projectName = '';
  #degradedReasons = [];
  #materializing = new Set();
  #writeDurations = [];
  #readOnly = false;
  #readOnlyReason = null;
  #readOnlyWarnedFor = new Set();
  #projectRoot = '';
  #onlyProject = false;
  #captureTitle = true;
  #foreignSessions = new Set();
  #lastInjection = new Map();
  #stats = {
    events: 0,
    starts: 0,
    summaries: 0,
    ends: 0,
    failures: 0,
    skipped: 0,
    lateSnapshots: 0,
    protectionWrites: 0,
    protectionWriteFailures: 0,
    lastProtectionWriteMs: 0,
    materializeFailures: 0,
    reinjections: 0,
    reinjectionFailures: 0,
    reinjectionSkips: 0,
    auditWriteFailures: 0,
    auditSkippedReadOnly: 0,
    interruptedCycles: 0,
    abandonedCycles: 0,
    readOnlyRecoveries: 0,
    ignoredForeignEvents: 0,
    unattributedEvents: 0,
    reinjectionShadowed: 0,
  };

  constructor(options = {}) {
    this.#ctx = options.ctx ?? {};
    this.#logger = options.logger ?? this.#ctx?.logger ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#matrix = options.matrix ?? DEFAULT_MATRIX;
    this.#hostVersion = options.hostVersion ?? 'unknown';
    this.#backendVersion = options.backendVersion ?? 'unknown';
    this.#enabled = options.enabled !== false;
    this.#store = options.store ?? null;
    this.#projectName = typeof options.project === 'string' ? options.project.trim() : '';
    // P2-1：只处理本项目会话。projectRoot 为空时无法判定，保持旧行为（不过滤）。
    this.#projectRoot = typeof options.projectRoot === 'string' ? options.projectRoot.trim() : '';
    this.#onlyProject = options.onlyProject !== false && this.#projectRoot !== '';
    this.#captureTitle = options.captureTitle !== false;
    this.#readOnly = this.#store?.status?.readOnlyReason !== null && this.#store?.status?.readOnlyReason !== undefined;
    this.#readOnlyReason = this.#readOnly ? this.#store.status.readOnlyReason : null;
    this.#reinjection = {
      enabled: options.reinjection?.enabled !== false,
      maxLines: Math.min(Math.max(options.reinjection?.maxLines ?? 8, 1), 20),
      maxChars: Math.min(Math.max(options.reinjection?.maxChars ?? 800, 120), 4000),
      maxFailures: Math.min(Math.max(options.reinjection?.maxFailures ?? 3, 1), 20),
    };
    this.#maxReinjectionFailures = this.#reinjection.maxFailures;
    this.#onFirstEvent = typeof options.onFirstEvent === 'function' ? options.onFirstEvent : null;
    // M1.2：装载时先试一次；失败不缓存 null，之后走注入回调/按需获取。
    this.#getTokenMeter();
    this.#audit = options.audit ?? (this.#store === null
      ? null
      : new AuditLog({
        file: path.join(this.#store.rootDir, 'audit.jsonl'),
        now: this.#now,
        maxBytes: options.auditMaxBytes,
      }));
    this.#adapter = options.adapter ?? this.#detect();
    const eventApi = typeof this.#ctx?.on === 'function';
    this.#eventApi = eventApi;
    this.#adapter = runSelfCheck({ adapter: this.#adapter, eventApi, matrix: this.#matrix });
    this.#selection = selectMode({
      adapter: this.#adapter,
      eventApi,
      enabled: this.#enabled,
    });
  }

  #detect() {
    let compaction = null;
    try {
      compaction = this.#ctx?.compaction ??
        (typeof this.#ctx?.get === 'function' ? this.#ctx.get('compaction') : null) ??
        null;
    } catch {
      compaction = null;
    }
    return detectAdapter({
      compaction,
      hostVersion: this.#hostVersion,
      backendVersion: this.#backendVersion,
      matrix: this.#matrix,
    });
  }

  get adapter() { return this.#adapter; }
  get mode() { return this.#selection.mode; }
  /**
   * 实际感知层级（v0.1.3）：只有**订阅真的挂上**才声称 `event`。
   * `adapter.perception` 是契约声明（provider 不可用时为 `none`），不能拿来表示"正在看压缩事件"。
   */
  get perception() {
    if (this.#eventApi && this.#started) return 'event';
    return this.#adapter.perception;
  }
  get eventApi() { return this.#eventApi; }
  get auditLog() { return this.#audit; }
  get readOnly() { return this.#readOnly; }
  get readOnlyReason() { return this.#readOnlyReason; }

  /** 会话的 cwd：优先 `session.header.cwd`（宿主真实字段），退回 `session.cwd`。 */
  #sessionCwd(session) {
    const header = session?.header;
    if (header !== null && typeof header === 'object' && typeof header.cwd === 'string' && header.cwd.trim() !== '') {
      return header.cwd.trim();
    }
    if (typeof session?.cwd === 'string' && session.cwd.trim() !== '') return session.cwd.trim();
    return '';
  }

  /**
   * P2-1 项目归属：只处理本项目会话的压缩事件。
   * - cwd 与本项目根不同 → 忽略（fail-closed）；
   * - cwd 缺失（老会话/测试夹具）→ 无法判定，放行但计入 `unattributedEvents`。
   */
  #belongsToProject(session) {
    if (!this.#onlyProject) return true;
    const cwd = this.#sessionCwd(session);
    if (cwd === '') {
      this.#stats.unattributedEvents += 1;
      return true;
    }
    return sameDirectory(cwd, this.#projectRoot);
  }

  /** 记录只读原因；同一原因只 warn 一次，避免每周期刷屏。 */
  #setReadOnly(reason, details = '') {
    const next = String(reason ?? 'unknown');
    this.#readOnly = true;
    this.#readOnlyReason = next;
    if (this.#readOnlyWarnedFor.has(next)) return;
    this.#readOnlyWarnedFor.add(next);
    this.#logger?.warn?.(
      `[context-governance] memory read-only (${next})${details === '' ? '' : `: ${details}`}; ` +
      'protection writes and audit appends are suspended, compaction continues',
    );
  }

  /** 每周期开始时尝试恢复：根目录写探测 / 外部改动重载。失败保持只读，不抛错。 */
  async #refreshReadOnly() {
    if (this.#store === null || !this.#readOnly) return;
    const reason = this.#readOnlyReason ?? '';
    try {
      if (reason === 'external-change' && typeof this.#store.reload === 'function') {
        await this.#store.reload();
        if (this.#store.status.writable === true) {
          this.#readOnly = false;
          this.#readOnlyReason = null;
          this.#stats.readOnlyRecoveries += 1;
          this.#logger?.info?.('[context-governance] memory reloaded after external change; read-only cleared');
        }
      } else if (typeof this.#store.probeWritable === 'function') {
        const result = await this.#store.probeWritable();
        if (result.ok === true) {
          this.#readOnly = false;
          this.#readOnlyReason = null;
          this.#stats.readOnlyRecoveries += 1;
          this.#logger?.info?.('[context-governance] memory root is writable again; read-only cleared');
        } else if (result.reason !== this.#readOnlyReason) {
          this.#setReadOnly(result.reason ?? 'root-not-writable');
        }
      }
    } catch (error) {
      this.#logger?.warn?.(`[context-governance] read-only recovery probe failed: ${String(error?.message ?? error)}`);
    }
  }

  /** 开始订阅；重复调用安全。 */
  start() {
    if (this.#started) return this;
    this.#tryInjectTokenMeter();
    if (typeof this.#ctx?.on !== 'function') {
      this.#logger?.warn?.('[context-governance] ctx.on is unavailable; compaction observation disabled');
      return this;
    }
    try {
      this.#unsubscribe = this.#ctx.on('session/event', (session, event) => this.#handle(session, event));
      this.#started = true;
    } catch (error) {
      this.#logger?.warn?.(`[context-governance] compaction observer registration failed: ${String(error?.message ?? error)}`);
    }
    return this;
  }

  /** 停止订阅（插件卸载时调用）。 */
  stop() {
    try {
      this.#unsubscribe?.();
    } catch {
      /* dispose 失败不能阻断卸载 */
    }
    this.#unsubscribe = null;
    this.#started = false;
    try {
      // ctx.inject 返回 cordis Fiber（不是 dispose 函数）；调用 fiber.dispose()，
      // 不是把返回值当函数调用。父 fiber 仍兜底。
      const fiber = this.#meterFiber;
      if (fiber !== null && typeof fiber?.dispose === 'function') {
        const result = fiber.dispose();
        if (result !== null && typeof result?.catch === 'function') void result.catch(() => {});
      }
    } catch {
      /* meter 注入清理失败不阻断卸载 */
    }
    this.#meterFiber = null;
    // M1.2：还没等到 after usage 的成本行，用 null + none 显式落盘，不静默丢。
    this.#flushPendingCosts();
    // T2′：未等到替换/未归属周期的 prune，按 unknown + outside 落盘。
    if (this.#pendingPrune !== null) this.#completePrune(null);
    this.#flushAllUnassignedOutside();
    // T6：卸载时还没 end 的周期显式留痕（不静默丢弃）。
    for (const [pendingId, pendingState] of this.#pending) {
      this.#stats.abandonedCycles += 1;
      this.#auditEvent('cycle-abandoned', {
        sessionId: pendingState.sessionId,
        compactionId: pendingId,
        reason: 'observer-disposed-without-end',
      });
    }
    this.#pending.clear();
  }

  /** 供 `/cg status`（T5）读取；不含消息正文。 */
  get status() {
    const last = this.#reports[this.#reports.length - 1] ?? null;
    return {
      started: this.#started,
      mode: this.#selection.mode,
      perception: this.perception,
      eventApi: this.#eventApi,
      readOnly: this.#readOnly,
      readOnlyReason: this.#readOnlyReason,
      reasons: [...this.#selection.reasons],
      degradedReasons: [...this.#degradedReasons],
      conflicts: this.#selection.conflicts.map((conflict) => ({ ...conflict })),
      fallback: this.#selection.fallback === null ? null : { ...this.#selection.fallback },
      adapter: {
        kind: this.#adapter.kind,
        label: this.#adapter.label,
        versions: { ...this.#adapter.versions },
        perception: this.#adapter.perception,
        control: this.#adapter.control,
        hooks: { ...this.#adapter.hooks },
        protectionRole: this.#adapter.protectionRole,
        summary: { ...this.#adapter.summary },
        matrix: { ...this.#adapter.matrix },
        selfCheck: {
          state: this.#adapter.selfCheck.state,
          checks: this.#adapter.selfCheck.checks.map((check) => ({ ...check })),
        },
        notes: [...(this.#adapter.notes ?? [])],
      },
      protection: {
        enabled: this.#store !== null && this.#reinjection.enabled,
        storeRoot: this.#store?.rootDir ?? null,
        auditFile: this.#audit?.file ?? null,
        auditMaxBytes: this.#audit?.maxBytes ?? null,
        auditSizeBytes: this.#audit?.sizeBytes ?? 0,
        auditRotations: this.#audit?.rotations ?? 0,
        pendingJournals: this.#store?.protectionPending ?? 0,
        reinjectionFailureStreak: this.#reinjectionFailureStreak,
        reinjectionSuspended: this.#protectionSuspended || this.#skipProtectionThisCycle,
        maxReinjectionFailures: this.#maxReinjectionFailures,
        readOnly: this.#readOnly,
        readOnlyReason: this.#readOnlyReason,
      },
      scope: {
        projectRoot: this.#projectRoot,
        onlyProject: this.#onlyProject,
        captureTitle: this.#captureTitle,
        ignoredForeignEvents: this.#stats.ignoredForeignEvents,
        ignoredForeignSessions: this.#foreignSessions.size,
        unattributedEvents: this.#stats.unattributedEvents,
      },
      writeLatency: calculateLatencyStats(this.#writeDurations),
      stats: { ...this.#stats, pending: this.#pending.size, reports: this.#reports.length },
      lastCost: this.#lastCost === null ? null : { ...this.#lastCost },
      lastReport: last === null ? null : cloneJson(last),
    };
  }

  /** 已完成的保护报告（最多 20 条，供 T5 审计）。 */
  reports() {
    return this.#reports.map((report) => cloneJson(report));
  }

  #auditEvent(event, details) {
    // 只读模式：不写审计（根目录不可写时写也写不进去），失败信息走 logger。
    if (this.#readOnly) {
      this.#stats.auditSkippedReadOnly += 1;
      return false;
    }
    const ok = this.#audit?.append(event, details) ?? true;
    if (!ok) {
      this.#stats.auditWriteFailures += 1;
      const suffix = this.#audit?.lastError ? ` (${this.#audit.lastError})` : '';
      this.#logger?.warn?.(`[context-governance] audit write failed for ${event}${suffix}`);
    }
    return ok;
  }

  #degradeProtection(reason) {
    if (!this.#degradedReasons.includes(reason)) this.#degradedReasons.push(reason);
    if (this.#selection.mode === 'full' || this.#selection.mode === 'degraded-summary-unreadable') {
      this.#selection = {
        ...this.#selection,
        mode: 'degraded-protection',
        reasons: [...new Set([...this.#selection.reasons, reason])],
      };
    }
  }

  /**
   * T8-1 自愈：一次回注失败不再永久关闭。
   * - 每次失败都记 `reinjection-failed`（count=连续失败次数）；
   * - 连续失败达到 `maxFailures` 才进入 `degraded-protection` 并跳过**下一周期**的保护写；
   * - 下一周期仍会重试回注（用已有记忆指针），成功即写 `reinjection-recovered` 并恢复写入。
   */
  /**
   * M1.2：按需取 tokenMeter；成功才缓存，失败不缓存 null（服务可能晚注册）。
   * 不把 tokenMeter 加进硬 inject：缺服务时插件仍要能装载。
   */
  #getTokenMeter() {
    if (this.#tokenMeter !== null) return this.#tokenMeter;
    try {
      const meter = this.#ctx?.tokenMeter
        ?? (typeof this.#ctx?.get === 'function' ? this.#ctx.get('tokenMeter') : null)
        ?? null;
      if (meter !== null && typeof meter?.measure === 'function') {
        this.#tokenMeter = meter;
        return meter;
      }
    } catch {
      /* 服务未就绪/代理抛错：下次再试 */
    }
    return null;
  }

  /** M1.2：可选注入回调；服务就绪时直接拿到 meter，作为按需获取之外的第二条路。 */
  #tryInjectTokenMeter() {
    if (typeof this.#ctx?.inject !== 'function') return;
    try {
      this.#meterFiber = this.#ctx.inject(['tokenMeter'], (scope) => {
        try {
          const meter = scope?.tokenMeter
            ?? (typeof scope?.get === 'function' ? scope.get('tokenMeter') : null)
            ?? null;
          if (meter !== null && typeof meter?.measure === 'function') this.#tokenMeter = meter;
        } catch {
          /* 注入回调失败不阻断；按需获取仍会重试 */
        }
      });
    } catch {
      this.#meterFiber = null;
    }
  }

  /** T8-2：优先用宿主 tokenMeter 测整会话 token；取不到返回 null（记 unknown）。 */
  #measureTokens(session) {
    const meter = this.#getTokenMeter();
    if (meter === null || typeof meter?.measure !== 'function') return null;
    try {
      const measurement = meter.measure(session);
      const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : null;
      if (nodes === null) return null;
      let total = 0;
      for (const node of nodes) {
        const value = Number.isFinite(node?.tokens) ? node.tokens : (Number.isFinite(node?.heuristicTokens) ? node.heuristicTokens : null);
        if (value === null) continue;
        total += value;
      }
      return Number.isFinite(total) ? total : null;
    } catch {
      return null;
    }
  }

  #sessionKey(session) {
    const id = session?.id ?? session?.header?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  #pruneSessionKey(session) {
    return this.#sessionKey(session) ?? 'unknown';
  }

  /** 宿主 pruner 的替换事件是否引用了当前等待中的 prune 原事件。 */
  #isPruneReplacement(event, pending) {
    if (pending === null || event?.type !== 'tool/result') return false;
    const source = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
    if (source.length === 0) return false;
    const { shadowedStart, shadowedEnd } = pending.obs;
    return (shadowedStart !== null && source.includes(shadowedStart))
      || (shadowedEnd !== null && source.includes(shadowedEnd));
  }

  #findActiveCycle(sessionId) {
    let found = null;
    for (const state of this.#pending.values()) {
      if (state.sessionId === sessionId) found = state;
    }
    return found;
  }

  #auditPrune(observation, cycle) {
    this.#auditEvent('prune-observed', {
      sessionId: observation.sessionId,
      seq: observation.seq,
      shadowedStart: observation.shadowedStart,
      shadowedEnd: observation.shadowedEnd,
      shadowedTokenCount: observation.shadowedTokenCount,
      tool: observation.tool,
      replacementSeq: observation.replacementSeq,
      cycle,
    });
  }

  /** 上一条 prune 的替换事件到了/没来：补齐元数据并按周期归属落审计。 */
  #completePrune(replacementEvent) {
    const pending = this.#pendingPrune;
    if (pending === null) return;
    this.#pendingPrune = null;
    const { obs, session } = pending;
    if (replacementEvent !== null) {
      obs.replacementSeq = replacementEvent.seq ?? null;
      // 只读元数据 callId，不读工具结果正文。
      const callId = replacementEvent?.data?.message?.source?.callId
        ?? replacementEvent?.data?.message?.toolCallId
        ?? null;
      if (typeof callId === 'string' && callId !== '') {
        obs.tool = this.#toolNames.get(callId) ?? 'unknown';
      }
    }
    const active = this.#findActiveCycle(obs.sessionId);
    if (active !== null && active.summaryEvent === null) {
      obs.cycle = 'current';
      if (!Array.isArray(active.prunes)) active.prunes = [];
      active.prunes.push(obs);
      this.#auditPrune(obs, 'current');
    } else if (active !== null) {
      // 已经过 summary，属于“本次 summary 之后”，只进会话累计。
      obs.cycle = 'outside';
      this.#auditPrune(obs, 'outside');
    } else {
      // prune 发生在 compaction/start 之前（宿主常态）：先挂起，start/summary 时归 current。
      const key = obs.sessionId ?? 'unknown';
      if (!this.#unassignedPrunes.has(key)) this.#unassignedPrunes.set(key, []);
      this.#unassignedPrunes.get(key).push(obs);
    }
  }

  #attachPrunesToState(state, session) {
    const key = this.#pruneSessionKey(session);
    const list = this.#unassignedPrunes.get(key);
    if (list === undefined) return;
    this.#unassignedPrunes.delete(key);
    if (!Array.isArray(state.prunes)) state.prunes = [];
    for (const obs of list) {
      obs.cycle = 'current';
      state.prunes.push(obs);
      this.#auditPrune(obs, 'current');
    }
  }

  #flushUnassignedOutside(session) {
    const key = this.#pruneSessionKey(session);
    const list = this.#unassignedPrunes.get(key);
    if (list === undefined) return;
    this.#unassignedPrunes.delete(key);
    for (const obs of list) {
      obs.cycle = 'outside';
      this.#auditPrune(obs, 'outside');
    }
  }

  #flushAllUnassignedOutside() {
    for (const [key, list] of [...this.#unassignedPrunes.entries()]) {
      this.#unassignedPrunes.delete(key);
      for (const obs of list) {
        obs.cycle = 'outside';
        this.#auditPrune(obs, 'outside');
      }
    }
  }

  #observePrune(session, event) {
    // 上一条 prune 还没等到替换事件：先按 unknown 落盘，再开始新的一条。
    if (this.#pendingPrune !== null) this.#completePrune(null);
    const data = event?.data ?? {};
    const range = data.shadowedRange;
    let shadowedStart = Number.isFinite(range?.start) ? range.start : null;
    let shadowedEnd = Number.isFinite(range?.end) ? range.end : null;
    if (shadowedStart === null && Array.isArray(data.shadowedSeqs)) {
      const seqs = data.shadowedSeqs.filter((seq) => Number.isFinite(seq));
      if (seqs.length > 0) {
        shadowedStart = Math.min(...seqs);
        shadowedEnd = Math.max(...seqs);
      }
    }
    const sessionId = this.#sessionKey(session);
    const dedupeKey = `${sessionId ?? 'unknown'}:${shadowedStart ?? 'n'}:${shadowedEnd ?? 'n'}:${shadowedStart === null ? event?.seq ?? 'n' : ''}`;
    if (this.#pruneSeen.has(dedupeKey)) return;
    this.#pruneSeen.add(dedupeKey);
    this.#pendingPrune = {
      obs: {
        sessionId,
        seq: event?.seq ?? null,
        shadowedStart,
        shadowedEnd,
        shadowedTokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : null,
        tool: 'unknown',
        replacementSeq: null,
        cycle: null,
      },
      session,
    };
  }

  /** 从 assistant/message 的 usage 取上下文侧用量：input + cacheRead + cacheWrite。 */
  #usageOf(event) {
    const usage = event?.data?.usage ?? event?.data?.message?.usage;
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
    const parts = {};
    let seen = false;
    for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      if (Number.isFinite(usage[key]) && usage[key] >= 0) {
        parts[key] = usage[key];
        seen = true;
      }
    }
    if (!seen) return null;
    const tokens = (parts.inputTokens ?? 0) + (parts.cacheReadTokens ?? 0) + (parts.cacheWriteTokens ?? 0);
    return { tokens, parts };
  }

  #recordUsage(session, event) {
    const usage = this.#usageOf(event);
    const key = this.#sessionKey(session);
    if (usage === null || key === null) return;
    this.#lastUsage.set(key, { ...usage, seq: event?.seq ?? null });
  }

  /** compaction/end 后第一条 assistant/message 到达：补齐 tokensAfter 并落成本行。 */
  #captureCostAfter(session, event) {
    const key = this.#sessionKey(session);
    if (key === null) return;
    const pending = this.#pendingCosts.get(key);
    if (pending === undefined) return;
    this.#pendingCosts.delete(key);
    const usage = this.#usageOf(event);
    if (usage !== null) {
      pending.state.cost.tokensAfter = usage.tokens;
      pending.state.cost.tokensAfterSource = 'usage';
      pending.state.cost.tokensAfterParts = usage.parts;
    } else {
      pending.state.cost.tokensAfter = null;
      pending.state.cost.tokensAfterSource = 'none';
      pending.state.cost.tokensAfterParts = null;
    }
    queueMicrotask(() => {
      try {
        this.#writeCost(pending.state, pending.session);
      } catch (error) {
        this.#logger?.warn?.(`[context-governance] cost audit failed: ${String(error?.message ?? error)}`);
      }
    });
  }

  /** 插件卸载/新周期前冲刷未等到 after usage 的成本行：null + none，不伪造。 */
  #flushPendingCosts() {
    for (const pending of this.#pendingCosts.values()) {
      pending.state.cost.tokensAfter = null;
      pending.state.cost.tokensAfterSource = 'none';
      pending.state.cost.tokensAfterParts = null;
      try {
        this.#writeCost(pending.state, pending.session);
      } catch (error) {
        this.#logger?.warn?.(`[context-governance] cost audit failed: ${String(error?.message ?? error)}`);
      }
    }
    this.#pendingCosts.clear();
  }

  #newCost(trigger, session) {
    const meterTokens = this.#measureTokens(session);
    const usage = this.#lastUsage.get(this.#sessionKey(session));
    let tokensBefore = null;
    let tokensBeforeSource = 'none';
    let tokensBeforeParts = null;
    if (meterTokens !== null) {
      tokensBefore = meterTokens;
      tokensBeforeSource = 'tokenMeter';
    } else if (usage !== undefined) {
      tokensBefore = usage.tokens;
      tokensBeforeSource = 'usage';
      tokensBeforeParts = usage.parts;
    }
    return {
      trigger,
      tokensBefore,
      tokensBeforeSource,
      tokensBeforeParts,
      tokensAfter: null,
      tokensAfterSource: 'none',
      tokensAfterParts: null,
      tokensShadowed: null,
      tokensSummary: null,
      tokensInjected: null,
      injectedEntries: 0,
      tokensDropped: 0,
      backendUsage: null,
      model: null,
      occurredAt: null,
    };
  }

  /** 一个周期一条成本记录：end 后、回注 microtask 之后写，带上估算的注入 token。 */
  #writeCost(state, session) {
    if (state === undefined || state.cost === undefined) return;
    const cost = state.cost;
    if (state.reinjection?.status === 'injected' && Number.isFinite(state.reinjection.tokens)) {
      cost.tokensInjected = state.reinjection.tokens;
      cost.injectedEntries = state.reinjection.lines ?? 0;
    } else if (state.reinjection?.status !== undefined) {
      cost.tokensInjected = 0;
      cost.injectedEntries = 0;
    }
    const backendMeasured = cost.backendUsage !== null
      && typeof cost.backendUsage === 'object'
      && Object.keys(cost.backendUsage).length > 0;
    const governanceEstimated = state.reinjection?.status === 'injected';
    const prunes = Array.isArray(state.prunes) ? state.prunes : [];
    let prunedSum = 0;
    let prunedMeasured = 0;
    const pruneToolCounts = new Map();
    for (const observation of prunes) {
      if (Number.isFinite(observation.shadowedTokenCount)) {
        prunedSum += observation.shadowedTokenCount;
        prunedMeasured += 1;
      }
      const tool = typeof observation.tool === 'string' && observation.tool !== '' ? observation.tool : 'unknown';
      pruneToolCounts.set(tool, (pruneToolCounts.get(tool) ?? 0) + 1);
    }
    const tokensPruned = prunedMeasured > 0 ? prunedSum : null;
    const pruneTools = [...pruneToolCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name, count]) => `${name}:${count}`);
    const occurredAt = cost.occurredAt ?? this.#now().toISOString();
    this.#auditEvent('compaction-cost', {
      sessionId: state.sessionId,
      compactionId: state.compactionId,
      project: this.#projectName,
      backend: this.#adapter.kind,
      model: cost.model,
      trigger: cost.trigger,
      occurredAt,
      tokensBefore: cost.tokensBefore,
      tokensAfter: cost.tokensAfter,
      tokensBeforeSource: cost.tokensBeforeSource,
      tokensAfterSource: cost.tokensAfterSource,
      tokensBeforeParts: cost.tokensBeforeParts,
      tokensAfterParts: cost.tokensAfterParts,
      tokensShadowed: cost.tokensShadowed,
      tokensSummary: cost.tokensSummary,
      tokensInjected: cost.tokensInjected,
      injectedEntries: cost.injectedEntries,
      tokensDropped: cost.tokensDropped,
      backendUsage: cost.backendUsage,
      tokensPruned,
      pruneCount: prunes.length,
      pruneTools,
      backendCostSource: backendMeasured ? 'measured' : 'unknown',
      governanceCostSource: governanceEstimated ? 'estimated' : 'unknown',
      estimateMethod: governanceEstimated ? 'chars/4' : 'none',
      auditVersion: 'cost-v1.2',
    });
    this.#lastCost = {
      sessionId: state.sessionId,
      compactionId: state.compactionId,
      trigger: cost.trigger,
      tokensBefore: cost.tokensBefore,
      tokensAfter: cost.tokensAfter,
      tokensBeforeSource: cost.tokensBeforeSource,
      tokensAfterSource: cost.tokensAfterSource,
      occurredAt,
      tokensPruned,
      pruneCount: prunes.length,
      pruneTools,
    };
  }

  #noteReinjectionFailure(reason) {
    this.#reinjectionFailureStreak += 1;
    if (!this.#degradedReasons.includes(reason)) this.#degradedReasons.push(reason);
    if (this.#reinjectionFailureStreak >= this.#maxReinjectionFailures && !this.#protectionSuspended) {
      this.#protectionSuspended = true;
      this.#selection = {
        ...this.#selection,
        mode: 'degraded-protection',
        reasons: [...new Set([...this.#selection.reasons, 'reinjection-suspended'])],
      };
      this.#auditEvent('reinjection-degraded', {
        reason: 'max-consecutive-failures',
        count: this.#reinjectionFailureStreak,
      });
      this.#logger?.warn?.(
        `[context-governance] reinjection failed ${this.#reinjectionFailureStreak} times in a row; ` +
        'suspending protection writes for the next cycle (reinjection will retry from existing memory)',
      );
    }
  }

  /** 回注成功：清连续失败计数/降级，恢复到正常选择。 */
  #noteReinjectionRecovered() {
    if (this.#reinjectionFailureStreak === 0 && !this.#protectionSuspended && !this.#skipProtectionThisCycle) return;
    this.#reinjectionFailureStreak = 0;
    this.#protectionSuspended = false;
    this.#skipProtectionThisCycle = false;
    this.#degradedReasons = this.#degradedReasons.filter((reason) => reason !== 'reinjection-failed');
    this.#auditEvent('reinjection-recovered', { count: 1 });
    this.#logger?.info?.('[context-governance] reinjection recovered; protection writes resume');
    const next = selectMode({
      adapter: this.#adapter,
      eventApi: typeof this.#ctx?.on === 'function',
      enabled: this.#enabled,
      summaryReadability: this.#adapter.summary.readability,
    });
    if (this.#degradedReasons.length === 0) {
      // 恢复后回到实际 mode（本机 adapter=none 时是 event-level，不写死 full）。
      this.#selection = next;
    } else {
      this.#applySelection(next);
    }
  }

  #record(report, state) {
    const enriched = {
      ...report,
      startedAt: state?.snapshot?.capturedAt ?? null,
      lateSnapshot: state?.lateSnapshot === true,
      protectionWrite: state?.protectionWrite ?? 'not-attempted',
      protectedEntries: Array.isArray(state?.entries) ? state.entries.map((entry) => entry.id) : [],
    };
    this.#reports.push(enriched);
    if (this.#reports.length > MAX_REPORTS) this.#reports.shift();
    if (enriched.ok === false) {
      this.#stats.failures += 1;
      this.#logger?.warn?.(
        `[context-governance] compaction protection failed (${enriched.failures.length}): ` +
        enriched.failures.map((failure) => `${failure.name}: ${failure.detail}`).join('; '),
      );
    }
    return enriched;
  }

  #protectBeforeSummary(session, state, id) {
    if (this.#store === null || !this.#reinjection.enabled) {
      state.protectionWrite = 'disabled';
      return;
    }
    const storeReason = this.#store?.status?.readOnlyReason ?? null;
    if (storeReason !== null && !this.#readOnly) this.#setReadOnly(storeReason);
    if (this.#skipProtectionThisCycle) {
      // T8-1：连续回注失败后的一个周期暂停写入，但压缩/回注照常（回注走既有记忆指针）。
      state.protectionWrite = 'suspended';
      this.#auditEvent('protection-write-skipped', {
        sessionId: state.sessionId,
        compactionId: id,
        reason: 'reinjection-suspended',
        count: this.#reinjectionFailureStreak,
      });
      return;
    }
    if (this.#readOnly) {
      // T6 只读降级：不写记忆、不写审计；压缩照常走完，回注走内存可读条目。
      state.protectionWrite = 'read-only';
      state.entries = [];
      this.#setReadOnly(this.#readOnlyReason ?? 'unknown');
      return;
    }
    try {
      const built = buildProtectionItems(state.snapshot, {
        sessionId: state.sessionId ?? 'unknown',
        compactionId: id,
        cycleKey: id,
        manual: state.manual === true,
        captureTitle: this.#captureTitle,
      });
      state.protectionMeta = built.meta;
      if (built.items.length === 0) {
        state.protectionWrite = 'empty';
        state.entries = [];
        return;
      }
      const writeStartedAt = Date.now();
      const entries = this.#store.protectSync({
        cycleKey: id,
        compactionId: id,
        sessionId: state.sessionId,
        items: built.items,
      });
      const durationMs = Date.now() - writeStartedAt;
      state.protectionWriteMs = durationMs;
      this.#writeDurations.push(durationMs);
      if (this.#writeDurations.length > 200) this.#writeDurations.shift();
      state.entries = entries;
      state.protectionWrite = 'ok';
      this.#stats.protectionWrites += 1;
      this.#stats.lastProtectionWriteMs = durationMs;
      this.#auditEvent('protection-write', {
        sessionId: state.sessionId,
        compactionId: id,
        manual: state.manual === true,
        count: entries.length,
        durationMs,
        ids: entries.map((entry) => entry.id),
        kinds: built.meta.map((item) => item.kind),
      });
      // 落盘 journal 已完成；并入主题文件是异步的，不阻塞 start。
      queueMicrotask(() => this.#materializeProtection(id, state));
    } catch (error) {
      state.entries = [];
      state.protectionWrite = 'failed';
      this.#stats.protectionWriteFailures += 1;
      const code = error?.code ?? 'PROTECTION_WRITE';
      this.#auditEvent('protection-write-failed', {
        sessionId: state.sessionId,
        compactionId: id,
        code,
        reason: String(error?.message ?? error).slice(0, 300),
      });
      this.#logger?.warn?.(`[context-governance] protection write failed: ${String(error?.message ?? error)}`);
      if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY'].includes(code) || error?.name === 'MemoryReadOnlyError') {
        // 写不进去 ≠ 压缩失败：转只读，本周期继续，下周期不再尝试写。
        this.#setReadOnly(`write-failed:${code}`, String(error?.message ?? error));
      } else if (error?.name === 'ExternalModificationError' || error?.code === 'EXTERNAL_MODIFICATION') {
        this.#setReadOnly('external-change', String(error?.message ?? error));
      } else {
        this.#degradeProtection('protection-write-failed');
      }
    }
  }

  /** 等待所有异步物化结束（测试/卸载用）。 */
  async flush() {
    while (this.#materializing.size > 0) {
      await Promise.allSettled([...this.#materializing]);
    }
  }

  #applySelection(next) {
    if (this.#protectionSuspended || this.#skipProtectionThisCycle) {
      this.#selection = {
        ...next,
        mode: 'degraded-protection',
        reasons: [...new Set([...next.reasons, ...this.#degradedReasons, 'reinjection-suspended'])],
      };
      return;
    }
    if (this.#selection.mode === 'degraded-protection' && this.#degradedReasons.length > 0) {
      this.#selection = {
        ...next,
        mode: 'degraded-protection',
        reasons: [...new Set([...next.reasons, ...this.#degradedReasons])],
      };
      return;
    }
    this.#selection = next;
  }

  #materializeProtection(cycleKey, state) {
    if (this.#store === null) return;
    const promise = Promise.resolve(this.#store.materializeProtection(cycleKey))
      .then((result) => {
        if (state !== undefined) state.protectionMaterialized = result;
        this.#auditEvent('protection-materialized', {
          compactionId: cycleKey,
          moved: result?.moved ?? 0,
        });
      })
      .catch((error) => {
        this.#stats.materializeFailures += 1;
        this.#auditEvent('protection-materialize-failed', {
          compactionId: cycleKey,
          reason: String(error?.message ?? error).slice(0, 300),
        });
        this.#logger?.warn?.(`[context-governance] protection journal materialize failed: ${String(error?.message ?? error)}`);
        this.#degradeProtection('protection-materialize-failed');
      })
      .finally(() => {
        this.#materializing.delete(promise);
      });
    this.#materializing.add(promise);
  }

  #hasCycleMessage(session, cycleKey) {
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    for (const seq of nodes) {
      const event = session?.eventAt?.(seq);
      const source = event?.data?.source;
      if (source?.kind === REINJECTION_SOURCE_KIND && source.cycle === cycleKey) return true;
    }
    return false;
  }

  /**
   * 只读模式下的回注来源：从**已可读**的记忆里取本会话的历史保护条目（不再新增写入）。
   * 没有则返回空数组，由调用方走 `skipped-no-entries`。
   */
  #readOnlyPointers(sessionId) {
    if (this.#store === null || typeof this.#store.allEntries !== 'function') return [];
    try {
      const needle = typeof sessionId === 'string' && sessionId !== '' ? `session:${sessionId}#` : null;
      if (needle === null) return [];
      const scoped = this.#store.allEntries().filter((entry) => (
        entry !== null && typeof entry === 'object' &&
        (entry.status === 'active' || entry.status === 'proposed') &&
        typeof entry.source === 'string' && entry.source.startsWith(needle)
      ));
      return scoped.slice(-this.#reinjection.maxLines);
    } catch (error) {
      this.#logger?.warn?.(`[context-governance] read-only pointer lookup failed: ${String(error?.message ?? error)}`);
      return [];
    }
  }

  #scheduleReinjection(session, state) {
    if (state.reinjectionScheduled === true) return;
    state.reinjectionScheduled = true;
    queueMicrotask(() => this.#injectPointers(session, state));
  }

  #injectPointers(session, state) {
    if (this.#store === null || !this.#reinjection.enabled) {
      state.reinjection = { status: 'disabled' };
      return;
    }
    if (!Array.isArray(state.entries) || state.entries.length === 0) {
      const fallback = (this.#readOnly || this.#skipProtectionThisCycle)
        ? this.#readOnlyPointers(state.sessionId)
        : [];
      if (fallback.length === 0) {
        state.reinjection = { status: 'skipped-no-entries' };
        this.#stats.reinjectionSkips += 1;
        this.#auditEvent('reinjection-skipped', {
          sessionId: state.sessionId,
          compactionId: state.compactionId,
          reason: this.#skipProtectionThisCycle ? 'reinjection-suspended-no-entries' : 'no-protected-entries',
        });
        return;
      }
      state.entries = fallback;
      state.protectionMeta = fallback.map(() => ({ kind: 'recovery-memory' }));
      state.reinjectionReadOnly = true;
      this.#logger?.info?.(
        `[context-governance] ${this.#skipProtectionThisCycle ? 'suspended' : 'read-only'} reinjection: ` +
        `${fallback.length} existing memory pointers for this session`,
      );
    }
    if (this.#hasCycleMessage(session, state.compactionId)) {
      state.reinjection = { status: 'skipped-duplicate' };
      this.#stats.reinjectionSkips += 1;
      this.#auditEvent('reinjection-skipped', {
        sessionId: state.sessionId,
        compactionId: state.compactionId,
        reason: 'cycle-already-injected',
      });
      return;
    }
    const summaryText = state.summaryText ?? '';
    const summaryReadable = state.summaryReadable !== false && summaryText.trim() !== '';
    const lines = [];
    let chars = 0;
    const header = `[context-governance] 压缩后受保护指针（cycle ${String(state.compactionId).slice(0, 8)}，manual=${state.manual === true}）：`;
    chars += header.length;
    for (let index = 0; index < state.entries.length && lines.length < this.#reinjection.maxLines; index += 1) {
      const entry = state.entries[index];
      const meta = state.protectionMeta?.[index] ?? { kind: 'unknown' };
      let includeTitle;
      if (meta.kind === 'latest-user' && state.manual === true) includeTitle = true;
      else if (!summaryReadable) includeTitle = false;
      else includeTitle = !coveredBySummary(meta, summaryText);
      const line = formatPointer(entry, { includeTitle, summaryReadable: true });
      if (chars + line.length + 1 > this.#reinjection.maxChars) {
        this.#auditEvent('reinjection-budget', {
          sessionId: state.sessionId,
          compactionId: state.compactionId,
          omitted: state.entries.length - lines.length,
        });
        break;
      }
      chars += line.length + 1;
      lines.push(line);
    }
    if (lines.length === 0) {
      state.reinjection = { status: 'skipped-budget' };
      this.#stats.reinjectionSkips += 1;
      return;
    }
    const text = [header, ...lines].join('\n');
    const message = {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: {
        kind: REINJECTION_SOURCE_KIND,
        plugin: 'context-governance',
        form: 'notice',
        cycle: state.compactionId,
      },
    };
    try {
      const appended = session.append('user/message', message, { surfaceOp: 'append' });
      const injectedTokens = Math.max(1, Math.ceil(text.length / 4));
      state.reinjection = { status: 'injected', seq: appended?.seq ?? null, lines: lines.length, tokens: injectedTokens };
      this.#stats.reinjections += 1;
      if (state.sessionId !== null && appended?.seq !== undefined) {
        // REQ-02：记住本次回注 seq，下一次压缩若把它 shadow 掉就记 `reinjection-shadowed`。
        this.#lastInjection.set(state.sessionId, {
          seq: appended.seq,
          cycle: state.compactionId,
          // T8-2：回注 token 优先用字符估算（宿主 tokenMeter 不测单条消息）。
          tokens: Math.max(1, Math.ceil(text.length / 4)),
          entries: lines.length,
        });
      }
      this.#noteReinjectionRecovered();
      this.#auditEvent('reinjection', {
        sessionId: state.sessionId,
        compactionId: state.compactionId,
        manual: state.manual === true,
        count: lines.length,
        seq: appended?.seq ?? null,
      });
      if (state.report !== undefined) {
        state.report.reinjection = state.reinjection;
      }
    } catch (error) {
      state.reinjection = { status: 'failed', reason: String(error?.message ?? error).slice(0, 200) };
      this.#stats.reinjectionFailures += 1;
      this.#noteReinjectionFailure('reinjection-failed');
      this.#auditEvent('reinjection-failed', {
        sessionId: state.sessionId,
        compactionId: state.compactionId,
        reason: String(error?.message ?? error).slice(0, 300),
        count: this.#reinjectionFailureStreak,
      });
      this.#logger?.warn?.(`[context-governance] reinjection failed: ${String(error?.message ?? error)}`);
      if (state.report !== undefined) state.report.reinjection = state.reinjection;
    }
  }

  #handle(session, event) {
    try {
      // M1.2：首个会话事件后再探测一次能力面（服务可能晚注册）。
      if (!this.#readyFired) {
        this.#readyFired = true;
        try {
          this.#onFirstEvent?.();
        } catch (error) {
          this.#logger?.warn?.(`[context-governance] ready capability hook failed: ${String(error?.message ?? error)}`);
        }
      }
      // P2-1：别的项目/其它工作区会话的压缩不写本项目记忆、也不回注到那个会话。
      if (!this.#belongsToProject(session)) {
        this.#stats.ignoredForeignEvents += 1;
        const sessionId = session?.header?.id ?? session?.id ?? 'unknown';
        if (!this.#foreignSessions.has(sessionId)) {
          this.#foreignSessions.add(sessionId);
          this.#logger?.warn?.(
            `[context-governance] ignoring session ${sessionId}: cwd ${this.#sessionCwd(session) || 'unknown'} ` +
            `is outside project ${this.#projectRoot}; no memory writes or reinjection for it`,
          );
        }
        return;
      }
      this.#stats.events += 1;
      // T2′：替换事件必须紧跟在 compaction/prune 之后；若下一条不是它，
      // 先把尚未完成的那条按 unknown 落盘，再处理当前事件。
      const eventSessionId = this.#sessionKey(session);
      if (this.#pendingPrune !== null && this.#pendingPrune.obs.sessionId === eventSessionId) {
        if (this.#isPruneReplacement(event, this.#pendingPrune)) this.#completePrune(event);
        else this.#completePrune(null);
      }
      const id = event?.data?.compactionId ?? null;
      switch (event?.type) {
        case 'tool/call': {
          const callId = event?.data?.callId;
          const toolName = event?.data?.name;
          if (typeof callId === 'string' && callId !== '' && typeof toolName === 'string' && toolName !== '') {
            this.#toolNames.set(callId, toolName);
          }
          return;
        }
        case 'compaction/prune': {
          this.#observePrune(session, event);
          return;
        }
        case 'assistant/message': {
          this.#recordUsage(session, event);
          this.#captureCostAfter(session, event);
          return;
        }
        case 'compaction/start': {
          if (id === null) return;
          // M1.2：上一周期还没等到 after usage 就开了新周期 → 用 null + none 先落盘。
          const sessionKey = this.#sessionKey(session);
          const pendingCost = sessionKey === null ? undefined : this.#pendingCosts.get(sessionKey);
          if (pendingCost !== undefined) {
            this.#pendingCosts.delete(sessionKey);
            pendingCost.state.cost.tokensAfter = null;
            pendingCost.state.cost.tokensAfterSource = 'none';
            pendingCost.state.cost.tokensAfterParts = null;
            this.#writeCost(pendingCost.state, pendingCost.session);
          }
          this.#stats.starts += 1;
          // T8-1：连续失败达到阈值后的“暂停一个周期”在这里生效；下一个 start 自动重试写入。
          this.#skipProtectionThisCycle = this.#protectionSuspended;
          this.#protectionSuspended = false;
          if (this.#readOnly) void this.#refreshReadOnly();
          if (this.#adapter.kind === 'none' || this.#adapter.kind === 'unknown') {
            // 加载顺序可能在 compaction 行之前：事务真正发生时再探测一次。
            const detected = this.#detect();
            if (detected.kind !== 'none') {
              this.#adapter = runSelfCheck({
                adapter: detected,
                eventApi: typeof this.#ctx?.on === 'function',
                matrix: this.#matrix,
              });
              this.#applySelection(selectMode({
                adapter: this.#adapter,
                eventApi: typeof this.#ctx?.on === 'function',
                enabled: this.#enabled,
              }));
            }
          }
          if (this.#completedCycles.has(id)) {
            this.#auditEvent('duplicate-cycle-start', {
              sessionId: session?.id ?? null,
              compactionId: id,
            });
            return;
          }
          if (this.#pending.has(id)) {
            this.#auditEvent('duplicate-cycle-start', {
              sessionId: session?.id ?? null,
              compactionId: id,
            });
            return;
          }
          // T6：同一会话上一周期还没 end 就来了新 start → 事件流中断；显式留痕后继续新周期。
          const sessionId = session?.id ?? null;
          if (sessionId !== null) {
            for (const [pendingId, pendingState] of [...this.#pending]) {
              if (pendingId === id || pendingState.sessionId !== sessionId) continue;
              this.#pending.delete(pendingId);
              this.#stats.interruptedCycles += 1;
              this.#auditEvent('cycle-interrupted', {
                sessionId,
                compactionId: pendingId,
                reason: 'new-cycle-start-without-end',
              });
              this.#logger?.warn?.(
                `[context-governance] compaction cycle ${pendingId} interrupted by ${id} ` +
                '(no compaction/end observed); its protection journal was already written',
              );
            }
          }
          const state = {
            compactionId: id,
            sessionId: session?.id ?? null,
            snapshot: snapshotProtection(session),
            startSeq: event.seq ?? null,
            manual: event.data?.sourceCommandId != null,
            summaryEvent: null,
            summaryText: '',
            summaryReadable: null,
            checkpointSeq: null,
            lateSnapshot: false,
            entries: [],
            protectionMeta: [],
            protectionWrite: 'not-attempted',
            reinjectionScheduled: false,
            report: null,
            prunes: [],
            cost: this.#newCost(event.data?.sourceCommandId != null ? 'manual' : 'auto', session),
          };
          this.#pending.set(id, state);
          this.#attachPrunesToState(state, session);
          this.#protectBeforeSummary(session, state, id);
          return;
        }
        case 'compaction/summary': {
          if (id === null) return;
          this.#stats.summaries += 1;
          let state = this.#pending.get(id);
          if (state === undefined) {
            // 插件在压缩事务中途才挂上：来不及在摘要前固化，只能记审计。
            state = {
              compactionId: id,
              sessionId: session?.id ?? null,
              snapshot: snapshotProtection(session),
              startSeq: null,
              manual: null,
              summaryEvent: null,
              summaryText: '',
              summaryReadable: null,
              checkpointSeq: null,
              lateSnapshot: true,
              entries: [],
              protectionMeta: [],
              protectionWrite: 'late-start',
              reinjectionScheduled: false,
              report: null,
              prunes: [],
              cost: this.#newCost(event.data?.sourceCommandId != null ? 'manual' : 'auto', session),
            };
            this.#pending.set(id, state);
            this.#attachPrunesToState(state, session);
            this.#stats.lateSnapshots += 1;
            this.#auditEvent('protection-write-skipped', {
              sessionId: state.sessionId,
              compactionId: id,
              reason: 'compaction-start-not-observed',
            });
          }
          state.summaryEvent = event;
          const text = summaryTextOf(event);
          state.summaryText = text;
          state.summaryReadable = text.trim() !== '';
          // T8-2：成本字段取自压缩事件（usage/shadowedTokenCount/provider/model）。
          const usage = event?.data?.usage;
          const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
          const hasUsage = usage !== null && typeof usage === 'object' && !Array.isArray(usage)
            && usageKeys.some((key) => Number.isFinite(usage[key]));
          if (hasUsage) state.cost.backendUsage = usage; // 空对象/无有效数值 → 保持 null + unknown
          state.cost.tokensSummary = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : null;
          state.cost.tokensShadowed = Number.isFinite(event?.data?.shadowedTokenCount)
            ? event.data.shadowedTokenCount
            : state.cost.tokensShadowed;
          const modelParts = [event?.data?.provider, event?.data?.model].filter((part) => typeof part === 'string' && part !== '');
          state.cost.model = modelParts.length > 0 ? modelParts.join('/') : null;
          // REQ-02：上一次回注的指针被本次压缩 shadow 掉 → 记“回注被吞”。
          // P3-2：优先 shadowedSeqs，缺失/不完整时用 shadowedRange 兜底。
          const shadowedSeqs = Array.isArray(event?.data?.shadowedSeqs) ? event.data.shadowedSeqs : [];
          const shadowedRange = event?.data?.shadowedRange;
          const inShadowedRange = (seq) => Number.isFinite(shadowedRange?.start)
            && Number.isFinite(shadowedRange?.end)
            && seq >= shadowedRange.start
            && seq <= shadowedRange.end;
          const lastInjection = state.sessionId === null ? undefined : this.#lastInjection.get(state.sessionId);
          if (lastInjection !== undefined && (shadowedSeqs.includes(lastInjection.seq) || inShadowedRange(lastInjection.seq))) {
            this.#lastInjection.delete(state.sessionId);
            this.#stats.reinjectionShadowed += 1;
            state.cost.tokensDropped += Number.isFinite(lastInjection.tokens) ? lastInjection.tokens : 0;
            this.#auditEvent('reinjection-shadowed', {
              sessionId: state.sessionId,
              compactionId: id,
              seq: lastInjection.seq,
              cycle: lastInjection.cycle,
              reason: 'shadowed-by-next-compaction',
            });
          }
          this.#adapter = applySummaryObservation(this.#adapter, text);
          this.#adapter = runSelfCheck({
            adapter: this.#adapter,
            eventApi: typeof this.#ctx?.on === 'function',
            matrix: this.#matrix,
          });
          this.#applySelection(selectMode({
            adapter: this.#adapter,
            eventApi: typeof this.#ctx?.on === 'function',
            enabled: this.#enabled,
            summaryReadability: this.#adapter.summary.readability,
          }));
          return;
        }
        case 'user/message': {
          if (sourceKindOf(event) !== 'compact-checkpoint') return;
          const compactionId = event?.data?.source?.compactionId ?? null;
          const state = compactionId === null ? undefined : this.#pending.get(compactionId);
          if (state !== undefined) state.checkpointSeq = event.seq ?? null;
          return;
        }
        case 'compaction/end': {
          if (id === null) return;
          this.#stats.ends += 1;
          const state = this.#pending.get(id);
          if (state === undefined) {
            this.#stats.skipped += 1;
            this.#record({
              compactionId: id,
              adapterKind: this.#adapter.kind,
              finishedAt: this.#now().toISOString(),
              ok: true,
              degraded: false,
              skipped: true,
              reason: 'compaction/start was not observed (plugin mounted mid-transaction)',
              checks: [],
              failures: [],
            }, null);
            return;
          }
          const report = verifyProtection({
            snapshot: state.snapshot,
            summaryEvent: state.summaryEvent,
            checkpointSeq: state.checkpointSeq,
            postSurfaceNodes: Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : null,
            adapterKind: this.#adapter.kind,
            manual: state.manual ?? null,
          });
          state.report = this.#record(report, state);
          // 保护校验中有“明确原因”的 skip（如 batch 只有关键字、没有数字比例）要留痕，便于回溯改判。
          const explainedSkips = report.checks.filter(
            (item) => item.status === 'skip' && typeof item.reason === 'string' && item.reason !== '',
          );
          if (explainedSkips.length > 0) {
            this.#auditEvent('protection-skip', {
              sessionId: state.sessionId,
              compactionId: id,
              manual: state.manual,
              count: explainedSkips.length,
              reason: explainedSkips[0].reason,
              names: explainedSkips.map((item) => item.name),
            });
          }
          if (state.manual === true) {
            const protectedFailures = report.failures
              .map((failure) => failure.name)
              .filter((name) => ['latest-user-message', 'batch-list', 'rollback-point', 'rule-injection'].includes(name));
            if (protectedFailures.length > 0) {
              this.#auditEvent('manual-compaction-loss', {
                sessionId: state.sessionId,
                compactionId: id,
                failures: protectedFailures,
                entries: state.entries?.length ?? 0,
              });
            }
          }
          this.#pending.delete(id);
          this.#completedCycles.add(id);
          this.#completedOrder.push(id);
          while (this.#completedOrder.length > 200) {
            this.#completedCycles.delete(this.#completedOrder.shift());
          }
          if (state.cost !== undefined) {
            state.cost.occurredAt = Number.isFinite(event?.time)
              ? new Date(event.time).toISOString()
              : this.#now().toISOString();
          }
          this.#scheduleReinjection(session, state);
          // T8-2/M1.2：回注 microtask 之后写成本记录（同一周期一条）。
          // tokenMeter 可用 → 立即写；不可用 → 等 compaction/end 后第一条
          // assistant/message 的 usage 补齐 tokensAfter；等不到则由 stop/新周期冲刷为 null + none。
          const sessionKey = this.#sessionKey(session);
          queueMicrotask(() => {
            try {
              const afterTokens = this.#measureTokens(session);
              if (afterTokens !== null) {
                state.cost.tokensAfter = afterTokens;
                state.cost.tokensAfterSource = 'tokenMeter';
                state.cost.tokensAfterParts = null;
                this.#writeCost(state, session);
              } else if (sessionKey === null) {
                state.cost.tokensAfterSource = 'none';
                this.#writeCost(state, session);
              } else {
                this.#pendingCosts.set(sessionKey, { state, session });
              }
            } catch (error) {
              this.#logger?.warn?.(`[context-governance] cost audit failed: ${String(error?.message ?? error)}`);
            }
          });
          return;
        }
        case 'turn/end': {
          // 到回合边界仍没有对应 compaction → 这些 prune 只进会话累计。
          this.#flushUnassignedOutside(session);
          return;
        }
        default:
      }
    } catch (error) {
      this.#stats.failures += 1;
      this.#logger?.warn?.(`[context-governance] compaction observer error: ${String(error?.message ?? error)}`);
    }
  }
}
