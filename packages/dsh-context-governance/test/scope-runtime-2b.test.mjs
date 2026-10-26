/**
 * P1（B）runtime：非主根/无根会话**完全不碰**（不再有外部会话 cost-only 分支）。
 *
 * 断言：unmanaged-root / no-project-root → 零审计、零 store 写、零保护/回注；
 * 只有 managed（主根）会话才进入观测/保护/成本主路径。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
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

function scopeOf(root, { managed = true, skipReason = null } = {}) {
  return {
    mode: 'multi-root',
    root,
    cwd: root,
    governed: managed,
    skipReason: managed ? null : skipReason,
    unattributed: false,
    isSubagent: false,
  };
}

function cycle(compactionId = 'cmp-1') {
  return [
    { seq: 1, type: 'compaction/start', time: 1790000000005, data: { compactionId, sourceCommandId: 'cmd-1' } },
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

function makeGuard({ ctx = makeCtx(), audit = makeAudit(), store = null, resolveScope } = {}) {
  return new CompressionGuard({
    ctx,
    hostVersion: '0.2.1-rc.2',
    projectRoot: ROOT,
    project: 'demo',
    resolveScope,
    audit,
    store,
    onlyProject: false,
  });
}

for (const [label, scope] of [
  ['unmanaged-root', scopeOf(OUTSIDE, { managed: false, skipReason: 'unmanaged-root' })],
  ['no-project-root', scopeOf(null, { managed: false, skipReason: 'no-project-root' })],
]) {
  test(`P1 runtime：${label} → 零审计、零保护/回注、零 cost`, async () => {
    const ctx = makeCtx({ tokenMeter: { measure: () => ({ nodes: [{ tokens: 1000 }] }) } });
    const audit = makeAudit();
    const guard = makeGuard({ ctx, audit, resolveScope: () => scope });
    guard.start();
    const session = sessionOf('s-other', OUTSIDE);
    for (const item of cycle('cmp-other')) emit(ctx, session, item);
    await flush();
    assert.equal(audit.entries.length, 0, '不得写任何 per-root 审计（含 cost）');
    assert.equal(guard.status.stats.events, 0);
    assert.equal(guard.status.stats.starts, 0);
    const counter = label === 'unmanaged-root' ? guard.status.scope.unmanagedEvents : guard.status.scope.noRootEvents;
    assert.equal(counter, 3, 'start/summary/end 三个事件都只计数');
    guard.stop();
  });
}

test('P1 runtime：无 resolver + projectRoot → 根外会话按 unmanaged-root 兜底、零审计', async () => {
  const ctx = makeCtx();
  const audit = makeAudit();
  const guard = makeGuard({ ctx, audit, resolveScope: undefined });
  guard.start();
  const session = sessionOf('s-legacy-outside', OUTSIDE);
  for (const item of cycle('cmp-legacy')) emit(ctx, session, item);
  await flush();
  assert.equal(audit.entries.length, 0);
  assert.equal(guard.status.stats.starts, 0);
  assert.equal(guard.status.scope.unmanagedEvents, 3, 'start/summary/end 三个事件都只计数');
  assert.equal(ctx.logs.filter(([level]) => level === 'warn').length >= 1, true, '应留一次 warn');
  guard.stop();
});

test('P1 runtime：resolver 抛错/返回非对象 → 落根边界判定；根外仍零审计', async () => {
  for (const [index, resolver] of [
    () => { throw new Error('resolver exploded'); },
    () => null,
    () => 'not-an-object',
  ].entries()) {
    const ctx = makeCtx();
    const audit = makeAudit();
    const guard = makeGuard({ ctx, audit, resolveScope: resolver });
    guard.start();
    const session = sessionOf(`s-resolver-${index}`, OUTSIDE);
    for (const item of cycle(`cmp-resolver-${index}`)) emit(ctx, session, item);
    await flush();
    assert.equal(audit.entries.length, 0, `resolver#${index}`);
    assert.equal(guard.status.stats.starts, 0);
    guard.stop();
  }
});

test('P1 runtime：managed 会话照常观测 → 一条 cost + lastCost（含 project/治理字段）', async () => {
  let tokens = 1000;
  const ctx = makeCtx({ tokenMeter: { measure: () => ({ nodes: [{ tokens }] }) } });
  const audit = makeAudit();
  const guard = makeGuard({ ctx, audit, resolveScope: () => scopeOf(ROOT) });
  guard.start();
  const built = buildCompaction({ compactionId: 'own-1', before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
  built.session.id = 'own-1';
  built.session.cwd = ROOT;
  built.session.header = { id: 'own-1', cwd: ROOT };
  for (const item of built.events) {
    if (item.type === 'compaction/end') built.session.surface.nodes = [...built.postSurface];
    emit(ctx, built.session, item);
  }
  tokens = 400;
  await flush();
  const rows = audit.entries.filter((entry) => entry.event === 'compaction-cost');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.project, 'demo');
  assert.equal(row.sessionId, 'own-1');
  assert.equal(typeof row.tokensShadowed, 'number');
  assert.equal(Number.isFinite(row.tokensInjected), true);
  assert.equal(guard.status.lastCost.compactionId, 'own-1');
  guard.stop();
});

test('P1 runtime：unmanaged 会话不写真实 store/记忆（目录零新增）', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const before = (await fs.readdir(rootDir)).sort();
    const ctx = makeCtx();
    const audit = makeAudit();
    const guard = makeGuard({ ctx, audit, store, resolveScope: () => scopeOf(OUTSIDE, { managed: false, skipReason: 'unmanaged-root' }) });
    guard.start();
    const session = sessionOf('s-store', OUTSIDE);
    for (const item of cycle('cmp-store')) emit(ctx, session, item);
    await flush();
    assert.equal(store.protectionPending, 0);
    assert.equal(store.allEntries().length, 0);
    assert.equal(guard.status.stats.protectionWrites, 0);
    assert.deepEqual((await fs.readdir(rootDir)).sort(), before);
    assert.equal(audit.entries.length, 0);
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
