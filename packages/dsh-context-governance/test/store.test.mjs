import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ExternalModificationError,
  MemoryReadOnlyError,
  MemoryStore,
  MemoryStoreError,
} from '../src/memory/store.js';
import { parseTopicFile } from '../src/memory/entry-format.js';
import { draft, tempDir, withStore } from './helpers.mjs';

test('首次打开会建目录与空索引', async () => {
  await withStore(async (store, rootDir) => {
    const index = await fs.readFile(path.join(rootDir, 'MEMORY.md'), 'utf8');
    assert.match(index, /# Memory index — test-project/);
    assert.equal(store.status.writable, true);
    assert.deepEqual(store.status.counts, { proposed: 0, active: 0, superseded: 0, expired: 0 });
    assert.ok((await fs.stat(path.join(rootDir, 'topics'))).isDirectory());
  });
});

test('新建/读取/更新/确认/过期/取代的完整链路', async () => {
  await withStore(async (store) => {
    const created = await store.create(draft());
    assert.match(created.id, /^MEM-\d{8}-\d{3}$/);
    assert.equal(created.status, 'active');
    assert.equal(store.get(created.id).title, '插件名定为 dsh-context-governance');

    const updated = await store.update(created.id, { title: '插件名定为 dsh-context-governance（定稿）' });
    assert.equal(updated.title, '插件名定为 dsh-context-governance（定稿）');

    const proposal = await store.create({
      type: 'todo',
      title: '接 T3 压缩适配',
      writer: 'model',
      confidence: 0.7,
      risk: 'high',
    });
    assert.equal(proposal.status, 'proposed');
    await assert.rejects(store.confirm('MEM-19000101-001'), (e) => e instanceof MemoryStoreError && e.code === 'NOT_FOUND');
    const confirmed = await store.confirm(proposal.id);
    assert.equal(confirmed.status, 'active');
    await assert.rejects(store.confirm(proposal.id), /cannot move active → active/);

    const expired = await store.expire(proposal.id);
    assert.equal(expired.status, 'expired');

    const replacement = await store.supersede(created.id, {
      title: '插件名保持 dsh-context-governance',
      writer: 'user',
    });
    assert.equal(replacement.entry.supersedes, created.id);
    assert.equal(replacement.superseded.status, 'superseded');
    assert.equal(replacement.superseded.supersededBy, replacement.entry.id);
    await assert.rejects(
      store.supersede(created.id, { title: '再取代', writer: 'user' }),
      (e) => e instanceof MemoryStoreError && e.code === 'ALREADY_SUPERSEDED',
    );
  });
});

test('纯索引查询不带详情；按 ids 查询才返回详情', async () => {
  await withStore(async (store) => {
    const entry = await store.create(draft());
    await store.create({ type: 'preference', title: '回复用中文', writer: 'user' });
    const index = store.query({});
    assert.equal(index.count, 2);
    assert.deepEqual(Object.keys(index.entries[0]).includes('detail'), false);
    assert.equal('detail' in index.entries[0], false);

    const detail = store.query({ ids: [entry.id] });
    assert.equal(detail.count, 1);
    assert.equal(detail.entries[0].detail, draft().detail);

    const byText = store.query({ text: '回复用中文' });
    assert.equal(byText.count, 1);
    assert.equal(byText.entries[0].type, 'preference');

    const byType = store.query({ type: 'decision' });
    assert.equal(byType.count, 1);
    assert.equal(store.query({ status: 'proposed' }).count, 0);
    assert.equal(store.query({ limit: 1 }).entries.length, 1);
  });
});

test('MEMORY.md 是派生索引：一行一条，不含详情', async () => {
  await withStore(async (store, rootDir) => {
    const entry = await store.create(draft());
    const index = await fs.readFile(path.join(rootDir, 'MEMORY.md'), 'utf8');
    assert.match(index, new RegExp(`- ${entry.id} · active · decision · 插件名`));
    assert.ok(!index.includes('大小写与 npm 包名一致'));
  });
});

test('主题文件往返：重开存储后条目完整，落盘格式可解析', async () => {
  const rootDir = await tempDir();
  try {
    const first = await MemoryStore.open({ rootDir, project: 'test-project' });
    const created = await first.create(draft({ detail: '第一段\n\n第二段' }));
    await first.close();

    const raw = await fs.readFile(path.join(rootDir, 'topics', 'decision.md'), 'utf8');
    assert.match(raw, /<!-- entry:MEM-\d{8}-\d{3} -->/);
    assert.match(raw, /### MEM-\d{8}-\d{3}/);
    assert.match(raw, /- source: session:test#1/);
    const reparsed = parseTopicFile(raw, { file: 'topics/decision.md', project: 'test-project', type: 'decision' });
    assert.equal(reparsed.length, 1);
    assert.equal(reparsed[0].detail, '第一段\n\n第二段');

    const second = await MemoryStore.open({ rootDir, project: 'test-project' });
    const loaded = second.get(created.id);
    assert.equal(loaded.title, created.title);
    assert.equal(loaded.detail, '第一段\n\n第二段');
    assert.equal(loaded.writer, 'user');
    await second.close();
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('原子写不留下临时文件，且覆盖前留一代备份', async () => {
  await withStore(async (store, rootDir) => {
    const entry = await store.create(draft());
    await store.update(entry.id, { title: '第二版标题' });
    const dir = path.join(rootDir, 'topics');
    const names = await fs.readdir(dir);
    assert.equal(names.some((name) => name.includes('.tmp')), false);
    assert.ok(names.includes('decision.md.bak'), '覆盖后应存在 .bak');
    const bak = await fs.readFile(path.join(dir, 'decision.md.bak'), 'utf8');
    assert.match(bak, /插件名定为 dsh-context-governance/);
    assert.ok(!bak.includes('第二版标题'));
  });
});

test('敏感信息被拒绝，且不落盘', async () => {
  await withStore(async (store, rootDir) => {
    await assert.rejects(
      store.create({ type: 'fact', title: '密钥', detail: 'api_key = sk-abcdefghijklmnopqrstuvwx', writer: 'user' }),
      /SENSITIVE_CONTENT/,
    );
    assert.equal(store.entries().length, 0);
    const files = await fs.readdir(path.join(rootDir, 'topics')).catch(() => []);
    assert.equal(files.filter((name) => name.endsWith('.md')).length, 0);
  });
});

test('未知状态/非法更新不会写坏文件', async () => {
  await withStore(async (store) => {
    const entry = await store.create(draft());
    await assert.rejects(store.update(entry.id, { status: 'active' }), /cannot be patched/);
    await assert.rejects(store.update('MEM-19000101-001', { title: 'x' }), (e) => e instanceof MemoryStoreError && e.code === 'NOT_FOUND');
    await assert.rejects(
      store.update(entry.id, { risk: 'high' }),
      (e) => e instanceof MemoryStoreError && e.code === 'RISK_ACTIVE',
    );
    assert.equal(store.get(entry.id).status, 'active');
  });
});

test('只读存储拒绝一切写入', async () => {
  await withStore(async (store) => {
    const entry = await store.create(draft());
    const rootDir = store.rootDir;
    await store.close();
    const readOnly = await MemoryStore.open({ rootDir, project: 'test-project', readOnly: true });
    try {
      assert.equal(readOnly.status.writable, false);
      await assert.rejects(readOnly.create(draft()), (e) => e instanceof MemoryReadOnlyError);
      assert.equal(readOnly.get(entry.id).title, entry.title);
    } finally {
      await readOnly.close();
    }
  });
});

test('外部修改会被检测到并转只读', async () => {
  await withStore(async (store, rootDir) => {
    const entry = await store.create(draft());
    const file = path.join(rootDir, 'topics', 'decision.md');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original.replace('插件名定为', '插件名被外部改成'), 'utf8');
    await assert.rejects(store.create(draft({ title: '下一条' })), (e) => e instanceof ExternalModificationError);
    assert.equal(store.status.writable, false);
    assert.match(store.status.readOnlyReason, /external-change/);
    await assert.rejects(store.create(draft({ title: '再一条' })), (e) => e instanceof MemoryReadOnlyError);
    assert.equal(store.get(entry.id).title, '插件名定为 dsh-context-governance');
  });
});

test('外部新增主题文件也会被检测到', async () => {
  await withStore(async (store, rootDir) => {
    await store.create(draft());
    await fs.writeFile(
      path.join(rootDir, 'topics', 'fact.md'),
      '# topics/fact.md — project test-project\n\n<!-- entry:MEM-20261025-099 -->\n### MEM-20261025-099\n- title: 外部写入\n- type: fact\n- status: proposed\n- project: test-project\n- writer: model\n- confidence: 0.5\n- risk: low\n- createdAt: 2026-10-25T00:00:00.000Z\n- updatedAt: 2026-10-25T00:00:00.000Z\n- supersedes: \n- supersededBy: \n- source: \n- evidence: \n<!-- /entry -->\n',
      'utf8',
    );
    await assert.rejects(store.create(draft({ title: '下一条' })), /outside this store/);
    assert.equal(store.status.writable, false);
  });
});

test('reload 之后可以继续写（外部修改已由人处理）', async () => {
  await withStore(async (store, rootDir) => {
    await store.create(draft());
    const file = path.join(rootDir, 'topics', 'decision.md');
    await fs.appendFile(file, '\n<!-- 人工备注 -->\n', 'utf8');
    await assert.rejects(store.create(draft({ title: 'x' })), (e) => e instanceof ExternalModificationError);
    await store.reload();
    assert.equal(store.status.writable, true);
    const entry = await store.create(draft({ title: 'x' }));
    assert.equal(store.get(entry.id).title, 'x');
  });
});
