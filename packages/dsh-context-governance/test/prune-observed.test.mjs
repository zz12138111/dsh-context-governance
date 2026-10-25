/**
 * T2′（REQ-20261025-02 收口版）：宿主 prune 观测 + 成本接入。
 *
 * 只读观测：不改 content、不 append 替换事件、不写任何落盘文件。
 * 用合成事件对齐宿主 `compaction/prune` + 紧随的 `tool/result` 替换形状。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import {
  FIVE_SECTION_SUMMARY,
  buildCompaction,
  checkpoint,
  compactionEnd,
  compactionStart,
  compactionSummary,
  event,
  healthyMessages,
} from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx({ meter = null } = {}) {
  const handlers = [];
  const ctx = {
    handlers,
    get(name) {
      if (name === 'compaction') return new BasicCompactionEngine();
      if (name === 'tokenMeter') return meter;
      if (name === 'commands') return { register: () => () => {} };
      return undefined;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  ctx.on = (eventName, handler) => {
    handlers.push({ event: eventName, handler });
    return () => {};
  };
  return ctx;
}

function meterFor(nodes = 10) {
  return {
    measure(session) {
      const surface = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
      return { nodes: surface.map((seq) => ({ seq, tokens: nodes })) };
    },
  };
}

function liveSession(events) {
  const bySeq = new Map(events.map((item) => [item.seq, item]));
  return {
    id: 'session-prune',
    surface: { nodes: events.map((item) => item.seq) },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const e = { seq: 90_000 + bySeq.size, type, data, ...opts };
      bySeq.set(e.seq, e);
      return e;
    },
  };
}

function toolCall(seq, callId, name = 'read') {
  return event(seq, 'tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' });
}

function prune(seq, start, end, tokens) {
  return event(seq, 'compaction/prune', {
    shadowedRange: { start, end },
    shadowedSeqs: [start],
    shadowedTokenCount: tokens,
  });
}

function replacement(seq, originalSeq, callId, text = 'SECRET-TOOL-BODY D:\\secret\\path') {
  return event(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text }],
    },
  }, {
    sourceEventSeqs: [originalSeq],
    surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
  });
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
  return { text, entries: text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function sendUntilStart(ctx, session, events) {
  const handler = ctx.handlers[0].handler;
  for (const item of events) handler(session, item);
}

function runStartSummaryCheckpointEnd(ctx, session, start, summary, checkpointEvent, end) {
  const handler = ctx.handlers[0].handler;
  handler(session, start);
  handler(session, summary);
  handler(session, checkpointEvent);
  session.surface.nodes = [...session.surface.nodes]; // surface unchanged by obs
  handler(session, end);
}

test('T2′ prune 归因：每条 prune 一行，callId 反查 tool，replacementSeq/cycle/字段齐全，无正文/路径', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({
      before: [toolCall(1, 'call-1', 'read'), prune(2, 10, 10, 4797), replacement(3, 10, 'call-1')],
      start: 2,
      end: 11,
      startSeq: 100,
      summarySeq: 101,
      checkpointSeq: 102,
      endSeq: 103,
    });
    const session = liveSession(built.events);
    sendUntilStart(ctx, session, built.events.filter((item) => item.seq < built.startSeq));
    runStartSummaryCheckpointEnd(ctx, session, built.events.find((item) => item.type === 'compaction/start'),
      built.events.find((item) => item.type === 'compaction/summary'), built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'),
      built.events.find((item) => item.type === 'compaction/end'));
    await flush();
    guard.stop();
    const { text, entries } = await readAudit(store);
    const observed = entries.find((entry) => entry.event === 'prune-observed');
    assert.ok(observed);
    assert.equal(observed.sessionId, 'session-prune');
    assert.equal(observed.seq, 2);
    assert.equal(observed.shadowedStart, 10);
    assert.equal(observed.shadowedEnd, 10);
    assert.equal(observed.shadowedTokenCount, 4797);
    assert.equal(observed.tool, 'read');
    assert.equal(observed.replacementSeq, 3);
    assert.equal(observed.cycle, 'current');
    const cost = entries.find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.auditVersion, 'cost-v1.4');
    assert.equal(cost.tokensPruned, 4797);
    assert.equal(cost.pruneCount, 1);
    assert.deepEqual(cost.pruneTools, ['read:1']);
    assert.equal(text.includes('SECRET-TOOL-BODY'), false, 'prune-observed 不得写工具正文');
    assert.equal(text.includes('D:\\\\secret'), false, 'prune-observed 不得写路径');
  });
});

test('T2′ 归因失败：替换事件查不到 tool/call → tool=unknown，不猜', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({
      before: [prune(2, 20, 20, 100), replacement(3, 20, 'call-missing')],
      start: 2,
      end: 11,
      startSeq: 100,
      summarySeq: 101,
      checkpointSeq: 102,
      endSeq: 103,
    });
    const session = liveSession(built.events);
    sendUntilStart(ctx, session, built.events.filter((item) => item.seq < built.startSeq));
    runStartSummaryCheckpointEnd(ctx, session, built.events.find((item) => item.type === 'compaction/start'),
      built.events.find((item) => item.type === 'compaction/summary'), built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'),
      built.events.find((item) => item.type === 'compaction/end'));
    await flush();
    guard.stop();
    const observed = (await readAudit(store)).entries.find((entry) => entry.event === 'prune-observed');
    assert.ok(observed);
    assert.equal(observed.tool, 'unknown');
    assert.equal(observed.replacementSeq, 3);
    assert.equal(observed.cycle, 'current');
  });
});

test('T2′ 周期归属：summary 之后的 prune 记 outside，不进本周期成本', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx({ meter: meterFor(10) });
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const events = [
      compactionStart(100, 'cmp-out'),
      compactionSummary(101, 'cmp-out', { summary: FIVE_SECTION_SUMMARY, start: 1, end: 9 }),
      prune(102, 30, 30, 333),
      replacement(103, 30, 'call-out', 'OUTSIDE BODY'),
      checkpoint(104, 'cmp-out'),
      compactionEnd(105, 'cmp-out'),
    ];
    const session = liveSession(events);
    const handler = ctx.handlers[0].handler;
    for (const item of events) handler(session, item);
    await flush();
    guard.stop();
    const { entries } = await readAudit(store);
    const observed = entries.find((entry) => entry.event === 'prune-observed');
    assert.ok(observed);
    assert.equal(observed.cycle, 'outside');
    const cost = entries.find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.pruneCount, 0);
    assert.equal(cost.tokensPruned, null);
    assert.deepEqual(cost.pruneTools, []);
  });
});

test('T2′ 去重：同一 shadowedRange 只记一次、成本只计一次', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({
      before: [
        toolCall(1, 'call-1', 'grep'),
        prune(2, 40, 40, 50),
        replacement(3, 40, 'call-1'),
        prune(4, 40, 40, 50),
        replacement(5, 40, 'call-1'),
      ],
      start: 2,
      end: 11,
      startSeq: 100,
      summarySeq: 101,
      checkpointSeq: 102,
      endSeq: 103,
    });
    const session = liveSession(built.events);
    sendUntilStart(ctx, session, built.events.filter((item) => item.seq < built.startSeq));
    runStartSummaryCheckpointEnd(ctx, session, built.events.find((item) => item.type === 'compaction/start'),
      built.events.find((item) => item.type === 'compaction/summary'), built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'),
      built.events.find((item) => item.type === 'compaction/end'));
    await flush();
    guard.stop();
    const { entries } = await readAudit(store);
    assert.equal(entries.filter((entry) => entry.event === 'prune-observed').length, 1);
    const cost = entries.find((entry) => entry.event === 'compaction-cost');
    assert.equal(cost.pruneCount, 1);
    assert.equal(cost.tokensPruned, 50);
  });
});

test('T2′ 无 pruner：pruneCount=0 + tokensPruned=null；/cg status 显示 pruned=0', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx({ meter: meterFor(10) });
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built.events);
    const handler = ctx.handlers[0].handler;
    handler(session, built.events.find((item) => item.type === 'compaction/start'));
    handler(session, built.events.find((item) => item.type === 'compaction/summary'));
    handler(session, built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'));
    session.surface.nodes = [...built.postSurface];
    handler(session, built.events.find((item) => item.type === 'compaction/end'));
    await flush();
    const cost = (await readAudit(store)).entries.find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.pruneCount, 0);
    assert.equal(cost.tokensPruned, null);
    assert.deepEqual(cost.pruneTools, []);
    const command = createStatusCommand({ store, getGuard: () => guard, audit: guard.auditLog });
    const result = await command.handler({ rawInput: 'status' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /pruned=0 tools=-/);
    const last = await command.handler({ rawInput: 'last-cost' });
    assert.equal(last.kind, 'success');
    assert.match(last.text, /pruned=0 tools=-/);
    guard.stop();
  });
});
