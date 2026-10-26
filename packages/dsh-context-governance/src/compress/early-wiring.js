/**
 * 0.2.2 第 5 步：提前压接线（`turn/end` 门禁 + `early-*` 审计）。
 *
 * 约束：
 * - `armed=false`（默认）时**不审计、不取 agent/engine、不调用**；打开 `armed` 是用户的单独批准项；
 * - 只在 `turn/end` 后 `EARLY_DELAY_MS` 检查一次（turn 中不试探，G2-B 已证 busy 路径）；
 * - 判定用 `decideEarly`（纯函数），本模块只负责取事实、审计与调用；
 * - `protection=failed` 不触发重试/关开关（由 `shouldEscalateEarly` 约束，接线后续批次使用）。
 */
import { computePressure, shortSessionId } from '../policy.js';
import { SCOPE_SKIP } from '../scope.js';
import { EarlyCompactor } from './early.js';
import { EARLY_DECISION, decideEarly } from './early-gate.js';
import { EARLY_REPORT_WAIT_MS } from './runtime.js';

export const EARLY_DELAY_MS = 50;
/**
 * S1.1：`early-forced` 等待本 cycle 报告的上限。唯一数字定义点在 `runtime.js`（`waitForReport`
 * 的宿主），这里只引用并再导出，两处不得各自写字面量；超时仍写 unknown、不阻塞 turn。
 */
export { EARLY_REPORT_WAIT_MS };
/** 冷却期默认值（policy `compact.cooldownMin` 生效时按其分钟数换算）。 */
export const EARLY_COOLDOWN_MS = 10 * 60 * 1000;
/** 增量门槛默认值（policy `compact.minDeltaTokens` 生效时按窗口换算成比例）。 */
export const EARLY_MIN_DELTA_RATIO = 0.01;

function getOrNull(ctx, name) {
  try {
    return ctx.get(name) ?? null;
  } catch {
    return null;
  }
}

function findAgent(ctx, session) {
  const agents = getOrNull(ctx, 'agents');
  if (agents === null || typeof agents.list !== 'function') return null;
  const id = session?.id ?? null;
  try {
    const list = agents.list() ?? [];
    return list.find((agent) => agent?.session?.id === id) ?? null;
  } catch {
    return null;
  }
}

