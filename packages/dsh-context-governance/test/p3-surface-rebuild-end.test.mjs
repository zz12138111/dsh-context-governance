/**
 * P3 修复回归（end-order）：compaction/end 在 verifyProtection 前重建
 * latest-user-message / rule-injection 的内容副本，报告不得再写这两项 loss。
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
    on(event, handler) { handlers.push({ event, handler }); return () => {}; },
  };
}

function liveSession(built, id = 'session-p3-rebuild-end') {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  const appended = [];
  let nextSeq = 9000;
  return {
    id,
    appended,
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt(seq) { return bySeq.get(seq); },
    append(type, data, opts) {
      const event = { seq: nextSeq, type, data, time: Date.now(), ...opts };
      nextSeq += 1;
      bySeq.set(event.seq, event);
      if (opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      appended.push(event);
      return event;
    },
  };
}

const eventOf = (built, type) => built.events.find((item) => item.type === type);
const checkpointOf = (built) => built.events.find(
  (item) => item.type === 'user/message' && item.data.source?.kind === 'compact-checkpoint',
);

test('P3 end-order：end 内先 append latest/rule 内容副本，再校验通过', async () => {
  const base = await tempDir('cg-p3-rebuild-end-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  try {
    const ctx = makeCtx();
    const guard = new CompressionGuard({
      resolveScope: () => ({
        mode: 'single-root', root: 'D:/work/p3-rebuild', cwd: '', governed: true,
        skipReason: null, unattributed: false,
      }),
      ctx,
      hostVersion: '0.2.1-rc.3',
      store,
      rootAudit: { append() {} },
      rootId: 'root-p3-rebuild',
      projectRoot: 'D:/work/p3-rebuild',
      logger: ctx.logger,
    });
    guard.start();
    const built = buildCompaction({
      before: healthyMessages(),
      summary: FIVE_SECTION_SUMMARY,
      start: 0,
      end: 13,
      manual: true,
    });
    const session = liveSession(built);
    const handler = ctx.handlers[0].handler;
    handler(session, eventOf(built, 'compaction/start'));
    handler(session, eventOf(built, 'compaction/summary'));
    handler(session, checkpointOf(built));
    session.surface.nodes = [...built.postSurface];
    handler(session, eventOf(built, 'compaction/end'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const report = guard.status.lastReport;
    assert.ok(report);
    for (const name of ['latest-user-message', 'rule-injection']) {
      const check = report.checks.find((item) => item.name === name);
      assert.equal(check?.status, 'pass', `${name}: ${JSON.stringify(check)}`);
    }
    assert.deepEqual(
      report.failures.filter((failure) => ['latest-user-message', 'rule-injection'].includes(failure.name)),
      [],
    );

    const latestCopy = session.appended.find((item) => item.type === 'user/message'
      && item.data?.content?.[0]?.text === '最新一条用户消息：继续。');
    const ruleCopy = session.appended.find((item) => item.type === 'system/message'
      && item.data?.message?.content?.[0]?.text === 'SYSTEM PROMPT');
    assert.ok(latestCopy, '必须 append latest-user 内容副本');
    assert.ok(ruleCopy, '必须 append rule-injection 内容副本');
    assert.ok(session.surface.nodes.includes(latestCopy.seq));
    assert.ok(session.surface.nodes.includes(ruleCopy.seq));

    await guard.flush();
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
