/**
 * C36 ④③：A2 持久会话层 + 层级 A1 > A2 > cwd > plugin。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createA2Store } from '../src/a2-store.js';
import { buildPolicyState } from '../src/index.js';
import { resolveConfig } from '../src/index.js';
import { tempDir } from './helpers.mjs';

function fakeA2(initial = new Map()) {
  const sessions = initial;
  const writes = [];
  const clears = [];
  return {
    sessions,
    writes,
    clears,
    read(sessionId) {
      const value = sessions.get(sessionId);
      return value === undefined ? null : { at: value, source: 'session:A2' };
    },
    write(sessionId, at) {
      sessions.set(sessionId, at);
      writes.push({ sessionId, at });
      return true;
    },
    clear(sessionId) {
      sessions.delete(sessionId);
      clears.push(sessionId);
      return true;
    },
  };
}

test('C36 ④：A2 落盘按完整 session id，重启（新实例）可读回、可清除', async () => {
  const dir = await tempDir('cg-a2-');
  const file = path.join(dir, 'context-governance', 'session-policy.json');
  try {
    const first = createA2Store({ file });
    assert.equal(first.write('session-aaa', 0.55), true);
    assert.equal(first.write('session-bbb', 0.65), true);
    const second = createA2Store({ file });
    assert.equal(second.read('session-aaa').at, 0.55);
    assert.equal(second.read('session-bbb').at, 0.65);
    assert.equal(second.read('session-bbb').source, 'session:A2');
    assert.equal(second.clear('session-aaa'), true);
    const third = createA2Store({ file });
    assert.equal(third.read('session-aaa'), null);
    assert.equal(third.read('session-bbb').at, 0.65);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C36 ④：A2 上限淘汰写 a2-evicted，不无界累积', async () => {
  const dir = await tempDir('cg-a2-evict-');
  const audits = [];
  try {
    const file = path.join(dir, 'session-policy.json');
    const store = createA2Store({
      file,
      maxEntries: 2,
      now: () => new Date('2026-11-15T00:00:00Z'),
      audit: (event, details) => audits.push({ event, details }),
    });
    store.write('s1', 0.5);
    store.write('s2', 0.55);
    store.write('s3', 0.6);
    assert.equal(store.size(), 2);
    const evicted = audits.filter((row) => row.event === 'a2-evicted');
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].details.reason, 'max-entries');
    assert.equal(evicted[0].details.count, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C36 ④：A2 文件损坏/未知版本 → 视为无 A2 并写 a2-load-failed，不抛错', async () => {
  const dir = await tempDir('cg-a2-bad-');
  try {
    const file = path.join(dir, 'session-policy.json');
    await fs.writeFile(file, '{not json', 'utf8');
    const audits = [];
    const store = createA2Store({ file, audit: (event, details) => audits.push({ event, details }) });
    assert.equal(store.size(), 0);
    assert.equal(audits.some((row) => row.event === 'a2-load-failed'), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C36 ③：层级 A1 > A2 > cwd > plugin；source 字面与 /cg status 可核', async () => {
  const a2 = fakeA2(new Map([['session-c36', 0.55]]));
  const config = resolveConfig({ projectRoot: 'D:/tmp/c36-project' });
  const state = buildPolicyState(config, {
    readFile: () => { throw new Error('no project file'); },
    a2Store: a2,
    onPolicyResolved: () => {},
  });
  // A2 命中：plugin 默认 0.60 被会话持久值覆盖。
  const viaA2 = state.resolve('session-c36');
  assert.equal(viaA2.values['compact.at'], 0.55);
  assert.equal(viaA2.sources['compact.at'], 'session:A2');
  // A1 命中：本进程 /cg set 覆盖 A2，并持久到 A2（重启后按 A2 读回）。
  const bucket = state.sessionValues('session-c36', { create: true });
  bucket['compact.at'] = 0.65;
  const viaA1 = state.resolve('session-c36');
  assert.equal(viaA1.values['compact.at'], 0.65);
  assert.equal(viaA1.sources['compact.at'], 'session:A1');
  assert.deepEqual(a2.writes.at(-1), { sessionId: 'session-c36', at: 0.65 });
  // 模拟重启：新 state 只带 A2 → source=session:A2、值=0.65。
  const restarted = buildPolicyState(config, {
    readFile: () => { throw new Error('no project file'); },
    a2Store: fakeA2(new Map([['session-c36', 0.65]])),
  });
  const afterRestart = restarted.resolve('session-c36');
  assert.equal(afterRestart.values['compact.at'], 0.65);
  assert.equal(afterRestart.sources['compact.at'], 'session:A2');
  // 清 A2（恢复全局）→ 回落 plugin/builtin。
  bucket['compact.at'] = undefined;
  delete bucket['compact.at'];
  assert.equal(a2.clears.includes('session-c36'), true);
  const afterClear = state.resolve('session-c36');
  assert.notEqual(afterClear.sources['compact.at'], 'session:A2');
});

test('C36 裁定 3：A2 淘汰保护活跃会话与显式 pin；a2-evicted 带 sessionIds', async () => {
  const dir = await tempDir('cg-a2-active-');
  const audits = [];
  try {
    const file = path.join(dir, 'session-policy.json');
    const old = new Date('2026-01-01T00:00:00Z');
    const nowDate = new Date('2026-11-15T00:00:00Z');
    const store = createA2Store({
      file,
      maxEntries: 10,
      now: () => nowDate,
      audit: (event, details) => audits.push({ event, details }),
      pins: ['session-pinned'],
      isActive: (sessionId) => sessionId === 'session-active',
    });
    // 直接写文件造“很久没更新”的两条记录（一条 active、一条 pinned、一条 idle）。
    const write = (sid, at) => {
      store.write(sid, at);
    };
    write('session-active', 0.5);
    write('session-pinned', 0.55);
    write('session-idle', 0.6);
    // 把三条 updatedAt 全改成 2026-01-01（模拟长期未改压缩比）。
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const sid of Object.keys(raw.sessions)) raw.sessions[sid].updatedAt = old.toISOString();
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');
    // 重新装载（read 不静默删）→ evict 只清 idle。
    const reloaded = createA2Store({
      file,
      now: () => nowDate,
      audit: (event, details) => audits.push({ event, details }),
      pins: ['session-pinned'],
      isActive: (sessionId) => sessionId === 'session-active',
    });
    assert.ok(reloaded.snapshot()['session-active'], '活跃会话不因过期被静默删除');
    assert.equal(reloaded.read('session-active'), null, 'read 过期只返回 null（不静默删）');
    reloaded.write('session-new', 0.65); // 触发 evict
    const evicted = audits.filter((row) => row.event === 'a2-evicted');
    assert.ok(evicted.length >= 1);
    const ids = evicted.flatMap((row) => row.details.sessionIds ?? []);
    assert.ok(ids.includes('session-idle'), '空闲会话被清');
    assert.equal(ids.includes('session-active'), false, '活跃会话不得被清');
    assert.equal(ids.includes('session-pinned'), false, 'pin 会话不得被清');
    assert.ok(reloaded.snapshot()['session-pinned'], 'pin 会话保留');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
