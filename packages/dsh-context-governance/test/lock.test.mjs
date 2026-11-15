import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { LOCK_FILE_NAME, acquireWriterLock, isPidAlive, readWriterLock } from '../src/memory/lock.js';
import { atomicWriteFile } from '../src/memory/atomic.js';
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  }
});

test('MemoryStore 使用的锁文件在 close 后删除', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'p' });
  assert.ok(await fs.stat(path.join(rootDir, LOCK_FILE_NAME)).then(() => true, () => false));
  await store.close();
  assert.equal(await fs.stat(path.join(rootDir, LOCK_FILE_NAME)).then(() => true, () => false), false);
  await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  }
});

/**
 * CI 回归（GitHub run 43684661666 / commit 47b1e9b）：`lock.test:182` 偶发红——
 * release 时**在途心跳**在 `fs.rm` 之后落盘，把锁文件写回来（heartbeatAt 是新的）。
 * 修法：release 先置 released → await 在途串行队列 → 删 → 删后复核。
 * 本用例以极小心跳间隔连续压 20 轮，release 后**立即**断言无锁（不给"轮询等待"掩盖竞态）。
 */
test('rc.18a 心跳在途写不得在 release 后复活锁文件（CI 竞态回归）', async () => {
  const rootDir = await tempDir();
  try {
    for (let round = 0; round < 20; round += 1) {
      const acquired = await acquireWriterLock(rootDir, { project: 'p', heartbeatMs: 1 });
      assert.equal(acquired.ok, true, `round ${round} 取锁失败`);
      // 让若干心跳进入/接近在途，再立刻 release（最大化与 unlink 的竞态窗口）
      await new Promise((resolve) => setTimeout(resolve, round % 3 === 0 ? 1 : 5));
      await acquired.release();
      const afterRelease = (await readWriterLock(rootDir)).lock;
      assert.equal(afterRelease, null, `round ${round}: release 后锁文件被心跳写回（heartbeatAt=${afterRelease?.heartbeatAt}）`);
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  }
});

/**
 * B15 确定性竞态用例（审核要求"别只留靠 setTimeout 撞的那条"）：
 * 注入一个**可控挂起**的写函数，把心跳写卡在"已通过 read 检查、正准备写盘"的位置，
 * 其间调用 release()，再放行写入 → 断言 release 结束时锁文件为 null，且 200ms 后仍为 null。
 */
test('B15 慢心跳：release 等待在途写，放行后也不复活锁文件', async () => {
  const rootDir = await tempDir();
  try {
    let gate = null;
    let heartbeatWrites = 0;
    const controlledWrite = async (file, text, options) => {
      heartbeatWrites += 1;
      // 第 1 次是初始写（必须立即完成）；之后的心跳写挂起，等测试放行。
      if (heartbeatWrites > 1 && gate !== null) await gate.promise;
      await atomicWriteFile(file, text, options);
    };
    const acquired = await acquireWriterLock(rootDir, {
      project: 'p', heartbeatMs: 5, probe: () => 'alive', writeFile: controlledWrite,
    });
    assert.equal(acquired.ok, true);
    // 让至少一次心跳进入"挂起待写"状态
    await new Promise((resolve) => setTimeout(resolve, 30));
    let releaseGate = null;
    gate = { promise: new Promise((resolve) => { releaseGate = resolve; }) };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const releasing = acquired.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 放行挂起的心跳写（模拟"写盘已经开始、release 已删文件"的最坏时序）
    releaseGate();
    await releasing;
    assert.equal((await readWriterLock(rootDir)).lock, null, 'release 完成后不得有锁文件');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await readWriterLock(rootDir)).lock, null, '200ms 后仍不得复活');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  }
});

/** B15：release 之后立即重取必须成功（这正是"新鲜心跳锁挡住 45s"的真问题）。 */
test('B15 release 后立即重取：acquire 必须 ok:true', async () => {
  const rootDir = await tempDir();
  try {
    const first = await acquireWriterLock(rootDir, { project: 'p', heartbeatMs: 1 });
    assert.equal(first.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20)); // 期间会有多次心跳
    await first.release();
    const second = await acquireWriterLock(rootDir, { project: 'p', heartbeatMs: 1 });
    assert.equal(second.ok, true, 'release 后立即重取被挡 ⇒ 锁文件被心跳写回');
    await second.release();
    assert.equal((await readWriterLock(rootDir)).lock, null);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
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
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  }
});
