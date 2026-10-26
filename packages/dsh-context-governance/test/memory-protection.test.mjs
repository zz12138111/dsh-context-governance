import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryReadOnlyError, MemoryStore } from '../src/memory/store.js';
import { tempDir, withStore } from './helpers.mjs';

function item(title, seq = 1) {
  return {
    type: 'fact',
    title,
    source: `session:test#${seq}`,
  };
}

test('protectSync：同步写 journal，条目立即可查；ID 落在保护区间', async () => {
  await withStore(async (store, rootDir) => {
    const entries = store.protectSync({
      cycleKey: 'cycle-A',
      compactionId: 'cycle-A',
      sessionId: 'test-session',
      items: [item('最后用户消息：继续 T4', 13)],
    });
    assert.equal(entries.length, 1);
    assert.match(entries[0].id, /^MEM-\d{8}-1\d{3}$/);
    assert.equal(store.get(entries[0].id).title, '最后用户消息：继续 T4');
    assert.equal(store.query({ ids: [entries[0].id] }).count, 1);
    assert.equal(store.protectionPending, 1);

    const journalDir = path.join(rootDir, 'protection');
    const files = await fs.readdir(journalDir);
    assert.equal(files.filter((name) => name.endsWith('.json')).length, 1);
  });
});

test('protectSync：同一 cycle 幂等，不重复分号/写文件', async () => {
  await withStore(async (store, rootDir) => {
    const first = store.protectSync({ cycleKey: 'cycle-A', items: [item('a', 1)] });
    const second = store.protectSync({ cycleKey: 'cycle-A', items: [item('a', 1), item('b', 2)] });
    assert.deepEqual(second.map((entry) => entry.id), first.map((entry) => entry.id));
    assert.equal(store.protectionPending, 1);
    const files = (await fs.readdir(path.join(rootDir, 'protection'))).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
  });
});

test('materializeProtection：并入主题文件与索引，journal 删除', async () => {
  await withStore(async (store, rootDir) => {
    const [entry] = store.protectSync({ cycleKey: 'cycle-A', items: [item('批次 STATE：TASKS\\x-STATE.md', 3)] });
    const result = await store.materializeProtection('cycle-A');
    assert.equal(result.moved, 1);
    assert.equal(store.protectionPending, 0);
    const topic = await fs.readFile(path.join(rootDir, 'topics', 'fact.md'), 'utf8');
    assert.ok(topic.includes(entry.id));
    assert.ok((await fs.readFile(path.join(rootDir, 'MEMORY.md'), 'utf8')).includes(entry.id));
    assert.equal(store.get(entry.id).title, entry.title);
    const journals = await fs.readdir(path.join(rootDir, 'protection')).catch(() => []);
    assert.equal(journals.filter((name) => name.endsWith('.json')).length, 0);
    // 二次物化是无操作
    assert.deepEqual(await store.materializeProtection('cycle-A'), { moved: 0, ids: [] });
  });
});

test('残留 journal 在下次 open 时自动物化', async () => {
  const rootDir = await tempDir();
  try {
    const first = await MemoryStore.open({ rootDir, project: 'test-project' });
    const [entry] = first.protectSync({ cycleKey: 'crash-cycle', items: [item('回滚点：D:\\backup\\x.zip', 4)] });
    await first.close();

    const second = await MemoryStore.open({ rootDir, project: 'test-project' });
    try {
      assert.equal(second.protectionPending, 0);
      assert.equal(second.get(entry.id).title, '回滚点：D:\\backup\\x.zip');
      const topic = await fs.readFile(path.join(rootDir, 'topics', 'fact.md'), 'utf8');
      assert.ok(topic.includes(entry.id));
    } finally {
      await second.close();
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('P3：orphan 归档只移动不删除；discard 只用于明确未压缩', async () => {
  await withStore(async (store, rootDir) => {
    const [entry] = store.protectSync({ cycleKey: 'early-unknown', items: [item('批处理进度：块B', 9)] });
    assert.equal(store.protectionPending, 1);
    const archived = await store.archiveProtection('early-unknown', { reason: 'early-start-missing' });
    assert.equal(archived.ok, true);
    assert.equal(store.protectionPending, 0, '归档后不再算 pending');
    assert.equal(store.get(entry.id), null, '归档不发生活跃记忆物化');
    const orphanDir = path.join(rootDir, 'protection', 'orphaned');
    const files = (await fs.readdir(orphanDir)).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1, '归档文件必须保留');
    const journal = JSON.parse(await fs.readFile(path.join(orphanDir, files[0]), 'utf8'));
    assert.equal(journal.status, 'unknown');
    assert.equal(journal.archiveReason, 'early-start-missing');
    assert.equal(journal.entries[0].id, entry.id);

    store.protectSync({ cycleKey: 'discard-me', items: [item('临时', 10)] });
    const discarded = await store.discardProtection('discard-me');
    assert.equal(discarded.ok, true);
    assert.equal(store.protectionPending, 0);
    assert.equal((await fs.readdir(orphanDir)).filter((name) => name.endsWith('.json')).length, 1, 'discard 不写 orphan');
  });
});

test('只读 store 的 protectSync 抛 READ_ONLY，不落 journal', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project', readOnly: true });
  try {
    assert.throws(
      () => store.protectSync({ cycleKey: 'readonly', items: [item('x')] }),
      (error) => error instanceof MemoryReadOnlyError,
    );
    const dir = path.join(rootDir, 'protection');
    assert.equal(await fs.stat(dir).then(() => true, () => false), false);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
