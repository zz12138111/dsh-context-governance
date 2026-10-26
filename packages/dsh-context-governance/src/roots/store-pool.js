/**
 * P2：每根 memory store 池（懒打开、refCount、TTL、每根 audit、统一 close）。
 *
 * 只负责“记忆/审计/锁”的按根生命周期；不碰 P3 的保护/回注/header/提前压。
 */
import path from 'node:path';

import { AuditLog } from '../audit.js';
import { MemoryStore } from '../memory/store.js';
import { memoryRootFor } from './paths.js';

export const DEFAULT_STORE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_SWEEP_MS = 60 * 1000;
export const DEFAULT_POOL_WARN = 16;

export class RootStorePoolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RootStorePoolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class RootStorePool {
  #registry;
  #rootAudit;
  #logger;
  #now;
  #maxBytes;
  #ttlMs;
  #sweepMs;
  #warnThreshold;
  #entries = new Map();
  #opening = new Map();
  #warnedLimit = false;
  #disposed = false;
  #timer = null;

  constructor({
    registry,
    rootAudit = null,
    logger = null,
    now = () => new Date(),
    maxBytes = undefined,
    ttlMs = DEFAULT_STORE_TTL_MS,
    sweepMs = DEFAULT_SWEEP_MS,
    warnThreshold = DEFAULT_POOL_WARN,
  } = {}) {
    this.#registry = registry;
    this.#rootAudit = rootAudit;
    this.#logger = logger;
    this.#now = now;
    this.#maxBytes = maxBytes;
    this.#ttlMs = Math.max(Number(ttlMs) || DEFAULT_STORE_TTL_MS, 1000);
    this.#sweepMs = Math.max(Number(sweepMs) || DEFAULT_SWEEP_MS, 1000);
    this.#warnThreshold = Math.max(Number(warnThreshold) || DEFAULT_POOL_WARN, 1);
    this.#timer = setInterval(() => { void this.closeIdle(); }, this.#sweepMs);
    this.#timer.unref?.();
  }

  get disposed() { return this.#disposed; }

  #audit(event, details) {
    try {
      this.#rootAudit?.append?.(event, details);
    } catch {
      /* 根审计失败不影响池 */
    }
  }

