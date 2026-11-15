/**
 * 测试角色独立探针（不属于开发自测）：REQ-20261114-01 / dsh-context-governance 1.0.3。
 *
 * 目的：不复用开发用例，自己构造输入，逐条款取"命令+输出行"证据。
 * 约束：只写系统临时目录；不装插件、不重启 DSH、不碰本机真实记忆库。
 *
 * 运行：node tests\probe-1.0.3\probe.mjs
 * 退出码：0 = 全部 A 档检查通过；1 = 有 FAIL。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../../packages/dsh-context-governance/src/memory/store.js';
import { MEM_WRITE_NAME, createMemoryTools } from '../../packages/dsh-context-governance/src/tools/mem-tools.js';
import { resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { buildProtectionItems } from '../../packages/dsh-context-governance/src/compress/protection-memory.js';
import { detectTitleTruncation } from '../../packages/dsh-context-governance/src/memory/contract.js';
import { createStatusCommand } from '../../packages/dsh-context-governance/src/commands/cg-status.js';

const DAY = 24 * 60 * 60 * 1000;
const exec = { agent: { session: { id: 'session-probe-1f3' } } };
const results = [];
const observations = [];

function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}
function obs(id, detail) {
  observations.push({ id, detail });
  console.log(`OBS  ${id} :: ${detail}`);
}
async function tmpRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `cg-103-${label}-`));
}
function makeAudit() {
  const entries = [];
  return { entries, append(event, details = {}) { entries.push({ event, ...details }); } };
}
async function cleanup(root, stores = []) {
  for (const store of stores) { try { await store.close(); } catch { /* ignore */ } }
  await fs.rm(root, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────
// 条款 1（A）：写入即校验——空正文/截断标题不入库，且留 1 行审计
// ─────────────────────────────────────────────────────────────
{
  const root = await tmpRoot('c1');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe' });
  try {
    const audit = makeAudit();
    const tools = createMemoryTools(store, { audit });
    const write = tools[MEM_WRITE_NAME].definition;
    const before = store.allEntries().length;

    const cases = [
      ['empty-detail', { op: 'create', type: 'criterion', title: '规则在场：不会落库', writer: 'model', confidence: 0.8 }, 'empty-detail'],
      ['title-cut-separator', { op: 'create', type: 'anchor', title: '回滚点：', detail: '正文在场', writer: 'model', confidence: 0.5 }, 'title-cut-separator'],
      ['title-unclosed-backtick', { op: 'create', type: 'criterion', title: '规则在场（未闭合 `', detail: '正文在场', writer: 'model', confidence: 0.5 }, 'title-unclosed-backtick'],
      ['title-multiline', { op: 'create', type: 'fact', title: '第一行\n第二行', detail: '正文在场', writer: 'model', confidence: 0.5 }, 'title-multiline'],
    ];
    let rejected = 0;
    for (const [label, args, wantReason] of cases) {
      let code = null;
      try { await write.execute(args, exec); } catch (error) {
        // reject() 只抛 message（无 code 属性）：错误面契约 = 消息带 [CODE] 前缀（mem-tools.js:159）。
        const message = String(error?.message ?? '');
        const match = /^\[([A-Z_]+)\]/.exec(message);
        code = match?.[1] ?? null;
      }
      rejected += 1;
      const lines = audit.entries.filter((entry) => entry.event === 'memory-tool-rejected');
      const last = audit.entries.at(-1);
      check(
        `c1-${label}`,
        code === 'ENTRY_UNREADABLE' && lines.length === rejected && last?.code === 'ENTRY_UNREADABLE' && last?.reason === wantReason,
        `code=${code} auditLines=${lines.length} last=${last?.event}/${last?.code}/${last?.reason} db=${store.allEntries().length}`,
      );
    }
    check('c1-db-unchanged', store.allEntries().length === before, `before=${before} after=${store.allEntries().length}`);

    const ok = await write.execute({ op: 'create', type: 'fact', title: '构建号 1.0.3 探针', detail: '正文在场', writer: 'model', confidence: 0.5 }, exec);
    check('c1-valid-accepted', ok.status === 'proposed' && store.allEntries().length === before + 1, `status=${ok.status} db=${store.allEntries().length}`);

    // 8cc3c0b 口径：writer=user 同样受准入（"读得出"不按写入者豁免）。
    let userCode = null;
    try {
      await write.execute({ op: 'create', type: 'fact', title: '用户只存标题', writer: 'user' }, exec);
    } catch (error) {
      userCode = /^\[([A-Z_]+)\]/.exec(String(error?.message ?? ''))?.[1] ?? null;
    }
    check('c1-user-writer-rejected', userCode === 'ENTRY_UNREADABLE', `writer=user 空正文 → message code=${userCode}`);

    // 8cc3c0b：先解析根，再准入——无根错误优先于 ENTRY_UNREADABLE。
    const rootAudit = makeAudit();
    const noRoot = createMemoryTools(null, {
      resolveStore: () => ({ ok: false, code: 'NO_ROOT', message: 'no project root for this session', reason: 'no-git-ancestor' }),
      audit: rootAudit,
    });
    let rootCode = null;
    try {
      await noRoot[MEM_WRITE_NAME].definition.execute({ op: 'create', type: 'fact', title: 'x', writer: 'rule' }, exec);
    } catch (error) {
      rootCode = /^\[([A-Z_]+)\]/.exec(String(error?.message ?? ''))?.[1] ?? null;
    }
    check('c1-root-error-priority', rootCode === 'NO_ROOT' && rootAudit.entries.at(-1)?.code === 'NO_ROOT',
      `空正文+无根 → code=${rootCode} audit=${rootAudit.entries.at(-1)?.event}/${rootAudit.entries.at(-1)?.code}`);
  } finally {
    await cleanup(root, [store]);
  }
}

// 只读优先级的实际顺序（8cc3c0b 声称"只读错误优先"——本探针据实记录）
{
  const root = await tmpRoot('c1ro');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', readOnly: true });
  try {
    const tools = createMemoryTools(store);
    const write = tools[MEM_WRITE_NAME].definition;
    let emptyCode = null;
    let normalCode = null;
    try { await write.execute({ op: 'create', type: 'fact', title: '只读空正文', writer: 'model', confidence: 0.5 }, exec); } catch (error) {
      emptyCode = /^\[([A-Z_]+)\]/.exec(String(error?.message ?? ''))?.[1] ?? null;
    }
    try { await write.execute({ op: 'create', type: 'fact', title: '只读有正文', detail: '正文', writer: 'model', confidence: 0.5 }, exec); } catch (error) {
      normalCode = /^\[([A-Z_]+)\]/.exec(String(error?.message ?? ''))?.[1] ?? null;
    }
    check('c1-readonly-priority-actual', emptyCode === 'ENTRY_UNREADABLE' && normalCode === 'READ_ONLY',
      `只读+空正文 → ${emptyCode}；只读+有正文 → ${normalCode}（即只读仍排在准入之后）`);
  } finally { await cleanup(root, [store]); }
}

// ─────────────────────────────────────────────────────────────
// 条款 1（A·生成侧）：压缩保护项标题/正文在生成时即可读（长标题安全切分）
// ─────────────────────────────────────────────────────────────
{
  const rolloutPath = `analysis/req-20261025-12/${'segment-'.repeat(40)}REPORT.md`;
  const longKeyword = `回滚点：${'很长的回滚说明'.repeat(40)}`;
  const snapshot = {
    latestUser: { title: '继续修复记忆', seq: 21 },
    rules: [{ kind: 'agents', seq: 22, paths: ['AGENTS.md', '~/.dsh/AGENTS.md'] }],
    batch: { ratios: ['511/958'], statePath: null, seq: 23 },
    rollback: { paths: [rolloutPath], keyword: longKeyword, seq: 24 },
    unpairedCalls: [{ callId: 'call-abc', seq: 25 }],
  };
  const built = buildProtectionItems(snapshot, { sessionId: 'sess-probe', cycleKey: 'probe-gen' });
  for (const item of built.items) {
    const cut = detectTitleTruncation(item.title);
    check(
      `c1-generate-${item.type}`,
      cut === null && String(item.detail ?? '').trim() !== '' && item.title.length <= 200,
      `titleLen=${item.title.length} trunc=${cut} detailLen=${item.detail.length}`,
    );
  }
  // 复现实测噪声形态：无路径 + 泛词 keyword='回滚'（旧条目名为「回滚点：回滚」）。
  const noise = buildProtectionItems({
    latestUser: null, rules: [], batch: null,
    rollback: { paths: [], keyword: '回滚', seq: 9 },
    unpairedCalls: null,
  }, { sessionId: 'sess-probe', cycleKey: 'probe-noise' });
  const anchor = noise.items[0];
  check(
    'c1-generate-noise-rollback',
    anchor !== undefined && detectTitleTruncation(anchor.title) === null && anchor.title !== '回滚点：回滚' && anchor.detail.trim() !== '',
    `title="${anchor?.title}" trunc=${detectTitleTruncation(anchor?.title)} detailLen=${anchor?.detail.length}`,
  );
}

// ─────────────────────────────────────────────────────────────
// 条款 2（A）：proposed 超 TTL 自动 expired（打开时扫 + 写前扫 + 索引同步 + 0=关闭）
// ─────────────────────────────────────────────────────────────
{
  const root = await tmpRoot('c2');
  let now = new Date('2026-11-01T00:00:00Z');
  const first = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 1 });
  let entry;
  try {
    entry = await first.create({ type: 'fact', title: '待确认的一条', detail: '正文', writer: 'model', confidence: 0.5 });
    check('c2-create-proposed', entry.status === 'proposed', `status=${entry.status} ttl=1d`);
  } finally { await first.close(); }

  now = new Date(now.getTime() + 2 * DAY);
  const reopened = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 1 });
  try {
    const got = reopened.get(entry.id);
    check('c2-expire-on-open', got.status === 'expired', `status=${got.status} created=${entry.createdAt}`);
    check('c2-counts-synced', JSON.stringify(reopened.status.counts) === '{"proposed":0,"active":0,"superseded":0,"expired":1}', `counts=${JSON.stringify(reopened.status.counts)}`);
    const index = await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8');
    check('c2-index-synced', /expired[^\n]*1/.test(index), `MEMORY.md 计数行: ${index.split('\n').find((line) => line.startsWith('> Updated')) ?? '(未找到 Updated 行)'}`);
  } finally { await cleanup(root, [reopened]); }
}
{
  const root = await tmpRoot('c2b');
  let now = new Date('2026-11-01T00:00:00Z');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 1 });
  try {
    const a = await store.create({ type: 'fact', title: '写前扫 A', detail: '正文', writer: 'model', confidence: 0.5 });
    now = new Date(now.getTime() + 2 * DAY);
    const b = await store.create({ type: 'fact', title: '写前扫 B', detail: '正文', writer: 'model', confidence: 0.5 });
    check('c2-expire-before-write', store.get(a.id).status === 'expired' && store.get(b.id).status === 'proposed',
      `A=${store.get(a.id).status} B=${store.get(b.id).status}`);
  } finally { await cleanup(root, [store]); }
}
{
  const root = await tmpRoot('c2c');
  let now = new Date('2026-11-01T00:00:00Z');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 0 });
  try {
    const a = await store.create({ type: 'fact', title: 'TTL 关闭 A', detail: '正文', writer: 'model', confidence: 0.5 });
    now = new Date(now.getTime() + 30 * DAY);
    const b = await store.create({ type: 'fact', title: 'TTL 关闭 B', detail: '正文', writer: 'model', confidence: 0.5 });
    check('c2-ttl0-disabled', store.get(a.id).status === 'proposed', `ttl=0, 30 天后 A=${store.get(a.id).status}`);
    void b;
  } finally { await cleanup(root, [store]); }
}

