import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, assistantToolCall, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx(compaction) {
  const handlers = [];
  const logs = [];
  return {
    handlers,
    logs,
    get(name) { return name === 'compaction' ? compaction : undefined; },
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
}

function liveSession(built) {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 1000;
  const appended = [];
  const session = {
    id: 'session-t4',
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

function eventOf(built, type) {
  return built.events.find((event) => event.type === type);
}

function checkpointEventOf(built) {
  return built.events.find((event) => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint');
}

function endEventOf(built) {
  return built.events.find((event) => event.type === 'compaction/end');
}

function emitStart(ctx, session, built) {
  ctx.handlers[0].handler(session, eventOf(built, 'compaction/start'));
}

function emitThroughEnd(ctx, session, built) {
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointEventOf(built));
  session.surface.nodes = [...built.postSurface];
  handler(session, endEventOf(built));
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
    await fn(store, rootDir);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function orphanMessages() {
  return [...healthyMessages(), assistantToolCall(14, 'call-orphan')];
}

test('T4-1：compaction/start 同步落盘；5 类保护项在 summary 之前可查', async () => {
  await withStore(async (store, rootDir) => {
    const built = buildCompaction({ before: orphanMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitStart(ctx, session, built);
      // 同步窗口：start 返回时 journal 必须在（异步 readAudit 前立即断言）。
      assert.equal(store.protectionPending, 1);
      const audit = await readAudit(store);
      const write = audit.find((entry) => entry.event === 'protection-write');
      assert.ok(write, 'protection-write audit missing');
      assert.equal(write.count, 5);
      assert.deepEqual(write.kinds, ['latest-user', 'rules', 'batch', 'rollback', 'unpaired-calls']);
      for (const id of write.ids) assert.notEqual(store.get(id), null);
      await guard.flush();
    } finally {
      guard.stop();
    }
  });
});

test('T4-2：自动压缩完整周期只回注一次；ID+状态+标题，不含详情', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      assert.equal(session.appended.length, 1);
      const injected = session.appended[0];
      assert.equal(injected.type, 'user/message');
      assert.equal(injected.data.source.kind, 'plugin:context-governance');
      assert.equal(injected.data.source.cycle, built.compactionId);
      const text = injected.data.content.map((block) => block.text).join('\n');
      assert.match(text, /MEM-\d{8}-1\d{3}/);
      assert.match(text, /最新一条用户消息/);
      assert.equal(text.includes('详情'), false);
      assert.ok(injected.seq > endEventOf(built).seq);

      const audit = await readAudit(store);
      assert.ok(audit.some((entry) => entry.event === 'protection-write'));
      assert.ok(audit.some((entry) => entry.event === 'protection-materialized'));
      assert.ok(audit.some((entry) => entry.event === 'reinjection'));
      assert.equal(guard.status.stats.reinjections, 1);
    } finally {
      guard.stop();
    }
  });
});

test('T4-3：手动压缩允许丢原文，但 audit 告警 + 回注最后用户消息标题', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 13, end: 13 });
    eventOf(built, 'compaction/start').data.sourceCommandId = 'cmd-manual';
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      const audit = await readAudit(store);
      const loss = audit.find((entry) => entry.event === 'manual-compaction-loss');
      assert.ok(loss);
      assert.ok(loss.failures.includes('latest-user-message'));
      const text = session.appended[0].data.content.map((block) => block.text).join('\n');
      assert.match(text, /最新一条用户消息/);
      assert.equal(guard.status.lastReport.manual, true);
    } finally {
      guard.stop();
    }
  });
});

test('T4-4：写记忆失败 → audit + degraded，不阻断压缩、不抛宿主', async () => {
  await withStore(async (store) => {
    const original = store.protectSync;
    store.protectSync = () => { throw new Error('disk full'); };
    try {
      const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
      const session = liveSession(built);
      const ctx = makeCtx(new BasicCompactionEngine());
      const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
      guard.start();
      try {
        assert.doesNotThrow(() => emitThroughEnd(ctx, session, built));
        await flush();
      await guard.flush();
        const audit = await readAudit(store);
        assert.ok(audit.some((entry) => entry.event === 'protection-write-failed'));
        assert.equal(guard.status.mode, 'degraded-protection');
        assert.equal(guard.status.stats.protectionWriteFailures, 1);
        assert.equal(session.appended.length, 0);
      } finally {
        guard.stop();
      }
    } finally {
      store.protectSync = original;
    }
  });
});

