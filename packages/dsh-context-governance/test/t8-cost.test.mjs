/**
 * T8-2：成本归属审计（REQUIREMENTS A）。
 *
 * 只做 token 归属，不记金额；实测与估算分列（backendCostSource / governanceCostSource），
 * 一条压缩周期一条 `compaction-cost`，不含任何正文/标题/路径。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx({ meterNodes = null } = {}) {
  const handlers = [];
  const logs = [];
  const ctx = {
    handlers,
    logs,
    get(name) {
      if (name === 'compaction') return new BasicCompactionEngine();
      if (name === 'tokenMeter' && meterNodes !== null) {
        return {
          measure(session) {
            const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
            return { nodes: nodes.map((seq) => ({ seq, tokens: meterNodes })) };
          },
        };
      }
      return undefined;
    },
    logger: {
      info: () => {},
      warn: (...args) => logs.push(['warn', ...args]),
      error: () => {},
    },
  };
  ctx.on = (event, handler) => {
    handlers.push({ event, handler });
    return () => {};
  };
  return ctx;
}

function liveSession(built) {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 30_000;
  const appended = [];
  const session = {
    id: 'session-t8',
    appended,
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const event = { seq: nextSeq++, type, data, time: Date.now(), ...opts };
      bySeq.set(event.seq, event);
      if (type === 'user/message' && opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      appended.push(event);
      return event;
    },
  };
  return session;
}

const eventOf = (built, type) => built.events.find((item) => item.type === type);
const checkpointOf = (built) => built.events.find(
  (item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint',
);

function runCycle(ctx, session, built) {
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointOf(built));
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
}

async function flush() {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function withStore(fn) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    await fn(store, rootDir);
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

async function readAudit(store) {
  const text = await fs.readFile(path.join(store.rootDir, 'audit.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('T8-2 成本记录：主键/维度/数值/口径齐全，实测与估算分列', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx({ meterNodes: 100 });
    const guard = new CompressionGuard({
      ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger, project: 'DSH插件开发',
    });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();

    const audit = await readAudit(store);
    const cost = audit.find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost, '缺少 compaction-cost 记录');
    assert.equal(cost.compactionId, built.compactionId);
    assert.equal(cost.sessionId, 'session-t8');
    assert.equal(cost.project, 'DSH插件开发');
    assert.equal(cost.trigger, 'auto');
    assert.equal(cost.backend, 'host-basic');
    assert.equal(cost.model, 'test/test');
    assert.match(cost.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
    // tokenMeter 提供 tokensBefore/After（每节点 100，按 surface 节点数）
    assert.equal(cost.tokensBefore, built.session.surface.nodes.length * 100);
    assert.equal(cost.tokensAfter, session.surface.nodes.length * 100, 'after 包含本次回注新增的节点');
    // 压缩事件提供 shadowed/summary/usage
    assert.equal(cost.tokensShadowed, 1000);
    assert.equal(cost.tokensSummary, 10);
    assert.deepEqual(cost.backendUsage, {
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20,
    });
    // 回注 token 为字符估算
    assert.ok(cost.tokensInjected > 0);
    assert.ok(cost.injectedEntries >= 1);
    assert.equal(cost.backendCostSource, 'measured');
    assert.equal(cost.governanceCostSource, 'estimated');
    assert.equal(cost.estimateMethod, 'chars/4');
    assert.equal(cost.auditVersion, 'cost-v1');
    assert.equal(typeof cost.tokensDropped, 'number');
    guard.stop();
  });
});

test('T8-2 成本记录：无 tokenMeter / 无 usage 时标 unknown，不伪造数字', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({
      before: healthyMessages(),
      summary: '自由摘要，没有五段标题。',
      start: 2,
      end: 11,
    });
    const summaryEvent = built.events.find((item) => item.type === 'compaction/summary');
    summaryEvent.data.usage = undefined;
    delete summaryEvent.data.shadowedTokenCount;
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.tokensBefore, null);
    assert.equal(cost.tokensAfter, null);
    assert.equal(cost.backendUsage, undefined, '没有 usage 时不写 backendUsage');
    assert.equal(cost.backendCostSource, 'unknown');
    assert.equal(cost.tokensSummary, null);
    assert.equal(cost.tokensShadowed, null, '缺 shadowedTokenCount 应为 null（不是 0）');
    assert.equal(cost.governanceCostSource, 'estimated', '回注仍有字符估算');
    guard.stop();
  });
});

test('P3：usage={} 空对象时标 unknown，不写 backendUsage', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const summaryEvent = built.events.find((item) => item.type === 'compaction/summary');
    summaryEvent.data.usage = {};
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.backendUsage, undefined, '空 usage 不应写 backendUsage');
    assert.equal(cost.backendCostSource, 'unknown', '空 usage 应标 unknown');
    assert.equal(cost.tokensSummary, null);
    guard.stop();
  });
});

test('P3：late-start 周期的 trigger 按 summary.sourceCommandId 判定 manual', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const summary = built.events.find((item) => item.type === 'compaction/summary');
    summary.data.sourceCommandId = 'cmd-late-manual';
    const session = liveSession(built);
    const handler = ctx.handlers[0].handler;
    // 模拟晚挂载：只看到 summary，没看到 start
    handler(session, summary);
    session.surface.nodes = [...built.postSurface];
    handler(session, built.events.find((item) => item.type === 'compaction/end'));
    await flush();
    const cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.trigger, 'manual');
    guard.stop();
  });
});

test('T8-2 成本记录不含正文/标题/路径', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx({ meterNodes: 10 });
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const raw = await fs.readFile(path.join(store.rootDir, 'audit.jsonl'), 'utf8');
    for (const needle of ['最新一条用户消息', '继续。', '511/958', 'D:\\\\backup', 'pre-t3.zip', 'Goal and intent']) {
      assert.equal(raw.includes(needle), false, `audit 泄漏 ${needle}`);
    }
    guard.stop();
  });
});

test('T8-2 tokensDropped：下一次压缩 shadow 掉回注时计入成本', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx({ meterNodes: 10 });
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const [injected] = session.appended;
    assert.ok(injected, '前置：第一次周期应回注');

    const built2 = buildCompaction({
      compactionId: 'cmp-drop',
      startSeq: 300,
      summarySeq: 301,
      checkpointSeq: 302,
      endSeq: 303,
      before: healthyMessages(),
      summary: FIVE_SECTION_SUMMARY,
      start: 2,
      end: 11,
      shadowedSeqs: [injected.seq],
    });
    runCycle(ctx, liveSession(built2), built2);
    await flush();
    const cost = (await readAudit(store)).filter((entry) => entry.event === 'compaction-cost').at(-1);
    assert.equal(cost.compactionId, 'cmp-drop');
    assert.ok(cost.tokensDropped > 0, 'tokensDropped 应来自 reinjection-shadowed');
    guard.stop();
  });
});

test('P3-2 shadowedSeqs 缺失时用 shadowedRange 兜底判定回注被吞', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx({ meterNodes: 10 });
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const [injected] = session.appended;
    assert.ok(injected);

    const built2 = buildCompaction({
      compactionId: 'cmp-range',
      startSeq: 300,
      summarySeq: 301,
      checkpointSeq: 302,
      endSeq: 303,
      before: healthyMessages(),
      summary: FIVE_SECTION_SUMMARY,
      start: 2,
      end: 11,
      shadowedSeqs: [],
    });
    const summaryEvent = built2.events.find((item) => item.type === 'compaction/summary');
    summaryEvent.data.shadowedSeqs = [];
    summaryEvent.data.shadowedRange = { start: injected.seq, end: injected.seq };
    runCycle(ctx, liveSession(built2), built2);
    await flush();
    const audit = await readAudit(store);
    assert.ok(audit.some((entry) => entry.event === 'reinjection-shadowed' && entry.compactionId === 'cmp-range'),
      'shadowedRange 兜底失败：没有 reinjection-shadowed');
    guard.stop();
  });
});
