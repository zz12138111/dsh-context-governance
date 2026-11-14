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
import { detectTitleTruncation } from '../src/memory/contract.js';
import { buildProtectionItems } from '../src/compress/protection-memory.js';
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

test('1.0.3 观察修正：用户直写同样受准入；旧空正文条目不被拿去去重', async () => {  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const audit = makeAudit();
    const tools = createMemoryTools(store, { audit });
    const write = tools[MEM_WRITE_NAME].definition;
    // 用户直写（writer=user）空正文也拒——"读得出"不按写入者豁免。
    await assert.rejects(
      write.execute({ op: 'create', type: 'preference', title: '用中文', writer: 'user' }, exec),
      /ENTRY_UNREADABLE/,
    );
    assert.equal(audit.entries.at(-1).reason, 'empty-detail');

    // 1.0.2 遗留：直调 store.create 造一条正文为空的旧条目；同标题新写入不应被它去重吃掉。
    const legacy = await store.create({ type: 'preference', title: '用中文', detail: '', writer: 'user' });
    assert.equal(legacy.detail, '');
    const fresh = await write.execute({ op: 'create', type: 'preference', title: '用中文', detail: '偏好：中文', writer: 'user' }, exec);
    assert.notEqual(fresh.id, legacy.id, '空正文旧条目不得参与去重');
    assert.equal(store.get(fresh.id).detail, '偏好：中文');
    assert.equal(store.allEntries().length, 2);
  } finally {
    await store.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('1.0.3 守卫：生产代码里 `.create(` 直调只允许 mem-tools.js 一处（见 docs/记忆契约-v1.md §12）', async () => {
  // 准入在工具层；任何新代码直调 store.create 都会绕过它，且不会有人注意到
  // （1.0.2 白名单静默丢弃就是这种形态）。这条守卫把"只有一个入口"钉死。
  const srcDir = path.join(process.cwd(), 'src');
  const files = [];
  const walk = async (dir) => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.name.endsWith('.js')) files.push(full);
    }
  };
  await walk(srcDir);
  const hits = [];
  for (const file of files) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/\.create\(/.test(line)) return;
      const trimmed = line.trim();
      // 注释里提到 `MemoryStore.create()` 不算调用点。
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      hits.push({ rel, line: index + 1, text: trimmed });
    });
  }
  assert.equal(hits.length, 1, `直调点应为 1 处，实际：${JSON.stringify(hits)}`);
  assert.equal(hits[0].rel, 'src/tools/mem-tools.js');
});

test('1.0.3-B 回归（红）：过期 journal 不物化，直接归档', async () => {
  const rootDir = await tempDir();
  const s1 = await MemoryStore.open({ rootDir, project: 'test-project' });
  s1.protectSync({ cycleKey: 'old-cycle', items: [{ type: 'fact', title: '旧条目', detail: '正文', source: 'session:s#1' }] });
  await s1.close();
  const dir = path.join(rootDir, 'protection');
  const name = (await fs.readdir(dir)).find((n) => n.endsWith('.json'));
  const file = path.join(dir, name);
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.entries[0].createdAt = '2026-01-01T00:00:00.000Z';
  journal.entries[0].updatedAt = journal.entries[0].createdAt;
  await fs.writeFile(file, JSON.stringify(journal), 'utf8');
  const s2 = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    assert.equal(s2.allEntries().length, 0, '过期 journal 不得物化');
    const archived = await fs.readdir(path.join(dir, 'orphaned')).catch(() => []);
    assert.ok(archived.length >= 1, '应归档到 orphaned/');
  } finally { await s2.close(); await fs.rm(rootDir, { recursive: true, force: true }); }
});

test('1.0.3-5b 回归（红）：前缀近似的回滚点标题只留 1 条', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    store.protectSync({ cycleKey: 'c1', items: [{ type: 'anchor', title: '回滚点：G:\\DS-HARNESS', detail: '正文', source: 'session:s#1' }] });
    store.protectSync({ cycleKey: 'c2', items: [{ type: 'anchor', title: '回滚点：G:\\DS-HARNESS（见记忆）', detail: '正文', source: 'session:s#2' }] });
    await store.materializeProtection('c1');
    await store.materializeProtection('c2');
    const anchors = store.allEntries().filter((e) => e.title.startsWith('回滚点'));
    assert.equal(anchors.length, 1, '前缀近似应合并为 1 条');
  } finally { await store.close(); await fs.rm(rootDir, { recursive: true, force: true }); }
});
test('1.0.3-5c 回归：生成侧 anchor 标题不留残句（安全切分/退回指针）', () => {
  const base = { latestUser: null, rules: [], batch: null, unpairedCalls: [] };
  // 真机 #5 的残尾：未闭合反引号 + 半句「（见记忆」。
  const bad = buildProtectionItems(
    { ...base, rollback: { paths: [], keyword: 'G:\\DS-HARNESS`（见记忆', seq: 7 } },
    { sessionId: 'session-1f3', cycleKey: 'c5c' },
  );
  const anchor = bad.items.find((item) => item.type === 'anchor');
  assert.ok(anchor, '应生成 anchor 保护项');
  assert.equal(detectTitleTruncation(anchor.title), null, `标题不得截断：${anchor.title}`);
  assert.equal(anchor.title, '回滚点');

  // 超长标题仍只在安全边界切，切完不得被判截断。
  const long = buildProtectionItems(
    { ...base, rollback: { paths: [], keyword: `回滚点 ${'x'.repeat(300)}`, seq: 8 } },
    { sessionId: 'session-1f3', cycleKey: 'c5c-2' },
  );
  for (const item of long.items) {
    assert.equal(detectTitleTruncation(item.title), null, `标题不得截断：${item.title}`);
  }
});

