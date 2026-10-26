import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import {
  FIVE_SECTION_SUMMARY,
  FREE_FORM_SUMMARY,
  buildCompaction,
  healthyMessages,
} from './compress-helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

class ContextZipEngine {
  constructor() {
    this.undoManualSeat = () => {};
    this.declaredConfig = {};
  }
  compactNow() {}
  compactRegion() {}
}

function makeCtx(compaction) {
  const handlers = [];
  const logs = [];
  let disposed = 0;
  return {
    handlers,
    logs,
    get disposed() { return disposed; },
    get(name) { return name === 'compaction' ? compaction : undefined; },
    on(event, handler) {
      handlers.push({ event, handler });
      return () => { disposed += 1; };
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
  };
}

function emitAll(ctx, { session, events, postSurface }) {
  const handler = ctx.handlers.find((item) => item.event === 'session/event').handler;
  for (const event of events) {
    if (event.type === 'compaction/end') session.surface.nodes = [...postSurface];
    handler(session, event);
  }
}

const flushEnd = () => new Promise((resolve) => setImmediate(resolve));

test('宿主默认：完整压缩事务产生 full 模式与通过报告', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  assert.equal(ctx.handlers[0].event, 'session/event');
  assert.equal(guard.mode, 'full');
  assert.equal(guard.adapter.kind, 'host-basic');

  const built = buildCompaction({ before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
  emitAll(ctx, built);
  await flushEnd();
  const status = guard.status;
  assert.equal(status.stats.starts, 1);
  assert.equal(status.stats.summaries, 1);
  assert.equal(status.stats.ends, 1);
  assert.equal(status.lastReport.protection, 'ok', JSON.stringify(status.lastReport.failures));
  assert.equal(status.lastReport.compaction, 'committed');
  assert.equal(status.lastReport.lateSnapshot, false);
  assert.equal(guard.reports().length, 1);
  assert.equal(ctx.logs.some(([level]) => level === 'warn' && String(level).includes('protection')), false);
  guard.stop();
});

test('S1：waitForReport 在回注收尾后返回本 cycle 报告', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
  const pending = guard.waitForReport({ previousCompactionId: 'old', sessionId: built.session.id, timeoutMs: 200 });
  emitAll(ctx, built);
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, 'none');
  assert.equal(Number.isInteger(outcome.waitedMs), true);
  const report = outcome.report;
  assert.equal(report.compactionId, built.compactionId);
  assert.equal(report.sessionId, built.session.id);
  assert.equal(report.compaction, 'committed');
  await flushEnd();
  guard.stop();
});

test('S1.1：waitForReport 的默认上限是 3000ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  let result = 'pending';
  const pending = guard.waitForReport().then((value) => { result = value; });
  t.mock.timers.tick(2999);
  await Promise.resolve();
  assert.equal(result, 'pending', '2999ms 不得提前超时');
  t.mock.timers.tick(1);
  await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.report, null);
  guard.stop();
});

test('S1.1：waitForReport 的 timeoutMs 也被夹到 3000ms 上限', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  let result = 'pending';
  // 传 60000 也只能等 3000：大于 500 的旧上限也证明 clamp 与常量同源。
  const pending = guard.waitForReport({ timeoutMs: 60000 }).then((value) => { result = value; });
  t.mock.timers.tick(2999);
  await Promise.resolve();
  assert.equal(result, 'pending');
  t.mock.timers.tick(1);
  await pending;
  assert.equal(result.reason, 'timeout');
  guard.stop();
});

test('S1.1：报告 600ms 后才 ready 仍能等到（旧 500ms 上限会漏）', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
  const pending = guard.waitForReport({ previousCompactionId: 'old', sessionId: built.session.id });
  await new Promise((resolve) => setTimeout(resolve, 600));
  emitAll(ctx, built);
  const outcome = await pending;
  assert.equal(outcome.ok, true, '600ms 后才 ready 也必须等到');
  assert.equal(outcome.report.compactionId, built.compactionId);
  assert.equal(outcome.waitedMs >= 600, true, `waitedMs=${outcome.waitedMs} 应覆盖真实等待`);
  await flushEnd();
  guard.stop();
});

test('S1.1：waitForReport 区分 mismatch（别的会话抢先报告）', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
  const pending = guard.waitForReport({ previousCompactionId: 'old', sessionId: 'session-other', timeoutMs: 20 });
  emitAll(ctx, built);
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'mismatch', '有候选报告但不属于本会话 → mismatch');
  assert.equal(outcome.report, null);
  await flushEnd();
  guard.stop();
});

test('context-zip：识别五段摘要并保持 full', async () => {
  const ctx = makeCtx(new ContextZipEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2', backendVersion: '0.1.10' });
  guard.start();
  assert.equal(guard.adapter.kind, 'context-zip');
  const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
  emitAll(ctx, built);
  await flushEnd();
  assert.equal(guard.adapter.summary.style, 'five-section');
  assert.equal(guard.status.lastReport.protection, 'ok');
  assert.equal(guard.status.adapter.selfCheck.state, 'pass');
});

test('保护失败：报告 fail、写 warn，但不向宿主抛错', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 13 });
  assert.doesNotThrow(() => emitAll(ctx, built));
  await flushEnd();
  const report = guard.status.lastReport;
  assert.equal(report.protection, 'failed');
  assert.equal(report.compaction, 'committed');
  assert.ok(report.failures.some((failure) => failure.name === 'latest-user-message'));
  assert.equal(guard.status.stats.protectionFailures, 1);
  assert.equal(guard.status.stats.compactionFailures, 0);
  assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && String(message).includes('protection failed')));
});

