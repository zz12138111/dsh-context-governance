/**
 * rc.2：宿主自己中止压缩（`compaction/end` 带 `error`，如 compaction-basic 的 shrink 检查拒绝）
 * 时，治理按 host-aborted 处理：report skipped(reason=host-compaction-error)，不写 failed warn、
 * 不写诊断行、不记 compaction-loss。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

test('rc.2 宿主中止（end 带 error）：report skipped，无 failed warn / 无诊断行 / 无 loss', async () => {
  const base = await tempDir('rc2-abort-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const warns = [];
  const infos = [];
  const handlers = [];
  const diagnosticsFile = path.join(base, 'diagnostics.log');
  const ctx = {
    get() { return undefined; },
    logger: {
      info(message) { infos.push(String(message)); },
      warn(message) { warns.push(String(message)); },
      error() {},
    },
    on(name, handler) { handlers.push({ event: name, handler }); return () => {}; },
  };
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/work/rc2', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(event, details) { audits.push({ event, details }); return true; } },
    rootId: 'root-rc2',
    projectRoot: 'D:/work/rc2',
    diagnosticsLogFile: diagnosticsFile,
    logger: ctx.logger,
  });
  guard.start();
  try {
    const built = buildCompaction({
      before: [healthyMessages()[0], healthyMessages()[1], ...healthyMessages().slice(3)],
      summary: FIVE_SECTION_SUMMARY, start: 0, end: 13, manual: true,
    });
    const handler = handlers[0].handler;
    handler(built.session, built.events.find((item) => item.type === 'compaction/start'));
    const endEvent = built.events.find((item) => item.type === 'compaction/end');
    handler(built.session, {
      ...endEvent,
      data: {
        ...endEvent.data,
        error: 'summary is not smaller than the shadowed content (996 estimated framed tokens >= 988)',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const report = guard.status.lastReport;
    assert.equal(report.skipped, true, '报告必须是 skipped');
    assert.equal(report.reason, 'host-compaction-error');
    assert.equal(report.compaction, 'skipped');
    assert.equal(report.checks.length, 0, '不做保护核对');
    assert.equal(report.failures.length, 0);

    assert.equal(audits.filter((item) => item.event === 'compaction-loss').length, 0, '不得记 loss');
    assert.equal(audits.filter((item) => item.event === 'self-heal-pending').length, 0, '不登记 C35 pending');
    assert.equal(warns.filter((message) => message.includes('compaction protection failed')).length, 0,
      '不得写 failed warn');
    assert.equal(guard.status.stats.aborted, 1);
    // 诊断文件里不允许出现 protection failed 行。
    let diagnostics = '';
    try {
      diagnostics = await fs.readFile(diagnosticsFile, 'utf8');
    } catch {
      diagnostics = '';
    }
    assert.equal(diagnostics.includes('protection failed'), false, '不得写诊断行');
    // 但要有低噪音 info，便于排查（不是 warn）。
    assert.equal(infos.some((message) => message.includes('compaction aborted by host')), true);
  } finally {
    await guard.flush().catch(() => {});
    guard.stop();
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
