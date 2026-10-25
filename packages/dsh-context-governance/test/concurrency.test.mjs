import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { parseTopicFile } from '../src/memory/entry-format.js';
import { tempDir } from './helpers.mjs';

test('并发写入被单写者队列串行化，不丢条、不重号、不损坏文件', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const types = ['decision', 'todo', 'progress', 'fact', 'preference', 'criterion', 'anchor'];
    const jobs = [];
    for (let i = 0; i < 60; i += 1) {
      jobs.push(store.create({
        type: types[i % types.length],
        title: `并发条目 ${String(i).padStart(2, '0')}`,
        detail: `第 ${i} 条`,
        writer: 'rule',
        source: `session:test#${i}`,
      }));
    }
    const created = await Promise.all(jobs);
    assert.equal(created.length, 60);
    const ids = new Set(created.map((entry) => entry.id));
    assert.equal(ids.size, 60, 'ids must be unique');

    const entries = store.entries();
    assert.equal(entries.length, 60);

    // 全部主题文件都应可解析，且没有临时文件残留。
    const dir = path.join(rootDir, 'topics');
    const files = await fs.readdir(dir);
    assert.equal(files.some((name) => name.includes('.tmp')), false);
    let parsed = 0;
    for (const name of files.filter((file) => file.endsWith('.md'))) {
      const type = name.slice(0, -3);
      const content = await fs.readFile(path.join(dir, name), 'utf8');
      parsed += parseTopicFile(content, { file: `topics/${name}`, project: 'test-project', type }).length;
    }
    assert.equal(parsed, 60);

    const index = await fs.readFile(path.join(rootDir, 'MEMORY.md'), 'utf8');
    assert.equal(index.split('\n').filter((line) => line.startsWith('- MEM-')).length, 60);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('写失败不会卡死队列：后续写入继续可用', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const good = await store.create({ type: 'fact', title: '正常', writer: 'user' });
    await assert.rejects(store.create({ type: 'fact', title: '', writer: 'user' }), /title/);
    const after = await store.create({ type: 'fact', title: '失败之后', writer: 'user' });
    assert.notEqual(after.id, good.id);
    assert.equal(store.entries().length, 2);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('两个 store 不能同时写同一项目（进程内写者锁）', async () => {
  const rootDir = await tempDir();
  const first = await MemoryStore.open({ rootDir, project: 'test-project' });
  const second = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    assert.equal(first.status.writable, true);
    assert.equal(second.status.writable, false);
    assert.match(second.status.readOnlyReason, /writer-lock/);
    await assert.rejects(second.create({ type: 'fact', title: 'x', writer: 'user' }), /read-only/);

    await first.close();
    await second.reload();
    assert.equal(second.status.writable, true);
    const entry = await second.create({ type: 'fact', title: '移交写者', writer: 'user' });
    assert.equal(second.get(entry.id).title, '移交写者');
  } finally {
    await first.close().catch(() => {});
    await second.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
