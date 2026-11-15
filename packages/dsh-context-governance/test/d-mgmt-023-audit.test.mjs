/**
 * D-MGMT-023 ②：protection-write 的 ids 与落盘逐条对账；缺失显式审计。
 *
 * 判据（审核 N3）：任一 id 不可解析 → fail；`moved` 与落盘差 ≥1 且无审计 → fail。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { sanitizeAuditDetails } from '../src/audit.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages, skillCatalog } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

function makeCtx(warnings = []) {
  const handlers = [];
  return {
    handlers,
    get() { return undefined; },
    logger: { info() {}, warn(message) { warnings.push(String(message)); }, error() {} },
    on(name, handler) { handlers.push({ event: name, handler }); return () => {}; },
  };
}

test('D-MGMT-023 ②：IDS 与落盘逐条对账——每个 id 可解析，moved=requested，无缺条审计', async () => {
  const base = await tempDir('dmgmt023-audit-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const warnings = [];
  const ctx = makeCtx(warnings);
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/work/d023', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(event, details) { audits.push({ event, details }); return true; } },
    rootId: 'root-d023',
    projectRoot: 'D:/work/d023',
    logger: ctx.logger,
  });
  guard.start();
  try {
    const messages = healthyMessages();
    const built = buildCompaction({
      before: [messages[0], messages[1], skillCatalog(2, 'skill catalog'), ...messages.slice(3)],
      summary: FIVE_SECTION_SUMMARY, start: 0, end: 13, manual: true,
    });
    const handler = ctx.handlers[0].handler;
    handler(built.session, built.events.find((item) => item.type === 'compaction/start'));
    handler(built.session, built.events.find((item) => item.type === 'compaction/summary'));
    handler(built.session, built.events.find(
      (item) => item.type === 'user/message' && item.data?.source?.kind === 'compact-checkpoint',
    ));
    built.session.surface.nodes = [...built.postSurface];
    handler(built.session, built.events.find((item) => item.type === 'compaction/end'));
    // 等 materialize 的 microtask/队列落完。
    await new Promise((resolve) => setTimeout(resolve, 50));
    await guard.flush().catch(() => {});

    const write = audits.find((item) => item.event === 'protection-write');
    assert.ok(write, '必须有 protection-write');
    const ids = write.details.ids ?? [];
    assert.ok(ids.length > 0, 'ids 不得为空');
    for (const id of ids) {
      const entry = store.get(id);
      assert.ok(entry !== null && entry !== undefined, `id 不可解析：${id}`);
    }
    assert.ok(Array.isArray(write.details.dedupedIds), 'dedupedIds 必须存在（可为空数组）');
    assert.equal(write.details.dedupedIds.length, 0, '本用例无同标题重复');

    const materialized = audits.find((item) => item.event === 'protection-materialized');
    assert.ok(materialized, '必须有 protection-materialized');
    assert.equal(materialized.details.moved, ids.length, 'moved 必须等于落盘条数');
    assert.equal(materialized.details.requested, ids.length);
    assert.equal(audits.filter((item) => item.event === 'protection-entry-missing').length, 0);
    assert.equal(warnings.some((message) => message.includes('not materialized')), false);
  } finally {
    guard.stop();
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('D-MGMT-023 ②：白名单保留对账字段（反向验证）', () => {
  const kept = sanitizeAuditDetails({
    dedupedIds: ['MEM-20261115-1006'],
    missingIds: ['MEM-20261115-1007'],
    requested: 3,
    missing: 1,
    moved: 2,
  });
  assert.deepEqual(kept.dedupedIds, ['MEM-20261115-1006']);
  assert.deepEqual(kept.missingIds, ['MEM-20261115-1007']);
  assert.equal(kept.requested, 3);
  assert.equal(kept.missing, 1);
  assert.equal(kept.moved, 2);
});

test('D-MGMT-023 ②：旧 journal（无 deduped 标记）物化时按同标题兜底去重，只落 1 条', async () => {
  const rootDir = await tempDir('dmgmt023-legacy-');
  try {
    const store = await MemoryStore.open({ rootDir, project: 'test-project' });
    const entries = store.protectSync({
      cycleKey: 'legacy-cycle',
      items: [
        { type: 'fact', title: '旧格式同标题', detail: '正文 A', source: 'session:legacy#1' },
        { type: 'fact', title: '旧格式同标题', detail: '正文 B', source: 'session:legacy#2' },
      ],
    });
    // 模拟 1.0.3 之前写下的 journal：没有 deduped 标记。
    for (const entry of entries) delete entry.deduped;
    const journalDirs = path.join(rootDir, 'protection');
    const files = (await fs.readdir(journalDirs)).filter((name) => name.endsWith('.json'));
    const journalFile = path.join(journalDirs, files[0]);
    const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
    for (const entry of journal.entries) delete entry.deduped;
    await fs.writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
    await store.close();

    // 打开时会自动物化残留 journal（含旧格式兜底去重）。
    const reopened = await MemoryStore.open({ rootDir, project: 'test-project' });
    try {
      assert.equal(reopened.protectionPending, 0, 'journal 应已物化');
      const committed = reopened.allEntries().filter((entry) => entry.title === '旧格式同标题');
      assert.equal(committed.length, 1, '旧 journal 同标题兜底只落 1 条');
      const remaining = await reopened.materializeProtection('legacy-cycle');
      assert.equal(remaining.moved, 0, '已物化的周期再物化是无操作');
    } finally {
      await reopened.close();
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});


