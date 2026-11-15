/**
 * 测试角色独立回归探针（不属于开发自测）：1.0.3 返修提交 7112f5a（返修链 70cf8f0 → 7112f5a；含 5a 空正文+可解析指针放行）。
 *
 * 覆盖这次返修的 4 个行为，全部自建输入、只写系统临时目录：
 *  A. 生成侧标题安全切分（5c）——残句退回指针式标题，不写半句；
 *  B. 前缀近似去重（5b）——同一指针续写视为同一条，且短前缀（<8 字）不误合并；
 *  C. 保护链路准入（唯一写入口 #admitEntry）——坏条目在 protectSync 就跳过；
 *  D. journal 读入准入 + 过期 journal 归档（不物化）。
 *
 * 运行：node tests\probe-1.0.3\probe-regression-final.mjs
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../../packages/dsh-context-governance/src/memory/store.js';
import { buildProtectionItems } from '../../packages/dsh-context-governance/src/compress/protection-memory.js';
import { detectTitleTruncation, titleKeyMatches } from '../../packages/dsh-context-governance/src/memory/contract.js';

const DAY = 24 * 60 * 60 * 1000;
const results = [];

function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}
async function tmpRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `cg-fix-${label}-`));
}
async function cleanup(root, stores = []) {
  for (const store of stores) { try { await store.close(); } catch { /* ignore */ } }
  await fs.rm(root, { recursive: true, force: true });
}
async function journalFiles(root) {
  const dir = path.join(root, 'protection');
  const names = await fs.readdir(dir).catch(() => []);
  return names.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
}