// ─────────────────────────────────────────────────────────────
// 条款 3（A）：同标题（归一化）7 天内只留 1 条（工具 + 保护物化 + 窗口到期 + 0=关闭）
// ─────────────────────────────────────────────────────────────
{
  const root = await tmpRoot('c3');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe' });
  try {
    const tools = createMemoryTools(store);
    const write = tools[MEM_WRITE_NAME].definition;
    const a = await write.execute({ op: 'create', type: 'fact', title: '同一条标题', detail: '第一次', writer: 'model', confidence: 0.5 }, exec);
    const b = await write.execute({ op: 'create', type: 'fact', title: '同一条标题。', detail: '第二次', writer: 'model', confidence: 0.5 }, exec);
    check('c3-tool-dedup', a.id === b.id && store.allEntries().length === 1, `id1=${a.id} id2=${b.id} db=${store.allEntries().length}`);

    const item = { type: 'criterion', title: '规则在场：system-prompt、AGENTS.md', detail: '', source: 'session:s#1' };
    store.protectSync({ cycleKey: 'probe-p1', items: [item] });
    store.protectSync({ cycleKey: 'probe-p2', items: [item] });
    await store.materializeProtection('probe-p1');
    await store.materializeProtection('probe-p2');
    const rules = store.allEntries().filter((entry) => entry.title.startsWith('规则在场'));
    check('c3-protection-dedup', rules.length === 1 && rules[0].detail.length > 0, `rules=${rules.length} detailLen=${rules[0]?.detail.length}`);
  } finally { await cleanup(root, [store]); }
}
{
  const root = await tmpRoot('c3b');
  let now = new Date('2026-11-01T00:00:00Z');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', now: () => now, proposedTtlDays: 0, dedupWindowDays: 7 });
  try {
    const a = await store.create({ type: 'fact', title: '窗口外重复标题', detail: '第一次', writer: 'model', confidence: 0.5 });
    now = new Date(now.getTime() + 8 * DAY);
    const b = await store.create({ type: 'fact', title: '窗口外重复标题', detail: '第二次', writer: 'model', confidence: 0.5 });
    check('c3-window-expires', a.id !== b.id && store.allEntries().length === 2, `id1=${a.id} id2=${b.id} db=${store.allEntries().length}（8 天 > 7 天窗口）`);
  } finally { await cleanup(root, [store]); }
}
{
  const root = await tmpRoot('c3c');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', proposedTtlDays: 0, dedupWindowDays: 0 });
  try {
    const a = await store.create({ type: 'fact', title: '去重关闭标题', detail: '第一次', writer: 'model', confidence: 0.5 });
    const b = await store.create({ type: 'fact', title: '去重关闭标题', detail: '第二次', writer: 'model', confidence: 0.5 });
    check('c3-dedup0-disabled', a.id !== b.id && store.allEntries().length === 2, `db=${store.allEntries().length}`);
  } finally { await cleanup(root, [store]); }
}
{
  // 8cc3c0b：1.0.2 遗留的"空正文同标题条目"不得吃掉新写入（低层 create 直调造旧条目）。
  const root = await tmpRoot('c3d');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe' });
  try {
    const legacy = await store.create({ type: 'preference', title: '用中文', detail: '', writer: 'user' });
    const tools = createMemoryTools(store);
    const write = tools[MEM_WRITE_NAME].definition;
    const fresh = await write.execute({ op: 'create', type: 'preference', title: '用中文', detail: '偏好：中文', writer: 'user' }, exec);
    check('c3-legacy-empty-detail-skipped', fresh.id !== legacy.id && store.allEntries().length === 2 && store.get(fresh.id).detail === '偏好：中文',
      `legacy=${legacy.id}(detailLen=0) fresh=${fresh.id} db=${store.allEntries().length}`);
  } finally { await cleanup(root, [store]); }
}

