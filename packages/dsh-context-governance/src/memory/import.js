/**
 * C38 ⑤⑥⑩⑪⑬：共享 promote、legacy 显式导入、`--from-role` 角色显式继承。
 *
 * 原则：
 * - 默认不共享、不继承；只有显式动作才写 shared/ 或复制指针；
 * - 复制生成**新 id**，保留 `originSessionId`/`originRole`/`importedAt`，原会话记忆不动；
 * - 找不到源会话 → 报错 + `memory-import-no-source`（不静默成功）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { openSessionMemory } from './session-store.js';

/** ⑤ promote：把本会话指定指针复制到 `<home>/context-governance/shared/<rootId>/`。 */
export function promotePointers({
  home, rootId, sessionId, fromStore, ids = [], audit = null, now = () => new Date(),
} = {}) {
  if (typeof rootId !== 'string' || rootId === '') return { ok: false, reason: 'root-unresolved' };
  const entries = typeof fromStore?.all === 'function' ? fromStore.all() : [];
  const wanted = new Set(ids);
  const selected = entries.filter((entry) => wanted.has(entry.id));
  if (selected.length === 0) return { ok: false, reason: 'no-match' };
  const shared = openSessionMemory({ home, sessionId, sharedRootId: rootId, now, audit });
  const promoted = [];
  for (const entry of selected) {
    const result = shared.importPointer({
      type: entry.type,
      title: entry.title,
      target: entry.target,
      summary: entry.summary,
      status: entry.status,
      originSessionId: sessionId,
      importedAt: now().toISOString(),
    });
    if (result.ok === true) promoted.push(result.id);
  }
  try {
    audit?.('memory-promoted', { sessionId, rootId, count: promoted.length, ids: promoted });
  } catch { /* 审计失败不影响 promote */ }
  return { ok: promoted.length > 0, promoted, shared, reason: promoted.length > 0 ? null : 'duplicate-target' };
}

/** 列出 shared 指针（默认不注入；显式查询才读）。 */
export function openSharedMemory({ home, rootId, now = () => new Date(), audit = null } = {}) {
  return openSessionMemory({ home, sessionId: null, sharedRootId: rootId, now, audit });
}

function parseLegacyFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^<!-- entry:(MEM-[0-9]{8}-[0-9]{3,}) -->/.exec(lines[index]);
    if (marker === null) continue;
    const id = marker[1];
    let title = '';
    for (let offset = index + 1; offset < Math.min(index + 6, lines.length); offset += 1) {
      const candidate = lines[offset].replace(/^#+\s*/, '').trim();
      if (candidate !== '' && candidate !== id) { title = candidate; break; }
    }
    entries.push({ legacyId: id, title, target: `${file}:${index + 1}` });
  }
  return entries;
}

/** ⑩ `memory import --from legacy`：显式导入 `<root>/memory/governance` 下的旧指针，生成新 id。 */
export function importLegacy({
  legacyDir, toStore, sessionId, audit = null, now = () => new Date(),
} = {}) {
  if (typeof legacyDir !== 'string' || legacyDir === '') return { ok: false, reason: 'no-legacy-dir' };
  // C38 ⑩：原地标 legacy-shared-v1（只写标记文件，不改记忆内容）。
  try {
    const markerPath = path.join(legacyDir, 'legacy-shared-v1.json');
    if (!fs.existsSync(markerPath)) {
      const markerBody = { version: 1, markedAt: now().toISOString() };
      fs.writeFileSync(markerPath, `${JSON.stringify(markerBody, null, 2)}\n`, 'utf8');
    }
  } catch {
    /* 标记失败不影响导入 */
  }
  const topicsDir = path.join(legacyDir, 'topics');
  let names = [];
  try {
    names = fs.readdirSync(topicsDir).filter((name) => name.endsWith('.md'));
  } catch {
    return { ok: false, reason: 'no-topics' };
  }
  const imported = [];
  for (const name of names) {
    for (const legacy of parseLegacyFile(path.join(topicsDir, name))) {
      const result = toStore.importPointer({
        type: 'fact',
        title: legacy.title || legacy.legacyId,
        target: legacy.target,
        summary: `imported from ${legacy.legacyId}`,
        originSessionId: 'legacy-shared-v1',
        importedAt: now().toISOString(),
      });
      if (result.ok === true) imported.push(result.id);
    }
  }
  try {
    audit?.('memory-imported', { sessionId, from: 'legacy', count: imported.length, ids: imported });
  } catch { /* ignore */ }
  return { ok: imported.length > 0, imported, reason: imported.length > 0 ? null : 'nothing-to-import' };
}

/** ⑪⑬ `memory import --from-role <role>`：找同 role + 同 rootId 最近活跃会话，复制其指针。 */
export function importFromRole({
  home, role, rootId = null, sessionId, toStore, audit = null, now = () => new Date(),
} = {}) {
  const sessionsDir = path.join(path.resolve(home), 'context-governance', 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    names = [];
  }
  let best = null;
  for (const name of names) {
    if (name === sessionId) continue;
    const metaFile = path.join(sessionsDir, name, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      continue;
    }
    if (meta?.role !== role) continue;
    if (rootId !== null && meta?.rootId !== rootId) continue;
    const activeAt = Date.parse(meta?.lastActiveAt ?? meta?.updatedAt ?? '');
    if (!Number.isFinite(activeAt)) continue;
    if (best === null || activeAt > best.activeAt) best = { sessionId: name, activeAt };
  }
  if (best === null) {
    try {
      audit?.('memory-import-no-source', { sessionId, role, rootId });
    } catch { /* ignore */ }
    return { ok: false, reason: 'no-source-session' };
  }
  const source = openSessionMemory({ home, sessionId: best.sessionId, now });
  const imported = [];
  for (const entry of source.all()) {
    const result = toStore.importPointer({
      type: entry.type,
      title: entry.title,
      target: entry.target,
      summary: entry.summary,
      originSessionId: best.sessionId,
      originRole: role,
      importedAt: now().toISOString(),
    });
    if (result.ok === true) imported.push(result.id);
  }
  try {
    audit?.('memory-imported-role', { sessionId, role, fromSessionId: best.sessionId, count: imported.length });
  } catch { /* ignore */ }
  return { ok: true, from: best.sessionId, imported };
}
