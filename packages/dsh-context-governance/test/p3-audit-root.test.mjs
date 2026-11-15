/**
 * P3（rc.11）：记忆审计按会话根路由 + header 两行同根 + header-injected 字段口径。
 *
 * rc.10 三项缺口（审核/测试判定）：
 *  ① 命令面/工具面/header 的记忆审计一律写主根审计（D），会话受治根是 G 时落在错的根上；
 *  ② `header-injected.lines` 取了指针条数而非**实际注入行数**，且缺 `pointers` 字段；
 *  ③ `header-truncated` 传 `auditForSession(null)`，与 `header-injected` 不同根。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRootRoutedMemoryAudit } from '../src/memory-audit.js';
import { headerInjectedFields, registerMemoryHeader } from '../src/memory/header.js';

const NOW = { now: () => new Date('2026-11-15T00:00:00Z') };

function fakeAudit(label, rows) {
  return { label, append: (event, details) => { rows.push({ label, event, details }); return true; } };
}

test('P3 ①：记忆审计按会话根路由——已打开的根优先，未打开按 entry 开，取不到才落主根', () => {
  const rows = [];
  const main = fakeAudit('D', rows);
  const opened = fakeAudit('opened-G', rows);
  const created = fakeAudit('created-G', rows);
  const openedFor = new Set(['session-open']);
  const entries = { 'session-open': { root: 'G', rootId: 'g1' }, 'session-lazy': { root: 'G2', rootId: 'g2' } };

  const audit = createRootRoutedMemoryAudit({
    auditForSessionId: (sessionId) => (openedFor.has(sessionId) ? opened : null),
    resolveEntry: (sessionId) => entries[sessionId] ?? null,
    openRootAudit: (entry) => (entry.rootId === 'g2' ? created : null),
    fallback: main,
  });

  audit('memory-pointer-miss', { sessionId: 'session-open', id: 'MEM-1', reason: 'body-missing' });
  audit('memory-pointer-miss', { sessionId: 'session-lazy', id: 'MEM-2', reason: 'line-drift' });
  audit('memory-pointer-miss', { sessionId: 'session-unknown', id: 'MEM-3', reason: 'body-missing' });
  audit('memory-pointer-miss', { id: 'MEM-4', reason: 'body-missing' });

  assert.deepEqual(rows.map((row) => row.label), ['opened-G', 'created-G', 'D', 'D'],
    '已打开的根 → 它；未打开的根按 entry 开 → 它；未知会话/无 sessionId → 主根');
  assert.equal(rows[0].details.sessionId, 'session-open');
  assert.equal(rows[1].details.sessionId, 'session-lazy');
});

test('P3 ①：根不存在（P4 联动）→ 不建审计、退回主根；根恢复后落回该根且不重复建', () => {
  const rows = [];
  const main = fakeAudit('D', rows);
  let rootExists = false;
  const created = [];
  const audit = createRootRoutedMemoryAudit({
    auditForSessionId: () => null,
    resolveEntry: () => ({ root: 'G', rootId: 'g1' }),
    openRootAudit: () => {
      if (rootExists !== true) return null; // 根不在：调用方不建目录
      const instance = fakeAudit(`G#${created.length + 1}`, rows);
      created.push(instance);
      return instance;
    },
    fallback: main,
  });

  audit('memory-pointer-miss', { sessionId: 's1', id: 'MEM-1', reason: 'body-missing' });
  assert.deepEqual(rows.map((row) => row.label), ['D'], '根不在 → 只剩主根，不得伪造');

  rootExists = true;
  audit('memory-pointer-miss', { sessionId: 's1', id: 'MEM-2', reason: 'body-missing' });
  audit('memory-pointer-miss', { sessionId: 's1', id: 'MEM-3', reason: 'body-missing' });
  assert.deepEqual(rows.map((row) => row.label), ['D', 'G#1', 'G#1'], '根恢复后落该根，且只开一次');
  assert.equal(created.length, 1);
});

test('P3 ①：miss 去重仍只一份——同 sessionId|id|reason 跨根切换不重复落行', () => {
  const rows = [];
  const main = fakeAudit('D', rows);
  const audit = createRootRoutedMemoryAudit({
    auditForSessionId: () => null,
    resolveEntry: () => null,
    openRootAudit: () => null,
    fallback: main,
  });
  audit('memory-pointer-miss', { sessionId: 's', id: 'MEM-1', reason: 'body-missing' });
  audit('memory-pointer-miss', { sessionId: 's', id: 'MEM-1', reason: 'body-missing' });
  audit('memory-pointer-miss', { sessionId: 's', id: 'MEM-1', reason: 'line-drift' });
  assert.equal(rows.length, 2, '同键去重；理由不同各落一行');
});

test('P3 ②：header-injected 的 lines = 实际注入行数，pointers = 条目数，两值不混用', () => {
  const injection = { messagesBefore: 1, messagesAfter: 2 };
  const single = headerInjectedFields({ text: 'L1\nL2', count: 2, mode: 'session-pointers' }, injection);
  assert.equal(single.lines, 2);
  assert.equal(single.pointers, 2);
  assert.equal(single.count, 2);

  // 一条指针 + 头部行 + Note → lines 与 pointers 必须分开（rc.10 会把两者混成 1）。
  const multi = headerInjectedFields(
    { text: '[CG-MEMORY · state-only · budget 20 lines]\n- MEM-1 · A\n[Note: ...]', count: 1, mode: 'state-only' },
    injection,
  );
  assert.equal(multi.lines, 3, '实际注入 3 行');
  assert.equal(multi.pointers, 1, '只有 1 条指针');
  assert.equal(multi.injected, 1);
  assert.equal(headerInjectedFields({ text: '', count: 0 }, {}).lines, 0, '空文本不得算 1 行');
});

test('P3 ③：header-truncated 与 header-injected 同根——截断回传 session', async () => {
  const pointers = [{ id: 'MEM-1', title: 'A' }, { id: 'MEM-2', title: 'B' }];
  const truncated = [];
  const injected = [];
  const handlers = [];
  const ctx = { on: (event, handler) => { handlers.push({ event, handler }); return () => {}; }, logger: { warn: () => {} } };
  registerMemoryHeader(ctx, null, {
    enabled: true,
    hasRuleFile: true,
    ...NOW,
    resolvePointers: () => pointers,
    maxLines: 1,
    maxBytes: 4096,
    onTruncated: (event, details, session) => truncated.push({ event, details, sessionId: session?.id ?? null }),
    onInjected: (built, _injection, info) => injected.push({ sessionId: info.session?.id ?? null, built }),
  });
  const handler = handlers.find((item) => item.event === 'agent/pre-step').handler;
  const session = { id: 'session-same-root' };
  await handler({ agent: { session }, step: 1 }, async () => ({ kind: 'accept', messages: [] }));

  assert.equal(truncated.length, 1, '必须写 header-truncated');
  assert.equal(truncated[0].event, 'header-truncated');
  assert.equal(truncated[0].details.count, 1, '超上限 1 条被截断');
  assert.equal(truncated[0].sessionId, 'session-same-root', '截断行必须带 session，才能与注入行落到同一根');
  assert.equal(injected.length, 1);
  assert.equal(injected[0].sessionId, 'session-same-root', '两行 session 相同 = 同根');

  // 同一 header：lines=3（标题行 + 1 条指针 + 截断提示）≠ pointers=2——rc.10 两值混用会都报 2。
  const fields = headerInjectedFields(injected[0].built, { messagesBefore: 0, messagesAfter: 1 });
  assert.equal(fields.lines, 3);
  assert.equal(fields.pointers, 2);
  assert.equal(fields.mode, 'session-pointers');
});