test('1.0.3 准入守卫：journal 坏条目读入即跳过（不物化 + warning 一行带原因与计数）', async () => {
  const rootDir = await tempDir();
  const s1 = await MemoryStore.open({ rootDir, project: 'test-project' });
  s1.protectSync({ cycleKey: 'bad-cycle', items: [{ type: 'anchor', title: '回滚点：G:\\DS-HARNESS', detail: '正文', source: 'session:s#1' }] });
  await s1.close();
  const dir = path.join(rootDir, 'protection');
  const name = (await fs.readdir(dir)).find((n) => n.endsWith('.json'));
  const file = path.join(dir, name);
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.entries[0].title = '回滚点：'; // 截断标题：保护链路必须挡住
  await fs.writeFile(file, JSON.stringify(journal), 'utf8');
  const s2 = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    assert.equal(s2.allEntries().length, 0, '坏条目不得物化');
    const hit = s2.warnings.find((line) => /ignored unreadable protection journal/.test(line));
    assert.ok(hit, `应有跳过 warning，实际：${JSON.stringify(s2.warnings)}`);
    assert.match(hit, /1\/1 entries \(title-cut-separator\)/);
  } finally { await s2.close(); await fs.rm(rootDir, { recursive: true, force: true }); }
});

test('1.0.3 守卫扩散：`#entries.set(` 只允许经 `#admitEntry`（低层装载/更新除外），保护链路禁直写', async () => {
  const src = await fs.readFile(path.join(process.cwd(), 'src/memory/store.js'), 'utf8');
  const methodStart = /^  (?:async\s+)?(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*\(/;
  let method = null;
  const hits = [];
  src.split(/\r?\n/).forEach((line, index) => {
    const found = methodStart.exec(line);
    if (found !== null) method = found[1];
    if (line.includes('#entries.set(')) hits.push({ method, line: index + 1 });
  });
  assert.ok(hits.length > 0, '应能扫到写入点');
  const allowed = new Set(['#loadAll', '#recoverCorruptTopic', '#admitEntry', 'create', 'update', 'confirm', 'expire', 'supersede']);
  for (const hit of hits) {
    assert.ok(allowed.has(hit.method), `第 ${hit.line} 行在 ${hit.method} 内直写 #entries.set(；保护链路只能经 #admitEntry`);
  }
  assert.ok(hits.some((hit) => hit.method === '#admitEntry'), '`#admitEntry` 必须存在且是写入口');
  assert.ok(!hits.some((hit) => hit.method === 'materializeProtection'), 'materializeProtection 不得直写 #entries.set(');
  assert.ok(!hits.some((hit) => hit.method === '#loadProtectionJournals'), '#loadProtectionJournals 不得直写 #entries.set(');
});

test('1.0.3 准入（5a）：保护条目正文可为空，指针可解析即放行', async () => {
  const rootDir = await tempDir();
  const s1 = await MemoryStore.open({ rootDir, project: 'test-project' });
  s1.protectSync({ cycleKey: 'ptr-only', items: [{ type: 'fact', title: '指针可解析', detail: '正文', source: 'session:s#3' }] });
  await s1.close();
  const dir = path.join(rootDir, 'protection');
  const name = (await fs.readdir(dir)).find((n) => n.endsWith('.json'));
  const file = path.join(dir, name);
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.entries[0].detail = ''; // 已批 5a：protection 允许空正文
  await fs.writeFile(file, JSON.stringify(journal), 'utf8');
  const s2 = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const entries = s2.allEntries();
    assert.equal(entries.length, 1, '空正文但有指针的保护条目应物化');
    assert.equal(entries[0].detail, '');
    assert.ok(!s2.warnings.some((line) => /unreadable protection/.test(line)), `不应误判：${JSON.stringify(s2.warnings)}`);
  } finally { await s2.close(); await fs.rm(rootDir, { recursive: true, force: true }); }
});

test('1.0.3 守卫扩容：`#protectionEntries.set(` 只允许在 intake（protectSync / #loadProtectionJournals）内', async () => {
  const src = await fs.readFile(path.join(process.cwd(), 'src/memory/store.js'), 'utf8');
  const methodStart = /^  (?:async\s+)?(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*\(/;
  let method = null;
  const hits = [];
  src.split(/\r?\n/).forEach((line, index) => {
    const found = methodStart.exec(line);
    if (found !== null) method = found[1];
    if (line.includes('#protectionEntries.set(')) hits.push({ method, line: index + 1 });
  });
  assert.ok(hits.length > 0, '应能扫到保护条目写入点');
  const allowed = new Set(['protectSync', '#loadProtectionJournals']);
  for (const hit of hits) {
    assert.ok(allowed.has(hit.method), `第 ${hit.line} 行在 ${hit.method} 内直写 #protectionEntries.set(；只允许 intake 两处`);
  }
});
