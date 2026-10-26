import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { MEM_QUERY_NAME, MEM_WRITE_NAME, createMemoryTools, registerMemoryTools } from '../src/tools/mem-tools.js';
import { apply, resolveConfig } from '../src/index.js';
import { tempDir } from './helpers.mjs';

const exec = { agent: { session: { id: 'session-test' } } };

function toolsFor(store) {
  return createMemoryTools(store);
}

test('mem_write 新建后自动带会话来源，模型写入默认 proposed', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const tools = toolsFor(store);
    const write = tools[MEM_WRITE_NAME].definition;
    const value = await write.execute({
      op: 'create',
      type: 'decision',
      title: 'E2 默认形态用 ID+状态',
      writer: 'model',
      confidence: 0.8,
    }, exec);
    assert.match(value.id, /^MEM-\d{8}-\d{3}$/);
    assert.equal(value.status, 'proposed');
    const stored = store.get(value.id);
    assert.equal(stored.source, 'session:session-test');
    assert.equal(stored.writer, 'model');

    const confirmed = await write.execute({ op: 'confirm', id: value.id }, exec);
    assert.equal(confirmed.status, 'active');

    const expired = await write.execute({ op: 'expire', id: value.id }, exec);
    assert.equal(expired.status, 'expired');

    await assert.rejects(
      write.execute({ op: 'update', id: value.id, status: 'active' }, exec),
      /status transitions use confirm/,
    );
    await assert.rejects(write.execute({ op: 'bogus' }, exec), /BAD_OP/);
    await assert.rejects(
      write.execute({ op: 'create', type: 'fact', title: '密钥', detail: 'password: hunter2hunter2', writer: 'user' }, exec),
      /SENSITIVE_CONTENT/,
    );
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('mem_query 默认只返回索引，ids 才带详情', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const tools = toolsFor(store);
    const write = tools[MEM_WRITE_NAME].definition;
    const query = tools[MEM_QUERY_NAME].definition;
    const a = await write.execute({ op: 'create', type: 'todo', title: '接 T3', detail: '压缩适配的细节', writer: 'user' }, exec);
    await write.execute({ op: 'create', type: 'preference', title: '用中文', writer: 'user' }, exec);

    const list = await query.execute({ limit: 10 }, {});
    assert.equal(list.count, 2);
    assert.equal('detail' in list.entries[0], false);

    const detail = await query.execute({ ids: [a.id] }, {});
    assert.equal(detail.count, 1);
    assert.equal(detail.entries[0].detail, '压缩适配的细节');

    const filtered = await query.execute({ text: '中文' }, {});
    assert.equal(filtered.count, 1);

    await assert.rejects(query.execute({ ids: Array.from({ length: 21 }, (_, i) => `MEM-20261025-${String(i + 1).padStart(3, '0')}`) }, {}), /at most 20 ids/);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('工具注册：ctx.tools.register 逐个注册，缺失时只记录失败不抛出', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const registered = [];
    const ctx = { tools: { register: (definition) => registered.push(definition.name) } };
    const result = registerMemoryTools(ctx, store);
    assert.deepEqual(result.registered, [MEM_WRITE_NAME, MEM_QUERY_NAME]);
    assert.deepEqual(registered, [MEM_WRITE_NAME, MEM_QUERY_NAME]);

    const missing = registerMemoryTools({}, store);
    assert.deepEqual(missing.failures.map((failure) => failure.name), [MEM_WRITE_NAME, MEM_QUERY_NAME]);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('resolveConfig：默认项目取目录名，非法配置直接拒绝', () => {
  const config = resolveConfig({ projectRoot: 'D:\\work\\demo' });
  assert.equal(config.project, 'demo');
  assert.equal(config.memoryRoot, path.resolve('D:\\work\\demo', 'memory', 'governance'));
  assert.equal(config.enabled, true);

  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/);
  assert.throws(() => resolveConfig({ memoryRoot: '' }), /memoryRoot/);
  assert.throws(() => resolveConfig({ indexMaxChars: 10 }), /indexMaxChars/);
  assert.equal(resolveConfig({ project: '  显式项目  ' }).project, '显式项目');
});

test('apply：注册工具、打开记忆库，并在 dispose 时释放写者锁', async () => {
  const rootDir = await tempDir();
  const disposers = [];
  const registered = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition.name) },
    logger: { info: () => {}, warn: () => {} },
    effect: (callback, _label) => {
      const disposer = callback();
      disposers.push(disposer);
    },
  };
  try {
    await apply(ctx, { projectRoot: rootDir, project: 'test-project' });
    assert.deepEqual(registered, [MEM_WRITE_NAME, MEM_QUERY_NAME]);
    assert.ok(await fs.stat(path.join(rootDir, 'memory', 'governance', '.writer.json')).then(() => true, () => false));

    for (const disposer of disposers) await disposer();
    assert.equal(await fs.stat(path.join(rootDir, 'memory', 'governance', '.writer.json')).then(() => true, () => false), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
