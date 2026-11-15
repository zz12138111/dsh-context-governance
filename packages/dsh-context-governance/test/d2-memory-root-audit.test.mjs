/**
 * rc.10 两个必闭（C38 缺口）：
 * 1. `/cg memory show` 的 miss 审计必须与 `mem_*`/header 共用**同一个去重器**（同 key 只 1 行）；
 * 2. `/cg memory ...` 的根必须用**已解析的 root/rootId**（旧实现读 `policy.projectRoot`，该字段不存在
 *    → rootId 恒空 → `show` 显示 root-unresolved，`shared`/`promote`/`import --from legacy` 不可用）。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { createDedupedMemoryAudit, MEMORY_MISS_EVENT } from '../src/memory-audit.js';
import { openSessionMemory } from '../src/memory/session-store.js';
import { tempDir } from './helpers.mjs';

const ROOT = 'D:/DS-PROJECT/DSH插件开发';
const ROOT_ID = 'a85126058b8904c7';

function makeCommand(extra = {}) {
  return createStatusCommand({
    policy: {
      resolve: () => ({ values: { 'compact.at': 0.55 }, sources: { 'compact.at': 'plugin' }, invalid: [] }),
      validationNative: () => 0.6785,
    },
    resolveSessionRoot: () => ({ status: 'managed', entry: { root: ROOT, rootId: ROOT_ID } }),
    now: () => new Date('2026-11-15T03:30:00Z'),
    ...extra,
  });
}

test('rc.10 去重器：同 (sessionId,id,reason) 只出 1 行；不同 key/事件不受影响；有界淘汰', () => {
  const rows = [];
  const audit = createDedupedMemoryAudit({ sink: (event, details) => rows.push({ event, details }) });
  audit(MEMORY_MISS_EVENT, { sessionId: 's1', id: 'MEM-1', reason: 'body-missing' });
  audit(MEMORY_MISS_EVENT, { sessionId: 's1', id: 'MEM-1', reason: 'body-missing' });
  assert.equal(rows.length, 1, '同 key 重复必须只落 1 行');
  audit(MEMORY_MISS_EVENT, { sessionId: 's1', id: 'MEM-1', reason: 'line-drift' });
  audit(MEMORY_MISS_EVENT, { sessionId: 's2', id: 'MEM-1', reason: 'body-missing' });
  audit(MEMORY_MISS_EVENT, { sessionId: 's1', id: 'MEM-2', reason: 'body-missing' });
  assert.equal(rows.length, 4, '不同 reason/session/id 各自保留');
  // 非去重事件照常透传（同参数也每次都记）。
  audit('memory-promoted', { sessionId: 's1', id: 'MEM-1' });
  audit('memory-promoted', { sessionId: 's1', id: 'MEM-1' });
  assert.equal(rows.filter((row) => row.event === 'memory-promoted').length, 2);

  // 有界：limit 2 时最旧的 key 被淘汰，可再次落盘。
  const seen = new Set();
  const bounded = createDedupedMemoryAudit({ sink: () => {}, limit: 2, seen });
  bounded(MEMORY_MISS_EVENT, { sessionId: 'a', id: '1', reason: 'r' });
  bounded(MEMORY_MISS_EVENT, { sessionId: 'b', id: '2', reason: 'r' });
  bounded(MEMORY_MISS_EVENT, { sessionId: 'c', id: '3', reason: 'r' });
  assert.equal(seen.size, 2, '去重集合不得无界增长');
});

test('rc.10 `/cg memory show`：root 显示已解析 rootId（不再是 root-unresolved）', async () => {
  const home = await tempDir('cg-mem-home-');
  try {
    const command = makeCommand({ home });
    const result = await command.handler({ rawInput: 'memory show', agent: { session: { id: 'session-rc10' } } });
    assert.equal(result.kind, 'success');
    assert.match(result.text, new RegExp(`root: ${ROOT_ID}`), `实际输出：\n${result.text}`);
    assert.equal(result.text.includes('root-unresolved'), false);
  } finally {
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('rc.10 `/cg memory shared|promote|import --from legacy`：根可用时不再报 root-unresolved', async () => {
  const home = await tempDir('cg-mem-home2-');
  try {
    const command = makeCommand({ home });
    const agent = { agent: { session: { id: 'session-rc10' } } };

    const shared = await command.handler({ rawInput: 'memory shared', ...agent });
    assert.equal(shared.kind, 'success', shared.text);
    assert.match(shared.text, /shared: \d+ pointer/);

    const promote = await command.handler({ rawInput: 'memory promote MEM-does-not-exist', ...agent });
    assert.equal(promote.text.includes('root-unresolved'), false, promote.text);
    assert.match(promote.text, /promote|未找到|missing|unknown/i);

    const legacy = await command.handler({ rawInput: 'memory import --from legacy', ...agent });
    assert.equal(legacy.text.includes('root-unresolved'), false, legacy.text);
  } finally {
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('rc.10 `/cg memory show` 与 mem_* 共用去重：同指针 body-missing 多次 show 只记 1 行', async () => {
  const home = await tempDir('cg-mem-home3-');
  try {
    const sessionId = 'session-rc10-dedupe';
    // 造一条指向不存在文件的指针 → show 时必然 body-missing。
    const store = openSessionMemory({ home, sessionId });
    const appended = store.append({ type: 'fact', title: 'rc10', target: 'docs/ghost-file.md:3' });
    assert.equal(appended.ok, true, JSON.stringify(appended));

    const rows = [];
    const shared = createDedupedMemoryAudit({ sink: (event, details) => rows.push({ event, details }) });
    const command = makeCommand({ home, auditMemoryEvent: shared });
    const agent = { agent: { session: { id: sessionId } } };

    const first = await command.handler({ rawInput: 'memory show', ...agent });
    assert.equal(first.kind, 'success');
    const second = await command.handler({ rawInput: 'memory show', ...agent });
    assert.equal(second.kind, 'success');

    const misses = rows.filter((row) => row.event === MEMORY_MISS_EVENT);
    assert.equal(misses.length, 1, `同 key 两次 show 后必须只 1 行，实际 ${misses.length}：${JSON.stringify(misses)}`);
    assert.equal(misses[0].details.id, appended.id, '审计行必须带指针 id（落盘可定位）');
    assert.equal(misses[0].details.reason, 'body-missing');
    assert.equal(misses[0].details.sessionId, sessionId);
  } finally {
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('rc.10 没有共享去重器时仍回落到 per-session audit（不丢审计）', async () => {
  const home = await tempDir('cg-mem-home4-');
  try {
    const rows = [];
    const command = makeCommand({ home, audit: { append: (event, details) => rows.push({ event, details }) }, auditMemoryEvent: null });
    const sessionId = 'session-rc10-fallback';
    const store = openSessionMemory({ home, sessionId });
    store.append({ type: 'fact', title: 'rc10', target: 'docs/ghost-file.md:3' });
    await command.handler({ rawInput: 'memory show', agent: { session: { id: sessionId } } });
    assert.equal(rows.some((row) => row.event === MEMORY_MISS_EVENT), true, '无共享器时必须走 per-session audit');
  } finally {
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
