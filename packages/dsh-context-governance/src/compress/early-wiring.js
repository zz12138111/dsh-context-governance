/**
 * 0.2.2 第 5 步：提前压接线（`turn/end` 门禁 + `early-*` 审计）。
 *
 * 约束：
 * - `armed=false`（默认）时**不审计、不取 agent/engine、不调用**；打开 `armed` 是用户的单独批准项；
 * - 只在 `turn/end` 后 `EARLY_DELAY_MS` 检查一次（turn 中不试探，G2-B 已证 busy 路径）；
 * - 判定用 `decideEarly`（纯函数），本模块只负责取事实、审计与调用；
 * - `protection=failed` 不触发重试/关开关（由 `shouldEscalateEarly` 约束，接线后续批次使用）。
 */
import { computePressure } from '../policy.js';
import { EarlyCompactor } from './early.js';
import { EARLY_DECISION, decideEarly } from './early-gate.js';

export const EARLY_DELAY_MS = 50;
/** 冷却期：同一会话两次提前压至少间隔 10 分钟。 */
export const EARLY_COOLDOWN_MS = 10 * 60 * 1000;
/** 增量门槛：effective 至少上升 1 个百分点才再压。 */
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
 * @param {() => object|null} options.getPolicy 取 policy.resolve() 结果
 * @param {() => boolean} [options.getArmed] 执行开关；默认恒 false
 * @param {object|null} [options.audit] AuditLog
 * @param {object|null} [options.logger]
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => unknown} [options.schedule]
 * @param {number} [options.cooldownMs]
 * @param {number} [options.minDeltaRatio]
 * @returns {{stop: () => void, check: (session: object) => Promise<void>}}
 */
export function wireEarlyCompaction(options = {}) {
  const {
    ctx,
    getGuard = () => null,
    getPolicy = () => null,
    getArmed = () => false,
    audit = null,
    logger = null,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cooldownMs = EARLY_COOLDOWN_MS,
    minDeltaRatio = EARLY_MIN_DELTA_RATIO,
  } = options;

  const state = new Map();
  const timers = new Set();
  const armedNow = () => getArmed() === true;

  async function check(session) {
    // armed=false：完全静默（不审计、不取服务）——接线 ≠ 触发。
    if (!armedNow()) return;
    const policy = getPolicy();
    if (policy === null || policy === undefined || policy.early === false) return;

    const guard = getGuard();
    const pressureStatus = guard?.status?.pressure ?? {};
    const pressure = computePressure({
      measuredTokens: pressureStatus.measuredTokens ?? null,
      estimatedTokens: pressureStatus.estimatedTokens ?? null,
      windowTokens: policy.window?.currentTokens ?? null,
      estimateSafety: policy.values?.['compact.estimateSafety'],
    });
    const effective = pressure?.effective ?? null;
    const at = policy.values?.['compact.at'] ?? null;
    const native = policy.window?.native ?? policy.native ?? null;
    const agent = findAgent(ctx, session);
    const engine = agent === null ? null : engineFor(ctx, agent);
    const sessionId = session?.id ?? null;
    const previous = sessionId === null ? null : state.get(sessionId) ?? null;
    const nowMs = now();
    const cooldownOk = previous === null || nowMs - previous.at >= cooldownMs;
    const deltaOk = previous === null
      || !Number.isFinite(previous.effective) || !Number.isFinite(effective)
      || effective - previous.effective >= minDeltaRatio;
    const pending = Number.isFinite(guard?.status?.stats?.pending) ? guard.status.stats.pending : 0;

    const decision = decideEarly({
      armed: true,
      early: true,
      turnEnded: true,
      agentIdle: true,
      hasAgent: agent !== null,
      hasEngine: engine !== null,
      inProgress: pending > 0,
      cooldownOk,
      deltaOk,
      effective,
      at,
      native,
    });

    audit?.append?.('early-decision', {
      sessionId,
      action: decision.action,
      reason: decision.reason,
      effective,
      threshold: at,
      native,
    });

    if (decision.action !== EARLY_DECISION.FORCE) {
      audit?.append?.('early-skipped', { sessionId, reason: decision.reason, effective, threshold: at, native });
      return;
    }

    state.set(sessionId, { at: nowMs, effective });
    // 审核 §10-⑤：attempt 前取 prevReport；失败时没有新报告，绝不能抄上一轮。
    const prevReport = getGuard()?.status?.lastReport ?? null;
    const compactor = new EarlyCompactor({ getEngine: () => engine, armed: true, logger });
    const result = await compactor.attempt({
      agent,
      signal: new AbortController().signal,
      sourceCommandId: 'early-auto',
      // idle 是 turn/end 后的假设，不是测量；靠宿主 busy 拒绝兜底（G2-B），失败映射 early-aborted。
      turnEnded: true,
      agentIdle: true,
    });
    const report = getGuard()?.status?.lastReport ?? null;
    const fresh = result.accepted === true
      && report !== null
      && report.compactionId !== prevReport?.compactionId
      ? report
      : null;
    const fields = {
      sessionId,
      accepted: result.accepted === true,
      compaction: fresh?.compaction ?? (result.accepted === true ? 'committed' : 'failed'),
      protection: result.accepted === true ? (fresh?.protection ?? 'ok') : null,
      failures: result.accepted === true && Array.isArray(fresh?.failures)
        ? fresh.failures.map((failure) => failure.name)
        : [],
      reinjected: result.accepted === true ? (fresh?.reinjected ?? null) : null,
      reason: result.reason ?? null,
      delayMs: EARLY_DELAY_MS,
      effective,
      threshold: at,
      native,
    };
    if (result.accepted === true) audit?.append?.('early-forced', fields);
    else if (result.reason === 'busy') audit?.append?.('early-aborted', fields);
    else audit?.append?.('early-failed', fields);
  }

  const dispose = typeof ctx?.on === 'function'
    ? ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return;
      // 审核 §10-⑤ 附注：armed=false 时不排定时器（无服务/审计副作用，也不积 timers）。
      if (!armedNow()) return;
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
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (typeof dispose === 'function') dispose();
    },
  };
}
