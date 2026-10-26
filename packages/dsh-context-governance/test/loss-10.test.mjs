/**
 * 1.0 #10：统一 compaction-loss（auto/manual 都写、旧名只读）+ /cg status last-loss。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx() {
  const handlers = [];
  return {
    handlers,
    get(name) { return name === 'compaction' ? new BasicCompactionEngine() : undefined; },
    on(event, handler) { handlers.push({ event, handler }); return () => {}; },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function scopeResolver() {
  return { mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false };
}

function liveSession(built) {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 1000;
  return {
    id: built.session.id,
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt(seq) { return bySeq.get(seq); },
    append(type, data, opts) {
      const event = { seq: nextSeq++, type, data, time: Date.now(), ...opts };
      bySeq.set(event.seq, event);
      if (type === 'user/message' && opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      return event;
    },
  };
}

function eventOf(built, type) {
  return built.events.find((event) => event.type === type);
}

function emitThroughEnd(ctx, session, built) {
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  const checkpoint = built.events.find((event) =>
    event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint');
  handler(session, checkpoint);
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
}

function emitWithoutStart(ctx, session, built) {
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/summary'));
  const checkpoint = built.events.find((event) =>
    event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint');
  handler(session, checkpoint);
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function readAudit(store) {
  const file = path.join(store.rootDir, 'audit.jsonl');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function withStore(fn) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    await fn(store);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function lossBuilt(compactionId, { manual = false, startSeq = 100 } = {}) {
  // start=end=13：latest-user 等保护项不在 shadow 内 → 保护失败（沿用 T4-3 fixture）。
  const built = buildCompaction({
    compactionId,
    startSeq,
    summarySeq: startSeq + 1,
    checkpointSeq: startSeq + 2,
    endSeq: startSeq + 3,
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 13,
    end: 13,
  });
  if (manual) eventOf(built, 'compaction/start').data.sourceCommandId = 'cmd-manual';
  return built;
}

test('#10 auto（manual:false）保护失败 → compaction-loss(auto) 恰 1 条', async () => {
  await withStore(async (store) => {
    const built = lossBuilt('loss-auto-1');
    const session = liveSession(built);
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: scopeResolver, ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      // 让 end 的 microtask 先把周期挂到 pendingCosts，再来首条 assistant/message 补齐 tokensAfter。
      await flush();
      ctx.handlers[0].handler(session, {
        seq: 9999,
        type: 'assistant/message',
        data: { usage: { inputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      });
      await flush();
      await guard.flush();
      const audit = await readAudit(store);
      const losses = audit.filter((entry) => entry.event === 'compaction-loss');
      assert.equal(losses.length, 1);
      assert.equal(losses[0].sessionId, session.id);
      assert.equal(losses[0].compactionId, 'loss-auto-1');
      assert.equal(losses[0].manual, false);
      assert.equal(losses[0].trigger, 'auto');
      assert.ok(losses[0].failures.includes('latest-user-message'));
      assert.equal(losses[0].entries, 4);
      assert.equal(losses[0].auditVersion, 'loss-v1.0');
      assert.equal(audit.some((entry) => entry.event === 'manual-compaction-loss'), false, '旧名不得新写');
      assert.equal(losses.length, 1, '同周期不得重复');
      const cost = audit.find((entry) => entry.event === 'compaction-cost');
      assert.equal(cost.auditVersion, 'cost-v1.4', 'cost 版本不随 loss 变');
    } finally {
      guard.stop();
    }
  });
});

test('#10 manual 保护失败 → compaction-loss(manual)，不写旧名', async () => {
  await withStore(async (store) => {
    const built = lossBuilt('loss-manual-1', { manual: true, startSeq: 200 });
    const session = liveSession(built);
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: scopeResolver, ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      const audit = await readAudit(store);
      const losses = audit.filter((entry) => entry.event === 'compaction-loss');
      assert.equal(losses.length, 1);
      assert.equal(losses[0].manual, true);
      assert.equal(losses[0].trigger, 'manual');
      assert.equal(losses[0].auditVersion, 'loss-v1.0');
      assert.equal(audit.some((entry) => entry.event === 'manual-compaction-loss'), false);
    } finally {
      guard.stop();
    }
  });
});

test('#10 两个周期（auto+manual）各一条 loss，不串', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: scopeResolver, ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      const auto = lossBuilt('loss-pair-auto', { startSeq: 300 });
      const session = liveSession(auto);
      emitThroughEnd(ctx, session, auto);
      await flush();
      const manual = lossBuilt('loss-pair-manual', { manual: true, startSeq: 500 });
      const manualSession = liveSession(manual);
      emitThroughEnd(ctx, manualSession, manual);
      await flush();
      await guard.flush();
      const losses = (await readAudit(store)).filter((entry) => entry.event === 'compaction-loss');
      assert.equal(losses.length, 2);
      assert.deepEqual(losses.map((entry) => entry.trigger), ['auto', 'manual']);
      assert.deepEqual(losses.map((entry) => entry.manual), [false, true]);
      assert.notEqual(losses[0].compactionId, losses[1].compactionId);
    } finally {
      guard.stop();
    }
  });
});

test('#10 保护通过（无 failures）→ 不写 loss', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({
      compactionId: 'loss-none',
      before: healthyMessages(),
      summary: FIVE_SECTION_SUMMARY,
      start: 2,
      end: 11,
    });
    const session = liveSession(built);
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: scopeResolver, ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      const audit = await readAudit(store);
      assert.equal(audit.some((entry) => entry.event === 'compaction-loss' || entry.event === 'manual-compaction-loss'), false);
    } finally {
      guard.stop();
    }
  });
});

test('#10 晚挂载（未观测 start）→ manual:false/trigger:auto', async () => {
  await withStore(async (store) => {
    const built = lossBuilt('loss-late-1', { startSeq: 600 });
    const session = liveSession(built);
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: scopeResolver, ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitWithoutStart(ctx, session, built);
      await flush();
      await guard.flush();
      const loss = (await readAudit(store)).find((entry) => entry.event === 'compaction-loss');
      assert.ok(loss);
      assert.equal(loss.manual, false);
      assert.equal(loss.trigger, 'auto');
      assert.equal(loss.reason, 'late-mount', '未观测 start 必须显式标 late-mount，不能把“不知道”写成确认自动');
    } finally {
      guard.stop();
    }
  });
});

function fakeAudit(entries) {
  return {
    file: 'fake-audit.jsonl',
    maxBytes: 1024,
    sizeBytes: 0,
    entries: () => entries.map((entry) => ({ ...entry })),
  };
}

async function statusOf(audit) {
  const command = createStatusCommand({ audit });
  return command.handler({ rawInput: 'status' });
}

test('#10 status last-loss：旧 manual-compaction-loss 只读兼容', async () => {
  const status = await statusOf(fakeAudit([{
    event: 'manual-compaction-loss',
    compactionId: 'oldloss0001',
    failures: ['latest-user-message'],
    entries: 4,
  }]));
  assert.match(status.text, /last-loss: id=oldloss0 manual=true trigger=manual failures=latest-user-message reason=-/);
});

test('#10 status last-loss：新事件优先显示 manual/trigger', async () => {
  const status = await statusOf(fakeAudit([
    { event: 'manual-compaction-loss', compactionId: 'oldloss0001', failures: ['latest-user-message'] },
    {
      event: 'compaction-loss',
      compactionId: 'newloss0002',
      manual: false,
      trigger: 'auto',
      failures: ['rule-injection'],
      entries: 4,
      auditVersion: 'loss-v1.0',
    },
  ]));
  assert.match(status.text, /last-loss: id=newloss0 manual=false trigger=auto failures=rule-injection reason=-/);
});
