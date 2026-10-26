/**
 * S1.3（1.0.1）：`early-forced` 待回填登记的持久化——存档层 + wiring 接线。
 *
 * 覆盖：登记落盘 → 新实例读回 → 报告命中写 reconciled + 清文件；TTL/上限裁剪；
 * 损坏/缺失/不可写只 warn 不抛；stop() 保留未回填条目（跨重启语义）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EARLY_RECONCILE_MAX,
  EARLY_RECONCILE_TTL_MS,
  wireEarlyCompaction,
} from '../src/compress/early-wiring.js';
import { readReconcileStore, reconcileStoreFile, writeReconcileStore } from '../src/compress/reconcile-store.js';

const POLICY = {
  early: true,
  values: { 'compact.at': 0.6, 'compact.estimateSafety': 1.35 },
  window: { currentTokens: 1048576, native: 0.6934 },
};

function makeEngine(behavior = 'resolve') {
  return {
    calls: 0,
    async compactNow() {
      this.calls += 1;
      if (behavior === 'busy') {
        const error = new Error('manual compaction requires an idle agent with no waking queued work');
        error.name = 'ManualCompactionError';
        throw error;
      }
    },
  };
}

function makeCtx({ engine = null } = {}) {
  const agent = { session: { id: 's1' } };
  const handlers = [];
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { list: () => [agent] };
      if (name === 'agentPresets') return engine === null ? null : { serviceFor: () => engine };
      return null;
    },
    on: (event, handler) => { handlers.push({ event, handler }); return () => {}; },
  };
  return { ctx, handlers };
}

const PRESSURE = { measuredTokens: 680000, estimatedTokens: 400000 };

function makeGuard({ cycleKey = 'early-cycle-a', withReports = true } = {}) {
  const listeners = new Set();
  const guard = {
    status: { pressure: PRESSURE, stats: { pending: 0 }, readOnly: false, lastReport: null },
    pressureFor: () => PRESSURE,
    preProtect: async () => ({ ok: true, cycleKey }),
    markEarlyAccepted: () => {},
    discardEarlyProtection: async () => {},
    emitReport(report) {
      for (const listener of [...listeners]) listener(report);
    },
  };
  if (withReports) {
    guard.onReportReady = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
  }
  return guard;
}

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
}

function makeWiring({ ctx, guard, audit, reconcileFile, now }) {
  return wireEarlyCompaction({
    ctx,
    subscribe: false,
    getGuard: () => guard,
    getPolicy: () => POLICY,
    audit,
    getArmed: () => true,
    now,
    reconcileFile,
  });
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-reconcile-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return dir;
}

function makeWarnSink() {
  const lines = [];
  return { lines, warn: (message) => lines.push(message), info: () => {} };
}

test('S1.3：登记落盘 → 新实例读回 → 报告命中写 reconciled 并清条目', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'pending-reconcile-desktop-abc123.json');
  let clock = 1_000_000;
  const now = () => clock;

  // 第一进程：early-forced 超窗写 unknown → 登记落盘。
  const audit1 = makeAudit();
  const guard1 = makeGuard({ cycleKey: 'early-cycle-a' });
  const wiring1 = makeWiring({ ctx: makeCtx({ engine: makeEngine() }).ctx, guard: guard1, audit: audit1, reconcileFile: file, now });
  await wiring1.check({ id: 's1' });
  assert.equal(audit1.entries.find((entry) => entry.event === 'early-forced').compaction, 'unknown');
  const saved = readReconcileStore(file, { now, ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX });
  assert.deepEqual(saved, [{ cycle: 'early-cycle-a', sessionId: 's1', writtenAt: 1_000_000 }]);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(raw.entries[0]).sort(), ['cycle', 'sessionId', 'writtenAt'], '只存三个字段，不存正文');
  wiring1.stop();

  // 第二进程（重启）：同文件读回；报告晚到 → 追加 reconciled 并删条目。
  clock += 5_000;
  const audit2 = makeAudit();
  const guard2 = makeGuard({ cycleKey: 'early-cycle-b' });
  const wiring2 = makeWiring({
    ctx: makeCtx({ engine: makeEngine('busy') }).ctx,
    guard: guard2,
    audit: audit2,
    reconcileFile: file,
    now,
  });
  await wiring2.check({ id: 's2' });
  guard2.emitReport({
    cycle: 'early-cycle-a',
    sessionId: 's1',
    compactionId: 'host-uuid-1',
    compaction: 'committed',
    protection: 'ok',
    failures: [],
    reinjected: true,
  });
  const reconciled = audit2.entries.find((entry) => entry.event === 'early-forced-reconciled');
  assert.ok(reconciled, '重启后收到的迟到报告必须能回填');
  assert.equal(reconciled.compaction, 'committed');
  assert.equal(reconciled.compactionId, 'host-uuid-1');
  assert.equal(reconciled.compactionShortId, 'host-uui');
  assert.equal(reconciled.reconcileDelayMs, 5_000);
  assert.equal(reconciled.source, 'late-report');
  assert.deepEqual(readReconcileStore(file, { now, ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX }), []);
  wiring2.stop();
});

test('S1.3：stop() 后文件里仍有未回填条目（跨重启语义）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'pending.json');
  const audit = makeAudit();
  const guard = makeGuard({ cycleKey: 'early-cycle-stop' });
  const wiring = makeWiring({ ctx: makeCtx({ engine: makeEngine() }).ctx, guard, audit, reconcileFile: file, now: () => 2_000_000 });
  await wiring.check({ id: 's1' });
  wiring.stop();
  const saved = readReconcileStore(file, { now: () => 2_000_000, ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX });
  assert.equal(saved.length, 1, 'stop 不能把未回填登记清掉');
  assert.equal(saved[0].cycle, 'early-cycle-stop');
});

test('S1.3：已 committed（窗内拿到报告）不登记、不落盘', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'pending.json');
  const audit = makeAudit();
  const guard = makeGuard({ cycleKey: 'early-cycle-hit' });
  guard.waitForReport = () => Promise.resolve({
    ok: true,
    reason: 'none',
    waitedMs: 3,
    report: {
      compactionId: 'host-uuid-hit',
      sessionId: 's1',
      cycle: 'early-cycle-hit',
      compaction: 'committed',
      protection: 'ok',
      failures: [],
      reinjected: true,
    },
  });
  const wiring = makeWiring({ ctx: makeCtx({ engine: makeEngine() }).ctx, guard, audit, reconcileFile: file, now: () => 3_000_000 });
  await wiring.check({ id: 's1' });
  assert.equal(audit.entries.find((entry) => entry.event === 'early-forced').compaction, 'committed');
  assert.deepEqual(readReconcileStore(file, { now: () => 3_000_000, ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX }), []);
  wiring.stop();
});

test('S1.3：TTL 过期条目加载时丢弃', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'pending.json');
  const now = 10_000_000;
  writeReconcileStore(file, [
    { cycle: 'early-fresh', sessionId: 's1', writtenAt: now - 1_000 },
    { cycle: 'early-expired', sessionId: 's1', writtenAt: now - EARLY_RECONCILE_TTL_MS - 1 },
  ]);
  const entries = readReconcileStore(file, { now: () => now, ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX });
  assert.deepEqual(entries.map((entry) => entry.cycle), ['early-fresh']);
});

test('S1.3：超过上限按最旧淘汰', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-reconcile-max-'));
  try {
    const file = path.join(dir, 'pending.json');
    const now = 20_000_000;
    const entries = [];
    for (let index = 0; index < EARLY_RECONCILE_MAX + 4; index += 1) {
      entries.push({ cycle: `early-${String(index).padStart(2, '0')}`, sessionId: 's1', writtenAt: now - (100 - index) });
    }
    writeReconcileStore(file, entries);
    const loaded = readReconcileStore(file, { now: () => now, ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX });
    assert.equal(loaded.length, EARLY_RECONCILE_MAX);
    assert.equal(loaded[0].cycle, 'early-04', '最旧的 4 条被淘汰');
    assert.equal(loaded.at(-1).cycle, `early-${String(EARLY_RECONCILE_MAX + 3).padStart(2, '0')}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('S1.3：文件损坏 → 空表 + 一行 warn，不抛错', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'pending.json');
  await fs.writeFile(file, '{not json', 'utf8');
  const logger = makeWarnSink();
  const entries = readReconcileStore(file, { now: () => Date.now(), ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX, logger });
  assert.deepEqual(entries, []);
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /reconcile store corrupt/);

  // wiring 侧同样不抛：损坏文件按空表继续，check 正常走完。
  const audit = makeAudit();
  const guard = makeGuard({ cycleKey: 'early-cycle-corrupt' });
  const wiring = makeWiring({ ctx: makeCtx({ engine: makeEngine() }).ctx, guard, audit, reconcileFile: file, now: () => Date.now() });
  await assert.doesNotReject(() => wiring.check({ id: 's1' }));
  wiring.stop();
});

test('S1.3：文件不存在 → 空表且不 warn', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'missing.json');
  const logger = makeWarnSink();
  const entries = readReconcileStore(file, { now: () => Date.now(), ttlMs: EARLY_RECONCILE_TTL_MS, max: EARLY_RECONCILE_MAX, logger });
  assert.deepEqual(entries, []);
  assert.deepEqual(logger.lines, [], '首次运行没有文件属正常态');
});

test('S1.3：不可写路径 → false + 一行 warn，不抛错、不阻塞 check', async (t) => {
  const dir = await tempDir(t);
  const blocker = path.join(dir, 'not-a-dir');
  await fs.writeFile(blocker, 'x', 'utf8');
  const file = path.join(blocker, 'pending.json');
  const logger = makeWarnSink();
  const ok = writeReconcileStore(file, [{ cycle: 'early-a', sessionId: 's1', writtenAt: Date.now() }], { logger });
  assert.equal(ok, false);
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /reconcile store write failed/);

  const audit = makeAudit();
  const guard = makeGuard({ cycleKey: 'early-cycle-unwritable' });
  const wiring = makeWiring({ ctx: makeCtx({ engine: makeEngine() }).ctx, guard, audit, reconcileFile: file, now: () => Date.now() });
  await assert.doesNotReject(() => wiring.check({ id: 's1' }));
  assert.equal(audit.entries.find((entry) => entry.event === 'early-forced').compaction, 'unknown', '压缩结论不受落盘失败影响');
  wiring.stop();
});

test('S1.3：reconcileStoreFile 复用持久化身份目录并按根分文件', () => {
  const identity = {
    ok: true,
    name: 'desktop',
    dir: 'C:\\profile\\desktop',
    home: 'C:\\Users\\u\\.dsh',
    anchor: 'home',
    stateFile: 'C:\\Users\\u\\.dsh\\context-governance\\root-state-desktop.json',
  };
  const file = reconcileStoreFile(identity, 'abcd1234');
  assert.equal(path.dirname(file), path.join('C:\\Users\\u\\.dsh', 'context-governance'));
  assert.equal(path.basename(file), 'pending-reconcile-desktop-abcd1234.json');
  assert.equal(reconcileStoreFile({ ok: false, reason: 'profileContext-unavailable' }), null);
});
