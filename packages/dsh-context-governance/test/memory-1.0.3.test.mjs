/**
 * 1.0.3（REQ-20261114-01）：记忆"读得出"修复。
 *
 * 覆盖单里 A 档四条：①写入准入（空正文/截断标题 → 不进入库 + 审计 1 行）；
 * ②proposed 超期自动作废；③同标题去重（含保护条目物化）；④配置键组与夹取。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { MEM_WRITE_NAME, createMemoryTools } from '../src/tools/mem-tools.js';
import { resolveConfig } from '../src/index.js';
import { tempDir } from './helpers.mjs';

const exec = { agent: { session: { id: 'session-1f3' } } };

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
}

test('1.0.3 条款1：空正文/截断标题被拒（库不变 + memory-tool-rejected 1 行）', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const audit = makeAudit();
    const tools = createMemoryTools(store, { audit });
    const write = tools[MEM_WRITE_NAME].definition;
    const before = store.allEntries().length;

    await assert.rejects(
      write.execute({ op: 'create', type: 'criterion', title: '规则在场：不会落库', writer: 'model', confidence: 0.8 }, exec),
      /ENTRY_UNREADABLE/,
    );
    assert.equal(store.allEntries().length, before, '空正文不得入库');
    assert.equal(audit.entries.at(-1).event, 'memory-tool-rejected');
    assert.equal(audit.entries.at(-1).code, 'ENTRY_UNREADABLE');
    assert.equal(audit.entries.at(-1).reason, 'empty-detail');

    await assert.rejects(
      write.execute({ op: 'create', type: 'anchor', title: '回滚点：', detail: '正文在场', writer: 'model', confidence: 0.8 }, exec),
      /ENTRY_UNREADABLE/,
    );
    assert.equal(store.allEntries().length, before, '截断标题不得入库');
    assert.equal(audit.entries.at(-1).reason, 'title-cut-separator');

    await assert.rejects(
      write.execute({ op: 'create', type: 'criterion', title: '规则在场（未闭合 `', detail: '正文在场', writer: 'model', confidence: 0.8 }, exec),
      /ENTRY_UNREADABLE/,
    );
    assert.equal(audit.entries.at(-1).reason, 'title-unclosed-backtick');

    // 合法写入仍可落库（正文非空、标题完整）。
    const ok = await write.execute({
      op: 'create', type: 'fact', title: '构建号 1.0.3', detail: '版本号与 commit 已记录', writer: 'model', confidence: 0.5,
    }, exec);
    assert.equal(ok.status, 'proposed');
    assert.equal(store.allEntries().length, before + 1);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('1.0.3 条款2：proposed 超 TTL 自动 expired（索引计数同步）', async () => {
  const rootDir = await tempDir();
  const start = new Date('2026-11-01T00:00:00Z');
  const store = await MemoryStore.open({ rootDir, project: 'test-project', now: () => start, proposedTtlDays: 1 });
  let id;
  try {
    const entry = await store.create({
      type: 'fact', title: '待确认的一条', detail: '正文', writer: 'model', confidence: 0.5,
    });
    id = entry.id;
    assert.equal(store.status.counts.proposed, 1);
  } finally {
    await store.close();
  }
  // 2 天后重开：超 1 天 TTL → expired。
  const later = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
  const reopened = await MemoryStore.open({ rootDir, project: 'test-project', now: () => later, proposedTtlDays: 1 });
  try {
    assert.equal(reopened.get(id).status, 'expired');
    assert.deepEqual(reopened.status.counts, { proposed: 0, active: 0, superseded: 0, expired: 1 });
    const index = await fs.readFile(path.join(rootDir, 'MEMORY.md'), 'utf8');
    assert.match(index, /expired 1/);
  } finally {
    await reopened.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('1.0.3 条款3：同标题 7 天内只留 1 条（mem_write 与保护条目都覆盖）', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const tools = createMemoryTools(store);
    const write = tools[MEM_WRITE_NAME].definition;
    const first = await write.execute({ op: 'create', type: 'fact', title: '同一条标题', detail: '第一次', writer: 'model', confidence: 0.5 }, exec);
    const second = await write.execute({ op: 'create', type: 'fact', title: '同一条标题。', detail: '第二次', writer: 'model', confidence: 0.5 }, exec);
    assert.equal(second.id, first.id, '窗口内同标题返回既有条目');
    assert.equal(store.allEntries().length, 1);

    // 保护条目：两次压缩同标题，物化后只留 1 条，但两次 journal 都返回（回注不丢）。
    const item = { type: 'criterion', title: '规则在场：system-prompt、AGENTS.md', detail: '', source: 'session:s#1' };
    const cycle1 = store.protectSync({ cycleKey: 'cmp-1', items: [item] });
    const cycle2 = store.protectSync({ cycleKey: 'cmp-2', items: [item] });
    assert.equal(cycle1.length, 1);
    assert.equal(cycle2.length, 1, '回注仍需本周期指针');
    await store.materializeProtection('cmp-1');
    await store.materializeProtection('cmp-2');
    const rules = store.allEntries().filter((entry) => entry.title.startsWith('规则在场'));
    assert.equal(rules.length, 1, '同内容只入库 1 条');
    assert.ok(rules[0].detail.length > 0, '正文非空');
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('1.0.3 条款4：自动提取条目必须 proposed 且 confidence ≤0.5', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    store.protectSync({
      cycleKey: 'cmp-conf',
      items: [{ type: 'progress', title: '批次进度：511/958', detail: '', source: 'session:s#2' }],
    });
    await store.materializeProtection('cmp-conf');
    const entry = store.allEntries().find((item) => item.title.startsWith('批次进度'));
    assert.equal(entry.status, 'proposed');
    assert.ok(entry.confidence <= 0.5, `confidence=${entry.confidence}`);
    assert.ok(entry.detail.length > 0);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('1.0.3 条款5：连续两次压缩新增条目 ≤1 且正文非空', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const items = [
      { type: 'fact', title: '最后用户消息：继续', detail: '', source: 'session:s#10' },
      { type: 'criterion', title: '规则在场：AGENTS.md', detail: '', source: 'session:s#11' },
    ];
    store.protectSync({ cycleKey: 'cmp-a', items });
    await store.materializeProtection('cmp-a');
    const first = store.allEntries().length;
    store.protectSync({ cycleKey: 'cmp-b', items });
    await store.materializeProtection('cmp-b');
    const second = store.allEntries().length;
    assert.equal(second - first, 0, '同内容第二次压缩新增 0 条');
    for (const entry of store.allEntries()) assert.ok(entry.detail.length > 0, `${entry.id} 正文为空`);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('1.0.3 配置键组：memory.proposedTtlDays / dedupWindowDays 夹取与非法拒绝', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/p', memory: { proposedTtlDays: 3, dedupWindowDays: 0 } });
  assert.equal(config.memory.proposedTtlDays, 3);
  assert.equal(config.memory.dedupWindowDays, 0);
  assert.equal(resolveConfig({ projectRoot: 'D:/tmp/p' }).memory.proposedTtlDays, 7);
  assert.throws(() => resolveConfig({ projectRoot: 'D:/tmp/p', memory: { proposedTtlDays: -1 } }), /memory\.proposedTtlDays/);
  assert.throws(() => resolveConfig({ projectRoot: 'D:/tmp/p', memory: { dedupWindowDays: 400 } }), /memory\.dedupWindowDays/);
});
