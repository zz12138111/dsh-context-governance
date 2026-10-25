/**
 * P2 回归：项目归属过滤 + captureTitle 隐私开关。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { buildProtectionItems } from '../src/compress/protection-memory.js';
import { resolveConfig } from '../src/index.js';
import { MemoryStore } from '../src/memory/store.js';
import { buildProtectionSnapshotFixture } from './p2-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx() {
  const handlers = [];
  const logs = [];
  return {
    handlers,
    logs,
    get: (name) => (name === 'compaction' ? new BasicCompactionEngine() : undefined),
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    on(event, handler) { handlers.push({ event, handler }); return () => {}; },
  };
}

async function withStore(fn) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    await fn(store, rootDir);
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

const projectRoot = path.resolve('D:\\work\\demo');

function sessionWithCwd(cwd, id = 'session-p2') {
  return { id, header: { id, cwd }, surface: { nodes: [1, 2] }, eventAt: () => undefined, append: () => ({ seq: 99 }) };
}

test('P2-1：别的 cwd 的会话压缩被忽略，不写本记忆、不回注', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({
      ctx,
      hostVersion: '0.2.1-rc.3',
      store,
      logger: ctx.logger,
      projectRoot,
      onlyProject: true,
    });
    guard.start();
    const foreign = sessionWithCwd('D:\\work\\other-project');
    ctx.handlers[0].handler(foreign, { type: 'compaction/start', seq: 1, data: { compactionId: 'cmp-foreign' } });
    ctx.handlers[0].handler(foreign, { type: 'compaction/end', seq: 2, data: { compactionId: 'cmp-foreign' } });
    const status = guard.status;
    assert.equal(status.stats.starts, 0);
    assert.equal(status.stats.protectionWrites, 0);
    assert.equal(status.scope.ignoredForeignEvents, 2);
    assert.equal(status.scope.ignoredForeignSessions, 1);
    assert.equal(store.protectionPending, 0);
    assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && message.includes('ignoring session')));
    guard.stop();
  });
});

test('P2-1：同 cwd 会话照常处理；cwd 未知时放行但计数', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({
      ctx,
      hostVersion: '0.2.1-rc.3',
      store,
      logger: ctx.logger,
      projectRoot,
      onlyProject: true,
    });
    guard.start();
    const own = sessionWithCwd(projectRoot.toUpperCase(), 'session-own');
    ctx.handlers[0].handler(own, { type: 'compaction/start', seq: 1, data: { compactionId: 'cmp-own' } });
    assert.equal(guard.status.stats.starts, 1);

    const unknown = { id: 'session-unknown', surface: { nodes: [] }, eventAt: () => undefined, append: () => ({ seq: 1 }) };
    ctx.handlers[0].handler(unknown, { type: 'compaction/start', seq: 2, data: { compactionId: 'cmp-unknown' } });
    assert.equal(guard.status.stats.starts, 2);
    assert.equal(guard.status.scope.unattributedEvents, 1);
    guard.stop();
  });
});

test('P2-1：onlyProject=false 时全部会话都处理（显式 opt-out）', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({
      ctx,
      hostVersion: '0.2.1-rc.3',
      store,
      logger: ctx.logger,
      projectRoot,
      onlyProject: false,
    });
    guard.start();
    ctx.handlers[0].handler(sessionWithCwd('D:\\work\\other'), { type: 'compaction/start', seq: 1, data: { compactionId: 'cmp-x' } });
    assert.equal(guard.status.stats.starts, 1);
    guard.stop();
  });
});

test('P2-2：captureTitle=false 只存通用标签与指针，不存首行', () => {
  const snapshot = buildProtectionSnapshotFixture();
  const captured = buildProtectionItems(snapshot, { sessionId: 'session-p2', cycleKey: 'c1' });
  assert.ok(captured.items.some((item) => item.title.includes('敏感首行')), '默认应保留首行');
  const off = buildProtectionItems(snapshot, { sessionId: 'session-p2', cycleKey: 'c1', captureTitle: false });
  for (const item of off.items) {
    assert.equal(item.title.includes('敏感首行'), false, `captureTitle=false 仍泄漏标题：${item.title}`);
  }
  assert.ok(off.items.some((item) => item.title === '最新用户消息'));
  assert.ok(off.items.every((item) => typeof item.source === 'string' && item.source.startsWith('session:session-p2#')));
  assert.equal(off.items.length, captured.items.length, '条目数量不应因隐私开关变化');
});

test('P2-2：默认 captureTitle 开启；配置非法布尔直接拒绝', () => {
  assert.equal(resolveConfig({}).captureTitle, true);
  assert.equal(resolveConfig({}).onlyProject, true);
  assert.equal(resolveConfig({ captureTitle: false }).captureTitle, false);
  assert.throws(() => resolveConfig({ captureTitle: 'yes' }), /captureTitle must be a boolean/);
  assert.throws(() => resolveConfig({ onlyProject: 1 }), /onlyProject must be a boolean/);
});
