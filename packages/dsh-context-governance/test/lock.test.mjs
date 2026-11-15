import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { LOCK_FILE_NAME, acquireWriterLock, isPidAlive, readWriterLock } from '../src/memory/lock.js';
import { tempDir } from './helpers.mjs';

test('死进程留下的锁视为陈旧，可被覆盖', async () => {
  const rootDir = await tempDir();
  try {
    // 取一个几乎确定不存在的 pid。
    const deadPid = 2147483647;
    assert.equal(isPidAlive(deadPid), false);
    await fs.writeFile(
      path.join(rootDir, LOCK_FILE_NAME),
      JSON.stringify({ pid: deadPid, startedAt: '2026-10-25T00:00:00.000Z', project: 'p', version: 1 }),
      'utf8',
    );
    const acquired = await acquireWriterLock(rootDir, { project: 'p' });
    assert.equal(acquired.ok, true);
    const current = await readWriterLock(rootDir);
    assert.equal(current.lock.pid, process.pid);
    await acquired.release();
    assert.equal((await readWriterLock(rootDir)).lock, null);
    // 心跳定时器可能有一次 tick 在飞：等它落地再删临时目录（否则偶发 ENOTEMPTY）。
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  }
});

test('活进程持有的锁拒绝第二个写者，并给出 holder', async () => {
  const rootDir = await tempDir();
  try {
    const first = await acquireWriterLock(rootDir, { project: 'p' });
    assert.equal(first.ok, true);
    const second = await acquireWriterLock(rootDir, { project: 'p' });
    assert.equal(second.ok, false);
    assert.equal(second.holder.pid, process.pid);
    await first.release();
    const third = await acquireWriterLock(rootDir, { project: 'p' });
    assert.equal(third.ok, true);
    await third.release();
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('损坏的锁文件不阻塞启动，覆盖前留 .bak', async () => {
  const rootDir = await tempDir();
  try {
    await fs.writeFile(path.join(rootDir, LOCK_FILE_NAME), 'not json', 'utf8');
    const acquired = await acquireWriterLock(rootDir, { project: 'p' });
    assert.equal(acquired.ok, true);
    const bak = await fs.readFile(path.join(rootDir, `${LOCK_FILE_NAME}.bak`), 'utf8');
    assert.equal(bak, 'not json');
    await acquired.release();
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('release 不会误删别人的锁', async () => {
  const rootDir = await tempDir();
  try {
    const acquired = await acquireWriterLock(rootDir, { project: 'p' });
    assert.equal(acquired.ok, true);
    // 模拟另一个写者接管（例如人工替换锁）。
    await fs.writeFile(
      path.join(rootDir, LOCK_FILE_NAME),
      JSON.stringify({ pid: 2147483647, startedAt: '2026-10-25T00:00:00.000Z', project: 'p', version: 1 }),
      'utf8',
    );
    await acquired.release();
    const current = await readWriterLock(rootDir);
    assert.notEqual(current.lock, null);
    assert.equal(current.lock.pid, 2147483647);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('MemoryStore 使用的锁文件在 close 后删除', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'p' });
  assert.ok(await fs.stat(path.join(rootDir, LOCK_FILE_NAME)).then(() => true, () => false));
  await store.close();
  assert.equal(await fs.stat(path.join(rootDir, LOCK_FILE_NAME)).then(() => true, () => false), false);
  await fs.rm(rootDir, { recursive: true, force: true });
});

// rc.2：陈旧写者锁自愈（EPERM/超龄 + 心跳停摆），回收必须给 reclaimed 诊断。
test('rc.2 EPERM 且锁龄超阈值：回收锁并给 reclaimed 诊断', async () => {
  const rootDir = await tempDir();
  try {
    await fs.writeFile(
      path.join(rootDir, LOCK_FILE_NAME),
      JSON.stringify({ pid: 35560, startedAt: '2026-01-01T00:00:00.000Z', project: 'p', version: 1 }),
      'utf8',
    );
    const acquired = await acquireWriterLock(rootDir, {
      project: 'p', staleMs: 60 * 1000, probe: () => 'denied', heartbeat: false,
    });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.reclaimed.reason, 'pid-unprobeable');
    assert.equal(acquired.reclaimed.probe, 'denied');
    assert.equal(acquired.reclaimed.pid, 35560);
    assert.equal(acquired.reclaimed.startedAt, '2026-01-01T00:00:00.000Z');
    assert.ok(acquired.reclaimed.lockAgeMs > 60 * 1000);
    assert.equal((await readWriterLock(rootDir)).lock.pid, process.pid);
    // 陈旧锁留档，便于复核。
    const stale = await fs.readFile(path.join(rootDir, `${LOCK_FILE_NAME}.stale.bak`), 'utf8');
    assert.equal(JSON.parse(stale).pid, 35560);
    await acquired.release();
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rc.2 EPERM 但锁很新：不回收，仍返回 holder', async () => {
  const rootDir = await tempDir();
  try {
    await fs.writeFile(
      path.join(rootDir, LOCK_FILE_NAME),
      JSON.stringify({ pid: 35560, startedAt: new Date().toISOString(), project: 'p', version: 1 }),
      'utf8',
    );
    const acquired = await acquireWriterLock(rootDir, {
      project: 'p', staleMs: 10 * 60 * 1000, probe: () => 'denied', heartbeat: false,
    });
    assert.equal(acquired.ok, false);
    assert.equal(acquired.holder.pid, 35560);
    assert.equal(acquired.reclaimed, undefined);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rc.2 可探测存活但心跳停摆超阈值（pid 复用）：回收，reason=heartbeat-stale', async () => {
  const rootDir = await tempDir();
  try {
    await fs.writeFile(
      path.join(rootDir, LOCK_FILE_NAME),
      JSON.stringify({
        pid: 4242, startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:01:00.000Z', project: 'p', version: 1,
      }),
      'utf8',
    );
    const acquired = await acquireWriterLock(rootDir, {
      project: 'p', staleMs: 60 * 1000, probe: () => 'alive', heartbeat: false,
    });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.reclaimed.reason, 'heartbeat-stale');
    await acquired.release();
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rc.2 活写者心跳新鲜：不回收（即使锁龄很长）', async () => {
  const rootDir = await tempDir();
  try {
    await fs.writeFile(
      path.join(rootDir, LOCK_FILE_NAME),
      JSON.stringify({
        pid: 4242, startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: new Date().toISOString(), project: 'p', version: 1,
      }),
      'utf8',
    );
    const acquired = await acquireWriterLock(rootDir, {
      project: 'p', staleMs: 60 * 1000, probe: () => 'alive', heartbeat: false,
    });
    assert.equal(acquired.ok, false);
    assert.equal(acquired.holder.pid, 4242);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rc.2 心跳：持锁期间锁文件 heartbeatAt 会被刷新，release 后停止', async () => {
  const rootDir = await tempDir();
  try {
    const acquired = await acquireWriterLock(rootDir, { project: 'p', heartbeatMs: 80 });
    assert.equal(acquired.ok, true);
    const first = (await readWriterLock(rootDir)).lock.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = (await readWriterLock(rootDir)).lock.heartbeatAt;
    assert.notEqual(second, first);
    await acquired.release();
    assert.equal((await readWriterLock(rootDir)).lock, null);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('rc.2 MemoryStore.open 回收死进程锁：status.lockReclaimed + warning 可见', async () => {
  const rootDir = await tempDir();
  const deadPid = 2147483647;
  await fs.writeFile(
    path.join(rootDir, LOCK_FILE_NAME),
    JSON.stringify({ pid: deadPid, startedAt: '2026-10-25T00:00:00.000Z', project: 'p', version: 1 }),
    'utf8',
  );
  const store = await MemoryStore.open({ rootDir, project: 'p' });
  try {
    assert.equal(store.status.writable, true);
    assert.equal(store.status.lockReclaimed.reason, 'pid-dead');
    assert.equal(store.status.lockReclaimed.pid, deadPid);
    assert.equal(store.warnings.some((warning) => warning.includes('stale writer lock reclaimed')), true);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
