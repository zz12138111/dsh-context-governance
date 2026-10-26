/**
 * M1.2（REQ-20261025-03）：能力探测双行 + tokenMeter 延迟获取 + usage 兜底 +
 * cost-v1.1 来源字段（v1.2 增 prune） + /cg status 成本行。
 *
 * 只读单测：不改宿主、不写真实记忆；所有会话为合成事件。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';
import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx({ meterRef = { current: null }, injectable = false } = {}) {
  const handlers = [];
  const injectCallbacks = [];
  const ctx = {
    handlers,
    injectCallbacks,
    meterRef,
    get(name) {
      if (name === 'compaction') return new BasicCompactionEngine();
      if (name === 'tokenMeter') return meterRef.current;
      if (name === 'commands') return { register: () => () => {} };
      return undefined;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  ctx.on = (event, handler) => {
    handlers.push({ event, handler });
    return () => {};
  };
  if (injectable) {
    ctx.inject = (names, callback) => {
      injectCallbacks.push({ names, callback });
      return () => {};
    };
  }
  ctx.setMeter = (meter) => {
    meterRef.current = meter;
    for (const { callback } of injectCallbacks) callback({ tokenMeter: meter });
  };
  return ctx;
}

function meterFor(nodes = 100) {
  return {
    measure(session) {
      const surface = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
      return { nodes: surface.map((seq) => ({ seq, tokens: nodes })) };
    },
  };
}

function liveSession(built) {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 30_000;
  const session = {
    id: 'session-m12',
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const event = { seq: nextSeq++, type, data, time: Date.now(), ...opts };
      bySeq.set(event.seq, event);
      return event;
    },
  };
  return session;
}

const eventOf = (built, type) => built.events.find((item) => item.type === type);
const checkpointOf = (built) => built.events.find(
  (item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint',
);

function usageEvent(seq, usage) {
  return { seq, type: 'assistant/message', data: { usage } };
}

function runCycle(ctx, session, built) {
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointOf(built));
  handler(session, usageEvent(20_000, { inputTokens: 1, outputTokens: 1 }));
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
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

test('M1.2 tokenMeter：晚注册服务在 apply 后可用（按需获取 + inject 回调）', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx({ injectable: true });
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    // apply 时服务还不存在
    assert.equal(ctx.meterRef.current, null);
    ctx.setMeter(meterFor(100));
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.ok(cost.tokensBefore > 0);
    assert.ok(cost.tokensAfter > 0);
    assert.equal(cost.tokensBeforeSource, 'tokenMeter');
    assert.equal(cost.tokensAfterSource, 'tokenMeter');
    guard.stop();
  });
});

test('M1.2 tokenMeter：无 inject 时按需读取也能拿到晚注册服务', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx(); // 无 ctx.inject
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    ctx.setMeter(meterFor(50));
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.tokensBeforeSource, 'tokenMeter');
    assert.equal(cost.tokensAfterSource, 'tokenMeter');
    guard.stop();
  });
});

test('P3-1 ctx.inject 返回 Fiber：stop 调 fiber.dispose()，不把返回值当函数调用', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    let disposed = 0;
    ctx.inject = (_names, callback) => {
      callback({ tokenMeter: meterFor(10) });
      return { dispose() { disposed += 1; return Promise.resolve(); } };
    };
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    guard.stop();
    assert.equal(disposed, 1);
  });
});

test('M1.2 usage 兜底：meters 缺失时 tokensBefore/After 来自 assistant/message.usage', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    const handler = ctx.handlers[0].handler;
    // 压缩前最后一次模型调用
    handler(session, usageEvent(19_999, { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 7 }));
    runCycle(ctx, session, built);
    await flush();
    // compaction/end 后第一条 assistant/message
    handler(session, usageEvent(20_001, { inputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 3 }));
    await flush();
    const cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.tokensBefore, 125);
    assert.equal(cost.tokensAfter, 60);
    assert.equal(cost.tokensBeforeSource, 'usage');
    assert.equal(cost.tokensAfterSource, 'usage');
    assert.deepEqual(cost.tokensBeforeParts, { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5 });
    assert.deepEqual(cost.tokensAfterParts, { inputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 });
    guard.stop();
  });
});

test('M1.2 两路都缺：null + none，不伪造；stop 冲刷未等到 after 的成本行', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    let cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.equal(cost, undefined, '未到 after usage 前不落半条成本');
    guard.stop();
    cost = (await readAudit(store)).find((entry) => entry.event === 'compaction-cost');
    assert.ok(cost);
    assert.equal(cost.tokensBefore, null);
    assert.equal(cost.tokensAfter, null);
    assert.equal(cost.tokensBeforeSource, 'none');
    assert.equal(cost.tokensAfterSource, 'none');
    assert.equal(cost.auditVersion, 'cost-v1.4');
    assert.equal(cost.tokensPruned, null);
    assert.equal(cost.pruneCount, 0);
    assert.deepEqual(cost.pruneTools, []);
  });
});

test('M1.2 /cg status：last-cost 显示 before/after 与来源', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    ctx.setMeter(meterFor(10));
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    runCycle(ctx, liveSession(built), built);
    await flush();
    const command = createStatusCommand({ store, getGuard: () => guard, audit: guard.auditLog });
    const result = await command.handler({ rawInput: 'status' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /last-cost: before=\d+\(tokenMeter\) after=\d+\(tokenMeter\) trigger=auto/);
    guard.stop();
  });
});

test('M1.2 能力探测双行：apply + ready，ready 能看到晚注册的 compaction/tokenMeter', async () => {
  const rootDir = await tempDir();
  const logFile = path.join(rootDir, 'logs', 'governance.log');
  const handlers = [];
  const ctx = {
    tools: { register: () => {} },
    commands: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (callback) => { ctx.effectCallbacks.push(callback); },
    effectCallbacks: [],
    get(name) {
      if (name === 'tools') return ctx.tools;
      if (name === 'commands') return ctx.commands;
      if (name === 'compaction') return new BasicCompactionEngine();
      if (name === 'tokenMeter') return { measure: () => ({ nodes: [] }) };
      return undefined;
    },
    on: (event, handler) => {
      handlers.push({ event, handler });
      return () => {};
    },
  };
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.3', backendVersion: '' },
      diagnostics: { logFile },
    });
    const auditFile = path.join(rootDir, 'memory', 'governance', 'audit.jsonl');
    const initial = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(initial.some((entry) => entry.event === 'capability@apply'));
    assert.equal(initial.some((entry) => entry.event === 'capability@ready'), false);
    const handler = handlers.find((item) => item.event === 'session/event').handler;
    handler({ id: 's1' }, { type: 'turn/start', data: {} });
    const after = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const ready = after.find((entry) => entry.event === 'capability@ready');
    assert.ok(ready);
    assert.ok(ready.probe.some((item) => item.startsWith('get.compaction=obj')));
    assert.ok(ready.probe.some((item) => item.startsWith('get.tokenMeter=obj')));
    const log = await fs.readFile(logFile, 'utf8');
    assert.match(log, /capability@apply/);
    assert.match(log, /capability@ready/);
    const readyLine = log.split('\n').find((line) => line.includes('capability@ready'));
    assert.match(readyLine, /compaction=obj/);
    assert.match(readyLine, /get\.tokenMeter=obj/);
  } finally {
    for (const callback of ctx.effectCallbacks.splice(0)) {
      try { await callback(); } catch { /* ignore */ }
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
