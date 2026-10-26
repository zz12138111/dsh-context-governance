/**
 * P3：每根 guard 池（单订阅、按根路由、生命周期）。
 *
 * 边界：
 * - 只做路由/生命周期；guard 构造、policy、early 由 `createGuard` 注入（index 生产、测试可替身）；
 * - 全局只持有一个 `session/event` 订阅；每个根的事件串行处理，A 抛错不阻断 B；
 * - 无根/unmanaged 不建 guard、不写 per-root 审计（3A）；fail-closed 根关闭已有 guard；
 * - `closeAll` 先停订阅，再逐根 dispose；idle 只关空 guard，pending 周期不关。
 */

export const DEFAULT_GUARD_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_GUARD_SWEEP_MS = 60 * 1000;
export const DEFAULT_GUARD_WARN = 16;
export const DEFAULT_START_WAIT_MS = 120 * 1000;

export class RootGuardPoolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RootGuardPoolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function sessionIdOf(session) {
  const id = session?.header?.id ?? session?.id ?? null;
  return typeof id === 'string' && id !== '' ? id : null;
}

export class RootGuardPool {
  #ctx;
  #registry;
  #storePool;
  #createGuard;
  #rootAudit;
  #logger;
  #now;
  #idleMs;
  #sweepMs;
  #warnThreshold;
  #startWaitMs;
  #guards = new Map();
  #opening = new Map();
  #queues = new Map();
  #subscription = null;
  #started = false;
  #closed = false;
  #timer = null;
  #warnedLimit = false;

  constructor({
    ctx,
    registry,
    storePool,
    createGuard,
    rootAudit = null,
    logger = null,
    now = () => new Date(),
    idleMs = DEFAULT_GUARD_IDLE_MS,
    sweepMs = DEFAULT_GUARD_SWEEP_MS,
    warnThreshold = DEFAULT_GUARD_WARN,
    startWaitMs = DEFAULT_START_WAIT_MS,
  } = {}) {
    if (registry === null || registry === undefined) {
      throw new RootGuardPoolError('NO_REGISTRY', 'RootGuardPool requires a root registry');
    }
    if (storePool === null || storePool === undefined) {
      throw new RootGuardPoolError('NO_STORE_POOL', 'RootGuardPool requires a root store pool');
    }
    if (typeof createGuard !== 'function') {
      throw new RootGuardPoolError('NO_GUARD_FACTORY', 'RootGuardPool requires createGuard(entry, resources)');
    }
    this.#ctx = ctx ?? {};
    this.#registry = registry;
    this.#storePool = storePool;
    this.#createGuard = createGuard;
    this.#rootAudit = rootAudit;
    this.#logger = logger ?? this.#ctx?.logger ?? null;
    this.#now = now;
    this.#idleMs = Math.max(Number(idleMs) || DEFAULT_GUARD_IDLE_MS, 1000);
    this.#sweepMs = Math.max(Number(sweepMs) || DEFAULT_GUARD_SWEEP_MS, 1000);
    this.#warnThreshold = Math.max(Number(warnThreshold) || DEFAULT_GUARD_WARN, 1);
    this.#startWaitMs = Math.max(Number(startWaitMs) || DEFAULT_START_WAIT_MS, 10);
    this.#timer = setInterval(() => { void this.closeIdle(); }, this.#sweepMs);
    this.#timer.unref?.();
  }

