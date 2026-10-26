/**
 * 多根 registry（P1 / 需求「多根通用性」1–4、7、9、10）。
 *
 * 硬约束：
 * - **根发现只来自会话**：`session/event` 喂 cwd / 父会话；不 readdir、不枚举盘符/工作区、不启动扫描；
 * - 根集合 = 已出现会话的根并集；state 里的 roots 是“曾出现根”，本进程区分 active/idle；
 * - 会话根一旦 pin 不随中途 cd 切换；子会话继承父根（父根已知时）；
 * - 根标识 = `rootId`（路径 hash）；`name`/`project` 只做展示；
 * - 不设硬上限：>16 只 `root-limit-warn`，照常登记。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT_ID_HEX_LENGTHS,
  cwdWithinRoot,
  inferRootFromCwd,
  normalizeRootPath,
  rootIdOf,
  samePath,
} from './identity.js';
import { MEMORY_ROOT_REL } from './paths.js';
import {
  emptyV2State,
  loadStateV2,
  makeV2Entry,
  persistPrimaryV2,
  sessionCwd,
  writeStateV2Merged,
} from '../root-state.js';

export const ROOT_WARN_THRESHOLD = 16;
export const DEFAULT_PIN_LIMIT = 1000;
const LAST_SEEN_PERSIST_MS = 60 * 60 * 1000;
const AUDIT_TAIL_BYTES = 4096;

function isSubagentSession(session) {
  const header = session?.header;
  if (header === null || typeof header !== 'object') return false;
  return header.origin === 'subagent' || header.parentSession !== undefined;
}

function sessionIdOf(session) {
  const header = session?.header;
  if (header !== null && typeof header === 'object' && typeof header.id === 'string' && header.id !== '') return header.id;
  if (typeof session?.id === 'string' && session.id !== '') return session.id;
  return null;
}

function parentSessionIdOf(session) {
  const header = session?.header;
  if (header !== null && typeof header === 'object' && typeof header.parentSession === 'string' && header.parentSession !== '') {
    return header.parentSession;
  }
  return null;
}

function sortedEntries(state) {
  const entries = Object.values(state.roots);
  return entries.sort((left, right) => (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? '')
    || left.rootId.localeCompare(right.rootId));
}

function readMemoryCount(root) {
  const file = path.join(root, MEMORY_ROOT_REL, 'MEMORY.md');
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter((line) => /^- MEM-/.test(line)).length;
  } catch {
    return null;
  }
}

function readAuditLast(root) {
  const file = path.join(root, MEMORY_ROOT_REL, 'audit.jsonl');
  let fd;
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return null;
    const length = Math.min(stat.size, AUDIT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) return null;
    const record = JSON.parse(lines[lines.length - 1]);
    if (record === null || typeof record !== 'object') return null;
    return {
      ts: typeof record.ts === 'string' ? record.ts : null,
      event: typeof record.event === 'string' ? record.event : null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export class RootRegistry {
  #stateFile;
  #state;
  #loaded;
  #rootAudit;
  #configRoot;
  #project;
  #profile;
  #home;
  #now;
  #logger;
  #hashFn;
  #pinLimit;
  #pins = new Map();
  #seen = new Set();
  #loadedIds = new Set();
  #attachRootId = null;
  #writable;
  #lastPersistAt = 0;
  #warnedLimit = false;
  #driftWarned = new Set();

  constructor({
    stateFile,
    state,
    loaded = null,
    rootAudit = null,
    configRoot = null,
    project = null,
    profile = null,
    home = null,
    now = () => new Date(),
    logger = null,
    hashFn = undefined,
    pinLimit = DEFAULT_PIN_LIMIT,
  } = {}) {
    this.#stateFile = typeof stateFile === 'string' ? path.resolve(stateFile) : null;
    this.#state = state ?? emptyV2State(null);
    this.#loaded = loaded;
    this.#rootAudit = rootAudit;
    this.#configRoot = normalizeRootPath(configRoot);
    this.#project = typeof project === 'string' && project.trim() !== '' ? project.trim() : null;
    this.#profile = typeof profile === 'string' && profile !== '' ? profile : null;
    this.#home = typeof home === 'string' && home.trim() !== '' ? path.resolve(home) : null;
    this.#now = now;
    this.#logger = logger;
    this.#hashFn = hashFn;
    this.#pinLimit = Math.max(Number(pinLimit) || DEFAULT_PIN_LIMIT, 1);
    this.#loadedIds = new Set(Object.keys(this.#state.roots));
    this.#attachRootId = this.#state.primaryRootId;
    this.#writable = loaded === null || loaded.writable !== false;
  }

  static load(options = {}) {
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const loaded = loadStateV2(options.stateFile, {
      now: now(),
      profile: options.profile ?? null,
      repair: options.repair !== false,
      hashFn: options.hashFn,
    });
    return new RootRegistry({ ...options, state: loaded.state, loaded, now });
  }

  get stateFile() { return this.#stateFile; }
  get state() { return this.#state; }
  get writable() { return this.#writable; }
  get loaded() { return this.#loaded; }
  get pinCount() { return this.#pins.size; }
  get primary() {
    const id = this.#state.primaryRootId;
    return id === null ? null : (this.#state.roots[id] ?? null);
  }

  /** P1 挂载根（config 覆盖或持久化主根）；不等于持久化 primaryRootId。 */
  get attach() {
    const id = this.#attachRootId ?? this.#state.primaryRootId;
    return id === null ? null : (this.#state.roots[id] ?? null);
  }

  #audit(event, details) {
    try {
      this.#rootAudit?.append?.(event, details);
    } catch {
      /* 根审计失败不影响登记 */
    }
  }

  #isManaged(entry) {
    if (entry === null || entry.state !== 'active') return false;
    return entry.rootId === (this.#attachRootId ?? this.#state.primaryRootId);
  }

  #pin(sid, entry, source) {
    if (sid === null) return;
    this.#pins.delete(sid);
    this.#pins.set(sid, { entry, source });
    if (this.#pins.size > this.#pinLimit) {
      const oldest = this.#pins.keys().next().value;
      if (oldest !== undefined) this.#pins.delete(oldest);
    }
  }

  /** 根登记；返回 {entry, created, source}。不扫描磁盘。 */
  ensureRoot(candidate, { cwd = '', origin = 'inferred' } = {}) {
    const canonical = normalizeRootPath(candidate);
    if (canonical === null) return null;
    let length = ROOT_ID_HEX_LENGTHS[0];
    let rootId = rootIdOf(canonical, { length, hashFn: this.#hashFn });
    let guard = 0;
    while (rootId !== '' && this.#state.roots[rootId] !== undefined
      && !samePath(this.#state.roots[rootId].root, canonical)) {
      guard += 1;
      this.#audit('root-id-collision', { root: canonical, rootId, reason: 'path-hash-prefix-collision' });
      const index = ROOT_ID_HEX_LENGTHS.indexOf(length);
      if (index < 0 || index === ROOT_ID_HEX_LENGTHS.length - 1 || guard > ROOT_ID_HEX_LENGTHS.length) {
        this.#logger?.warn?.(`[context-governance] root id collision unresolved for ${canonical}`);
        return null;
      }
      length = ROOT_ID_HEX_LENGTHS[index + 1];
      rootId = rootIdOf(canonical, { length, hashFn: this.#hashFn });
    }
    if (rootId === '') return null;
    const isConfig = this.#configRoot !== null && samePath(canonical, this.#configRoot);
    const existing = this.#state.roots[rootId];
    const source = isConfig ? 'config' : (existing !== undefined && this.#loadedIds.has(rootId) ? 'persisted' : 'inferred');
    this.#seen.add(rootId);
    if (existing !== undefined) {
      if (typeof existing.lastSeenAt !== 'string' || existing.lastSeenAt < this.#now().toISOString()) {
        existing.lastSeenAt = this.#now().toISOString();
      }
      this.#persist(false);
      return { entry: existing, created: false, source };
    }
    const entry = makeV2Entry({
      root: canonical,
      origin: isConfig ? 'config' : (origin === 'config' ? 'config' : 'inferred'),
      inferredAt: isConfig || origin === 'config' ? null : this.#now().toISOString(),
      inferredFromCwd: isConfig || origin === 'config' ? null : cwd,
      project: isConfig ? this.#project : null,
      hashFn: this.#hashFn,
      now: this.#now(),
    });
    if (entry === null) return null;
    entry.rootId = rootId;
    this.#state.roots[rootId] = entry;
    this.#persist(true);
    this.#audit('root-registered', {
      root: entry.root,
      rootId: entry.rootId,
      source: entry.origin,
      inferredFromCwd: entry.inferredFromCwd,
      rootCount: Object.keys(this.#state.roots).length,
    });
    this.#checkLimit();
    return { entry, created: true, source };
  }

  /**
   * P1 挂载根：登记（config 根/持久化根）但**不**改持久化 primaryRootId；
   * `primaryRootId` 只由首次推断（claimPrimary）确定，作为 config 移除后的回落锚点。
   */
  setAttachRoot(candidate, { origin = 'persisted' } = {}) {
    const ensured = this.ensureRoot(candidate, { origin: origin === 'config' ? 'config' : 'inferred' });
    if (ensured === null) return null;
    this.#attachRootId = ensured.entry.rootId;
    return ensured.entry;
  }

  /** 写 configRoot 镜像（只审计/展示，不参与根选择）；null = 清掉。 */
  noteConfigRoot(candidate) {
    const normalized = normalizeRootPath(candidate);
    if (normalized === null) {
      if (this.#state.configRoot !== null) {
        this.#state.configRoot = null;
        this.#persist(true);
      }
      return;
    }
    if (!samePath(normalized, this.#state.configRoot ?? '')) {
      this.#state.configRoot = normalized;
      this.#persist(true);
    }
  }

  /** 登记并设为主根（首次推断；落盘 primaryRootId + attach）。 */
  claimPrimary(candidate, { origin = 'inferred', inferredFromCwd = null } = {}) {
    // 首次推断：状态文件不存在时用 link 独占发布（两进程只有一方建文件）。
    if (this.#stateFile !== null && this.#state.roots === undefined) return null;
    if (this.#stateFile !== null && Object.keys(this.#state.roots).length === 0
      && !fs.existsSync(this.#stateFile)) {
      const published = persistPrimaryV2(this.#stateFile, {
        root: candidate,
        profile: this.#profile,
        inferredFromCwd,
        hashFn: this.#hashFn,
        now: this.#now(),
      });
      if (published.ok && published.state !== null) {
        if (published.existed) {
          this.#state = published.state;
          this.#loadedIds = new Set(Object.keys(this.#state.roots));
          this.#attachRootId = this.#state.primaryRootId;
          const primary = this.primary;
          if (primary !== null) this.#seen.add(primary.rootId);
          return primary;
        }
        this.#state = published.state;
        this.#loadedIds = new Set();
        this.#attachRootId = published.state.primaryRootId;
        const entry = this.#state.roots[published.state.primaryRootId];
        if (entry === undefined) return null;
        this.#seen.add(entry.rootId);
        this.#audit('root-registered', {
          root: entry.root,
          rootId: entry.rootId,
          source: entry.origin,
          inferredFromCwd: entry.inferredFromCwd,
          rootCount: 1,
        });
        this.#lastPersistAt = this.#now().getTime();
        return entry;
      }
    }
    const ensured = this.ensureRoot(candidate, { cwd: inferredFromCwd, origin });
    if (ensured === null || ensured.entry.state === 'fail-closed') return null;
    this.#attachRootId = ensured.entry.rootId;
    if (this.#state.primaryRootId !== ensured.entry.rootId) {
      this.#state.primaryRootId = ensured.entry.rootId;
      this.#state.primaryRoot = ensured.entry.root;
      this.#persist(true);
    }
    return ensured.entry;
  }

  failClosed(rootId, reason) {
    const entry = this.#state.roots[rootId];
    if (entry === undefined) return false;
    entry.state = 'fail-closed';
    entry.failClosedReason = String(reason ?? 'unknown');
    this.#persist(true);
    this.#audit('root-fail-closed', {
      root: entry.root,
      rootId: entry.rootId,
      reason: entry.failClosedReason,
      target: path.join(entry.root, MEMORY_ROOT_REL),
    });
    return true;
  }

  /**
   * 唯一会话→根入口。
   * @returns {{status:'managed'|'unmanaged'|'no-root', entry:object|null,
   *   source:'config'|'persisted'|'inferred'|'parent'|null, isSubagent:boolean,
   *   cwd:string, reason?:string, drift?:{from:string,cwd:string}|null}}
   */
  resolveSessionRoot(session) {
    const sid = sessionIdOf(session);
    const cwd = sessionCwd(session);
    const isSubagent = isSubagentSession(session);
    const pinned = sid === null ? null : this.#pins.get(sid);
    if (pinned !== undefined) {
      let drift = null;
      if (cwd !== '' && !cwdWithinRoot(cwd, pinned.entry.root)) {
        drift = { from: pinned.entry.root, cwd };
        const key = `${sid}|${pinned.entry.root}|${cwd}`;
        if (!this.#driftWarned.has(key)) {
          this.#driftWarned.add(key);
          this.#logger?.warn?.(
            `[context-governance] session ${sid} cwd changed outside its pinned root; keeping root ` +
            `${pinned.entry.root} (cwd=${cwd})`,
          );
        }
      }
      return {
        status: this.#isManaged(pinned.entry) ? 'managed' : 'unmanaged',
        entry: pinned.entry,
        source: pinned.source,
        isSubagent,
        cwd,
        drift,
      };
    }
    if (isSubagent) {
      const parentId = parentSessionIdOf(session);
      const parentPin = parentId === null || parentId === sid ? undefined : this.#pins.get(parentId);
      if (parentPin !== undefined) {
        this.#pin(sid, parentPin.entry, 'parent');
        return {
          status: this.#isManaged(parentPin.entry) ? 'managed' : 'unmanaged',
          entry: parentPin.entry,
          source: 'parent',
          isSubagent: true,
          cwd,
          drift: null,
        };
      }
    }
    if (cwd === '') {
      return { status: 'no-root', entry: null, source: null, isSubagent, cwd, reason: 'cwd-missing' };
    }
    const root = inferRootFromCwd(cwd, { exclude: this.#home });
    if (root === null) {
      return { status: 'no-root', entry: null, source: null, isSubagent, cwd, reason: 'no-git-ancestor' };
    }
    const ensured = this.ensureRoot(root, { cwd, origin: 'inferred' });
    if (ensured === null) {
      return { status: 'no-root', entry: null, source: null, isSubagent, cwd, reason: 'root-invalid' };
    }
    this.#pin(sid, ensured.entry, ensured.source);
    return {
      status: this.#isManaged(ensured.entry) ? 'managed' : 'unmanaged',
      entry: ensured.entry,
      source: ensured.source,
      isSubagent,
      cwd,
      drift: null,
    };
  }

  list() {
    return sortedEntries(this.#state).map((entry) => ({ ...entry }));
  }

  counts() {
    const entries = Object.values(this.#state.roots);
    let active = 0;
    let failClosed = 0;
    for (const entry of entries) {
      if (entry.state === 'fail-closed') failClosed += 1;
      else if (this.#seen.has(entry.rootId)) active += 1;
    }
    return {
      roots: entries.length,
      active,
      idle: entries.length - active - failClosed,
      failClosed,
      warn: entries.length > ROOT_WARN_THRESHOLD,
    };
  }

  /** 根集合视图（只读；不 mkdir/不开 store）。 */
  view() {
    const entries = sortedEntries(this.#state);
    const primaryId = this.#state.primaryRootId;
    entries.sort((left, right) => {
      if (left.rootId === primaryId) return -1;
      if (right.rootId === primaryId) return 1;
      const rank = (entry) => (entry.state === 'fail-closed' ? 2 : (this.#seen.has(entry.rootId) ? 0 : 1));
      const delta = rank(left) - rank(right);
      if (delta !== 0) return delta;
      return (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? '') || left.rootId.localeCompare(right.rootId);
    });
    return entries.map((entry) => ({
      rootId: entry.rootId,
      root: entry.root,
      name: entry.name,
      project: entry.project,
      state: entry.state === 'fail-closed' ? 'fail-closed' : (this.#seen.has(entry.rootId) ? 'active' : 'idle'),
      active: this.#seen.has(entry.rootId),
      memoryCount: readMemoryCount(entry.root),
      auditLast: readAuditLast(entry.root),
      failClosedReason: entry.failClosedReason,
    }));
  }

  #persist(force) {
    if (!this.#writable || this.#stateFile === null) return false;
    const stamp = this.#now().getTime();
    if (!force && this.#lastPersistAt > 0 && stamp - this.#lastPersistAt < LAST_SEEN_PERSIST_MS) return false;
    const ok = writeStateV2Merged(this.#stateFile, this.#state, { hashFn: this.#hashFn });
    if (ok) this.#lastPersistAt = stamp;
    return ok;
  }

  #checkLimit() {
    const count = Object.keys(this.#state.roots).length;
    if (count <= ROOT_WARN_THRESHOLD || this.#warnedLimit) return;
    this.#warnedLimit = true;
    this.#audit('root-limit-warn', { rootCount: count, threshold: ROOT_WARN_THRESHOLD });
    this.#logger?.warn?.(
      `[context-governance] root registry has ${count} roots (threshold ${ROOT_WARN_THRESHOLD}); ` +
      'continuing without a hard limit',
    );
  }
}
