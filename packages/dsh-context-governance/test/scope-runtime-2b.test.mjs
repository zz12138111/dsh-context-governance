/**
 * 1.0 #1（B-1）runtime：外部会话宿主原生压缩只记事实与用量。
 *
 * 断言口径（审核）：
 * - compaction-cost 字段齐全（sessionId/occurredAt/backend/前后 tokens/source=host-native）；
 * - 无 protection-write / reinjection* 事件；不写 store/记忆；本项目 lastCost 不被外部覆盖；
 * - onlyProject=false + 注入 resolveScope（生产形态）时外部仍 skip（旧 opt-out 只对无 resolver 的直接构造保留）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { resolveScope } from '../src/scope.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

const ROOT = path.resolve('D:\\work\\demo');
const OUTSIDE = 'G:\\DS-HARNESS';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx({ tokenMeter = null } = {}) {
  const handlers = [];
  const logs = [];
  const ctx = {
    handlers,
    logs,
    get(name) {
      if (name === 'compaction') return new BasicCompactionEngine();
      if (name === 'tokenMeter') return tokenMeter;
      return undefined;
    },
    on(event, handler) {
      handlers.push({ event, handler });
      return () => {};
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
  };
  return ctx;
}

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); return true; } };
}

function sessionOf(id, cwd) {
  return { id, header: { id, cwd }, cwd, surface: { nodes: [] }, eventAt: () => undefined };
}

function emit(ctx, session, event) {
  const handler = ctx.handlers.find((item) => item.event === 'session/event').handler;
  handler(session, event);
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeGuard(overrides = {}) {
  return new CompressionGuard({
    ctx: overrides.ctx ?? makeCtx(),
    hostVersion: '0.2.1-rc.2',
    projectRoot: ROOT,
    project: 'demo',
    resolveScope: (session) => resolveScope({ root: ROOT, cwd: session?.cwd ?? '' }),
    audit: overrides.audit ?? makeAudit(),
    store: overrides.store ?? null,
    onlyProject: overrides.onlyProject ?? true,
  });
}

function foreignCycle(compactionId = 'foreign-1') {
  return [
    {
      seq: 1,
      type: 'compaction/start',
      time: 1790000000005,
      data: { compactionId, sourceCommandId: 'cmd-foreign' },
    },
    {
      seq: 2,
      type: 'compaction/summary',
      time: 1790000000006,
      data: {
        compactionId,
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1020 },
        shadowedTokenCount: 500,
      },
    },
    { seq: 3, type: 'compaction/end', time: 1790000000007, data: { compactionId } },
  ];
}

test('2b runtime：外部会话压缩 → 一条 host-native cost（字段齐全、无保护/回注）', async () => {
  let tokens = 1000;
  const ctx = makeCtx({ tokenMeter: { measure: () => ({ nodes: [{ tokens }] }) } });
  const audit = makeAudit();
  const guard = makeGuard({ ctx, audit });
  guard.start();
  const session = sessionOf('foreign-1', OUTSIDE);
  const [start, summary, end] = foreignCycle();
  emit(ctx, session, start);
  emit(ctx, session, summary);
  tokens = 400;
  emit(ctx, session, end);
  await flush();

  const rows = audit.entries.filter((entry) => entry.event === 'compaction-cost');
  assert.equal(rows.length, 1, '一条真实压缩必须恰一条 cost');
  const row = rows[0];
  assert.equal(row.sessionId, 'foreign-1');
  assert.equal(row.source, 'host-native');
  assert.equal(row.compactionId, 'foreign-1');
  assert.equal(row.occurredAt, new Date(end.time).toISOString());
  assert.equal(row.trigger, 'manual', 'sourceCommandId → manual');
  assert.equal(row.tokensBefore, 1000);
  assert.equal(row.tokensBeforeSource, 'tokenMeter');
  assert.equal(row.tokensAfter, 400);
  assert.equal(row.tokensAfterSource, 'tokenMeter');
  assert.equal(row.tokensShadowed, 500);
  assert.equal(typeof row.backend, 'string');
  assert.equal(row.project, undefined, '外部会话不冒充本项目 project');
  assert.equal(row.tokensInjected, undefined, '外部 cost 不含回注字段');
  assert.equal(row.injectedEntries, undefined);
  assert.equal(row.pruneCount, undefined, '外部 cost 不含 prune 字段');
  assert.equal(row.governanceCostSource, undefined);
  assert.equal(audit.entries.some((entry) => /^protection-/.test(entry.event)), false, '不得写 protection-*');
  assert.equal(audit.entries.some((entry) => /^reinjection/.test(entry.event)), false, '不得写 reinjection*');
  assert.equal(guard.status.lastCost, null, '外部 cost 不覆盖本项目 last-cost');
  assert.equal(guard.status.stats.starts, 0);
  assert.equal(guard.status.scope.foreignStarts, 1);
  assert.equal(guard.status.scope.foreignSummaries, 1);
  assert.equal(guard.status.scope.foreignCosts, 1);
  guard.stop();
});

test('2b runtime：外部会话只观测到 end（中途挂载）→ 仍写一条 cost，reason 标未观测 start', async () => {
  const ctx = makeCtx({ tokenMeter: { measure: () => ({ nodes: [{ tokens: 777 }] }) } });
  const audit = makeAudit();
  const guard = makeGuard({ ctx, audit });
  guard.start();
  const session = sessionOf('foreign-late', OUTSIDE);
  const end = { seq: 9, type: 'compaction/end', time: 1790000000009, data: { compactionId: 'late-1' } };
  emit(ctx, session, end);
  emit(ctx, session, end); // 同一个 end 重复到达：不得重复记账
  await flush();
  const rows = audit.entries.filter((entry) => entry.event === 'compaction-cost');
  assert.equal(rows.length, 1, '同一 compactionId 的重复 end 不得重复写 cost');
  const row = rows[0];
  assert.ok(row, '不得整行缺失');
  assert.equal(row.source, 'host-native');
  assert.equal(row.reason, 'compaction/start was not observed');
  assert.equal(row.tokensBefore, 777);
  assert.equal(row.tokensAfter, 777);
  guard.stop();
});

test('2b runtime：外部与本项目交错 → cost 行不串、本项目 lastCost 不被外部覆盖', async () => {
  const ctx = makeCtx({ tokenMeter: { measure: () => ({ nodes: [{ tokens: 500 }] }) } });
  const audit = makeAudit();
  const guard = makeGuard({ ctx, audit });
  guard.start();
  // 先外部
  const foreign = sessionOf('foreign-1', OUTSIDE);
  for (const item of foreignCycle('foreign-1')) emit(ctx, foreign, item);
  // 再本项目完整压缩
  const built = buildCompaction({ compactionId: 'own-1', before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
  built.session.id = 'own-1';
  built.session.cwd = ROOT;
  built.session.header = { id: 'own-1', cwd: ROOT };
  for (const item of built.events) {
    if (item.type === 'compaction/end') built.session.surface.nodes = [...built.postSurface];
    emit(ctx, built.session, item);
  }
  await flush();
  const rows = audit.entries.filter((entry) => entry.event === 'compaction-cost');
  assert.equal(rows.length, 2);
  const foreignRow = rows.find((row) => row.sessionId === 'foreign-1');
  const ownRow = rows.find((row) => row.sessionId === 'own-1');
  assert.ok(foreignRow, '外部 cost 行必须在');
  assert.ok(ownRow, '本项目 cost 行必须在');
  assert.equal(foreignRow.source, 'host-native');
  assert.equal(ownRow.source, undefined, '本项目 cost 行不写 host-native');
  assert.equal(ownRow.project, 'demo');
  assert.equal(guard.status.lastCost.compactionId, 'own-1', 'last-cost 只记本项目');
  guard.stop();
});

test('2b runtime：只挂 resolveScope（生产形态）时 onlyProject=false 也 skip 外部会话', async () => {
  const ctx = makeCtx();
  const audit = makeAudit();
  const guard = makeGuard({ ctx, audit, onlyProject: false });
  guard.start();
  const foreign = sessionOf('foreign-onlyproject', OUTSIDE);
  for (const item of foreignCycle('foreign-op')) emit(ctx, foreign, item);
  await flush();
  assert.equal(guard.status.stats.starts, 0, '外部会话不得进入保护/观测主路径');
  assert.equal(guard.status.scope.foreignCosts, 1);
  assert.equal(audit.entries.some((entry) => /^protection-/.test(entry.event)), false);
  guard.stop();
});

test('2b runtime：外部压缩不写 store/记忆（真实 store 目录零新增）', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const before = (await fs.readdir(rootDir)).sort();
    const audit = makeAudit();
    const ctx = makeCtx();
    const guard = makeGuard({ ctx, audit, store });
    guard.start();
    const foreign = sessionOf('foreign-store', OUTSIDE);
    for (const item of foreignCycle('foreign-store')) emit(ctx, foreign, item);
    await flush();
    assert.equal(store.protectionPending, 0);
    assert.equal(store.allEntries().length, 0);
    assert.equal(guard.status.stats.protectionWrites, 0);
    const after = (await fs.readdir(rootDir)).sort();
    assert.deepEqual(after, before, '外部会话不得在记忆根新增文件');
    assert.equal(audit.entries.filter((entry) => entry.event === 'compaction-cost').length, 1);
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
