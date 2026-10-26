/**
 * P3 块 A：RootGuardPool 单订阅/按根路由/生命周期。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RootGuardPool } from '../src/compress/root-guards.js';
import { RootRegistry } from '../src/roots/registry.js';

function flush(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entry(rootId, root, project = 'p') {
  return { rootId, root, project, state: 'active' };
}

function auditSink() {
  const rows = [];
  return {
    rows,
    file: 'fake-audit.jsonl',
    append(event, details) {
      rows.push({ event, details });
      return true;
    },
  };
}

function makePool({ resolve, guards, storePool, createGuard, logger = null, now = () => new Date() } = {}) {
  const ctx = {
    handlers: [],
    logger: logger ?? { info() {}, warn() {}, error() {} },
    on(event, handler) {
      this.handlers.push({ event, handler });
      return () => {
        const index = this.handlers.findIndex((item) => item.handler === handler);
        if (index >= 0) this.handlers.splice(index, 1);
      };
    },
  };
  const pool = new RootGuardPool({
    ctx,
    registry: { resolveSessionRoot: resolve },
    storePool,
    createGuard: createGuard ?? (async (rootEntry, resources) => {
      const record = {
        events: [],
        stopped: 0,
        earlyChecks: [],
        status: { stats: { pending: 0 } },
        handleEvent(session, event) {
          this.events.push({ session, event });
          if (event?.type === 'boom') throw new Error('guard boom');
        },
        stop() { this.stopped += 1; },
      };
      const early = {
        checks: [],
        stopped: 0,
        check(session) { this.checks.push(session); },
        stop() { this.stopped += 1; },
        hasPending() { return false; },
      };
      guards.push({ entry: rootEntry, guard: record, early, audit: resources.audit });
      return { guard: record, early, policy: { root: rootEntry.root } };
    }),
    logger: ctx.logger,
    idleMs: 1000,
    now,
  });
  return { ctx, pool };
}

function fakeStorePool(releases) {
  return {
    async pin(rootEntry) {
      const audit = auditSink();
      return {
        entry: rootEntry,
        store: { rootDir: rootEntry.root },
        audit,
        release() { releases.push(rootEntry.rootId); },
      };
    },
  };
}

test('P3 pool：全局仅一个 session/event 订阅；A/B 各路由；A 抛错不阻断 B', async () => {
  const roots = {
    A: entry('root-a', 'D:/work/a'),
    B: entry('root-b', 'D:/work/b'),
  };
  const releases = [];
  const guards = [];
  const { ctx, pool } = makePool({
    resolve: (session) => ({ status: 'managed', entry: roots[session.cwd], isSubagent: false, cwd: session.cwd }),
    guards,
    storePool: fakeStorePool(releases),
  });
  pool.start();
  assert.equal(ctx.handlers.length, 1, '只能挂一个 session/event 订阅');

  ctx.handlers[0].handler({ cwd: 'A' }, { type: 'compaction/start', seq: 1, data: { compactionId: 'a1' } });
  ctx.handlers[0].handler({ cwd: 'B' }, { type: 'compaction/start', seq: 2, data: { compactionId: 'b1' } });
  await flush();
  assert.equal(guards.length, 2, 'A/B 各建一个 guard');
  assert.equal(guards[0].guard.events.length, 1);
  assert.equal(guards[1].guard.events.length, 1);
  assert.equal(guards[0].guard.events[0].event.data.compactionId, 'a1');
  assert.equal(guards[1].guard.events[0].event.data.compactionId, 'b1');
  assert.equal(pool.guardForSession({ cwd: 'A' }), guards[0].guard);
  assert.equal(pool.policyForSession({ cwd: 'B' }).root, 'D:/work/b');

  ctx.handlers[0].handler({ cwd: 'A' }, { type: 'boom', seq: 3 });
  ctx.handlers[0].handler({ cwd: 'B' }, { type: 'compaction/end', seq: 4, data: { compactionId: 'b1' } });
  await flush();
  assert.equal(guards[0].guard.events.length, 2);
  assert.equal(guards[1].guard.events.length, 2, 'A 抛错后 B 仍处理');
  assert.ok(guards[0].audit.rows.some((row) => row.event === 'root-guard-error'));
  assert.equal(guards[1].audit.rows.some((row) => row.event === 'root-guard-error'), false);

  // turn/end 由同一个订阅转给该根 early，不再另挂订阅。
  ctx.handlers[0].handler({ cwd: 'A' }, { type: 'turn/end', seq: 5 });
  await flush();
  assert.equal(guards[0].early.checks.length, 1);
  assert.equal(guards[1].early.checks.length, 0);

  await pool.closeAll('test');
  assert.equal(guards[0].guard.stopped, 1);
  assert.equal(guards[0].early.stopped, 1);
  assert.equal(guards[1].guard.stopped, 1);
  assert.deepEqual(releases.sort(), ['root-a', 'root-b']);
  assert.equal(pool.started, false);
  assert.equal(pool.closed, true);
  assert.equal(ctx.handlers.length, 0, 'closeAll 必须先解除唯一订阅');
});

test('P3 pool：no-root 不建 guard/不审计；fail-closed 关闭已有 guard', async () => {
  const active = entry('root-a', 'D:/work/a');
  const guards = [];
  const releases = [];
  let mode = 'no-root';
  const { pool } = makePool({
    resolve: () => (mode === 'no-root'
      ? { status: 'no-root', entry: null, isSubagent: false, cwd: '' }
      : { status: 'managed', entry: active, isSubagent: false, cwd: active.root }),
    guards,
    storePool: fakeStorePool(releases),
  });
  pool.start();
  pool.route({ header: { id: 'n1' } }, { type: 'compaction/start' });
  await flush();
  assert.equal(guards.length, 0, 'no-root 不建 guard');
  assert.equal(pool.size, 0);

  mode = 'managed';
  pool.route({ header: { id: 's1' } }, { type: 'compaction/start', data: { compactionId: 'c1' } });
  await flush();
  assert.equal(guards.length, 1);

  active.state = 'fail-closed';
  pool.route({ header: { id: 's1' } }, { type: 'compaction/end', data: { compactionId: 'c1' } });
  await flush();
  assert.equal(pool.size, 0, 'fail-closed 后 guard 必须关闭');
  assert.deepEqual(releases, ['root-a']);
  await pool.closeAll('test');
});

test('P3 pool：pending 周期不被 idle 关闭，清空后才回收', async () => {
  const active = entry('root-a', 'D:/work/a');
  const guards = [];
  const releases = [];
  const now = { value: new Date('2026-10-26T10:00:00Z') };
  const { pool } = makePool({
    resolve: () => ({ status: 'managed', entry: active, isSubagent: false, cwd: active.root }),
    guards,
    storePool: fakeStorePool(releases),
    now: () => now.value,
  });
  pool.start();
  pool.route({ header: { id: 's1' } }, { type: 'compaction/start' });
  await flush();
  assert.equal(guards.length, 1);
  guards[0].guard.status.stats.pending = 1;
  now.value = new Date('2026-10-26T11:00:00Z');
  assert.equal(await pool.closeIdle(), 0, '有 pending 周期不得 idle 关闭');
  guards[0].guard.status.stats.pending = 0;
  assert.equal(await pool.closeIdle(), 1);
  assert.deepEqual(releases, ['root-a']);
  await pool.closeAll('test');
});

test('P3 registry：manageAllRoots=true 时第二根纳管；默认仍保持 P1 unmanaged', async () => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cg-p3-reg-'));
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  for (const root of [rootA, rootB]) {
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(path.join(root, '.git'), 'gitdir: nowhere\n');
  }
  const stateFile = path.join(base, 'state.json');
  const make = (manageAllRoots) => RootRegistry.load({
    stateFile,
    profile: 'test',
    claimPrimary: undefined,
    manageAllRoots,
    now: () => new Date('2026-10-26T10:00:00Z'),
  });
  const legacy = make(false);
  legacy.claimPrimary(rootA, { origin: 'inferred' });
  assert.equal(legacy.resolveSessionRoot({ header: { id: 'b1', cwd: rootB } }).status, 'unmanaged');

  const p3 = make(true);
  p3.claimPrimary(rootA, { origin: 'inferred' });
  const other = p3.resolveSessionRoot({ header: { id: 'b2', cwd: rootB } });
  assert.equal(other.status, 'managed');
  assert.equal(other.entry.root, rootB);
  await fs.promises.rm(base, { recursive: true, force: true });
});
