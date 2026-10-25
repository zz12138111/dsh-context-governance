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
  #reinjectionDisabled = false;
  #degradedReasons = [];
  #materializing = new Set();
  #writeDurations = [];
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
    this.#reinjection = {
      enabled: options.reinjection?.enabled !== false,
      maxLines: Math.min(Math.max(options.reinjection?.maxLines ?? 8, 1), 20),
      maxChars: Math.min(Math.max(options.reinjection?.maxChars ?? 800, 120), 4000),
    };
    this.#audit = options.audit ?? (this.#store === null
      ? null
      : new AuditLog({ file: path.join(this.#store.rootDir, 'audit.jsonl'), now: this.#now }));
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

  /** 开始订阅；重复调用安全。 */
  start() {
    if (this.#started) return this;
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
        enabled: this.#store !== null && this.#reinjection.enabled && !this.#reinjectionDisabled,
        storeRoot: this.#store?.rootDir ?? null,
        auditFile: this.#audit?.file ?? null,
        pendingJournals: this.#store?.protectionPending ?? 0,
        reinjectionDisabled: this.#reinjectionDisabled,
      },
      writeLatency: calculateLatencyStats(this.#writeDurations),
      stats: { ...this.#stats, pending: this.#pending.size, reports: this.#reports.length },
      lastReport: last === null ? null : cloneJson(last),
    };
  }

  /** 已完成的保护报告（最多 20 条，供 T5 审计）。 */
  reports() {
    return this.#reports.map((report) => cloneJson(report));
  }

  #auditEvent(event, details) {
    const ok = this.#audit?.append(event, details) ?? true;
    if (!ok) this.#logger?.warn?.(`[context-governance] audit write failed for ${event}`);
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

  #disableReinjection(reason) {
    this.#reinjectionDisabled = true;
    if (!this.#degradedReasons.includes(reason)) this.#degradedReasons.push(reason);
    this.#selection = {
      ...this.#selection,
      mode: 'observe-only',
      reasons: [...new Set([...this.#selection.reasons, reason])],
    };
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
    if (this.#reinjectionDisabled) {
      state.protectionWrite = 'skipped-observe-only';
      this.#auditEvent('protection-write-skipped', {
        sessionId: state.sessionId,
        compactionId: id,
        reason: 'reinjection-disabled',
      });
      return;
    }
    try {
      const built = buildProtectionItems(state.snapshot, {
        sessionId: state.sessionId ?? 'unknown',
        compactionId: id,
        cycleKey: id,
        manual: state.manual === true,
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
      this.#auditEvent('protection-write-failed', {
        sessionId: state.sessionId,
        compactionId: id,
        code: error?.code ?? 'PROTECTION_WRITE',
        reason: String(error?.message ?? error).slice(0, 300),
      });
      this.#logger?.warn?.(`[context-governance] protection write failed: ${String(error?.message ?? error)}`);
      this.#degradeProtection('protection-write-failed');
    }
  }

  /** 等待所有异步物化结束（测试/卸载用）。 */
  async flush() {
    while (this.#materializing.size > 0) {
      await Promise.allSettled([...this.#materializing]);
    }
  }

  #applySelection(next) {
    if (this.#reinjectionDisabled) {
      this.#selection = {
        ...next,
        mode: 'observe-only',
        reasons: [...new Set([...next.reasons, 'reinjection-failed'])],
      };
      return;
    }
    if (this.#selection.mode === 'degraded-protection') {
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
    if (this.#reinjectionDisabled) {
      state.reinjection = { status: 'skipped-observe-only' };
      return;
    }
    if (!Array.isArray(state.entries) || state.entries.length === 0) {
      state.reinjection = { status: 'skipped-no-entries' };
      this.#stats.reinjectionSkips += 1;
      this.#auditEvent('reinjection-skipped', {
        sessionId: state.sessionId,
        compactionId: state.compactionId,
        reason: 'no-protected-entries',
      });
      return;
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
      state.reinjection = { status: 'injected', seq: appended?.seq ?? null, lines: lines.length };
      this.#stats.reinjections += 1;
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
      this.#auditEvent('reinjection-failed', {
        sessionId: state.sessionId,
        compactionId: state.compactionId,
        reason: String(error?.message ?? error).slice(0, 300),
      });
      this.#logger?.warn?.(`[context-governance] reinjection failed: ${String(error?.message ?? error)}`);
      this.#disableReinjection('reinjection-failed');
      if (state.report !== undefined) state.report.reinjection = state.reinjection;
    }
  }

  #handle(session, event) {
    try {
      this.#stats.events += 1;
      const id = event?.data?.compactionId ?? null;
      switch (event?.type) {
        case 'compaction/start': {
          if (id === null) return;
          this.#stats.starts += 1;
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
          };
          this.#pending.set(id, state);
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
            };
            this.#pending.set(id, state);
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
          this.#scheduleReinjection(session, state);
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