test('T4-5：回注失败按阈值降级（maxFailures=1）；下一周期暂停写入但回注仍尝试并自愈', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    session.append = () => { throw new Error('append rejected'); };
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({
      ctx, store, hostVersion: '0.2.1-rc.2', reinjection: { maxFailures: 1 },
    });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      assert.equal(guard.status.mode, 'degraded-protection');
      assert.equal(guard.status.protection.reinjectionFailureStreak, 1);
      const audit = await readAudit(store);
      assert.ok(audit.some((entry) => entry.event === 'reinjection-failed'));
      assert.ok(audit.some((entry) => entry.event === 'reinjection-degraded'));

      const second = buildCompaction({
        compactionId: 'cmp-2', startSeq: 200, summarySeq: 201, checkpointSeq: 202, endSeq: 203,
        before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11,
      });
      const session2 = liveSession(second);
      const beforePending = store.protectionPending;
      emitThroughEnd(ctx, session2, second);
      await flush();
      await guard.flush();
      const audit2 = await readAudit(store);
      assert.ok(audit2.some((entry) => entry.event === 'protection-write-skipped' && entry.compactionId === 'cmp-2' && entry.reason === 'reinjection-suspended'));
      assert.equal(store.protectionPending, beforePending, 'suspended cycle must not write new protection');
      // 降级周期仍会用既有记忆指针回注；append 成功即自愈。
      assert.equal(session2.appended.length, 1, 'degraded cycle must still attempt reinjection');
      assert.ok(audit2.some((entry) => entry.event === 'reinjection-recovered'));
      assert.equal(guard.status.protection.reinjectionFailureStreak, 0);
      assert.equal(guard.status.mode, 'full');
    } finally {
      guard.stop();
    }
  });
});

test('T8-1 自愈：一次回注失败不永久停写，下一周期恢复写入并清计数', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
      const session = liveSession(built);
      session.append = () => { throw new Error('append rejected once'); };
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      assert.equal(guard.status.protection.reinjectionFailureStreak, 1);
      assert.equal(guard.status.protection.reinjectionSuspended, false, '一次失败不应进入暂停');
      assert.ok((await readAudit(store)).some((entry) => entry.event === 'reinjection-failed'));

      const writesBefore = guard.status.stats.protectionWrites;
      const second = buildCompaction({
        compactionId: 'cmp-recovered', startSeq: 400, summarySeq: 401, checkpointSeq: 402, endSeq: 403,
        before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11,
      });
      const session2 = liveSession(second);
      emitThroughEnd(ctx, session2, second);
      await flush();
      await guard.flush();
      assert.equal(guard.status.protection.reinjectionFailureStreak, 0);
      assert.equal(guard.status.mode, 'full');
      assert.ok(guard.status.stats.protectionWrites > writesBefore, '下一周期应恢复保护写入');
      assert.equal(session2.appended.length, 1, '下一周期回注应成功');
      assert.ok((await readAudit(store)).some((entry) => entry.event === 'reinjection-recovered'));
    } finally {
      guard.stop();
    }
  });
});

test('T4-6：同一 cycle 不重复写/注（重复 start/end 被识别）', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      assert.equal(session.appended.length, 1);
      const journalFiles = await fs.readdir(path.join(store.rootDir, 'protection')).catch(() => []);
      const countBefore = journalFiles.filter((name) => name.endsWith('.json')).length;

      // 同一个 compactionId 再来一次（异常宿主/测试）：应被 completedCycles 拦下。
      emitStart(ctx, session, built);
      await flush();
      await guard.flush();
      const audit = await readAudit(store);
      assert.ok(audit.some((entry) => entry.event === 'duplicate-cycle-start'));
      const after = (await fs.readdir(path.join(store.rootDir, 'protection')).catch(() => []))
        .filter((name) => name.endsWith('.json')).length;
      assert.equal(after, countBefore);
      assert.equal(session.appended.length, 1);
    } finally {
      guard.stop();
    }
  });
});

test('T4-7：自动压缩受保护内容“可恢复”口径（5 类都有指针 + 回注）', async () => {
  await withStore(async (store) => {
    // 故意让最新用户消息落在 shadow 内（宿主会丢），验证记忆侧仍可恢复。
    const built = buildCompaction({ before: orphanMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 13 });
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      const audit = await readAudit(store);
      const write = audit.find((entry) => entry.event === 'protection-write');
      assert.equal(write.kinds.length, 5);
      for (const id of write.ids) {
        const entry = store.get(id);
        assert.notEqual(entry, null);
        assert.match(entry.source, /^session:session-t4#\d+$/);
      }
      const text = session.appended[0].data.content.map((block) => block.text).join('\n');
      for (const id of write.ids) assert.ok(text.includes(id), `missing ${id} in reinjection`);
    } finally {
      guard.stop();
    }
  });
});

test('T4-8：audit 不写消息正文/路径内容', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      const text = await fs.readFile(path.join(store.rootDir, 'audit.jsonl'), 'utf8');
      assert.equal(text.includes('最新一条用户消息'), false);
      assert.equal(text.includes('D:\\\\backup'), false);
      assert.equal(text.includes('511/958'), false);
    } finally {
      guard.stop();
    }
  });
});

test('T4-10：provider 不可见时走事件级感知，仍能固化/回注', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    const ctx = makeCtx(null);
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.3' });
    guard.start();
    try {
      assert.equal(guard.mode, 'event-level');
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      assert.equal(session.appended.length, 1);
      const audit = await readAudit(store);
      assert.ok(audit.some((entry) => entry.event === 'protection-write'));
      assert.ok(audit.some((entry) => entry.event === 'reinjection'));
    } finally {
      guard.stop();
    }
  });
});

test('T4-9：摘要不可读时回注只放 ID+状态（手动最新用户仍保留标题）', async () => {
  await withStore(async (store) => {
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      const text = session.appended[0].data.content.map((block) => block.text).join('\n');
      assert.match(text, /MEM-\d{8}-1\d{3}/);
      assert.equal(text.includes('最新一条用户消息'), false);
      assert.match(text, /（见记忆）|（详情查记忆）/);
    } finally {
      guard.stop();
    }
  });
});