// ─────────────────────────────────────────────────────────────
// 条款 4（B，只观察不判过）：机器产物必须 proposed 且 confidence ≤0.5
// ─────────────────────────────────────────────────────────────
{
  const root = await tmpRoot('c4');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe' });
  try {
    const snapshot = {
      latestUser: { title: '继续', seq: 10 },
      rules: [{ kind: 'agents', seq: 11, paths: ['AGENTS.md'] }],
      batch: { ratios: ['511/958'], statePath: null, seq: 12 },
      rollback: { paths: [], keyword: '回滚', seq: 13 },
      unpairedCalls: null,
    };
    const { items } = buildProtectionItems(snapshot, { sessionId: 'sess-probe', cycleKey: 'probe-b' });
    store.protectSync({ cycleKey: 'probe-b', items });
    await store.materializeProtection('probe-b');
    for (const entry of store.allEntries()) {
      obs('c4-fields', `id=${entry.id} type=${entry.type} status=${entry.status} confidence=${entry.confidence} title="${entry.title}" detailLen=${entry.detail.length}`);
    }
  } finally { await cleanup(root, [store]); }
}

// ─────────────────────────────────────────────────────────────
// 条款 5（A·代码路径）：连续两次压缩新增 ≤1 且正文非空（同代码路径模拟；真机链路见报告 C）
// ─────────────────────────────────────────────────────────────
{
  const root = await tmpRoot('c5');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe' });
  try {
    const snapshot = {
      latestUser: { title: '继续', seq: 30 },
      rules: [{ kind: 'agents', seq: 31, paths: ['AGENTS.md', '~/.dsh/AGENTS.md'] }],
      batch: { ratios: ['511/958'], statePath: null, seq: 32 },
      rollback: { paths: ['docs/记忆契约-v1.md'], keyword: '回滚', seq: 33 },
      unpairedCalls: null,
    };
    const { items } = buildProtectionItems(snapshot, { sessionId: 'sess-probe', cycleKey: 'probe-cmp-a' });
    const before = store.allEntries().length;
    store.protectSync({ cycleKey: 'probe-cmp-a', items });
    await store.materializeProtection('probe-cmp-a');
    const first = store.allEntries().length;
    store.protectSync({ cycleKey: 'probe-cmp-b', items });
    await store.materializeProtection('probe-cmp-b');
    const second = store.allEntries().length;
    const emptyDetails = store.allEntries().filter((entry) => entry.detail.trim() === '').length;
    check('c5-offline-sim-two-compactions', second - first <= 1 && emptyDetails === 0,
      `新增(第2次)=${second - first} 总条数=${before}→${first}→${second} 空正文=${emptyDetails}`);
    const index = await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8');
    const idxLine = index.split('\n').find((line) => /proposed|active|expired/.test(line)) ?? '(未找到计数行)';
    check('c5-offline-sim-index-nonempty', /proposed[^\n]*[1-9]/.test(index), `索引计数行: ${idxLine.trim()}`);
  } finally { await cleanup(root, [store]); }
}

