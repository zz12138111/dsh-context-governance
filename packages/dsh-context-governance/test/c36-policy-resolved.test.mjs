/**
 * C36 裁定 3：policy-resolved 每压缩 cycle 1 条（compactionId 去重）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

function makeCtx() {
  const handlers = [];
  return {
    handlers,
    get() { return undefined; },
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) { handlers.push({ event: name, handler }); return () => {}; },
  };
}

test('C36 裁定 3：policy-resolved 每压缩 cycle 一条（同 compactionId 去重，带 source/at）', async () => {
  const base = await tempDir('cg-policy-resolved-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/work/pr', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(event, details) { audits.push({ event, details }); return true; } },
    rootId: 'root-pr',
    projectRoot: 'D:/work/pr',
    logger: ctx.logger,
    resolvePolicy: () => ({ values: { 'compact.at': 0.55 }, sources: { 'compact.at': 'session:A2' } }),
  });
  guard.start();
  try {
    const handcraft = (seq) => buildCompaction({
      compactionId: 'cmp-pr',
      startSeq: seq, summarySeq: seq + 1, checkpointSeq: seq + 2, endSeq: seq + 3,
      before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 0, end: 13,
    });
    const built = handcraft(100);
    const handler = ctx.handlers[0].handler;
    const startEvent = built.events.find((item) => item.type === 'compaction/start');
    handler(built.session, startEvent);
    handler(built.session, { ...startEvent, seq: 90, data: { ...startEvent.data, compactionId: 'cmp-pr' } });
    const rows = audits.filter((item) => item.event === 'policy-resolved');
    assert.equal(rows.length, 1, '同 compactionId 只写一条');
    assert.equal(rows[0].details.compactionId, 'cmp-pr');
    assert.equal(rows[0].details.source, 'session:A2');
    assert.equal(rows[0].details.at, 0.55);
    // 新 cycle 再写一条。
    const built2 = handcraft(200);
    handler(built2.session, { ...built2.events.find((item) => item.type === 'compaction/start'), data: { compactionId: 'cmp-pr2', sourceCommandId: 'x' } });
    const rows2 = audits.filter((item) => item.event === 'policy-resolved');
    assert.equal(rows2.length, 2);
  } finally {
    guard.stop();
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5 });
  }
});
