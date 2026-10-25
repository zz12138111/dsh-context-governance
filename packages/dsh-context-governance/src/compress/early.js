/**
 * 0.2.2 提前压执行骨架（DEC-20261025-79）——**只做判断/封装/失败处理，默认不执行**。
 *
 * 安全约束（G2 已确认）：
 * - `compactNow` 在非 idle 时抛 `ManualCompactionError('busy')`；
 * - 因此只在“turn 已结束 + agent idle”时调用，**turn 中不试探**；
 * - 执行开关默认关（`armed=false`），等真机窗口验过 safe timing 再打开。
 *
 * 本模块不订阅事件、不改 surface、不写记忆；调用方（未来 0.2.2 接线）负责提供
 * “turn 是否结束 / agent 是否 idle”这两个事实，本模块不猜。
 */

export const EARLY_SKIP_REASONS = Object.freeze({
  DISABLED: 'disabled',
  NOT_IDLE: 'not-idle',
  NO_ENGINE: 'no-engine',
  BUSY: 'busy',
  FAILED: 'failed',
});

/** G2：CompactNow 抛错形态识别（不依赖具体错误类，宿主可能跨包实例化）。
 *
 * G2-B 真机实测（2026-10-26）：宿主 busy 形态为
 * `ManualCompactionError: manual compaction requires an idle agent with no waking queued work`，
 * 且 `code` 可能为小写 `busy`。旧三条件（busy 文案 / `code==='BUSY'` / `not idle|busy`+compaction）
 * 全部不命中 → 会被误映射为 `failed`。这里补：
 * - `code` 大小写不敏感；
 * - `ManualCompactionError` 且 message 含 `idle`（命中 “requires an idle agent”）。
 */
export function isBusyCompactionError(error) {
  if (error === null || typeof error !== 'object') return false;
  const name = String(error.name ?? '');
  const code = String(error.code ?? '');
  const message = String(error.message ?? '');
  return (name === 'ManualCompactionError' && /busy/i.test(message))
    || (name === 'ManualCompactionError' && /\bidle\b/i.test(message))
    || code.toLowerCase() === 'busy'
    || (/not\s+idle|busy/i.test(message) && /compaction/i.test(message));
}

/**
 * 提前压执行器（骨架）。默认 armed=false → 任何调用都只返回 disabled，不触碰引擎。
 */
export class EarlyCompactor {
  #getEngine;
  #logger;
  #armed;

  constructor({ getEngine, logger = null, armed = false } = {}) {
    this.#getEngine = typeof getEngine === 'function' ? getEngine : () => null;
    this.#logger = logger;
    this.#armed = armed === true;
  }

  get armed() { return this.#armed; }

  /** 只有真机窗口验证过 safe timing 后才允许打开。 */
  arm() { this.#armed = true; }
  disarm() { this.#armed = false; }

  /**
   * 尝试一次提前压（**异步**：宿主 compactNow 返回 Promise，异步阶段的 busy/失败必须进 catch）。
   * @param {object} input
   * @param {object} [input.agent] 宿主 compactNow 第一参是 agent（不是 session）
   * @param {AbortSignal|null} [input.signal] 宿主第二参；由调用方持有/传入
   * @param {string|null} [input.sourceCommandId] 第三参（来源命令 id）
   * @param {boolean} input.turnEnded turn 是否已结束（事实，不是猜测）
   * @param {boolean} input.agentIdle agent 是否 idle（事实）
   * @returns {Promise<{accepted:boolean, reason?:string, error?:Error}>}
   */
  async attempt({ agent = null, signal = null, sourceCommandId = null, turnEnded = false, agentIdle = false } = {}) {
    if (!this.#armed) return { accepted: false, reason: EARLY_SKIP_REASONS.DISABLED };
    if (turnEnded !== true || agentIdle !== true) return { accepted: false, reason: EARLY_SKIP_REASONS.NOT_IDLE };
    const engine = this.#getEngine();
    if (engine === null || engine === undefined || typeof engine.compactNow !== 'function') {
      return { accepted: false, reason: EARLY_SKIP_REASONS.NO_ENGINE };
    }
    try {
      // G2：宿主 compactNow(agent, signal, sourceCommandId) → runMaintenance(...) 返回 Promise；
      // 必须 await，否则异步 rejected 逃出 catch（假 accepted + unhandled rejection）。
      await engine.compactNow(agent, signal, sourceCommandId);
      return { accepted: true };
    } catch (error) {
      if (isBusyCompactionError(error)) return { accepted: false, reason: EARLY_SKIP_REASONS.BUSY };
      this.#logger?.warn?.(`[context-governance] early compaction failed: ${String(error?.message ?? error)}`);
      return { accepted: false, reason: EARLY_SKIP_REASONS.FAILED, error };
    }
  }
}

/**
 * 0.2.2 升级判据（纯函数，供接线使用）：
 * - 只有 `compaction === 'failed'` 或 `reinjected === false` 才允许退避/关开关；
 * - `protection === 'failed'` **不升级**（保护项丢失但已回注时仍算可用）。
 *
 * @param {{compaction?: 'committed'|'skipped'|'failed', protection?: 'ok'|'failed', reinjected?: boolean}} [input]
 * @returns {boolean}
 */
export function shouldEscalateEarly({ compaction = 'committed', reinjected = true } = {}) {
  return compaction === 'failed' || reinjected === false;
}

/**
 * `tools/pre-execute` 的 ask/deny 语义（供未来动作校验/权限交互复用；本版不接线）。
 * 宿主约定：需要等待用户确认时返回 `{kind:'ask'}`；硬拒绝返回 `{kind:'deny'}`。
 */
export function preExecuteAsk(reason) {
  return { kind: 'ask', reason: String(reason ?? 'context-governance requires confirmation') };
}

export function preExecuteDeny(reason) {
  return { kind: 'deny', reason: String(reason ?? 'context-governance denied this call') };
}