function engineFor(ctx, agent) {
  const presets = getOrNull(ctx, 'agentPresets');
  if (presets === null || typeof presets.serviceFor !== 'function') return null;
  try {
    const engine = presets.serviceFor(agent, 'compaction');
    return engine !== null && typeof engine.compactNow === 'function' ? engine : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.ctx 插件上下文（需要 `on`；服务用 `ctx.get`）
 * @param {() => object|null} options.getGuard 取 CompressionGuard
 * @param {(session?: object) => object|null} options.getPolicy 按会话取 policy.resolve() 结果
 * @param {(session?: object) => boolean} [options.getArmed] 按会话取执行开关；默认恒 false
 * @param {object|null} [options.audit] AuditLog
 * @param {object|null} [options.logger]
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => unknown} [options.schedule]
 * @param {number} [options.cooldownMs]
 * @param {number} [options.minDeltaRatio]
 * @param {number} [options.reportWaitMs] S1.1：等本 cycle 报告的上限（默认/最大均为 `EARLY_REPORT_WAIT_MS`）
 * @returns {{stop: () => void, check: (session: object) => Promise<void>}}
 */
export function wireEarlyCompaction(options = {}) {
  const {
    ctx,
    getGuard = () => null,
    getPolicy = () => null,
    getArmed = () => false,
    getScope = null,
    audit = null,
    getAudit = null,
    logger = null,
    onDecision = null,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    subscribe = true,
    cooldownMs: cooldownMsOption,
    minDeltaRatio: minDeltaRatioOption,
    reportWaitMs: reportWaitMsOption,
  } = options;
  const reportWaitMs = Number.isFinite(reportWaitMsOption)
    ? Math.min(EARLY_REPORT_WAIT_MS, Math.max(0, reportWaitMsOption))
    : EARLY_REPORT_WAIT_MS;

  const state = new Map();
  const timers = new Set();
  const armedNow = (session) => getArmed(session) === true;
  const guardNow = (session) => {
    try {
      return typeof getGuard === 'function' ? getGuard(session) : null;
    } catch {
      return null;
    }
  };
  const auditNow = (session) => {
    if (typeof getAudit === 'function') {
      try {
        return getAudit(session) ?? audit;
      } catch {
        return audit;
      }
    }
    return audit;
  };
  const explicitCooldown = Number.isFinite(cooldownMsOption) && cooldownMsOption >= 0;
  const explicitDelta = Number.isFinite(minDeltaRatioOption) && minDeltaRatioOption >= 0;
  let lastDecision = null;
  const record = (entry) => {
    lastDecision = entry;
    try {
      onDecision?.(entry);
    } catch {
      /* 观测回调失败不影响主流程 */
    }
  };

  async function check(session) {
    // armed=false：完全静默（不审计、不取服务）——接线 ≠ 触发。
    if (!armedNow(session)) return;
    const policy = getPolicy(session);
    if (policy === null || policy === undefined) return;
    const auditForSession = auditNow(session);
    const sessionId = session?.id ?? null;
    const at = policy.values?.['compact.at'] ?? null;
    const native = policy.window?.native ?? policy.native ?? null;
    const auditScopeSkip = (reason) => {
      auditForSession?.append?.('early-skipped', {
        sessionId,
        sessionShortId: sessionId === null ? null : shortSessionId(sessionId),
        reason,
        effective: null,
        threshold: at,
        native,
      });
      record({ event: 'early-skipped', reason, effective: null, time: new Date(now()).toISOString() });
    };
    // 1.0 #1（B-1）：归域判定必须在 armed/policy 之后、pressure 之前；
    // 否则外部会话会先落 unknown-pressure，foreign-session 无法区分。
    if (policy.early === false) {
      auditScopeSkip(SCOPE_SKIP.OUT_OF_SCOPE);
      return;
    }
    const scope = typeof getScope === 'function' ? getScope(session) : null;
    if (scope !== null && typeof scope === 'object' && typeof scope.skipReason === 'string' && scope.skipReason !== '') {
      auditScopeSkip(scope.skipReason);
      return;
    }

    const guard = guardNow(session);
    if (guard === null) {
      auditScopeSkip('guard-unavailable');
      return;
    }
    if (guard.status?.readOnly === true) {
      auditScopeSkip('read-only');
      return;
    }
    const pressureStatus = (typeof guard?.pressureFor === 'function'
      ? guard.pressureFor(session)
      : null) ?? guard?.status?.pressure ?? {};
    const pressure = computePressure({
      measuredTokens: pressureStatus.measuredTokens ?? null,
      estimatedTokens: pressureStatus.estimatedTokens ?? null,
      windowTokens: policy.window?.currentTokens ?? null,
      estimateSafety: policy.values?.['compact.estimateSafety'],
    });
    const effective = pressure?.effective ?? null;
    const agent = findAgent(ctx, session);
    const engine = agent === null ? null : engineFor(ctx, agent);
    const previous = sessionId === null ? null : state.get(sessionId) ?? null;
    const nowMs = now();
    // 1a/#3：cooldownMin / minDeltaTokens 从生效策略读取（不再只用常量）；显式选项优先（单测）。
    const cooldownMin = Number(policy.values?.['compact.cooldownMin']);
    const cooldownMs = explicitCooldown
      ? cooldownMsOption
      : (Number.isFinite(cooldownMin) && cooldownMin > 0 ? cooldownMin * 60000 : EARLY_COOLDOWN_MS);
    const windowTokens = Number(policy.window?.currentTokens ?? policy.window?.configTokens ?? 0);
    const minDeltaTokens = Number(policy.values?.['compact.minDeltaTokens']);
    const minDeltaRatio = explicitDelta
      ? minDeltaRatioOption
      : (Number.isFinite(minDeltaTokens) && minDeltaTokens >= 0 && windowTokens > 0
        ? minDeltaTokens / windowTokens
        : EARLY_MIN_DELTA_RATIO);
    const cooldownOk = previous === null || nowMs - previous.at >= cooldownMs;
    const deltaOk = previous === null
      || !Number.isFinite(previous.effective) || !Number.isFinite(effective)
      || effective - previous.effective >= minDeltaRatio;
    const pending = Number.isFinite(guard?.status?.stats?.pending) ? guard.status.stats.pending : 0;
    const earlyPending = typeof guard?.hasPendingEarly === 'function' && guard.hasPendingEarly() === true;

    const decision = decideEarly({
      armed: true,
      early: policy.early !== false,
      turnEnded: true,
      agentIdle: true,
      hasAgent: agent !== null,
      hasEngine: engine !== null,
      inProgress: pending > 0 || earlyPending,
      cooldownOk,
      deltaOk,
      effective,
      at,
      native,
    });

    auditForSession?.append?.('early-decision', {
      sessionId,
      action: decision.action,
      reason: decision.reason,
      effective,
      threshold: at,
      native,
    });

    if (decision.action !== EARLY_DECISION.FORCE) {
      auditForSession?.append?.('early-skipped', { sessionId, reason: decision.reason, effective, threshold: at, native });
      record({ event: 'early-skipped', reason: decision.reason, effective, time: new Date(nowMs).toISOString() });
      return;
    }

    // P3 门禁 7：preProtect 必须在 compactNow 之前；失败 → 不调用 compactNow。
    let preProtect = null;
    if (typeof guard?.preProtect === 'function') {
      try {
        preProtect = await guard.preProtect(session);
      } catch (error) {
        preProtect = { ok: false, reason: 'protection-prewrite-failed', error: String(error?.message ?? error) };
      }
      if (preProtect?.ok !== true) {
        auditForSession?.append?.('early-skipped', {
          sessionId,
          reason: 'protection-prewrite-failed',
          detail: preProtect?.reason ?? null,
          effective,
          threshold: at,
          native,
        });
        record({
          event: 'early-skipped',
          reason: 'protection-prewrite-failed',
          effective,
          time: new Date(nowMs).toISOString(),
        });
        return;
      }
    }
    state.set(sessionId, { at: nowMs, effective });
    // 审核 §10-⑤：attempt 前取 prevReport；失败时没有新报告，绝不能抄上一轮。
    const prevReport = guard?.status?.lastReport ?? null;
    const compactor = new EarlyCompactor({ getEngine: () => engine, armed: true, logger });
    const result = await compactor.attempt({
      agent,
      signal: new AbortController().signal,
      sourceCommandId: 'early-auto',
      // idle 是 turn/end 后的假设，不是测量；靠宿主 busy 拒绝兜底（G2-B），失败映射 early-aborted。
      turnEnded: true,
      agentIdle: true,
    });
    if (result.accepted === true && preProtect?.ok === true) {
      guard.markEarlyAccepted?.(preProtect.cycleKey);
    } else if (result.accepted !== true && preProtect?.ok === true) {
      await guard.discardEarlyProtection?.(preProtect.cycleKey, result.reason ?? 'not-accepted');
    }
    const cycleKey = preProtect?.ok === true && typeof preProtect.cycleKey === 'string'
      ? preProtect.cycleKey
      : null;
    let report = null;
    // S1.1：等待结论只用于诊断审计，不参与 accepted 判定、不增加 compactNow 调用。
    let waitOutcome = null;
    if (result.accepted === true) {
      try {
        // S1：有 guard 的 waitForReport 就等本 cycle 的完整报告；老 guard/旧测试无此方法时保留即时读取。
        if (typeof guard?.waitForReport === 'function') {
          const awaited = await guard.waitForReport({
            previousCompactionId: prevReport?.compactionId ?? null,
            sessionId,
            cycleKey,
            timeoutMs: reportWaitMs,
          });
          // S1.1：新形状 { ok, reason, report, waitedMs }；旧 guard/桩仍可能返回裸报告或 null。
          if (awaited !== null && typeof awaited === 'object' && typeof awaited.ok === 'boolean' && 'report' in awaited) {
            report = awaited.report ?? null;
            waitOutcome = {
              reason: awaited.reason ?? (report === null ? 'timeout' : 'none'),
              waitedMs: Number(awaited.waitedMs) || 0,
            };
          } else {
            report = awaited ?? null;
            waitOutcome = { reason: report === null ? 'timeout' : 'none', waitedMs: 0 };
          }
        } else {
          report = guard?.status?.lastReport ?? null;
          waitOutcome = { reason: 'none', waitedMs: 0 };
        }
      } catch (error) {
        // 等报告失败不能影响压缩结论/主流程；按无报告写 unknown。
        logger?.warn?.(`[context-governance] early report wait failed: ${String(error?.message ?? error)}`);
        report = null;
        // 只有该异常分支会写 'error'（不属于 waitForReport 的 timeout/mismatch/none 枚举）。
        waitOutcome = { reason: 'error', waitedMs: 0 };
      }
    }
    // 双保险：即使 guard 返回了别的会话/周期，也不能写进本会话的 early-forced。
    const sessionMatches = sessionId === null || report?.sessionId === sessionId;
    const cycleMatches = cycleKey === null || report?.cycle === cycleKey;
    const fresh = result.accepted === true
      && report !== null
      && report !== undefined
      && report.compactionId !== null
      && report.compactionId !== undefined
      && String(report.compactionId) !== ''
      && report.compactionId !== prevReport?.compactionId
      && sessionMatches
      && cycleMatches
      ? report
      : null;
    // S1.1：没等到（timeout/mismatch，或异常兜底 error）时留一条可诊断审计，只记 id/毫秒，不记正文。
    if (waitOutcome !== null && waitOutcome.reason !== 'none') {
      auditForSession?.append?.('early-report-wait', {
        sessionId,
        cycle: cycleKey,
        reason: waitOutcome.reason,
        waitedMs: Math.max(0, Math.round(Number(waitOutcome.waitedMs) || 0)),
      });
    }
    const fields = {
      sessionId,
      accepted: result.accepted === true,
      // B-2（1.0）：没有 fresh report 时不得写 committed（旧行为），写 unknown；
      // 只有拿到本轮新报告时才采用报告里的枚举。
      compaction: fresh === null ? (result.accepted === true ? 'unknown' : 'failed') : (fresh.compaction ?? 'unknown'),
      protection: result.accepted === true ? (fresh?.protection ?? null) : null,
      failures: result.accepted === true && Array.isArray(fresh?.failures)
        ? fresh.failures.map((failure) => failure.name)
        : [],
      reinjected: result.accepted === true ? (fresh?.reinjected ?? null) : null,
      compactionId: fresh?.compactionId ?? null,
      ...(preProtect?.ok === true ? { cycle: preProtect.cycleKey, phase: 'early-prewrite' } : {}),
      reason: result.reason ?? null,
      delayMs: EARLY_DELAY_MS,
      effective,
      threshold: at,
      native,
    };
    if (result.accepted === true) {
      auditForSession?.append?.('early-forced', fields);
      // T2 首触提示（不做弹窗）：logger 一行 info，只含数值/来源，不含正文。
      logger?.info?.(
        `[context-governance] early compaction forced effective=${Number(effective).toFixed(3)} ` +
        `threshold=${Number(at).toFixed(2)} compactionId=${String(fresh?.compactionId ?? '')} ` +
        `protection=${String(fields.protection ?? 'unknown')}`,
      );
    } else if (result.reason === 'busy') auditForSession?.append?.('early-aborted', fields);
    else auditForSession?.append?.('early-failed', fields);
    record({
      event: result.accepted === true ? 'early-forced' : (result.reason === 'busy' ? 'early-aborted' : 'early-failed'),
      reason: result.reason ?? null,
      accepted: result.accepted === true,
      effective,
      time: new Date(nowMs).toISOString(),
    });
  }

  const dispose = subscribe !== false && typeof ctx?.on === 'function'
    ? ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return;
      // 审核 §10-⑤ 附注：armed=false 时不排定时器（无服务/审计副作用，也不积 timers）。
      if (!armedNow(session)) return;
      const timer = schedule(() => {
        timers.delete(timer);
        void check(session).catch((error) => {
          logger?.warn?.(`[context-governance] early compaction check failed: ${String(error?.message ?? error)}`);
        });
      }, EARLY_DELAY_MS);
      timers.add(timer);
    })
    : () => {};

  return {
    check,
    getLast: () => lastDecision,
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (typeof dispose === 'function') dispose();
    },
  };
}
