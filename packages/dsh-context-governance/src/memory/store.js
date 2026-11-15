/**
 * 项目记忆文件存储（M1 最小实现）。
 *
 * 目录结构（默认 `<project>/.dsh/memory/`）：
 *
 *   MEMORY.md              派生索引，一行一条；不要手改（每次写后重建）
 *   topics/decision.md     每种 type 一个主题文件，条目块见 entry-format.js
 *   topics/progress.md
 *   .writer.json           进程间写者锁（pid + 起始时间）
 *   topics/*.md.bak        覆盖前的一代备份
 *
 * 硬语义：
 * - 进程内所有写入走一条 promise 队列（`#queue`），串行化；
 * - 每次写前对已加载文件做 stamp/hash 比对，外部改动 → 转只读并抛错；
 * - 文件写入是原子的（临时文件 + rename），读侧看不到半个文件；
 * - 跨进程不合并：发现活跃写者 → 只读；破损解析 → 用 .bak 只读并告警。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { atomicWriteFile, fileStamp, hashFile, hashText, readTextIfExists } from './atomic.js';
import { acquireWriterLock } from './lock.js';
import { checkWriteTarget } from '../roots/containment.js';
import {
  ENTRY_STATUSES,
  ENTRY_TYPES,
  MemoryContractError,
  assertStatusTransition,
  checkProtectionEntryReadable,
  formatPointer,
  localDateId,
  normalizeDraft,
  normalizePatch,
  normalizeTitleKey,
  titleKeyMatches,
  nextEntryId,
} from './contract.js';
import {
  MemoryFormatError,
  parseTopicFile,
  renderIndex,
  serializeTopicFile,
} from './entry-format.js';

export const DEFAULT_MEMORY_DIR = path.join('.dsh', 'memory');
export const INDEX_FILE_NAME = 'MEMORY.md';
export const TOPICS_DIR_NAME = 'topics';
export const PROTECTION_DIR_NAME = 'protection';
/** P3：终态未确认 journal 的归档目录；P3 只归档，TTL/GC 留 P4。 */
export const PROTECTION_ORPHAN_DIR_NAME = 'orphaned';
/** 保护条目预留的 ID 区间：`MEM-YYYYMMDD-1000+`，避开普通条目。 */
export const PROTECTION_ID_FLOOR = 1000;

/** 1.0.3：天数配置夹取（0=关闭；上限 365 天；非法回默认）。 */
function clampDays(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 0), 365);
}

export class MemoryStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MemoryStoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class MemoryReadOnlyError extends Error {
  constructor(reason, message) {
    super(message ?? `memory store is read-only: ${reason}`);
    this.name = 'MemoryReadOnlyError';
    this.code = 'READ_ONLY';
    this.reason = reason;
  }
}

export class ExternalModificationError extends Error {
  constructor(file, message) {
    super(message ?? `memory file changed outside this store: ${file}`);
    this.name = 'ExternalModificationError';
    this.code = 'EXTERNAL_MODIFICATION';
    this.file = file;
  }
}

function topicFile(rootDir, type) {
  return path.join(rootDir, TOPICS_DIR_NAME, `${type}.md`);
}

function topicRel(type) {
  return `${TOPICS_DIR_NAME}/${type}.md`;
}

function cloneEntry(entry) {
  return { ...entry };
}

export class MemoryStore {
  #rootDir;
  #project;
  #now;
  #indexMaxChars;
  #entries = new Map();
  #protectionEntries = new Map();
  #journalEntries = new Map(); // cycleKey -> entry[]
  /** D-MGMT-023：保护条 id 持久高水位（date → 已分配最大序号），防止同日 id 复用。 */
  #idWatermark = new Map();
  #files = new Map(); // rel -> { type, hash, stamp, source: 'file' | 'backup' }
  #queue = Promise.resolve();
  #readOnly = false;
  #readOnlyReason = null;
  #warnings = [];
  #lock = null;
  #lockRelease = null;
  /** rc.2：启动时回收陈旧写者锁的诊断（交给上层记审计，不静默）。 */
  #lockReclaimed = null;
  #closed = false;
  /** 1.0.3：proposed 自动过期窗口（天，0=关闭）与同标题去重窗口（天，0=关闭）。 */
  #proposedTtlDays = 7;
  #dedupWindowDays = 7;

  constructor(options) {
    this.#rootDir = options.rootDir;
    this.#project = options.project;
    this.#now = options.now ?? (() => new Date());
    this.#indexMaxChars = options.indexMaxChars ?? 64_000;
    this.#proposedTtlDays = clampDays(options.proposedTtlDays, 7);
    this.#dedupWindowDays = clampDays(options.dedupWindowDays, 7);
  }

