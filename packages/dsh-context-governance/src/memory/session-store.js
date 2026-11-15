/**
 * C38 ①：会话级记忆指针库（指针在插件、正文在文件）。
 *
 * 目录：`<home>/context-governance/sessions/<完整 sessionId>/`
 *   MEMORY.md         索引（短行）
 *   topics/<type>.md  指针条目（含 target=文件:行号、line-text 快照、summary）
 *   .id-watermark     本会话 id 高水位（复用 D-MGMT-023 机制）
 *   meta.json         `{version:1, sessionId, role, updatedAt}`
 *
 * 约定：
 * - 插件**只读正文**（target 行），绝不写正文；正文缺失/行漂移 → 指针标 `miss`（不抛错、不阻塞）。
 * - 登记失败（target 不可解析）返回 warning，调用方不受阻。
 * - 子会话默认不写、不读父记忆（由上层路由控制，本模块不跨会话）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_MEMORY_VERSION = 1;
const ID_PATTERN = /^MEM-([A-Za-z0-9]{4,12})-(\d{8})-(\d{4,})$/;

export function shortSessionIdOf(sessionId) {
  const raw = String(sessionId ?? '').replace(/^session-/, '');
  return raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'anon';
}

function localDateId(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function readLineAt(file, line) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
    return lines[line - 1];
  } catch {
    return null;
  }
}

export function parsePointerBlock(text) {
  const pointers = [];
  const pattern = /<!-- pointer:(MEM-[A-Za-z0-9-]+) -->\n### \1\n([\s\S]*?)(?=<!-- pointer:|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const fields = {};
    for (const line of match[2].split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index <= 0) continue;
      fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    pointers.push({
      id: match[1],
      target: fields.target ?? '',
      lineText: fields['line-text'] ?? '',
      summary: fields.summary ?? '',
      title: fields.title ?? '',
    });
  }
  return pointers;
}

/**
 * C38 ④：header 渲染——只注入短行（id + 一句话摘要 + miss 标记），
 * 有字节/条数上限；超限截断并发 `header-truncated`，**不复制正文**。
 */
export function renderMemoryHeader(store, { maxLines = 20, maxBytes = 2048, audit = null } = {}) {
  const entries = typeof store?.query === 'function' ? store.query() : [];
  const lines = ['## 会话记忆指针（C38）'];
  let bytes = Buffer.byteLength(lines[0], 'utf8');
  let truncated = 0;
  const limitLines = Math.max(Number(maxLines) || 20, 1);
  const limitBytes = Math.max(Number(maxBytes) || 2048, 64);
  for (const entry of entries) {
    if (lines.length - 1 >= limitLines) { truncated += 1; continue; }
    const title = String(entry.title || entry.summary || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const line = `- ${entry.id} · ${title === '' ? '(无摘要)' : title}${entry.miss === true ? ' [miss]' : ''}`;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > limitBytes) { truncated += 1; continue; }
    lines.push(line);
    bytes += size;
  }
  if (truncated > 0) {
    lines.push(`- … 已截断 ${truncated} 条（header 上限 ${limitLines} 行/${limitBytes} bytes）`);
    try {
      audit?.('header-truncated', { count: truncated, bytes: limitBytes, lines: limitLines });
    } catch {
      /* 审计失败不影响 header */
    }
  }
  return { text: lines.join('\n'), bytes, truncated };
}

export function serializePointers(entries) {
  return entries.map((entry) => [
    `<!-- pointer:${entry.id} -->`,
    `### ${entry.id}`,
    `target: ${entry.target}`,
    `line-text: ${entry.lineText}`,
    `summary: ${entry.summary}`,
    `title: ${entry.title}`,
    '',
  ].join('\n')).join('\n');
}

/**
 * @param {{home:string, sessionId:string, now?:()=>Date, audit?:(event:string,details:object)=>void,
 *   subagent?:boolean}} options
 */