test('0.2.2 保护失败：diagnostics 文件留一行（宿主 logger 之外的复核证据）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-diag-'));
  const file = path.join(dir, 'governance.log');
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2', diagnosticsLogFile: file });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 13 });
  emitAll(ctx, built);
  await flushEnd();
  const text = await fs.readFile(file, 'utf8');
  const line = text.split('\n').find((item) => item.includes('compaction protection failed'));
  assert.ok(line, 'diagnostics 文件必须有保护失败行');
  assert.match(line, /compaction protection failed \(\d+\): latest-user-message/);
  assert.ok(line.length < 200, '只记 names，不写 detail/正文');
  guard.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('插件在压缩事务中途挂上：用 summary 时补快照并标 lateSnapshot', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
  const handler = ctx.handlers[0].handler;
  const summaryEvent = built.events.find((item) => item.type === 'compaction/summary');
  const checkpointEvent = built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint');
  const endEvent = built.events.find((item) => item.type === 'compaction/end');
  handler(built.session, summaryEvent);
  handler(built.session, checkpointEvent);
  built.session.surface.nodes = built.postSurface;
  handler(built.session, endEvent);
  await flushEnd();
  const report = guard.status.lastReport;
  assert.equal(report.lateSnapshot, true);
  assert.equal(report.protection, 'ok', JSON.stringify(report.failures));
});

test('没有 compaction 服务：走事件级感知（event-level），不抛错', () => {
  const ctx = makeCtx(null);
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  assert.equal(guard.mode, 'event-level');
  assert.ok(guard.status.reasons.includes('event-perception-only'));
  assert.ok(guard.status.conflicts.some((conflict) => conflict.code === 'no-compaction-service'));
  assert.doesNotThrow(() => guard.stop());
});

test('畸形事件被忽略而不是抛错', () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const handler = ctx.handlers[0].handler;
  assert.doesNotThrow(() => handler(null, null));
  assert.doesNotThrow(() => handler({ surface: {} }, { type: 'compaction/summary', data: null }));
  assert.equal(guard.status.stats.events, 2);
  assert.equal(guard.status.stats.protectionFailures, 0);
  assert.equal(guard.status.stats.compactionFailures, 0);
});

test('两个会话的压缩事务互不串报告', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const a = buildCompaction({ compactionId: 'A', startSeq: 100, summarySeq: 101, checkpointSeq: 102, endSeq: 103, before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
  const b = buildCompaction({ compactionId: 'B', startSeq: 200, summarySeq: 201, checkpointSeq: 202, endSeq: 203, before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
  const handler = ctx.handlers[0].handler;
  const startA = a.events.find((item) => item.type === 'compaction/start');
  const summaryA = a.events.find((item) => item.type === 'compaction/summary');
  const startB = b.events.find((item) => item.type === 'compaction/start');
  const summaryB = b.events.find((item) => item.type === 'compaction/summary');
  const cpA = a.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint');
  const cpB = b.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint');
  const endA = a.events.find((item) => item.type === 'compaction/end');
  const endB = b.events.find((item) => item.type === 'compaction/end');
  handler(a.session, startA);
  handler(b.session, startB);
  handler(a.session, summaryA);
  handler(b.session, summaryB);
  handler(a.session, cpA);
  handler(b.session, cpB);
  a.session.surface.nodes = a.postSurface;
  b.session.surface.nodes = b.postSurface;
  handler(a.session, endA);
  handler(b.session, endB);
  await flushEnd();
  assert.equal(guard.reports().length, 2);
  assert.equal(guard.status.stats.pending, 0);
  assert.ok(guard.reports().every((report) => report.protection === 'ok'));
});

test('stop 幂等且释放订阅', () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  guard.stop();
  assert.equal(ctx.disposed, 1);
  assert.doesNotThrow(() => guard.stop());
});

test('不替换 provider：引擎实例与自有配置保持原样', () => {
  const engine = new BasicCompactionEngine();
  engine.config = { thresholdRatio: 0.65 };
  const beforeKeys = Object.keys(engine).sort();
  const ctx = makeCtx(engine);
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
  emitAll(ctx, built);
  guard.stop();
  assert.equal(ctx.get('compaction'), engine);
  assert.deepEqual(Object.keys(engine).sort(), beforeKeys);
  assert.deepEqual(engine.config, { thresholdRatio: 0.65 });
});

test('报告区分手动压缩与自动压缩', async () => {
  const ctx = makeCtx(new BasicCompactionEngine());
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2' });
  guard.start();
  const built = buildCompaction({ before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
  // 把 start 事件替换成手动压缩（sourceCommandId）。
  const start = built.events.find((item) => item.type === 'compaction/start');
  start.data.sourceCommandId = 'cmd-test';
  emitAll(ctx, built);
  await flushEnd();
  assert.equal(guard.status.lastReport.manual, true);
});