  get started() { return this.#started; }
  get closed() { return this.#closed; }
  get startWaitMs() { return this.#startWaitMs; }
  get idleMs() { return this.#idleMs; }
  get size() { return this.#guards.size; }

  #auditRoot(event, details) {
    try {
      this.#rootAudit?.append?.(event, details);
    } catch {
      /* 根审计失败不影响路由 */
    }
  }

  #auditRecord(record, event, details) {
    try {
      record?.audit?.append?.(event, details);
    } catch {
      /* per-root 审计失败不影响路由 */
    }
  }

  #checkLimit() {
    const count = this.#guards.size;
    if (count <= this.#warnThreshold || this.#warnedLimit) return;
    this.#warnedLimit = true;
    this.#auditRoot('root-guard-limit-warn', { count, threshold: this.#warnThreshold });
    this.#logger?.warn?.(
      `[context-governance] open root guards=${count} (threshold ${this.#warnThreshold}); ` +
      'continuing without a hard limit',
    );
  }

  #resolve(session) {
    try {
      const resolved = this.#registry.resolveSessionRoot(session);
      if (resolved === null || resolved === undefined) return null;
      return resolved;
    } catch (error) {
      this.#auditRoot('root-guard-error', {
        phase: 'resolve',
        sessionId: sessionIdOf(session),
        reason: String(error?.message ?? error).slice(0, 300),
      });
      return null;
    }
  }

  /** 只挂一个全局订阅；重复调用安全。 */
  start() {
    if (this.#closed || this.#started) return this;
    if (typeof this.#ctx?.on !== 'function') {
      this.#logger?.warn?.('[context-governance] ctx.on is unavailable; multi-root guard routing disabled');
      return this;
    }
    try {
      this.#subscription = this.#ctx.on('session/event', (session, event) => {
        this.route(session, event);
      });
      this.#started = true;
    } catch (error) {
      this.#logger?.warn?.(`[context-governance] root guard routing registration failed: ${String(error?.message ?? error)}`);
    }
    return this;
  }

  /** 路由入口：同步判定根，异步按根串行；宿主不等 Promise。 */
  route(session, event) {
    if (this.#closed || !this.#started) return;
    const resolved = this.#resolve(session);
    if (resolved === null || resolved.status !== 'managed' || resolved.entry === null) return;
    const entry = resolved.entry;
    if (entry.state !== 'active') {
      this.#enqueue(entry.rootId, () => this.dispose(entry.rootId, 'fail-closed'));
      return;
    }
    this.#enqueue(entry.rootId, async () => {
      if (this.#closed) return;
      const record = await this.#ensure(entry);
      if (record === null) return;
      record.lastUsed = this.#now();
      try {
        record.guard?.handleEvent?.(session, event);
      } catch (error) {
        record.lastError = String(error?.message ?? error).slice(0, 300);
        this.#auditRecord(record, 'root-guard-error', {
          phase: 'handle-event',
          root: entry.root,
          rootId: entry.rootId,
          sessionId: sessionIdOf(session),
          reason: record.lastError,
        });
        this.#logger?.warn?.(
          `[context-governance] root guard error (${entry.root}): ${String(error?.message ?? error)}`,
        );
        return;
      }
      if (event?.type === 'turn/end' && record.early !== null) {
        try {
          await record.early.check?.(session);
        } catch (error) {
          record.lastError = String(error?.message ?? error).slice(0, 300);
          this.#auditRecord(record, 'root-guard-error', {
            phase: 'early-check',
            root: entry.root,
            rootId: entry.rootId,
            sessionId: sessionIdOf(session),
            reason: record.lastError,
          });
          this.#logger?.warn?.(
            `[context-governance] root early check failed (${entry.root}): ${String(error?.message ?? error)}`,
          );
        }
      }
    });
  }

  #enqueue(rootId, task) {
    const previous = this.#queues.get(rootId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task).catch((error) => {
      this.#logger?.warn?.(
        `[context-governance] root guard task failed (${rootId}): ${String(error?.message ?? error)}`,
      );
    });
    this.#queues.set(rootId, next);
    void next.finally(() => {
      if (this.#queues.get(rootId) === next) this.#queues.delete(rootId);
    });
  }

  async #ensure(entry) {
    if (this.#closed) throw new RootGuardPoolError('POOL_CLOSED', 'root guard pool is closed');
    const existing = this.#guards.get(entry.rootId);
    if (existing !== undefined) return existing;
    const opening = this.#opening.get(entry.rootId);
    if (opening !== undefined) return opening;
    const task = (async () => {
      const handle = await this.#storePool.pin(entry);
      let built;
      try {
        built = await this.#createGuard(entry, {
          store: handle.store,
          audit: handle.audit,
          handle,
          pool: this,
          startWaitMs: this.#startWaitMs,
        });
      } catch (error) {
        try { handle.release?.(); } catch { /* ignore */ }
        throw error;
      }
      if (built === null || typeof built !== 'object' || built.guard === null || built.guard === undefined) {
        try { handle.release?.(); } catch { /* ignore */ }
        throw new RootGuardPoolError('NO_GUARD', `createGuard returned no guard for ${entry.root}`, {
          root: entry.root,
          rootId: entry.rootId,
        });
      }
      const record = {
        entry,
        guard: built.guard,
        policy: built.policy ?? null,
        early: built.early ?? null,
        dispose: typeof built.dispose === 'function' ? built.dispose : null,
        handle,
        audit: handle.audit,
        lastUsed: this.#now(),
        lastError: null,
      };
      this.#guards.set(entry.rootId, record);
      this.#checkLimit();
      this.#auditRecord(record, 'root-guard-created', {
        root: entry.root,
        rootId: entry.rootId,
        project: entry.project ?? null,
      });
      return record;
    })();
    this.#opening.set(entry.rootId, task);
    try {
      return await task;
    } finally {
      if (this.#opening.get(entry.rootId) === task) this.#opening.delete(entry.rootId);
    }
  }

  #recordForResolved(resolved) {
    if (resolved === null || resolved.status !== 'managed' || resolved.entry === null) return null;
    return this.#guards.get(resolved.entry.rootId) ?? null;
  }

  /** early/header/status 用：只读已存在 guard，不触发懒创建。 */
  recordForSession(session) {
    if (this.#closed) return null;
    return this.#recordForResolved(this.#resolve(session));
  }

  guardForSession(session) {
    return this.recordForSession(session)?.guard ?? null;
  }

  policyForSession(session) {
    return this.recordForSession(session)?.policy ?? null;
  }

  auditForSession(session) {
    return this.recordForSession(session)?.audit ?? null;
  }

  /** 供 header 等按根读 store；只取已打开 guard，不在这里开新 store。 */
  storeForSession(session) {
    return this.recordForSession(session)?.handle?.store ?? null;
  }

  recordForEntry(entry) {
    if (entry === null || entry === undefined) return null;
    return this.#guards.get(entry.rootId) ?? null;
  }

  async dispose(rootId, reason = 'dispose') {
    const record = this.#guards.get(rootId) ?? null;
    if (record === null) return false;
    this.#guards.delete(rootId);
    try {
      record.early?.stop?.();
    } catch (error) {
      this.#logger?.warn?.(`[context-governance] early stop failed (${rootId}): ${String(error?.message ?? error)}`);
    }
    try {
      if (record.dispose !== null) await record.dispose(reason);
      else if (typeof record.guard?.dispose === 'function') await record.guard.dispose(reason);
      else if (typeof record.guard?.stop === 'function') record.guard.stop();
    } catch (error) {
      this.#auditRecord(record, 'root-guard-error', {
        phase: 'dispose',
        root: record.entry.root,
        rootId,
        reason: String(error?.message ?? error).slice(0, 300),
      });
      this.#logger?.warn?.(`[context-governance] root guard dispose failed (${rootId}): ${String(error?.message ?? error)}`);
    }
    try {
      await record.handle?.release?.();
    } catch (error) {
      this.#logger?.warn?.(`[context-governance] root guard store release failed (${rootId}): ${String(error?.message ?? error)}`);
    }
    this.#auditRecord(record, 'root-guard-disposed', {
      root: record.entry.root,
      rootId,
      reason,
    });
    return true;
  }

  async closeIdle() {
    if (this.#closed) return 0;
    const now = this.#now().getTime();
    let closed = 0;
    for (const [rootId, record] of [...this.#guards.entries()]) {
      if (now - record.lastUsed.getTime() <= this.#idleMs) continue;
      const pending = Number(record.guard?.status?.stats?.pending) || 0;
      const earlyPending = record.early?.hasPending?.() === true;
      if (pending > 0 || earlyPending) continue;
      if (await this.dispose(rootId, 'idle')) closed += 1;
    }
    return closed;
  }

  /** 先停全局订阅，再逐根 dispose；单根失败不阻断其他根。 */
  async closeAll(reason = 'dispose') {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#subscription?.(); } catch { /* ignore */ }
    this.#subscription = null;
    this.#started = false;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const openings = [...this.#opening.values()];
    if (openings.length > 0) await Promise.allSettled(openings);
    for (const rootId of [...this.#guards.keys()]) {
      await this.dispose(rootId, reason);
    }
    this.#queues.clear();
    this.#opening.clear();
  }

  /** 供 `/cg status`；不含消息正文。 */
  stats() {
    const guards = [...this.#guards.values()].map((record) => ({
      root: record.entry.root,
      rootId: record.entry.rootId,
      project: record.entry.project ?? null,
      lastUsed: record.lastUsed.toISOString(),
      pending: Number(record.guard?.status?.stats?.pending) || 0,
      earlyPending: record.early?.hasPending?.() === true,
      lastError: record.lastError,
    }));
    return {
      started: this.#started,
      closed: this.#closed,
      count: guards.length,
      idleMs: this.#idleMs,
      startWaitMs: this.#startWaitMs,
      warned: this.#warnedLimit,
      guards,
    };
  }
}
