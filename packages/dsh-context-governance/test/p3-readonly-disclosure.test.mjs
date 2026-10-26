/**
 * P3 L3：只读根 host-native 压缩的披露（protection=unavailable / b1-host-native-unprotected）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { buildCompaction, healthyMessages } from './compress-helpers.mjs';
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
    get(name) { return name === 'compaction' ? new BasicCompactionEngine() : undefined; },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    on(event, handler) { handlers.push({ event, handler }); return () => {}; },
  };
}

function liveSession(built, id = 'session-p3-readonly') {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 9000;
  return {
    id,
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

const eventOf = (built, type) => built.events.find((item) => item.type === type);
const checkpointOf = (built) => built.events.find(
  (item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint',
);

test('L3 负向：正常根不出现 unavailable / b1-host-native-unprotected', async () => {
  const base = await tempDir('cg-p3-normal-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const rootAuditRows = [];
  try {
    const ctx = makeCtx();
    const guard = new CompressionGuard({
      resolveScope: () => ({
        mode: 'single-root', root: 'D:/work/p3-normal', cwd: '', governed: true,
        skipReason: null, unattributed: false,
      }),
      ctx,
      hostVersion: '0.2.1-rc.3',
      store,
      rootAudit: { append: (event, details) => rootAuditRows.push({ event, details }) },
      rootId: 'root-p3-normal',
      projectRoot: 'D:/work/p3-normal',
      logger: ctx.logger,
    });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built, 'session-p3-normal');
    const handler = ctx.handlers[0].handler;
    handler(session, eventOf(built, 'compaction/start'));
    handler(session, eventOf(built, 'compaction/summary'));
    handler(session, checkpointOf(built));
    session.surface.nodes = [...built.postSurface];
    handler(session, eventOf(built, 'compaction/end'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = guard.status;
    assert.ok(status.lastReport !== null);
    assert.notEqual(status.lastReport.protection, 'unavailable');
    assert.equal(status.lastReport.protection, 'ok');
    assert.equal(rootAuditRows.some((row) => row.event === 'b1-host-native-unprotected'), false);
    await guard.flush();
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('L3：只读根 host-native → protection=unavailable + b1-host-native-unprotected', async () => {
  const base = await tempDir('cg-p3-readonly-');
  const blocker = path.join(base, 'not-a-dir');
  await fs.writeFile(blocker, 'x', 'utf8');
  const rootDir = path.join(blocker, 'memory');
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  const rootAuditRows = [];
  try {
    assert.equal(store.status.writable, false);
    const ctx = makeCtx();
    const guard = new CompressionGuard({
      resolveScope: () => ({
        mode: 'single-root',
        root: 'D:/work/p3-readonly',
        cwd: '',
        governed: true,
        skipReason: null,
        unattributed: false,
      }),
      ctx,
      hostVersion: '0.2.1-rc.3',
      store,
      rootAudit: { append: (event, details) => rootAuditRows.push({ event, details }) },
      rootId: 'root-p3-readonly',
      projectRoot: 'D:/work/p3-readonly',
      logger: ctx.logger,
    });
    guard.start();
    assert.equal(guard.readOnly, true);
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built);
    const handler = ctx.handlers[0].handler;
    handler(session, eventOf(built, 'compaction/start'));
    handler(session, eventOf(built, 'compaction/summary'));
    handler(session, checkpointOf(built));
    session.surface.nodes = [...built.postSurface];
    handler(session, eventOf(built, 'compaction/end'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const status = guard.status;
    assert.ok(status.lastReport !== null);
    assert.equal(status.lastReport.protection, 'unavailable');
    assert.match(status.lastReport.protectionReason ?? '', /^root-not-writable:|^load-failed|read-only/);
    assert.equal(status.stats.protectionWrites, 0);
    const b1 = rootAuditRows.find((row) => row.event === 'b1-host-native-unprotected');
    assert.ok(b1, '必须写 b1-host-native-unprotected');
    assert.equal(b1.details.protection, 'unavailable');
    assert.equal(b1.details.rootId, 'root-p3-readonly');
    assert.ok(ctx.logs.some(([level, line]) => level === 'warn' && line.includes('b1-host-native-unprotected')));
    assert.equal(await fs.stat(path.join(rootDir, 'audit.jsonl')).then(() => true, () => false), false);
    await guard.flush();
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
