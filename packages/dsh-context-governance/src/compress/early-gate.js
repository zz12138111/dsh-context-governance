/**
 * 0.2.2 第 5 步：`turn/end` 门禁（纯函数，只判断、不触发）。
 *
 * 接线方在 `turn/end` 后调用本函数；`armed=false`（默认）时永远返回 `skip(not-armed)`，
 * 打开 `armed` 是用户的单独批准项，不在接线本轮。
 *
 * 判定顺序（先便宜后昂贵、先硬条件后压力）：
 *   policy 关闭 → 未 armed → turn 未结束/非 idle → 进行中压缩 → 无 agent/engine
 *   → 冷却/增量 → 压力未知 → 低于 at → 接近 native（不抢宿主）→ force
 */

export const EARLY_DECISION = Object.freeze({ FORCE: 'force', SKIP: 'skip' });

export const EARLY_SKIP = Object.freeze({
  DISABLED: 'disabled',
  NOT_ARMED: 'not-armed',
  TURN_IN_PROGRESS: 'turn-in-progress',
  NOT_IDLE: 'not-idle',
  IN_PROGRESS: 'compaction-in-progress',
  NO_AGENT: 'no-agent',
  NO_ENGINE: 'no-engine',
  COOLDOWN: 'cooldown',
  MIN_DELTA: 'min-delta',
  UNKNOWN_PRESSURE: 'unknown-pressure',
  BELOW_THRESHOLD: 'below-threshold',
  NEAR_NATIVE: 'near-native',
});

/** 距 native 这个范围内不抢宿主（G2 口径：effective ≥ native−0.02 不抢）。 */
export const EARLY_NEAR_NATIVE_MARGIN = 0.02;

/**
 * @param {object} input
 * @param {boolean} [input.armed] 执行开关（默认 false）
 * @param {boolean} [input.early] policy `compact.early`（默认 true；research profile 为 false）
 * @param {boolean} [input.turnEnded] turn 是否已结束（事实）
 * @param {boolean} [input.agentIdle] agent 是否 idle（事实）
 * @param {boolean} [input.hasAgent] 能取到 agent 句柄
 * @param {boolean} [input.hasEngine] 能取到 preset compaction 引擎
 * @param {boolean} [input.inProgress] 当前是否有进行中的压缩周期
 * @param {boolean} [input.cooldownOk] 冷却期已过
 * @param {boolean} [input.deltaOk] 增量达到阈值
 * @param {number|null} [input.effective] 压力 effective（0..1）
 * @param {number|null} [input.at] 生效阈值 `compact.at`
 * @param {number|null} [input.native] 宿主 native 阈值（0..1）
 * @returns {{action: 'force'|'skip', reason: string}}
 */
export function decideEarly(input = {}) {
  const {
    armed = false,
    early = true,
    turnEnded = false,
    agentIdle = false,
    hasAgent = false,
    hasEngine = false,
    inProgress = false,
    cooldownOk = true,
    deltaOk = true,
    effective = null,
    at = null,
    native = null,
  } = input;

  if (!early) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.DISABLED };
  if (!armed) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NOT_ARMED };
  if (!turnEnded) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.TURN_IN_PROGRESS };
  if (!agentIdle) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NOT_IDLE };
  if (inProgress) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.IN_PROGRESS };
  if (!hasAgent) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NO_AGENT };
  if (!hasEngine) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NO_ENGINE };
  if (!cooldownOk) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.COOLDOWN };
  if (!deltaOk) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.MIN_DELTA };
  if (!Number.isFinite(effective) || !Number.isFinite(at)) {
    return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.UNKNOWN_PRESSURE };
  }
  if (effective < at) return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.BELOW_THRESHOLD };
  if (Number.isFinite(native) && effective >= native - EARLY_NEAR_NATIVE_MARGIN) {
    return { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NEAR_NATIVE };
  }
  return { action: EARLY_DECISION.FORCE, reason: 'forced' };
}
