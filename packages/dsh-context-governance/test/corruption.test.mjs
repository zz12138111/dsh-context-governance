import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { tempDir } from './helpers.mjs';

test('主题文件损坏时使用 .bak 只读，并告警', async () => {
  const rootDir = await tempDir();
  try {
    const first = await MemoryStore.open({ rootDir, project: 'test-project' });
    const entry = await first.create({ type: 'decision', title: '第一版标题', writer: 'user' });
    // 第二写产生 .bak（内容 = 第一版）。
    await first.update(entry.id, { title: '第二版标题' });
    await first.close();

    await fs.writeFile(path.join(rootDir, 'topics', 'decision.md'), '<!-- entry:broken -->\n乱码', 'utf8');

    const second = await MemoryStore.open({ rootDir, project: 'test-project' });
    try {
      assert.equal(second.status.writable, false);
      assert.match(second.status.readOnlyReason, /corrupt:topics\/decision\.md/);
      assert.ok(second.warnings.some((warning) => warning.includes('loaded the .bak copy')));
      const entries = second.entries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].title, '第一版标题', 'backup 是覆盖前的一代');
      await assert.rejects(second.create({ type: 'fact', title: 'x', writer: 'user' }), /read-only/);
    } finally {
      await second.close();
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('没有可用备份时损坏文件只读且为空，不误删原文件', async () => {
  const rootDir = await tempDir();
  try {
    const first = await MemoryStore.open({ rootDir, project: 'test-project' });
    await first.create({ type: 'fact', title: '唯一一条', writer: 'user' });
    await first.close();
    const file = path.join(rootDir, 'topics', 'fact.md');
    await fs.writeFile(file, 'this is not a memory file', 'utf8');

    const second = await MemoryStore.open({ rootDir, project: 'test-project' });
    try {
      assert.equal(second.status.writable, false);
      assert.match(second.status.readOnlyReason, /corrupt/);
      assert.equal(second.entries().length, 0);
      const stillThere = await fs.readFile(file, 'utf8');
      assert.equal(stillThere, 'this is not a memory file', '只读模式不得覆盖损坏文件');
    } finally {
      await second.close();
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('重复 ID 视为损坏', async () => {
  const rootDir = await tempDir();
  try {
    const store = await MemoryStore.open({ rootDir, project: 'test-project' });
    await store.create({ type: 'fact', title: 'a', writer: 'user' });
    await store.close();
    const file = path.join(rootDir, 'topics', 'fact.md');
    const content = await fs.readFile(file, 'utf8');
    const start = content.indexOf('<!-- entry:');
    const end = content.indexOf('<!-- /entry -->') + '<!-- /entry -->'.length;
    const block = content.slice(start, end);
    await fs.writeFile(file, `${content}\n${block}\n`, 'utf8');

    const reopened = await MemoryStore.open({ rootDir, project: 'test-project' });
    try {
      assert.equal(reopened.status.writable, false);
      assert.match(reopened.status.readOnlyReason, /corrupt/);
    } finally {
      await reopened.close();
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
