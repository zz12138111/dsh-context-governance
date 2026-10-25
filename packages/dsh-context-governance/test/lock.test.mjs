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
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
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