// ─────────────────────────────────────────────────────────────
// 配置键组 + /cg status memory-policy 行（mock ctx；真机 apply 见报告 C）
// ─────────────────────────────────────────────────────────────
{
  const root = await tmpRoot('cfg');
  const store = await MemoryStore.open({ rootDir: root, project: 'probe', proposedTtlDays: 3, dedupWindowDays: 2 });
  try {
    const command = createStatusCommand({ store });
    const out = await command.handler({ rawInput: 'status', agent: { session: { id: 'session-probe-1f3' } } });
    const text = String(out?.text ?? '');
    const line = text.split('\n').find((item) => item.startsWith('memory-policy:')) ?? '(缺 memory-policy 行)';
    check('cfg-status-memory-policy', text.includes('memory-policy: proposedTtl=3d dedupWindow=2d'), line);
  } finally { await cleanup(root, [store]); }
}
{
  const cfg = resolveConfig({ projectRoot: 'D:/tmp/p' });
  check('cfg-defaults', cfg.memory.proposedTtlDays === 7 && cfg.memory.dedupWindowDays === 7,
    `proposedTtlDays=${cfg.memory.proposedTtlDays} dedupWindowDays=${cfg.memory.dedupWindowDays}`);
  const edge = resolveConfig({ projectRoot: 'D:/tmp/p', memory: { proposedTtlDays: 365, dedupWindowDays: 0 } });
  check('cfg-bounds-ok', edge.memory.proposedTtlDays === 365 && edge.memory.dedupWindowDays === 0,
    `365/0 accepted: ${edge.memory.proposedTtlDays}/${edge.memory.dedupWindowDays}`);
  let bad1 = false; let bad2 = false; let bad3 = false;
  try { resolveConfig({ projectRoot: 'D:/tmp/p', memory: { proposedTtlDays: 366 } }); } catch { bad1 = true; }
  try { resolveConfig({ projectRoot: 'D:/tmp/p', memory: { proposedTtlDays: -1 } }); } catch { bad2 = true; }
  try { resolveConfig({ projectRoot: 'D:/tmp/p', memory: { dedupWindowDays: 1.5 } }); } catch { bad3 = true; }
  check('cfg-invalid-rejected', bad1 && bad2 && bad3, `366→throw=${bad1} -1→throw=${bad2} 1.5→throw=${bad3}`);
}

// ─────────────────────────────────────────────────────────────
const failed = results.filter((item) => !item.ok);
console.log(`\nTOTAL ${results.length - failed.length}/${results.length} PASS · 观察项 ${observations.length}`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`);
  process.exitCode = 1;
}