  #checkLimit() {
    const count = this.#entries.size;
    if (count <= this.#warnThreshold || this.#warnedLimit) return;
    this.#warnedLimit = true;
    this.#audit('memory-store-pool-warn', { count, threshold: this.#warnThreshold });
    this.#logger?.warn?.(
      `[context-governance] open memory stores=${count} (threshold ${this.#warnThreshold}); ` +
      'continuing without a hard limit',
    );
  }

  /** 主根 store 由 index 先打开并 seed；pinned 不参与 TTL，dispose 时统一 close。 */
  seed(entry, store, audit) {
    if (!entry || typeof entry.rootId !== 'string' || entry.rootId === '') return null;
    const record = {
      entry,
      store,
      audit,
      refs: 1,
      lastUsed: this.#now(),
      pinned: true,
      readOnlyReason: store?.status?.readOnlyReason ?? null,
    };
    this.#entries.set(entry.rootId, record);
    this.#checkLimit();
    return record;
  }

  #handle(key, record) {
    return {
      entry: record.entry,
      store: record.store,
      audit: record.audit,
      release: () => this.release(key),
    };
  }

  async #open(entry) {
    const memory = memoryRootFor(entry.root);
    if (memory.ok !== true) {
      this.#registry?.failClosed?.(entry.rootId, memory.reason);
      this.#audit('memory-store-open-failed', {
        root: entry.root,
        rootId: entry.rootId,
        reason: memory.reason,
      });
      throw new RootStorePoolError('ROOT_FAIL_CLOSED', `root ${entry.root} fail-closed: ${memory.reason}`, {
        reason: memory.reason,
        root: entry.root,
        rootId: entry.rootId,
      });
    }
    let store;
    try {
      store = await MemoryStore.open({ rootDir: memory.memoryRoot, project: entry.project });
    } catch (error) {
      this.#audit('memory-store-open-failed', {
        root: entry.root,
        rootId: entry.rootId,
        reason: String(error?.message ?? error).slice(0, 200),
      });
      throw new RootStorePoolError('ROOT_UNAVAILABLE', `memory store open failed: ${error?.message ?? error}`, {
        root: entry.root,
        rootId: entry.rootId,
        reason: 'store-open-failed',
      });
    }
    let audit;
    try {
      audit = new AuditLog({
        file: path.join(memory.memoryRoot, 'audit.jsonl'),
        allowedBase: memory.memoryRoot,
        ...(Number.isFinite(this.#maxBytes) ? { maxBytes: this.#maxBytes } : {}),
      });
    } catch (error) {
      await store.close().catch(() => {});
      this.#audit('memory-store-open-failed', {
        root: entry.root,
        rootId: entry.rootId,
        reason: 'audit-path-rejected',
      });
      throw new RootStorePoolError('ROOT_UNAVAILABLE', `per-root audit rejected: ${error?.message ?? error}`, {
        root: entry.root,
        rootId: entry.rootId,
        reason: 'audit-path-rejected',
      });
    }
    const record = {
      entry,
      store,
      audit,
      refs: 0,
      lastUsed: this.#now(),
      pinned: false,
      readOnlyReason: store.status.readOnlyReason ?? null,
    };
    this.#entries.set(entry.rootId, record);
    this.#checkLimit();
    this.#audit('memory-store-open', {
      root: entry.root,
      rootId: entry.rootId,
      count: this.#entries.size,
    });
    if (record.readOnlyReason !== null) {
      this.#audit('memory-store-readonly', {
        root: entry.root,
        rootId: entry.rootId,
        reason: record.readOnlyReason,
      });
    }
    return record;
  }

  /**
   * 懒打开并 refs+1；调用方必须 release()。
   * @returns {Promise<{entry:object, store:MemoryStore, audit:AuditLog, release:()=>void}>}
   */
  async get(entry) {
    if (this.#disposed) {
      throw new RootStorePoolError('ROOT_UNAVAILABLE', 'store pool is disposed', { reason: 'disposed' });
    }
    if (entry === null || entry === undefined || typeof entry.rootId !== 'string' || entry.rootId === '') {
      throw new RootStorePoolError('NO_ROOT', 'session root is unavailable', { reason: 'no-root' });
    }
    if (entry.state !== 'active') {
      throw new RootStorePoolError('ROOT_FAIL_CLOSED', `root ${entry.root} is ${entry.state}`, {
        reason: entry.failClosedReason ?? entry.state,
        root: entry.root,
        rootId: entry.rootId,
      });
    }
    const key = entry.rootId;
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      existing.refs += 1;
      existing.lastUsed = this.#now();
      return this.#handle(key, existing);
    }
    if (this.#opening.has(key)) {
      await this.#opening.get(key).catch(() => {});
      return this.get(entry);
    }
    const opening = this.#open(entry);
    this.#opening.set(key, opening);
    let record;
    try {
      record = await opening;
    } finally {
      this.#opening.delete(key);
    }
    record.refs += 1;
    record.lastUsed = this.#now();
    return this.#handle(key, record);
  }

  /**
   * P3：guard 生命周期 pin。`get` 的 refs 保持到 release；pinned 期间 TTL 不关。
   * seed 记录本来 pinned=true，release 只恢复调用前的 pinned 状态，不把主根 seed 解 pin。
   * @returns {Promise<{entry,store,audit,release:()=>void}>}
   */
  async pin(entry) {
    const handle = await this.get(entry);
    const key = handle.entry.rootId;
    const record = this.#entries.get(key);
    if (record === undefined) return handle;
    const wasPinned = record.pinned;
    record.pinned = true;
    let released = false;
    return {
      ...handle,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#entries.get(key);
        if (current !== undefined) current.pinned = wasPinned;
        this.release(key);
      },
    };
  }

  release(rootId) {
    const record = this.#entries.get(rootId);
    if (record === undefined) return;
    record.refs = Math.max(0, record.refs - 1);
    record.lastUsed = this.#now();
  }

  async #closeRecord(key, reason) {
    const record = this.#entries.get(key);
    if (record === undefined) return false;
    this.#entries.delete(key);
    try {
      await record.store.close();
    } catch (error) {
      this.#logger?.warn?.(`[context-governance] memory store close failed (${key}): ${String(error?.message ?? error)}`);
    }
    try {
      record.audit?.close?.();
    } catch {
      /* ignore */
    }
    this.#audit('memory-store-close', {
      root: record.entry.root,
      rootId: record.entry.rootId,
      reason,
      count: this.#entries.size,
    });
    return true;
  }

  /** TTL 清理：只关 refs=0 且非 pinned 的 entry；不抛错。 */
  async closeIdle() {
    if (this.#disposed) return 0;
    const now = this.#now().getTime();
    let closed = 0;
    for (const [key, record] of [...this.#entries.entries()]) {
      if (record.pinned || record.refs > 0) continue;
      if (now - record.lastUsed.getTime() <= this.#ttlMs) continue;
      if (await this.#closeRecord(key, 'ttl')) closed += 1;
    }
    return closed;
  }

  /** dispose：清 timer，按 dispose 关闭全部（含 pinned），失败只 logger。 */
  async closeAll(reason = 'dispose') {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const keys = [...this.#entries.keys()];
    for (const key of keys) await this.#closeRecord(key, reason);
    this.#opening.clear();
  }

  stats() {
    const entries = [...this.#entries.values()];
    return {
      open: entries.length,
      refs: entries.reduce((sum, record) => sum + record.refs, 0),
      idle: entries.filter((record) => record.refs === 0 && !record.pinned).length,
      pinned: entries.filter((record) => record.pinned).length,
      warned: this.#warnedLimit,
      disposed: this.#disposed,
    };
  }
}