// ── A. 5c：生成侧标题不留残句 ────────────────────────────────
{
  const snapshot = {
    latestUser: null, rules: [], batch: null,
    // 真机残句来源：keyword 里带未闭合反引号 + 半句
    rollback: { paths: [], keyword: 'G:\\DS-HARNESS`（见记忆', seq: 9 },
    unpairedCalls: null,
  };
  const { items } = buildProtectionItems(snapshot, { sessionId: 'sess-fix', cycleKey: 'fix-a' });
  const anchor = items[0];
  check('a-5c-title-no-residual',
    anchor !== undefined && detectTitleTruncation(anchor.title) === null && !/`/.test(anchor.title),
    `title="${anchor?.title}" trunc=${detectTitleTruncation(anchor?.title)}`);
  check('a-5c-fallback-pointer-detail', anchor !== undefined && anchor.detail.trim() !== '',
    `detail="${String(anchor?.detail ?? '').slice(0, 40)}"`);

  // 长标题安全切分：>200 且尾部有分隔符/反引号，切后仍须可读。
  const longPaths = ['analysis/req-20261025-12/' + 'segment-'.repeat(40) + 'REPORT.md'];
  const built2 = buildProtectionItems({
    latestUser: null, rules: [], batch: null,
    rollback: { paths: longPaths, keyword: '回滚', seq: 10 }, unpairedCalls: null,
  }, { sessionId: 'sess-fix', cycleKey: 'fix-a2' });
  const longTitle = built2.items[0]?.title ?? '';
  check('a-5c-long-title-safe', longTitle.length <= 200 && detectTitleTruncation(longTitle) === null,
    `titleLen=${longTitle.length} trunc=${detectTitleTruncation(longTitle)}`);
}

// ── B. 5b：前缀近似去重 + 短前缀不误合并 ─────────────────────
{
  const root = await tmpRoot('5b');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe' });
  try {
    const first = await store.create({ type: 'anchor', title: '回滚点：G:\\DS-HARNESS', detail: '正文', writer: 'rule', confidence: 0.5 });
    const second = await store.create({ type: 'anchor', title: '回滚点：G:\\DS-HARNESS（见记忆', detail: '正文2', writer: 'rule', confidence: 0.5 });
    check('b-5b-prefix-merged', second.id === first.id && store.allEntries().length === 1,
      `id1=${first.id} id2=${second.id} db=${store.allEntries().length}`);

    const k1 = '短标题';
    const k2 = '短标题扩展';
    check('b-key-min-prefix', titleKeyMatches(k1, k2) === false, `key "${k1}" vs "${k2}" 短前缀不合并`);

    const x1 = await store.create({ type: 'fact', title: '批次进度：有批次标记', detail: '正文', writer: 'rule', confidence: 0.5 });
    const x2 = await store.create({ type: 'fact', title: '批次进度：有批次标记（续）', detail: '正文', writer: 'rule', confidence: 0.5 });
    check('b-5b-prefix-cjk-merged', x2.id === x1.id, `id1=${x1.id} id2=${x2.id}`);
  } finally { await cleanup(root, [store]); }
}

// ── C. protectSync 写前准入：坏条目跳过 + warning，不中断 ─────
{
  const root = await tmpRoot('admit');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe' });
  try {
    const good = { type: 'fact', title: '可以落库的条目', detail: '', source: 'session:s#1' };
    const badTitle = { type: 'anchor', title: '回滚点：', detail: '正文', source: 'session:s#2' };
    const badSource = { type: 'fact', title: '来源不可解析', detail: '正文', source: '' };
    const returned = store.protectSync({ cycleKey: 'fix-c', items: [good, badTitle, badSource] });
    check('c-protectsync-skips-bad', returned.length === 1 && returned[0].title === '可以落库的条目',
      `返回 ${returned.length} 条：${returned.map((entry) => entry.title).join(' / ')}`);
    const warns = store.warnings.filter((line) => /skipped unreadable item/.test(line));
    check('c-protectsync-warning', warns.length === 2, `warnings=${JSON.stringify(warns)}`);
    await store.materializeProtection('fix-c');
    check('c-materialize-good-only', store.allEntries().length === 1 && store.allEntries()[0].detail.trim() !== '',
      `db=${store.allEntries().length} detailLen=${store.allEntries()[0]?.detail.length}`);
  } finally { await cleanup(root, [store]); }
}

// ── D1. journal 读入准入：坏指针整册跳过；空正文+可解析指针放行（5a） ──
{
  const root = await tmpRoot('journal-bad');
  const now = new Date('2026-11-14T00:00:00Z');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 7 });
  try {
    store.protectSync({ cycleKey: 'fix-d1', items: [{ type: 'fact', title: 'journal 条目', detail: '正文', source: 'session:s#3' }] });
  } finally { await store.close(); }

  const [file] = await journalFiles(root);
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.entries[0].source = 'not-a-pointer'; // 指针不可解析 → 整册跳过
  await fs.writeFile(file, JSON.stringify(journal, null, 2), 'utf8');

  const reopened = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 7 });
  try {
    const warns = reopened.warnings.filter((line) => /ignored unreadable protection journal/.test(line));
    check('d1-journal-bad-skipped',
      reopened.allEntries().length === 0 && warns.length === 1 && /1\/1/.test(warns[0]) && /source-unparsable/.test(warns[0]),
      `db=${reopened.allEntries().length} warning="${warns[0] ?? '(无)'}"`);
  } finally { await cleanup(root, [reopened]); }
}
{
  // 5a 返修：protection 条目正文可为空，只要 source 可解析就放行（不能误 skip）。
  const root = await tmpRoot('journal-5a');
  const now = new Date('2026-11-14T00:00:00Z');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 7 });
  let id;
  try {
    const [entry] = store.protectSync({ cycleKey: 'fix-d1b', items: [{ type: 'anchor', title: '回滚点：docs/y.md', detail: '正文', source: 'session:s#5' }] });
    id = entry.id;
  } finally { await store.close(); }

  const [file] = await journalFiles(root);
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.entries[0].detail = ''; // 正文清空，指针保留 → 5a 要求放行
  await fs.writeFile(file, JSON.stringify(journal, null, 2), 'utf8');

  const reopened = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 7 });
  try {
    const warns = reopened.warnings.filter((line) => /ignored unreadable protection journal/.test(line));
    check('d1b-5a-empty-detail-admitted',
      reopened.get(id) !== null && reopened.get(id).detail === '' && warns.length === 0,
      `db=${reopened.allEntries().length} detailLen=${reopened.get(id)?.detail.length} warns=${warns.length}`);
  } finally { await cleanup(root, [reopened]); }
}

// ── D2. 过期 journal：不物化，归档到 protection/orphaned/ ────
{
  const root = await tmpRoot('journal-ttl');
  const day1 = new Date('2026-11-01T00:00:00Z');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => day1, proposedTtlDays: 7 });
  let id;
  try {
    const [entry] = store.protectSync({ cycleKey: 'fix-d2', items: [{ type: 'anchor', title: '回滚点：docs/x.md', detail: '正文', source: 'session:s#4' }] });
    id = entry.id;
  } finally { await store.close(); }

  const later = new Date(day1.getTime() + 14 * DAY);
  const reopened = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => later, proposedTtlDays: 7 });
  try {
    const orphaned = await fs.readdir(path.join(root, 'protection', 'orphaned')).catch(() => []);
    check('d2-expired-journal-archived',
      reopened.allEntries().length === 0 && reopened.get(id) === null && orphaned.length === 1,
      `db=${reopened.allEntries().length} get=${reopened.get(id)} orphaned=${orphaned.length}`);
  } finally { await cleanup(root, [reopened]); }
}

const failed = results.filter((item) => !item.ok);
console.log(`\nREGRESSION TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`);
  process.exitCode = 1;
}
