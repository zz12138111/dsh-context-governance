/**
 * D-MGMT-023 ①：保护条 id 单调分配 + 跨重启从磁盘续号（同日不复用）。
 *
 * 真机病历（rc.2，cycle 76f00aed / 下一轮）：同日两轮压缩都从 1005 起编，
 * 第 2 轮把 MEM-20261115-1005 覆盖成本轮 latest-user；理由：id 只在“当前已加载键”上找空位，
 * 被同标题去重/未落库的 id 不占位。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore, PROTECTION_ID_FLOOR } from '../src/memory/store.js';
import { tempDir } from './helpers.mjs';

const item = (title, detail = '正文') => ({
  type: 'fact', title, detail, source: 'session:test#1',
});

test('D-MGMT-023 ①：同日两轮 id 单调递增，不复用上一轮号段', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const first = store.protectSync({ cycleKey: 'cmp-1', items: [item('第一轮：进度 1/2')] });
    const second = store.protectSync({ cycleKey: 'cmp-2', items: [item('第二轮：进度 2/2')] });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    const firstSeq = Number(first[0].id.split('-').at(-1));
    const secondSeq = Number(second[0].id.split('-').at(-1));
    assert.ok(secondSeq > firstSeq, `第二轮 id 必须大于第一轮：${first[0].id} → ${second[0].id}`);
    assert.notEqual(second[0].id, first[0].id);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('D-MGMT-023 ①：id 跨重启从磁盘续号（不回到 floor/不重发）', async () => {
  const rootDir = await tempDir();
  try {
    const firstStore = await MemoryStore.open({ rootDir, project: 'test-project' });
    const before = firstStore.protectSync({ cycleKey: 'cmp-a', items: [item('重启前一条')] });
    await firstStore.materializeProtection('cmp-a');
    await firstStore.close();

    // 高水位文件必须存在，且内容里带当日最大序号。
    const watermarkFile = path.join(rootDir, 'protection', '.id-watermark');
    const raw = await fs.readFile(watermarkFile, 'utf8');
    const data = JSON.parse(raw);
    const date = before[0].id.split('-')[1];
    assert.equal(data.dates[date], Number(before[0].id.split('-').at(-1)));

    const secondStore = await MemoryStore.open({ rootDir, project: 'test-project' });
    try {
      const after = secondStore.protectSync({ cycleKey: 'cmp-b', items: [item('重启后一条')] });
      const beforeSeq = Number(before[0].id.split('-').at(-1));
      const afterSeq = Number(after[0].id.split('-').at(-1));
      assert.ok(afterSeq > beforeSeq, `重启后必须续号：${before[0].id} → ${after[0].id}`);
      assert.ok(afterSeq >= PROTECTION_ID_FLOOR);
    } finally {
      await secondStore.close();
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('D-MGMT-023 ①：被 discard 的周期也不回收号段', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const dropped = store.protectSync({ cycleKey: 'cmp-drop', items: [item('未压缩的预写')] });
    await store.discardProtection('cmp-drop');
    const next = store.protectSync({ cycleKey: 'cmp-next', items: [item('下一轮')] });
    assert.ok(
      Number(next[0].id.split('-').at(-1)) > Number(dropped[0].id.split('-').at(-1)),
      `discard 后不得复用号段：${dropped[0].id} → ${next[0].id}`,
    );
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('D-MGMT-023 ①：同标题去重前移到 protectSync——journal 仍留（回注不丢），物化只落 1 条', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const same = item('规则在场：AGENTS.md');
    const cycle = store.protectSync({ cycleKey: 'cmp-dup', items: [same, same] });
    assert.equal(cycle.length, 2, 'journal 保留两条供回注');
    assert.equal(cycle[0].deduped, undefined);
    assert.equal(cycle[1].deduped, true, '第二条标记为去重');

    const result = await store.materializeProtection('cmp-dup');
    assert.equal(result.moved, 1, '只落 1 条');
    assert.equal(result.ids.length, 1);
    assert.equal(result.dedupedIds.length, 1);
    assert.equal(result.dedupedIds[0], cycle[1].id);
    assert.equal(store.allEntries().filter((entry) => entry.title.startsWith('规则在场')).length, 1);
    // ids 与落盘逐条对账：moved 记的每个 id 都能在 store 里解析。
    for (const id of result.ids) {
      assert.equal(store.get(id).id, id, `id 不可解析：${id}`);
    }
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