  get memoryPolicy() {
    return { proposedTtlDays: this.#proposedTtlDays, dedupWindowDays: this.#dedupWindowDays };
  }

  /**
   * 打开（或创建）一个项目记忆库。
   *
   * @param {object} options
   * @param {string} options.rootDir 记忆根目录（绝对路径或相对当前目录）。
   * @param {string} options.project 项目命名空间。
   * @param {boolean} [options.lock] 是否取进程间写者锁（默认 true）。
   * @param {boolean} [options.readOnly] 强制只读（测试/审计用）。
   * @param {() => Date} [options.now] 注入时钟。
   * @param {number} [options.indexMaxChars] MEMORY.md 上限。
   */
  static async open(options) {
    if (options === null || typeof options !== 'object') {
      throw new MemoryStoreError('OPTIONS', 'MemoryStore.open needs an options object');
    }
    const project = String(options.project ?? '').trim();
    if (project.length === 0) throw new MemoryStoreError('PROJECT', 'memory store needs a project name');
    const rootDir = path.resolve(options.rootDir ?? path.join(process.cwd(), DEFAULT_MEMORY_DIR));
    const store = new MemoryStore({
      rootDir,
      project,
      now: options.now,
      indexMaxChars: options.indexMaxChars,
      proposedTtlDays: options.proposedTtlDays,
      dedupWindowDays: options.dedupWindowDays,
    });
    try {
      store.#guardContainment(path.join(rootDir, TOPICS_DIR_NAME));
      await fs.mkdir(path.join(rootDir, TOPICS_DIR_NAME), { recursive: true });
    } catch (error) {
      store.#setReadOnly(
        error?.code === 'CONTAINMENT' ? `containment:${error.message}` : `root-not-writable:${error?.code ?? 'ERR'}`,
        `memory root ${rootDir} is not writable: ${error.message}`,
      );
    }

    // T6：装载时先做一次真实写探测；不可写就整体降级为只读（不抛给宿主）。
    if (!store.#readOnly) await store.probeWritable();

    if (options.readOnly === true) {
      store.#readOnly = true;
      store.#readOnlyReason = 'requested';
    } else if (!store.#readOnly && options.lock !== false) {
      const acquired = await acquireWriterLock(rootDir, { project, now: store.#now });
      if (acquired.ok) {
        store.#lock = acquired.lock;
        store.#lockRelease = acquired.release;
        if (acquired.reclaimed !== undefined) {
          store.#lockReclaimed = acquired.reclaimed;
          store.#warnings.push(
            `stale writer lock reclaimed (${acquired.reclaimed.reason}; pid ${acquired.reclaimed.pid ?? '?'}, ` +
            `age ${Math.round((acquired.reclaimed.lockAgeMs ?? 0) / 1000)}s); this instance is the writer now`,
          );
        }
      } else {
        store.#readOnly = true;
        store.#readOnlyReason = acquired.reason ?? `writer-lock:${acquired.holder?.pid ?? 'unknown'}`;
        store.#warnings.push(
          acquired.reason
            ? `writer lock refused by containment (${acquired.reason}); this instance is read-only`
            : `another live writer (pid ${acquired.holder?.pid ?? '?'}, started ${acquired.holder?.startedAt ?? '?'}) ` +
              'owns this project memory; this instance is read-only',
        );
      }
    }

    try {
      await store.#loadAll();
      await store.#loadProtectionJournals();
      // D-MGMT-023：重启后从磁盘高水位续号（并与已加载条目/journal 取并集）。
      store.#loadIdWatermark();
    } catch (error) {
      store.#setReadOnly(
        `load-failed:${error?.code ?? 'ERR'}`,
        `memory load failed: ${error.message}`,
      );
    }
    if (!store.#readOnly) {
      // 上次进程在“已落保护日志、未物化主题文件”之间崩溃时，启动补齐。
      for (const cycleKey of [...store.#journalEntries.keys()]) {
        try {
          await store.materializeProtection(cycleKey);
        } catch (error) {
          store.#warnings.push(`protection journal ${cycleKey} could not be materialized: ${error.message}`);
        }
      }
      // 1.0.3：proposed 超期自动作废（打开即扫，不依赖人工确认；失败只记 warning）。
      try {
        await store.#expireProposedEntries();
      } catch (error) {
        store.#warnings.push(`proposed TTL sweep failed: ${error.message}`);
      }
      await store.#writeIndex().catch((error) => {
        store.#warnings.push(`index rebuild failed: ${error.message}`);
      });
    }
    return store;
  }

  get rootDir() { return this.#rootDir; }
  get project() { return this.#project; }
  get warnings() { return [...this.#warnings]; }

  /** 运行状态：供 `/cg status` 与测试使用。 */
  get status() {
    return {
      rootDir: this.#rootDir,
      project: this.#project,
      writable: !this.#readOnly && !this.#closed,
      readOnlyReason: this.#readOnlyReason,
      counts: this.#counts(),
      warnings: this.warnings,
      lock: this.#lock === null ? null : { pid: this.#lock.pid, startedAt: this.#lock.startedAt },
      /** rc.2：本次 open 回收的陈旧锁（reason/probe/pid/startedAt/lockAgeMs），无则为 null。 */
      lockReclaimed: this.#lockReclaimed === null ? null : { ...this.#lockReclaimed },
      closed: this.#closed,
    };
  }

  #counts() {
    const counts = { proposed: 0, active: 0, superseded: 0, expired: 0 };
    const seen = new Set();
    const pool = [...this.#entries.values(), ...this.#protectionEntries.values()];
    for (const entry of pool) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
    }
    return counts;
  }

  /** 尚未物化进主题文件的保护条目数量（只读诊断）。 */
  get protectionPending() {
    return this.#journalEntries.size;
  }

  /** 待物化的保护条目标识（只读）。 */
  protectionCycles() {
    return [...this.#journalEntries.keys()];
  }

  #assertOpen() {
    if (this.#closed) throw new MemoryStoreError('CLOSED', 'memory store is closed');
  }

  /** v3：实际写入前 containment（目标路径，不是配置值）。 */
  #guardContainment(file) {
    const check = checkWriteTarget(this.#rootDir, file);
    if (check.ok === true) return;
    const reason = `containment:${check.reason}`;
    this.#setReadOnly(reason, `write target ${file} is outside memory root (${check.reason})`);
    throw new MemoryStoreError('CONTAINMENT', `write target outside memory root: ${check.reason}`);
  }

  #setReadOnly(reason, warning) {
    if (this.#readOnly && this.#readOnlyReason === reason) return;
    this.#readOnly = true;
    this.#readOnlyReason = reason;
    if (warning !== undefined) this.#warnings.push(warning);
  }

  async #loadAll() {
    this.#entries.clear();
    this.#files.clear();
    for (const type of ENTRY_TYPES) {
      const rel = topicRel(type);
      const file = topicFile(this.#rootDir, type);
      const text = await readTextIfExists(file);
      if (text === null) continue;
      try {
        const entries = parseTopicFile(text, { file: rel, project: this.#project, type });
        for (const entry of entries) this.#entries.set(entry.id, entry);
        this.#files.set(rel, {
          type,
          source: 'file',
          hash: hashText(text),
          stamp: await fileStamp(file),
        });
      } catch (error) {
        if (!(error instanceof MemoryFormatError)) throw error;
        await this.#recoverCorruptTopic(type, file, rel, error);
      }
    }
    const seen = new Set();
    for (const entry of this.#entries.values()) {
      if (seen.has(entry.id)) throw new MemoryFormatError(`duplicate entry id ${entry.id} across topic files`);
      seen.add(entry.id);
    }
    return this;
  }

  async #recoverCorruptTopic(type, file, rel, error) {
    const backup = `${file}.bak`;
    const backupText = await readTextIfExists(backup);
    if (backupText !== null) {
      try {
        const entries = parseTopicFile(backupText, { file: `${rel}.bak`, project: this.#project, type });
        for (const entry of entries) this.#entries.set(entry.id, entry);
        this.#files.set(rel, { type, source: 'backup', hash: hashText(backupText), stamp: await fileStamp(file) });
        this.#setReadOnly(
          `corrupt:${rel}`,
          `topic file ${rel} is corrupt (${error.message}); loaded the .bak copy and switched to read-only`,
        );
        return;
      } catch {
        /* backup 也不可用：落到下面只读 + 空内容 */
      }
    }
    this.#setReadOnly(
      `corrupt:${rel}`,
      `topic file ${rel} is corrupt (${error.message}) and no usable backup exists; memory is read-only`,
    );
  }

  /**
   * 压缩前保护日志（同步写）。**这是唯一在 `compaction/start` 同步窗口内能保证落盘的入口**：
   * 先写独立的 protection journal（不碰主题文件/写者队列），随后由 `materializeProtection`
   * 异步并入正常记忆条目。journal 目录不参与外部修改检测（它只被本 store 写）。
   *
   * @param {object} options
   * @param {string} options.cycleKey 压缩 cycle 的幂等键（compactionId）。
   * @param {string} [options.compactionId]
   * @param {string} [options.sessionId]
   * @param {Array<object>} options.items 最小保护项：type/title/source/evidence。
   * @returns {object[]} 已分配 ID 的条目（同步返回，供 checkpoint 后回注）。
   */
  protectSync({ cycleKey, compactionId = null, sessionId = null, items = [] } = {}) {
    this.#assertOpen();
    if (typeof cycleKey !== 'string' || cycleKey.trim() === '') {
      throw new MemoryStoreError('PROTECTION_KEY', 'protection cycle key must be a non-empty string');
    }
    const key = cycleKey.trim();
    const existing = this.#journalEntries.get(key);
    if (existing !== undefined) return existing.map(cloneEntry);
    if (this.#readOnly) throw new MemoryReadOnlyError(this.#readOnlyReason ?? 'unknown');
    if (!Array.isArray(items)) throw new MemoryStoreError('PROTECTION_ITEMS', 'protection items must be an array');
    if (items.length === 0) return [];

    const now = this.#now();
    const createdAt = now.toISOString();
    const date = localDateId(now);
    const used = new Set([...this.#entries.keys(), ...this.#protectionEntries.keys()]);
    const entries = [];
    const dedupedIds = [];
    const cycleTitles = new Set();
    let skipped = 0;
    for (const item of items) {
      const detail = String(item?.detail ?? '').trim();
      const draft = normalizeDraft({
        type: item.type,
        title: item.title,
        // 1.0.3：正文不允许为空——保护项未带正文时落到来源/证据指针，保证"读得出"。
        detail: detail === ''
          ? `来源：${item.source ?? 'unknown'}${item.evidence ? `；证据：${item.evidence}` : ''}`
          : detail,
        source: item.source,
        evidence: item.evidence,
        writer: 'rule',
        risk: 'low',
        // 条款 4：机器产物不得高置信，且必须为 proposed（需人工确认后转 active）。
        status: 'proposed',
        confidence: 0.5,
        project: this.#project,
      }, { project: this.#project, now: this.#now });
      const id = this.#takeProtectionId(date, used);
      used.add(id);
      // 1.0.3 准入（A 口径）：protectSync 是保护链路起点，坏条目在这里就挡住，
      // 绝不写进 journal（否则真机又只能靠"条目数变多"倒推）。
      const entry = { ...draft, id, createdAt, updatedAt: createdAt };
      const admitted = this.#admitEntry(entry);
      if (admitted.ok !== true) {
        skipped += 1;
        this.#warnings.push(`protectSync cycle ${key}: skipped unreadable item ${id} (${admitted.reason})`);
        continue;
      }
      // D-MGMT-023：同标题去重前移到 protectSync——被去重的条目仍进 journal（本周期回注不丢），
      // 但打 `deduped` 标记、只计入 `dedupedIds`，不再进 `ids`/`moved` 对账口径。
      const titleKey = normalizeTitleKey(draft.title);
      const duplicate = titleKey !== ''
        && (cycleTitles.has(titleKey) || this.#findRecentByTitle(draft.title) !== null);
      if (titleKey !== '') cycleTitles.add(titleKey);
      if (duplicate) {
        entry.deduped = true;
        dedupedIds.push(id);
      }
      entries.push(entry);
    }

    const journal = {
      version: 1,
      cycleKey: key,
      compactionId,
      sessionId,
      createdAt,
      dedupedIds,
      entries,
    };
    const dir = path.join(this.#rootDir, PROTECTION_DIR_NAME);
    const file = this.#journalPath(key);
    this.#guardContainment(dir);
    this.#guardContainment(file);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fsSync.mkdirSync(dir, { recursive: true });
      const text = `${JSON.stringify(journal, null, 2)}\n`;
      const fd = fsSync.openSync(temp, 'w');
      try {
        fsSync.writeFileSync(fd, text, 'utf8');
        fsSync.fsyncSync(fd);
      } finally {
        fsSync.closeSync(fd);
      }
      fsSync.renameSync(temp, file);
    } catch (error) {
      try { fsSync.rmSync(temp, { force: true }); } catch { /* ignore */ }
      throw new MemoryStoreError('PROTECTION_WRITE', `could not write protection journal: ${error.message}`);
    }

    this.#journalEntries.set(key, entries);
    for (const entry of entries) this.#protectionEntries.set(entry.id, entry);
    // D-MGMT-023：分配完立刻落高水位，重启后从磁盘续号（即使本轮条目后续被去重/丢弃也不复用 id）。
    this.#persistIdWatermark();
    return entries.map(cloneEntry);
  }

  #watermarkPath() {
    return path.join(this.#rootDir, PROTECTION_DIR_NAME, '.id-watermark');
  }

  /** D-MGMT-023：读盘高水位，并与已加载条目/journal 里的最大序号取并集（兼容旧数据/丢文件）。 */
  #loadIdWatermark() {
    const map = new Map();
    try {
      const raw = fsSync.readFileSync(this.#watermarkPath(), 'utf8');
      const data = JSON.parse(raw);
      for (const [date, next] of Object.entries(data?.dates ?? {})) {
        if (/^\d{8}$/.test(date) && Number.isInteger(next)) map.set(date, next);
      }
    } catch {
      /* 无文件/损坏：从已加载数据重建 */
    }
    const bump = (id) => {
      const match = /^MEM-(\d{8})-(\d{3,})$/.exec(String(id ?? ''));
      if (match === null) return;
      const date = match[1];
      const seq = Number(match[2]);
      if (!Number.isFinite(seq)) return;
      map.set(date, Math.max(map.get(date) ?? 0, seq));
    };
    for (const id of this.#entries.keys()) bump(id);
    for (const id of this.#protectionEntries.keys()) bump(id);
    for (const list of this.#journalEntries.values()) {
      for (const entry of list) bump(entry?.id);
    }
    this.#idWatermark = map;
  }

  #persistIdWatermark() {
    try {
      const dir = path.join(this.#rootDir, PROTECTION_DIR_NAME);
      fsSync.mkdirSync(dir, { recursive: true });
      const file = this.#watermarkPath();
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const dates = {};
      for (const [date, next] of this.#idWatermark.entries()) dates[date] = next;
      fsSync.writeFileSync(temp, `${JSON.stringify({ version: 1, dates }, null, 2)}\n`, 'utf8');
      fsSync.renameSync(temp, file);
    } catch (error) {
      this.#warnings.push(`protection id watermark could not be persisted: ${error?.message ?? error}`);
    }
  }

  /** D-MGMT-023：同日单调分配（高水位 + 已用键），并推进内存高水位。 */
  #takeProtectionId(date, used) {
    let next = Math.max(PROTECTION_ID_FLOOR, (this.#idWatermark.get(date) ?? 0) + 1);
    let id = `MEM-${date}-${String(next).padStart(4, '0')}`;
    while (used.has(id)) {
      next += 1;
      id = `MEM-${date}-${String(next).padStart(4, '0')}`;
    }
    this.#idWatermark.set(date, next);
    return id;
  }

  #journalPath(cycleKey) {
    const safe = cycleKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    return path.join(this.#rootDir, PROTECTION_DIR_NAME, `${safe}-${hashText(cycleKey).slice(0, 8)}.json`);
  }

  /**
   * 1.0.3-B：journal 里的条目**全部**已超 proposed TTL 时，视为过期 journal。
   * 过期 journal 不再物化（"先脏后清"没意义），由 `materializeProtection` 直接归档。
   */
  #isJournalExpired(entries) {
    const ttlDays = this.#proposedTtlDays;
    if (ttlDays <= 0) return false;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const nowMs = this.#now().getTime();
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    return entries.every((entry) => {
      const created = Date.parse(entry?.createdAt);
      return Number.isFinite(created) && nowMs - created > ttlMs;
    });
  }

  async #loadProtectionJournals() {
    this.#protectionEntries.clear();
    this.#journalEntries.clear();
    const dir = path.join(this.#rootDir, PROTECTION_DIR_NAME);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names.filter((item) => item.endsWith('.json') && !item.startsWith('.'))) {
      const file = path.join(dir, name);
      try {
        const journal = JSON.parse(await fs.readFile(file, 'utf8'));
        const entries = Array.isArray(journal?.entries) ? journal.entries : [];
        const valid = entries.every((entry) => this.#isProtectionEntry(entry));
        if (!valid || typeof journal?.cycleKey !== 'string') {
          this.#warnings.push(`ignored malformed protection journal ${name}`);
          continue;
        }
        // 1.0.3 准入（A 口径）：journal 读入也过 `#admitEntry`；坏条目整册跳过并留一行原因+计数。
        const rejected = entries.map((entry) => this.#admitEntry(entry)).filter((verdict) => verdict.ok !== true);
        if (rejected.length > 0) {
          this.#warnings.push(
            `ignored unreadable protection journal ${name}: ${rejected.length}/${entries.length} entries (${rejected[0].reason})`,
          );
          continue;
        }
        this.#journalEntries.set(journal.cycleKey, entries);
        for (const entry of entries) this.#protectionEntries.set(entry.id, entry);
      } catch (error) {
        this.#warnings.push(`ignored unreadable protection journal ${name}: ${error.message}`);
      }
    }
  }

  #isProtectionEntry(entry) {
    return entry !== null && typeof entry === 'object' &&
      typeof entry.id === 'string' && entry.id.startsWith('MEM-') &&
      ENTRY_TYPES.includes(entry.type) && ENTRY_STATUSES.includes(entry.status) &&
      typeof entry.title === 'string' && entry.project === this.#project &&
      typeof entry.createdAt === 'string';
  }

  /**
   * 1.0.3 准入（保护链路唯一写入口，A 口径）：**所有**保护条目的 `#entries` 写入都从这里过。
   * 判据对齐真机 #5 与已批 5a：标题可读（非截断/未闭合反引号）、`source` 可解析、`evidence` 若给须非空；
   * **`detail` 允许为空**（保护条目 = 标题 + 指针，与工具层 `checkMachineEntryReadable` 分开）。
   * **不抛错**：返回 `{ok, reason}`，调用方"跳过 + warning"，绝不因一条坏数据中断压缩。
   * `store.create()` 低层 API 不在此列（by design，见 docs/记忆契约-v1.md §12）。
   */
  #admitEntry(entry, { commit = false } = {}) {
    const verdict = checkProtectionEntryReadable({
      title: entry?.title,
      source: entry?.source,
      evidence: entry?.evidence,
    });
    if (verdict.ok !== true) return verdict;
    if (commit) this.#entries.set(entry.id, entry);
    return { ok: true, reason: null };
  }

  /**
   * 把保护 journal 并入主题文件（异步，走单写者队列）。
   * 若在 checkpoint 后尚未完成，`query`/`get` 仍可从 `#protectionEntries` 读到。
   */
  async materializeProtection(cycleKey) {
    this.#assertOpen();
    const key = String(cycleKey);
    const entries = this.#journalEntries.get(key);
    if (entries === undefined) return { moved: 0, ids: [] };
    // 1.0.3-B：过期 journal 不物化，直接归档到 protection/orphaned/（内容留给审计）。
    if (this.#isJournalExpired(entries)) {
      const archived = await this.archiveProtection(key, { reason: 'ttl-expired' });
      if (archived.ok !== true) {
        this.#warnings.push(`expired protection journal ${key} could not be archived: ${archived.reason ?? 'unknown'}`);
      }
      return { moved: 0, ids: [], archived: archived.ok === true, expired: true };
    }
    const result = await this.#transact(() => {
      const dirty = new Set();
      const ids = [];
      const deduped = [];
      let skipped = 0;
      for (const entry of entries) {
        this.#protectionEntries.delete(entry.id);
        // D-MGMT-023：protectSync 已判定的同标题重复条不再参与落盘（只留在 journal 供回注）。
        if (entry.deduped === true) {
          deduped.push(entry.id);
          continue;
        }
        if (this.#entries.has(entry.id)) continue;
        // 兼容旧 journal（无 deduped 标记，1.0.3 之前写下的）：仍按同标题去重兜底，
        // 但这类旧条目会进 `skippedIds`，由运行时对账审计暴露，不再冒充 moved。
        if (this.#findRecentByTitle(entry.title, { pending: false }) !== null) {
          deduped.push(entry.id);
          continue;
        }
        // 1.0.3 准入（A 口径）：物化前过 `#admitEntry`，它同时是保护链路**唯一**写 `#entries` 的地方。
        const admitted = this.#admitEntry(entry, { commit: true });
        if (admitted.ok !== true) {
          skipped += 1;
          this.#warnings.push(`skipped unreadable protection entry ${entry.id}: ${admitted.reason}`);
          continue;
        }
        ids.push(entry.id);
        dirty.add(entry.type);
      }
      if (skipped > 0) {
        this.#warnings.push(`protection cycle ${key}: skipped ${skipped}/${entries.length} unreadable entries`);
      }
      return { dirty, value: { moved: ids.length, ids, dedupedIds: deduped, skipped } };
    });
    try {
      await fs.rm(this.#journalPath(key), { force: true });
    } catch (error) {
      this.#warnings.push(`protection journal ${key} cleanup failed: ${error.message}`);
    }
    this.#journalEntries.delete(key);
    return result;
  }

  #forgetJournal(cycleKey) {
    const entries = this.#journalEntries.get(cycleKey);
    if (entries !== undefined) {
      for (const entry of entries) this.#protectionEntries.delete(entry.id);
    }
    this.#journalEntries.delete(cycleKey);
  }

  /**
   * P3：明确“宿主未压缩/预写失败”时删除 journal。调用方必须先确认，不得拿它当超时清理。
   * @returns {Promise<{ok:boolean, removed:boolean, entries:number, reason?:string}>}
   */
  async discardProtection(cycleKey) {
    this.#assertOpen();
    const key = String(cycleKey);
    const entries = this.#journalEntries.get(key);
    const file = this.#journalPath(key);
    this.#guardContainment(file);
    let removed = false;
    try {
      await fs.rm(file, { force: true });
      removed = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, removed: false, entries: entries?.length ?? 0, reason: String(error?.message ?? error).slice(0, 200) };
      }
      removed = true;
    }
    this.#forgetJournal(key);
    return { ok: true, removed, entries: entries?.length ?? 0 };
  }

  /**
   * P3：终态未确认 journal 归档到 `protection/orphaned/`，**不删除**。
   * P3 不做 TTL/GC；归档文件保留 entries 供 P4 审计。
   * @returns {Promise<{ok:boolean, file?:string, entries?:number, reason?:string}>}
   */
  async archiveProtection(cycleKey, { reason = 'unknown' } = {}) {
    this.#assertOpen();
    const key = String(cycleKey);
    const entries = this.#journalEntries.get(key);
    const source = this.#journalPath(key);
    const dir = path.join(this.#rootDir, PROTECTION_DIR_NAME, PROTECTION_ORPHAN_DIR_NAME);
    this.#guardContainment(dir);
    let journal;
    try {
      journal = JSON.parse(await fs.readFile(source, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, entries: entries?.length ?? 0, reason: String(error?.message ?? error).slice(0, 200) };
      }
      this.#forgetJournal(key);
      return { ok: true, entries: entries?.length ?? 0, missing: true };
    }
    const base = path.basename(source, '.json');
    let target = path.join(dir, `${base}.orphan.json`);
    let suffix = 0;
    while (fsSync.existsSync(target)) {
      suffix += 1;
      target = path.join(dir, `${base}.orphan-${suffix}.json`);
    }
    this.#guardContainment(target);
    const archived = {
      ...journal,
      status: 'unknown',
      orphanedAt: this.#now().toISOString(),
      archiveReason: String(reason ?? 'unknown').slice(0, 120),
    };
    try {
      await fs.mkdir(dir, { recursive: true });
      await atomicWriteFile(target, `${JSON.stringify(archived, null, 2)}\n`, { backup: false });
      await fs.rm(source, { force: true });
    } catch (error) {
      return { ok: false, entries: entries?.length ?? 0, reason: String(error?.message ?? error).slice(0, 200) };
    }
    this.#forgetJournal(key);
    return { ok: true, file: target, entries: entries?.length ?? 0 };
  }

  /** 用后端文件内容重建内存态；外部改动后由上层显式调用。 */
  async reload() {    this.#assertOpen();
    this.#warnings = [];
    this.#readOnly = false;
    this.#readOnlyReason = null;
    await this.#loadAll();
    await this.#loadProtectionJournals();
    this.#loadIdWatermark();
    if (this.#lock === null) {
      const acquired = await acquireWriterLock(this.#rootDir, { project: this.#project, now: this.#now });
      if (acquired.ok) {
        this.#lock = acquired.lock;
        this.#lockRelease = acquired.release;
      } else {
        this.#setReadOnly(`writer-lock:${acquired.holder?.pid ?? 'unknown'}`, 'another writer owns this project memory');
      }
    }
    if (!this.#readOnly) await this.probeWritable();
    return this;
  }

  /**
   * 写探测（T6）：真实写一个临时文件再删掉，判断记忆根当前是否可写。
   * - 失败：置只读（`root-not-writable:<code>`）并返回 `{ok:false}`，绝不抛错；
   * - 成功且当前只读原因就是 `root-not-writable:*`：清掉只读（恢复路径）。
   * 其他只读原因（写者锁 / 外部改动 / 配置指定）不会被这里清掉。
   *
   * @returns {Promise<{ok:boolean, reason:string|null, code:string|null}>}
   */
  async probeWritable() {
    this.#assertOpen();
    if (this.#closed) return { ok: false, reason: 'closed', code: 'CLOSED' };
    const probe = path.join(this.#rootDir, `.write-probe-${process.pid}-${Date.now()}`);
    try {
      this.#guardContainment(probe);
      await fs.writeFile(probe, 'ok', 'utf8');
      await fs.rm(probe, { force: true });
    } catch (error) {
      const reason = error?.code === 'CONTAINMENT'
        ? (this.#readOnlyReason ?? 'containment')
        : `root-not-writable:${error?.code ?? 'ERR'}`;
      this.#setReadOnly(reason, `memory root ${this.#rootDir} is not writable: ${error.message}`);
      return { ok: false, reason, code: error?.code ?? null };
    }
    if (this.#readOnly && (this.#readOnlyReason ?? '').startsWith('root-not-writable')) {
      this.#readOnly = false;
      this.#readOnlyReason = null;
    }
    return { ok: true, reason: null, code: null };
  }

  async #assertUnchanged() {
    const known = new Set();
    for (const [rel, record] of this.#files) {
      known.add(path.basename(rel));
      const file = path.join(this.#rootDir, rel);
      const stamp = await fileStamp(file);
      if (stamp === null) {
        this.#setReadOnly('external-change', `memory file ${rel} disappeared outside this store`);
        throw new ExternalModificationError(rel, `memory file ${rel} disappeared outside this store`);
      }
      if (record.stamp !== null && stamp.size === record.stamp.size && stamp.mtimeMs === record.stamp.mtimeMs) continue;
      const hash = await hashFile(file);
      if (hash !== record.hash) {
        this.#setReadOnly('external-change', `memory file ${rel} changed outside this store`);
        throw new ExternalModificationError(rel);
      }
    }
    let dirEntries;
    try {
      dirEntries = await fs.readdir(path.join(this.#rootDir, TOPICS_DIR_NAME), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') dirEntries = [];
      else throw error;
    }
    for (const item of dirEntries) {
      if (!item.isFile() || !item.name.endsWith('.md')) continue;
      const rel = `${TOPICS_DIR_NAME}/${item.name}`;
      if (known.has(item.name)) continue;
      const type = item.name.slice(0, -3);
      if (!ENTRY_TYPES.includes(type)) continue;
      this.#setReadOnly('external-change', `unexpected memory file ${rel} appeared outside this store`);
      throw new ExternalModificationError(rel, `unexpected memory file ${rel} appeared outside this store`);
    }
  }

  /**
   * 1.0.3：同标题去重——归一化标题相同且在窗口内，返回既有条目。
   * D-MGMT-023：pending 默认含尚未物化的保护条（protectSync 用）；物化时只对已落盘条目比对
   * （pending:false），否则别的周期还在 pending 的同标题会把本周期条目误判成重复。
   */
  #findRecentByTitle(title, { pending = true } = {}) {
    const windowDays = this.#dedupWindowDays;
    if (windowDays <= 0) return null;
    const key = normalizeTitleKey(title);
    if (key === '') return null;
    const nowMs = this.#now().getTime();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const seen = new Set();
    const pool = pending ? [...this.#entries.values(), ...this.#protectionEntries.values()] : [...this.#entries.values()];
    for (const entry of pool) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.status === 'expired') continue;
      // 1.0.3：正文为空的旧条目（1.0.2 遗留）不参与去重，避免把"读不出"的旧条目当成同内容而拒绝新条目。
      if (String(entry.detail ?? '').trim() === '') continue;
      // 1.0.3-B(5b)：同一指针被续写（前缀近似）也算同一条；只做全等会漏。
      if (!titleKeyMatches(key, normalizeTitleKey(entry.title))) continue;
      const created = Date.parse(entry.createdAt);
      if (Number.isFinite(created) && nowMs - created <= windowMs) return entry;
    }
    return null;
  }

  /** 1.0.3：proposed 超过 TTL 自动 expired（条款 2）；返回作废条数。 */
  async #expireProposedEntries() {
    if (this.#readOnly) return 0;
    const ttlDays = this.#proposedTtlDays;
    if (ttlDays <= 0) return 0;
    const nowMs = this.#now().getTime();
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const dirty = new Set();
    let expired = 0;
    for (const entry of this.#entries.values()) {
      if (entry.status !== 'proposed') continue;
      const created = Date.parse(entry.createdAt);
      if (!Number.isFinite(created) || nowMs - created <= ttlMs) continue;
      entry.status = 'expired';
      entry.updatedAt = this.#now().toISOString();
      dirty.add(entry.type);
      expired += 1;
    }
    if (expired > 0) await this.#persist(dirty);
    return expired;
  }

  #transact(work) {
    this.#assertOpen();
    const run = this.#queue.then(async () => {
      if (this.#readOnly) throw new MemoryReadOnlyError(this.#readOnlyReason ?? 'unknown');
      await this.#assertUnchanged();
      // 1.0.3：写前顺手扫一次 proposed TTL（长驻进程不必等重启）。
      await this.#expireProposedEntries();
      const { dirty, value } = await work();
      if (dirty.size > 0) await this.#persist(dirty);
      return value;
    });
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #persist(dirtyTypes) {
    for (const type of dirtyTypes) {
      const entries = [...this.#entries.values()].filter((entry) => entry.type === type);
      const content = serializeTopicFile(type, this.#project, entries);
      const file = topicFile(this.#rootDir, type);
      this.#guardContainment(file);
      this.#guardContainment(`${file}.bak`);
      await atomicWriteFile(file, content, { backup: true });
      const rel = topicRel(type);
      this.#files.set(rel, {
        type,
        source: 'file',
        hash: hashText(content),
        stamp: await fileStamp(file),
      });
    }
    await this.#writeIndex();
  }

  async #writeIndex() {
    const content = renderIndex(this.#entries.values(), {
      project: this.#project,
      now: this.#now(),
      maxChars: this.#indexMaxChars,
    });
    const indexFile = path.join(this.#rootDir, INDEX_FILE_NAME);
    this.#guardContainment(indexFile);
    this.#guardContainment(`${indexFile}.bak`);
    await atomicWriteFile(indexFile, content, { backup: true });
  }

  #updateTimestamp() {
    return this.#now().toISOString();
  }

  /** 全部条目的只读快照。 */
  entries() {
    return [...this.#entries.values()].map(cloneEntry);
  }

  /** 普通条目 + 尚未物化的保护条目（去重）。 */
  allEntries() {
    const merged = new Map();
    for (const entry of this.#entries.values()) merged.set(entry.id, entry);
    for (const entry of this.#protectionEntries.values()) merged.set(entry.id, entry);
    return [...merged.values()].map(cloneEntry);
  }

  get(id) {
    const entry = this.#entries.get(String(id)) ?? this.#protectionEntries.get(String(id));
    return entry === undefined ? null : cloneEntry(entry);
  }

  /**
   * 查询。
   *
   * @param {object} [filter]
   * @param {string[]} [filter.ids] 指定 ID 时返回详情（架构：详情按需读取）。
   * @param {string} [filter.type]
   * @param {string|string[]} [filter.status]
   * @param {string} [filter.text] 标题/正文关键词（大小写不敏感）。
   * @param {number} [filter.limit] 默认 20，上限 100。
   * @returns {{count:number, entries:object[]}}
   */
  query(filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit ?? 20) || 20, 1), 100);
    const statuses = filter.status === undefined
      ? null
      : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
    const text = typeof filter.text === 'string' ? filter.text.trim().toLowerCase() : '';
    const findEntry = (id) => this.#entries.get(String(id)) ?? this.#protectionEntries.get(String(id));
    let rows;
    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      rows = [];
      for (const id of filter.ids) {
        const entry = findEntry(id);
        if (entry === undefined) continue;
        if (filter.type !== undefined && entry.type !== filter.type) continue;
        if (statuses !== null && !statuses.has(entry.status)) continue;
        rows.push({ ...cloneEntry(entry) });
      }
      // 指定 ID 时详情随行返回，limit 仍生效。
      rows = rows.slice(0, limit);
      return { count: rows.length, entries: rows };
    }
    const merged = new Map();
    for (const entry of this.#entries.values()) merged.set(entry.id, entry);
    for (const entry of this.#protectionEntries.values()) merged.set(entry.id, entry);
    rows = [...merged.values()].filter((entry) => {
      if (filter.type !== undefined && entry.type !== filter.type) return false;
      if (statuses !== null && !statuses.has(entry.status)) return false;
      if (text.length > 0) {
        const haystack = `${entry.title}\n${entry.detail}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
    rows.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
    const sliced = rows.slice(0, limit).map((entry) => {
      const { detail: _detail, ...row } = entry;
      return row;
    });
    return { count: sliced.length, entries: sliced };
  }

  /** 新建条目。 */
  async create(input) {
    return this.#transact(() => {
      const draft = normalizeDraft(input, { project: this.#project, now: this.#now });
      // 1.0.3：同标题（归一化）在去重窗口内只保留 1 条，重复写入返回既有条目。
      const duplicate = this.#findRecentByTitle(draft.title);
      if (duplicate !== null) return { dirty: new Set(), value: cloneEntry(duplicate) };
      const id = nextEntryId(this.#entries.keys(), this.#now());
      const entry = { ...draft, id };
      this.#entries.set(id, entry);
      return { dirty: new Set([entry.type]), value: cloneEntry(entry) };
    });
  }

  /** 更新既有条目的可编辑字段。 */
  async update(id, patch) {
    return this.#transact(() => {
      const entry = this.#entries.get(String(id));
      if (entry === undefined) throw new MemoryStoreError('NOT_FOUND', `memory entry ${id} not found`);
      const normalized = normalizePatch(patch);
      const next = { ...entry, ...normalized, updatedAt: this.#updateTimestamp() };
      if (next.risk === 'high' && next.status === 'active') {
        throw new MemoryStoreError('RISK_ACTIVE', `entry ${id} is active; a high-risk change must start as proposed`);
      }
      const dirty = new Set([entry.type]);
      if (next.type !== entry.type) dirty.add(next.type);
      this.#entries.set(entry.id, next);
      return { dirty, value: cloneEntry(next) };
    });
  }

  /** 用户确认：proposed → active。 */
  async confirm(id) {
    return this.#transact(() => {
      const entry = this.#entries.get(String(id));
      if (entry === undefined) throw new MemoryStoreError('NOT_FOUND', `memory entry ${id} not found`);
      assertStatusTransition(entry.status, 'active');
      const next = { ...entry, status: 'active', updatedAt: this.#updateTimestamp() };
      this.#entries.set(entry.id, next);
      return { dirty: new Set([entry.type]), value: cloneEntry(next) };
    });
  }

  /** 标记过期（不删除，保留可追溯性）。 */
  async expire(id) {
    return this.#transact(() => {
      const entry = this.#entries.get(String(id));
      if (entry === undefined) throw new MemoryStoreError('NOT_FOUND', `memory entry ${id} not found`);
      assertStatusTransition(entry.status, 'expired');
      const next = { ...entry, status: 'expired', updatedAt: this.#updateTimestamp() };
      this.#entries.set(entry.id, next);
      return { dirty: new Set([entry.type]), value: cloneEntry(next) };
    });
  }

  /**
   * 用一条新记录取代旧记录：旧记录转 superseded + supersededBy，新记录
   * 自动带 supersedes。不做原地覆盖（架构 §5.5）。
   */
  async supersede(oldId, input) {
    return this.#transact(() => {
      const old = this.#entries.get(String(oldId));
      if (old === undefined) throw new MemoryStoreError('NOT_FOUND', `memory entry ${oldId} not found`);
      if (old.status === 'superseded') throw new MemoryStoreError('ALREADY_SUPERSEDED', `entry ${oldId} is already superseded`);
      const draft = normalizeDraft(
        { ...input, type: input?.type ?? old.type },
        { project: this.#project, now: this.#now },
      );
      if (draft.type !== old.type) {
        throw new MemoryStoreError('SUPERSEDE_TYPE', 'a replacement must keep the same type (same topic file)');
      }
      const id = nextEntryId(this.#entries.keys(), this.#now());
      const created = { ...draft, id, supersedes: old.id };
      const retired = {
        ...old,
        status: 'superseded',
        supersededBy: created.id,
        updatedAt: this.#updateTimestamp(),
      };
      this.#entries.set(id, created);
      this.#entries.set(old.id, retired);
      return {
        dirty: new Set([created.type]),
        value: { entry: cloneEntry(created), superseded: cloneEntry(retired) },
      };
    });
  }

  /**
   * 生成回注行（供 T4 使用；T2 只冻结格式）。
   *
   * @param {{ids?:string[], summaryReadable?:boolean, includeTitles?:boolean}} [options]
   * @returns {{lines:string[], entries:object[]}}
   */
  renderPointers({ ids, summaryReadable = true, includeTitles = false } = {}) {
    const selected = Array.isArray(ids) && ids.length > 0
      ? ids.map((id) => this.#entries.get(String(id)) ?? this.#protectionEntries.get(String(id))).filter(Boolean)
      : [...this.#entries.values()]
        .filter((entry) => entry.status === 'active' || entry.status === 'proposed')
        .sort((a, b) => (a.status === b.status
          ? (a.updatedAt < b.updatedAt ? 1 : -1)
          : (a.status === 'active' ? -1 : 1)));
    const entries = selected.map(cloneEntry);
    const lines = entries.map((entry) => formatPointer(entry, {
      summaryReadable,
      includeTitle: includeTitles && summaryReadable,
    }));
    return { lines, entries };
  }

  /** 关闭：释放写者锁。之后再写会抛 CLOSED。 */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#lockRelease?.();
    this.#lockRelease = null;
  }
}

export { formatPointer, MemoryContractError, MemoryFormatError };




