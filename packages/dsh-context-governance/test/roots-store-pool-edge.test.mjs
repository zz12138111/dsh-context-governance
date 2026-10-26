/**
 * P2 / 块C：Pool 边界（软上限/失败关闭/只读/每根 audit 生命周期）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { MEM_WRITE_NAME, createMemoryTools } from '../src/tools/mem-tools.js';
import { RootStorePool } from '../src/roots/store-pool.js';

async function tempDir(prefix = 'cg-pool-edge-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoot(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: x\n');
  return dir;
}

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
}

function entryFor(root, rootId, project = 'p') {
  return { root, rootId, project, name: project, state: 'active', failClosedReason: null };
}

async function closePool(pool) {
  await pool.closeAll().catch(() => {});
}

test('P2 pool 软上限：超过阈值只告警不拒绝，stats 可见', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'a');
  const rootB = makeRoot(base, 'b');
  const audit = makeAudit();
  const pool = new RootStorePool({
    registry: { failClosed: () => {} },
    rootAudit: audit,
    warnThreshold: 1,
    ttlMs: 60_000,
    sweepMs: 60_000,
  });
  try {
    const a = await pool.get(entryFor(rootA, 'a'.repeat(16), 'a'));
    const b = await pool.get(entryFor(rootB, 'b'.repeat(16), 'b'));
    assert.equal(pool.stats().open, 2, '超阈值仍须打开（不拒绝）');
    assert.equal(pool.stats().warned, true);
    assert.equal(audit.entries.filter((item) => item.event === 'memory-store-pool-warn').length, 1);
    assert.match(a.store.rootDir, /memory[\\/]governance$/);
    assert.equal(b.entry.rootId, 'b'.repeat(16));
    a.release();
    b.release();
  } finally {
    await closePool(pool);
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});

test('P2 pool fail-closed：不打开 store、不创建目录', async () => {
  const base = await tempDir();
  const root = makeRoot(base, 'bad');
  const audit = makeAudit();
  const pool = new RootStorePool({ registry: { failClosed: () => {} }, rootAudit: audit, warnThreshold: 16 });
  try {
    const entry = { ...entryFor(root, 'c'.repeat(16), 'bad'), state: 'fail-closed', failClosedReason: 'memory-root-escape' };
    await assert.rejects(pool.get(entry), (error) => error?.code === 'ROOT_FAIL_CLOSED');
    assert.equal(pool.stats().open, 0);
    assert.equal(fs.existsSync(path.join(root, 'memory')), false);
  } finally {
    await closePool(pool);
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});

test('P2 pool 只读：第二 store writer-lock → readOnly；mem_write 拒绝且 per-root audit 可见', async () => {
  const base = await tempDir();
  const root = makeRoot(base, 'ro');
  const memoryDir = path.join(root, 'memory', 'governance');
  const writer = await MemoryStore.open({ rootDir: memoryDir, project: 'p' });
  const audit = makeAudit();
  const pool = new RootStorePool({ registry: { failClosed: () => {} }, rootAudit: audit, warnThreshold: 16 });
  try {
    const handle = await pool.get(entryFor(root, 'd'.repeat(16), 'p'));
    assert.match(handle.store.status.readOnlyReason ?? '', /^writer-lock:/);
    assert.ok(audit.entries.some((item) => item.event === 'memory-store-readonly'));
    const tools = createMemoryTools(handle.store);
    await assert.rejects(
      tools[MEM_WRITE_NAME].definition.execute({ op: 'create', type: 'fact', title: 'x', writer: 'rule' }),
      /\[READ_ONLY\] memory is read-only/,
    );
    const query = await tools.mem_query.definition.execute({});
    assert.equal(query.count, 0, '只读 store 仍可查询');
    handle.release();
  } finally {
    await closePool(pool);
    await writer.close().catch(() => {});
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});
