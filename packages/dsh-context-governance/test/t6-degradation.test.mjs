/**
 * T6：失败与降级（v0.1.4）。
 *
 * 覆盖：审计轮转、审计追加失败、记忆根不可写（只读降级）、外部修改与恢复、
 * `ctx.on` 抛错、事件流中断（无 end 的周期）、只读下的回注。
 *
 * 统一判据：降级后仍要能跑完一次完整压缩周期（start → summary → checkpoint → end），
 * 且任何失败都不得抛给宿主。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../src/audit.js';
import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx({ withOn = true, onThrows = false } = {}) {
  const handlers = [];
  const logs = [];
  const ctx = {
    handlers,
    logs,
    get(name) { return name === 'compaction' ? new BasicCompactionEngine() : undefined; },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
  };
  if (withOn) {
    ctx.on = (event, handler) => {
      if (onThrows) throw new Error('events service unavailable');
      handlers.push({ event, handler });
      return () => {};
    };
  }
  return ctx;
}

function liveSession(built, id = 'session-t6') {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 9000;
  const appended = [];
  const session = {
    id,
    appended,
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt(seq) { return bySeq.get(seq); },
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
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 等一个异步恢复条件成立（最多 1s），避免依赖固定 tick 数。 */
async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function warns(ctx) {
  return ctx.logs.filter(([level]) => level === 'warn').map(([, message]) => message).join('\n');
}

async function withStore(fn, options = {}) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project', ...options });
  try {
    await fn(store, rootDir);
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

test('T6-audit-rotate：超限轮转 audit-YYYYMMDD.jsonl，记录一条不少', async () => {
  const rootDir = await tempDir();
  const file = path.join(rootDir, 'audit.jsonl');
  const clock = (() => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 9, 25) + tick++ * 1000);
  })();
  try {
    const audit = new AuditLog({ file, now: clock, maxBytes: 64 * 1024 });
    const records = 1500;
    for (let index = 0; index < records; index += 1) {
      assert.equal(audit.append('protection-write', { compactionId: `cmp-${index}`, count: 1, durationMs: 2 }), true);
    }
    assert.ok(audit.rotations >= 1, 'expected at least one rotation');
    const rotated = (await fs.readdir(rootDir)).filter((name) => /^audit-\d{8}(-\d+)?\.jsonl$/.test(name));
    assert.ok(rotated.length >= 1, `rotated files missing: ${rotated.join(',')}`);
    assert.ok(rotated.every((name) => name.startsWith('audit-20261025')), 'rotation name must carry the date');
    const all = [];
    for (const name of [...rotated, 'audit.jsonl']) all.push(...await readJsonl(path.join(rootDir, name)));
    assert.equal(all.length, records, 'rotation must not lose records');
    assert.equal(new Set(all.map((record) => record.compactionId)).size, records);
    assert.ok(audit.sizeBytes <= audit.maxBytes);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('T6-audit-failure：审计追加失败只告警，压缩周期照常完成', async () => {
  await withStore(async (store, rootDir) => {
    const blocker = path.join(rootDir, 'audit-blocker');
    await fs.writeFile(blocker, 'x', 'utf8');
    const audit = new AuditLog({ file: path.join(blocker, 'audit.jsonl'), maxBytes: 64 * 1024 });
    const ctx = makeCtx();
    const guard = new CompressionGuard({
      ctx,
      hostVersion: '0.2.1-rc.2',
      store,
      audit,
      logger: ctx.logger,
    });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built);
    assert.doesNotThrow(() => runCycle(ctx, session, built));
    await flush();
    const status = guard.status;
    assert.ok(status.lastReport !== null, 'cycle must still finish');
    assert.ok(status.stats.auditWriteFailures > 0, 'audit failure must be counted');
    assert.match(warns(ctx), /audit write failed/);
    guard.stop();
  });
});