export function openSessionMemory({ home, sessionId, now = () => new Date(), audit = null, subagent = false, sharedRootId = null } = {}) {
  if (typeof home !== 'string' || home === '') throw new Error('session memory needs a home dir');
  const isShared = typeof sharedRootId === 'string' && sharedRootId !== '';
  if (!isShared && (typeof sessionId !== 'string' || sessionId === '')) throw new Error('session memory needs a session id');
  const short8 = isShared ? `sh${String(sharedRootId).replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}` : shortSessionIdOf(sessionId);
  const dir = isShared
    ? path.join(path.resolve(home), 'context-governance', 'shared', String(sharedRootId))
    : path.join(path.resolve(home), 'context-governance', 'sessions', sessionId);
  const indexFile = path.join(dir, 'MEMORY.md');
  const topicsDir = path.join(dir, 'topics');
  const watermarkFile = path.join(dir, '.id-watermark');
  const metaFile = path.join(dir, 'meta.json');
  const emit = (event, details) => {
    try {
      audit?.(event, details);
    } catch {
      /* 审计失败不影响记忆 */
    }
  };

  const pointers = load();
  const dates = loadWatermark();

  function loadWatermark() {
    try {
      const raw = JSON.parse(fs.readFileSync(watermarkFile, 'utf8'));
      return raw !== null && typeof raw === 'object' && typeof raw.dates === 'object' && raw.dates !== null
        ? { ...raw.dates }
        : {};
    } catch {
      return {};
    }
  }

  function persistWatermark() {
    try {
      writeAtomic(watermarkFile, `${JSON.stringify({ version: 1, dates }, null, 2)}\n`);
    } catch {
      /* 高水位写失败不回滚指针 */
    }
  }

  function load() {
    try {
      const files = fs.readdirSync(topicsDir).filter((name) => name.endsWith('.md'));
      const all = [];
      for (const name of files) {
        const text = fs.readFileSync(path.join(topicsDir, name), 'utf8');
        all.push(...parsePointerBlock(text));
      }
      return all;
    } catch {
      return [];
    }
  }

  function persist() {
    const byType = new Map();
    for (const entry of pointers) {
      const type = entry.type ?? 'fact';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(entry);
    }
    ensureDir(topicsDir);
    for (const [type, list] of byType.entries()) {
      writeAtomic(path.join(topicsDir, `${type}.md`), serializePointers(list));
    }
    const indexLines = ['# 会话记忆指针（C38）', ''];
    for (const entry of pointers) {
      indexLines.push(`- ${entry.id} · ${entry.status} · ${entry.type} · ${entry.title} · ${entry.target}`);
    }
    writeAtomic(indexFile, `${indexLines.join('\n')}\n`);
    persistWatermark();
  }

  function nextId(dateId) {
    const current = Math.max(1, (dates[dateId] ?? 0) + 1);
    let next = current;
    let id = `MEM-${short8}-${dateId}-${String(next).padStart(4, '0')}`;
    const used = new Set(pointers.map((entry) => entry.id));
    while (used.has(id)) {
      next += 1;
      id = `MEM-${short8}-${dateId}-${String(next).padStart(4, '0')}`;
    }
    dates[dateId] = next;
    return id;
  }

  /** 正文可解析性检查：文件存在 + 行号在范围内 + 与登记时 line-text 一致。 */
  function resolveTarget(entry) {
    const match = String(entry.target ?? '').match(/^(.*):(\d+)$/);
    if (match === null) return { ok: false, reason: 'target-format' };
    const file = match[1];
    const line = Number(match[2]);
    const current = readLineAt(file, line);
    if (current === null) return { ok: false, reason: 'body-missing' };
    if (entry.lineText !== '' && current.trim() !== entry.lineText.trim()) {
      return { ok: false, reason: 'line-drift' };
    }
    return { ok: true, file, line };
  }

  return {
    dir,
    short8,
    sessionId,
    /** 登记一条指针：target 为绝对路径 + 行号；line-text 快照用于后续漂移判定。 */
    append({ type = 'fact', title = '', target = '', summary = '', status = 'proposed', originSessionId = null, originRole = null, importedAt = null } = {}) {
      if (subagent === true) return { ok: false, reason: 'subagent-readonly' };
      const match = String(target).match(/^(.*):(\d+)$/);
      const file = match === null ? '' : match[1];
      const line = match === null ? 0 : Number(match[2]);
      const lineText = readLineAt(file, line);
      const dateId = localDateId(now());
      const id = nextId(dateId);
      const entry = {
        id,
        type,
        title,
        target,
        lineText: lineText === null ? '' : lineText.trim(),
        summary,
        status,
        ...(originSessionId === null ? {} : { originSessionId }),
        ...(originRole === null ? {} : { originRole }),
        ...(importedAt === null ? {} : { importedAt }),
      };
      pointers.push(entry);
      persist();
      if (lineText === null) {
        emit('memory-pointer-miss', { sessionId, id, target, reason: 'body-missing' });
        return { ok: true, id, warning: 'body-missing' };
      }
      return { ok: true, id };
    },
    /** 查询：默认全部；text 做 title/summary 关键词匹配；每次返回都做 target 可解析性检查。 */
    query({ text = '', type = null, ids = null } = {}) {
      const needle = String(text ?? '').trim().toLowerCase();
      const wanted = Array.isArray(ids) ? new Set(ids) : null;
      const result = [];
      for (const entry of pointers) {
        if (type !== null && entry.type !== type) continue;
        if (wanted !== null && !wanted.has(entry.id)) continue;
        if (needle !== '' && !`${entry.title} ${entry.summary}`.toLowerCase().includes(needle)) continue;
        const resolved = resolveTarget(entry);
        if (resolved.ok !== true) {
          emit('memory-pointer-miss', { sessionId, id: entry.id, target: entry.target, reason: resolved.reason });
        }
        result.push({ ...entry, miss: resolved.ok !== true, missReason: resolved.ok === true ? null : resolved.reason });
      }
      return result;
    },
    all() { return pointers.map((entry) => ({ ...entry })); },
    count() { return pointers.length; },
    setRole(role) {
      let meta = { version: SESSION_MEMORY_VERSION, sessionId, role: null, updatedAt: now().toISOString() };
      try {
        const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (raw !== null && typeof raw === 'object') meta = { ...meta, ...raw };
      } catch { /* 无 meta 即新建 */ }
      meta.role = role;
      meta.updatedAt = now().toISOString();
      try {
        writeAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
      }
      emit('session-role-set', { sessionId, role });
      return { ok: true, role };
    },
    /** C38 ⑬：记录最近活跃信息（role/rootId/lastActiveAt），供 --from-role 找源会话。 */
    touchMeta({ rootId = null, role = undefined } = {}) {
      const meta = this.meta();
      if (role !== undefined) meta.role = role;
      if (rootId !== null) meta.rootId = rootId;
      meta.lastActiveAt = now().toISOString();
      meta.updatedAt = meta.lastActiveAt;
      try {
        writeAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
      }
    },

    meta() {
      try {
        const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        return raw !== null && typeof raw === 'object' ? raw : { version: SESSION_MEMORY_VERSION, sessionId, role: null };
      } catch {
        return { version: SESSION_MEMORY_VERSION, sessionId, role: null };
      }
    },
    /** 直接以完整指针对象导入（promote/import 复用；仍然走 id 分配与持久）。 */
    importPointer(entry) {
      const same = pointers.some((item) => item.target === entry.target && item.title === entry.title);
      if (same) return { ok: false, reason: 'duplicate-target' };
      return this.append(entry);
    },
    ID_PATTERN,
  };
}
