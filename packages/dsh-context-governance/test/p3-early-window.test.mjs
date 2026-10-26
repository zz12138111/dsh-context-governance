/**
 * P3 块B：B2c/B2d 时间窗（start 延迟仍保护；start 永不出现显式 unknown）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../src/audit.js';
import { CompressionGuard } from '../src/compress/runtime.js';
import { wireEarlyCompaction } from '../src/compress/early-wiring.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makePolicy() {
  return {
    early: true,
    values: {
      'compact.at': 0.6,
      'compact.estimateSafety': 1.35,
      'compact.early.armed': true,
    },
    window: { currentTokens: 1_048_576, native: 0.6934 },
  };
}

async function makeFixture(startWaitMs = 30, { isSubagent = false } = {}) {
  const root = await tempDir('cg-p3-window-');
  const memoryRoot = path.join(root, 'memory', 'governance');
  const store = await MemoryStore.open({ rootDir: memoryRoot, project: 'p3-window' });
  const audit = new AuditLog({ file: path.join(memoryRoot, 'audit.jsonl'), allowedBase: memoryRoot });
  const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY });
  built.session.id = 'session-p3-window';
  built.session.header = { id: 'session-p3-window', cwd: root };
  built.session.append = () => ({ seq: 9900 });
  const engine = {
    calls: 0,
    pendingAtCall: null,
    async compactNow() {
      this.calls += 1;
      this.pendingAtCall = store.protectionPending;
    },
  };
  const ctx = {
    get(name) {
      if (name === 'agents') return { list: () => [{ session: built.session }] };
      if (name === 'agentPresets') return { serviceFor: () => engine };
      return null;
    },
  };
  const timers = [];
  let clock = 0;
  const guard = new CompressionGuard({
    ctx,
    store,
    audit,
    projectRoot: root,
    project: 'p3-window',
    startWaitMs,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.push(timer);
      return timer;
    },
    resolveScope: () => ({
      mode: 'multi-root',
      root,
      cwd: root,
      governed: true,
      skipReason: null,
      unattributed: false,
      isSubagent,
    }),
  });
  guard.pressureFor = () => ({ measuredTokens: 680_000, estimatedTokens: 400_000 });
  const policy = makePolicy();
  const wiring = wireEarlyCompaction({
    ctx,
    subscribe: false,
    getGuard: () => guard,
    getPolicy: () => policy,
    getAudit: () => audit,
    getArmed: () => true,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.push(timer);
      return timer;
    },
    now: () => clock,
  });
  return {
    root,
    memoryRoot,
    store,
    audit,
    built,
    engine,
    guard,
    wiring,
    timers,
    advance: (ms) => { clock += ms; },
    cleanup: async () => {
      await guard.dispose('test').catch(() => {});
      await store.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

async function readRows(audit) {
  try {
    return (await fs.readFile(audit.file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('P3 G8：子会话保护 journal 只回注，不 materialize 成持久 topics', async () => {
  const f = await makeFixture(20, { isSubagent: true });
  try {
    f.guard.handleEvent(f.built.session, f.built.events.find((item) => item.type === 'compaction/start'));
    f.guard.handleEvent(f.built.session, f.built.summaryEvent);
    f.guard.handleEvent(f.built.session, f.built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'));
    f.built.session.surface.nodes = f.built.postSurface;
    f.guard.handleEvent(f.built.session, f.built.events.find((item) => item.type === 'compaction/end'));
    await f.guard.flush();
    await wait(20);
    assert.equal(f.store.allEntries().length, 0, '子会话不得写持久记忆条目');
    assert.equal(f.store.protectionPending, 0, '周期结束应清理临时 journal');
    const rows = await readRows(f.audit);
    assert.ok(rows.some((row) => row.event === 'protection-materialize-skipped' && row.reason === 'subagent'));
    assert.ok(rows.some((row) => row.event === 'reinjection'));
    assert.ok(rows.some((row) => row.event === 'protection-write-skipped' && row.phase === 'subagent-cycle-end'));
    const topic = await fs.readFile(path.join(f.memoryRoot, 'topics', 'fact.md'), 'utf8').catch(() => '');
    assert.equal(topic.includes('session-p3-window'), false);
  } finally {
    await f.cleanup();
  }
});

test('B2f：预写失败不调用 compactNow（B-1 门禁）', async () => {
  const f = await makeFixture(10_000);
  try {
    f.built.session.surface.nodes = [];
    await f.wiring.check(f.built.session);
    assert.equal(f.engine.calls, 0, 'preProtect 失败必须 compactNow=0');
    assert.equal(f.store.protectionPending, 0);
    const rows = await readRows(f.audit);
    assert.ok(rows.some((row) => row.event === 'early-skipped' && row.reason === 'protection-prewrite-failed'));
    assert.equal(rows.some((row) => row.event === 'early-forced'), false);
  } finally {
    await f.cleanup();
  }
});

test('B2c：start 延迟超过阈值，journal 仍 pending；迟到 start 复用且只压一次', async () => {
  const f = await makeFixture(30);
  try {
    await f.wiring.check(f.built.session);
    assert.equal(f.engine.calls, 1);
    assert.equal(f.engine.pendingAtCall, 1, 'preProtect 必须先于 compactNow 落 journal');
    assert.equal(f.guard.earlyStatus().pending, 1);
    assert.equal(f.store.protectionPending, 1);
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].hasRef(), false, 'startWaitMs 定时器必须 unref');

    await wait(60);
    assert.equal(f.guard.earlyStatus().unknown, 1, '超时只转 unknown，不删 journal');
    assert.equal(f.store.protectionPending, 1, '超时后 journal 必须仍在');
    const afterTimeout = await readRows(f.audit);
    assert.ok(afterTimeout.some((row) => row.event === 'early-start-timeout'));

    // 迟到 start：复用预写 journal，不重新快照/不重写。
    f.guard.handleEvent(f.built.session, f.built.events.find((item) => item.type === 'compaction/start'));
    assert.equal(f.guard.earlyStatus().pending, 0);
    f.guard.handleEvent(f.built.session, f.built.summaryEvent);
    f.guard.handleEvent(f.built.session, f.built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'));
    f.built.session.surface.nodes = f.built.postSurface;
    f.guard.handleEvent(f.built.session, f.built.events.find((item) => item.type === 'compaction/end'));
    await wait(0);
    // 没有 tokenMeter 时，end 后的首条 assistant usage 补齐 tokensAfter 并落 compaction-cost。
    f.guard.handleEvent(f.built.session, {
      type: 'assistant/message',
      seq: 9001,
      data: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    });
    await f.guard.flush();
    await wait(20);

    assert.equal(f.engine.calls, 1, 'compactNow 只能调用一次');
    assert.equal(f.store.protectionPending, 0, '迟到 start 后 journal 应物化');
    assert.equal(f.guard.status.lastReport?.protection, 'ok');
    const rows = await readRows(f.audit);
    assert.ok(rows.some((row) => row.event === 'early-start-reused' && row.late === true));
    assert.ok(rows.some((row) => row.event === 'protection-materialized'));
    assert.ok(rows.some((row) => row.event === 'compaction-cost'));
    assert.equal(rows.some((row) => row.event === 'early-start-missing'), false);
  } finally {
    await f.cleanup();
  }
});

test('B2e：dispose 清 startWaitMs 定时器，超时不得触发', async () => {
  const f = await makeFixture(10_000);
  try {
    await f.wiring.check(f.built.session);
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].hasRef(), false);
    await f.guard.dispose('test');
    await wait(30);
    assert.equal(f.guard.status.stats.earlyTimeouts, 0, 'dispose 后定时器必须已清');
    const rows = await readRows(f.audit);
    assert.equal(rows.some((row) => row.event === 'early-start-timeout'), false);
    assert.ok(rows.some((row) => row.event === 'early-start-missing'));
  } finally {
    await f.cleanup();
  }
});

test('B2d：start 永不出现，终态归档 orphan，status=unknown，不得写 protected', async () => {
  const f = await makeFixture(20);
  try {
    await f.wiring.check(f.built.session);
    assert.equal(f.engine.calls, 1);
    assert.equal(f.engine.pendingAtCall, 1, 'preProtect 必须先于 compactNow 落 journal');
    assert.equal(f.guard.earlyStatus().pending, 1);
    await wait(50);
    assert.equal(f.guard.earlyStatus().unknown, 1);
    assert.equal(f.store.protectionPending, 1);

    await f.guard.dispose('test');
    assert.equal(f.store.protectionPending, 0);
    assert.equal(f.guard.earlyStatus().pending, 0);
    assert.equal(f.guard.status.lastReport, null, '未确认的 early 不得产生 protected report');
    assert.equal(f.guard.status.early.unknown, 0);
    const orphanDir = path.join(f.memoryRoot, 'protection', 'orphaned');
    const files = (await fs.readdir(orphanDir)).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1, '终态必须归档而不是删除');
    const rows = await readRows(f.audit);
    assert.ok(rows.some((row) => row.event === 'early-start-missing' && row.protection === 'unknown'));
    assert.equal(rows.some((row) => row.event === 'protection-materialized'), false);
    assert.equal(rows.some((row) => row.event === 'compaction-cost'), false);
    assert.equal(rows.some((row) => row.event === 'early-start-timeout'), true);
  } finally {
    await f.cleanup();
  }
});
