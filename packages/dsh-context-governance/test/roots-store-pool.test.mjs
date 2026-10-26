/**
 * P2：RootStorePool 生命周期（懒打开/refCount/TTL/closeAll/每根 audit）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../src/audit.js';
import { MemoryStore } from '../src/memory/store.js';
import { RootRegistry } from '../src/roots/registry.js';
import { RootStorePool } from '../src/roots/store-pool.js';

async function tempDir(prefix = 'cg-pool-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoot(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: x\n');
  return dir;
}

test('P2 pool：懒打开/refCount/TTL audit close/closeAll 清 timer', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const stateFile = path.join(base, 'context-governance', 'root-state-pool.json');
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const audit = [];
  const reg = RootRegistry.load({
    stateFile,
    profile: 'pool',
    now: () => clock.value,
    rootAudit: { append: (event, details) => audit.push({ event, details }) },
  });
  reg.claimPrimary(rootA, { origin: 'inferred' });
  const entryB = reg.resolveSessionRoot({ header: { id: 'b1', cwd: rootB } }).entry;

  const memoryA = path.join(rootA, 'memory', 'governance');
  const storeA = await MemoryStore.open({ rootDir: memoryA, project: 'alpha' });
  const auditA = new AuditLog({ file: path.join(memoryA, 'audit.jsonl'), allowedBase: memoryA });
  const pool = new RootStorePool({
    registry: reg,
    rootAudit: { append: (event, details) => audit.push({ event, details }) },
    logger: null,
    now: () => clock.value,
    ttlMs: 30_000,
    sweepMs: 60_000,
  });
  try {
    pool.seed(reg.attach, storeA, auditA);
    const memoryB = path.join(rootB, 'memory', 'governance');
    assert.equal(fs.existsSync(memoryB), false, 'seed 不打开其他根');
    assert.equal(pool.stats().open, 1);
    assert.equal(pool.stats().pinned, 1);

    const first = await pool.get(entryB);
    assert.equal(fs.existsSync(path.join(memoryB, '.writer.json')), true, '首次 get 懒打开');
    assert.equal(pool.stats().open, 2);
    const second = await pool.get(entryB);
    assert.equal(pool.stats().refs, 3, 'seed(1)+get(2) refs');
    pool.release(entryB.rootId);
    clock.value = new Date(clock.value.getTime() + 31_000);
    assert.equal(await pool.closeIdle(), 0, 'refs>0 不得关');
    pool.release(entryB.rootId);
    clock.value = new Date(clock.value.getTime() + 31_000);
    assert.equal(await pool.closeIdle(), 1, 'refs=0 且超 TTL 关闭');
    assert.equal(first.audit.closed, true, 'per-root AuditLog 随 store 关闭');
    assert.equal(fs.existsSync(memoryB), true, '关 store 不删除记忆文件');
    assert.ok(audit.some((item) => item.event === 'memory-store-open'));
    assert.ok(audit.some((item) => item.event === 'memory-store-close' && item.details.reason === 'ttl'));

    await pool.closeAll();
    assert.equal(pool.stats().disposed, true);
    assert.equal(pool.stats().open, 0);
    assert.equal(auditA.closed, true);
    assert.deepEqual(second.entry.rootId, entryB.rootId);
  } finally {
    await pool.closeAll().catch(() => {});
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});

test('P2 pool：P3 guard pin 期间不被 TTL 关闭，release 后恢复回收', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const stateFile = path.join(base, 'context-governance', 'root-state-pin.json');
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const reg = RootRegistry.load({ stateFile, profile: 'pool', now: () => clock.value });
  reg.claimPrimary(rootA, { origin: 'inferred' });
  const entryB = reg.resolveSessionRoot({ header: { id: 'b1', cwd: rootB } }).entry;
  const memoryA = path.join(rootA, 'memory', 'governance');
  const storeA = await MemoryStore.open({ rootDir: memoryA, project: 'alpha' });
  const pool = new RootStorePool({
    registry: reg,
    logger: null,
    now: () => clock.value,
    ttlMs: 30_000,
    sweepMs: 60_000,
  });
  try {
    pool.seed(reg.attach, storeA, new AuditLog({ file: path.join(memoryA, 'audit.jsonl'), allowedBase: memoryA }));
    const pinned = await pool.pin(entryB);
    assert.equal(pool.stats().pinned, 2, 'seed + guard pin');
    clock.value = new Date(clock.value.getTime() + 31_000);
    assert.equal(await pool.closeIdle(), 0, 'pinned guard store 不得被 TTL 关闭');
    pinned.release();
    assert.equal(pool.stats().refs, 1, 'release 只退 guard ref，主根 seed 仍保留');
    clock.value = new Date(clock.value.getTime() + 31_000);
    assert.equal(await pool.closeIdle(), 1, 'release 后超 TTL 可回收');
  } finally {
    await pool.closeAll().catch(() => {});
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});