test('T6-readonly-root：记忆根不可写 → 只读降级，周期完成且不写记忆/审计', async () => {
  const base = await tempDir();
  const blocker = path.join(base, 'not-a-dir');
  await fs.writeFile(blocker, 'x', 'utf8');
  const rootDir = path.join(blocker, 'memory');
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    assert.equal(store.status.writable, false);
    assert.match(store.status.readOnlyReason ?? '', /^root-not-writable|^load-failed/);
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    assert.equal(guard.readOnly, true);
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built);
    assert.doesNotThrow(() => runCycle(ctx, session, built));
    await flush();
    const status = guard.status;
    assert.ok(status.lastReport !== null);
    assert.equal(status.stats.protectionWrites, 0);
    assert.equal(status.protection.readOnly, true);
    assert.match(warns(ctx), /memory read-only|read-only \(/);
    assert.equal(await fs.stat(path.join(rootDir, 'audit.jsonl')).then(() => true, () => false), false);
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('T6-external-change：外部改动转只读，周期完成；reload 后恢复可写', async () => {
  await withStore(async (store, rootDir) => {
    await store.create({
      type: 'decision',
      title: '外部改动测试条目',
      detail: '用于 T6 外部修改恢复路径',
      writer: 'user',
      source: 'session:test#1',
    });
    const topic = path.join(rootDir, 'topics', 'decision.md');
    const text = await fs.readFile(topic, 'utf8');
    await fs.writeFile(topic, `${text}\n<!-- external edit -->\n`, 'utf8');

    // 存储层在下次写入前检测到外部改动：转只读并拒绝写。
    await assert.rejects(
      () => store.create({
        type: 'decision',
        title: '外部改动后写入',
        detail: '应被拒绝',
        writer: 'user',
        source: 'session:test#2',
      }),
      (error) => error?.name === 'ExternalModificationError',
    );
    assert.equal(store.status.writable, false);
    assert.match(store.status.readOnlyReason ?? '', /external-change/);

    // 只读期间仍要能跑完压缩周期（读旧记忆 + 回注既有指针）。
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    assert.equal(guard.readOnly, true);
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built);
    assert.doesNotThrow(() => runCycle(ctx, session, built));
    await flush();
    assert.ok(guard.status.lastReport !== null, 'cycle must finish while read-only');
    assert.equal(guard.status.stats.protectionWrites, 0);

    // 恢复：start 时的探测会重新加载并清掉只读；随后恢复写入。
    assert.equal(await waitFor(() => Promise.resolve(store.status.writable === true && guard.readOnly === false)), true,
      'start probe should clear read-only and recover the store');
    const built2 = buildCompaction({ compactionId: 'cmp-2', startSeq: 200, summarySeq: 201, checkpointSeq: 202, endSeq: 203, before: healthyMessages(), summary: '', start: 2, end: 11 });
    runCycle(ctx, liveSession(built2), built2);
    await flush();
    assert.ok(guard.status.stats.protectionWrites >= 1, 'writes resume after recovery');
    guard.stop();
  });
});

test('T6-ctx-on-throws：订阅抛错不崩，显式告警并保持未启动', () => {
  const ctx = makeCtx({ onThrows: true });
  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2' });
  assert.doesNotThrow(() => guard.start());
  assert.equal(guard.status.started, false);
  assert.match(warns(ctx), /registration failed/);
});

test('T6-cycle-interrupted：同会话新 start 未 end → cycle-interrupted；stop → cycle-abandoned', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const base = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(base);
    const startA = eventOf(base, 'compaction/start');
    ctx.handlers[0].handler(session, startA);
    // 第二个 start 直接到达（中间没有 summary/end）：模拟事件流中断。
    const interrupted = { ...startA, data: { ...startA.data, compactionId: 'cmp-second' } };
    ctx.handlers[0].handler(session, interrupted);
    await flush();
    const interruptedRecord = (await readJsonl(path.join(store.rootDir, 'audit.jsonl')))
      .find((entry) => entry.event === 'cycle-interrupted');
    assert.ok(interruptedRecord, 'interrupted cycle must be audited');
    assert.equal(guard.status.stats.interruptedCycles, 1);

    ctx.handlers[0].handler(session, { ...startA, data: { ...startA.data, compactionId: 'cmp-third' } });
    guard.stop();
    await flush();
    const abandoned = (await readJsonl(path.join(store.rootDir, 'audit.jsonl')))
      .filter((entry) => entry.event === 'cycle-abandoned');
    assert.ok(abandoned.length >= 1, 'pending cycle must be audited on dispose');
    assert.ok(guard.status.stats.abandonedCycles >= 1);
  });
});

test('T6-readonly-reinject：只读时仍可从既有记忆回注指针，不写新记忆/审计', async () => {
  const rootDir = await tempDir();
  const seed = await MemoryStore.open({ rootDir, project: 'test-project' });
  const sessionId = 'session-t6-readonly';
  seed.protectSync({
    cycleKey: 'seed-cycle',
    sessionId,
    items: [{
      type: 'progress',
      title: '只读回注种子条目',
      detail: 'T6 只读回注测试',
      writer: 'system',
      source: `session:${sessionId}#5`,
      confidence: 1,
      evidence: '',
    }],
  });
  const [seedEntry] = seed.allEntries();
  await seed.close();

  const store = await MemoryStore.open({ rootDir, project: 'test-project', readOnly: true });
  try {
    assert.equal(store.status.writable, false);
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built, sessionId);
    runCycle(ctx, session, built);
    await flush();
    const injected = session.appended.filter((item) => item.data?.source?.kind === 'plugin:context-governance');
    assert.equal(injected.length, 1, 'read-only mode must still reinject existing pointers');
    const text = injected[0].data.content.map((block) => block.text).join('\n');
    assert.ok(text.includes(seedEntry.id), 'pointer text must carry the existing entry id');
    assert.equal(guard.status.stats.protectionWrites, 0);
    assert.equal(await fs.stat(path.join(rootDir, 'audit.jsonl')).then(
      async () => (await fs.readFile(path.join(rootDir, 'audit.jsonl'), 'utf8')).length,
      () => 0,
    ), 0, 'read-only must not write audit records');
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});
