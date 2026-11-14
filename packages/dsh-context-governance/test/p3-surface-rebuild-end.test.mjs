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

test('D-MGMT-021 end-order：latest/user 副本重建，system 形态 skip 并留痕', async () => {
  const base = await tempDir('cg-p3-rebuild-end-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  try {
    const ctx = makeCtx();
    const audits = [];
    const guard = new CompressionGuard({
      resolveScope: () => ({
        mode: 'single-root', root: 'D:/work/p3-rebuild', cwd: '', governed: true,
        skipReason: null, unattributed: false,
      }),
      ctx,
      hostVersion: '0.2.1-rc.3',
      store,
      rootAudit: { append() {} },
      audit: { append(event, details) { audits.push({ event, details }); return true; } },
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
    assert.equal(report.checks.find((item) => item.name === 'latest-user-message').status, 'pass');
    const ruleCheck = report.checks.find((item) => item.name === 'rule-injection');
    assert.equal(ruleCheck?.status, 'fail', '被 skip 的 system 规则不得计为 pass');
    assert.deepEqual(ruleCheck.seqs, [0]);

    // 零 system/message append + 两条 user 副本（latest + agent-instructions）。
    assert.equal(session.appended.filter((item) => item.type === 'system/message').length, 0);
    const latestCopy = session.appended.find((item) => item.type === 'user/message'
      && item.data?.content?.[0]?.text === '最新一条用户消息：继续。');
    const ruleCopy = session.appended.find((item) => item.type === 'user/message'
      && item.data?.content?.[0]?.text === 'AGENTS.md rules');
    assert.ok(latestCopy, '必须 append latest-user 内容副本');
    assert.ok(ruleCopy, 'user 形态规则副本必须保留');
    assert.ok(session.surface.nodes.includes(latestCopy.seq));
    assert.ok(session.surface.nodes.includes(ruleCopy.seq));

    // 审计闭环（v3b pending）：skip 进 pending 第三态，window 内无重发 → stop 时结算 unacceptable。
    const skipped = audits.filter((item) => item.event === 'surface-rebuild-skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].details.ruleSeq, 0);
    assert.equal(skipped[0].details.kind, 'system-prompt');
    assert.equal(skipped[0].details.reason, 'no-open-step');
    assert.equal(skipped[0].details.disposition, 'pending', 'pending 期间不得判死');
    assert.equal(skipped[0].details.lossClass, 'pending');
    assert.equal(skipped[0].details.compactionId, built.compactionId);
    // pending 期间不得写 loss / accepted。
    assert.equal(audits.filter((item) => item.event === 'compaction-loss').length, 0);
    assert.equal(audits.filter((item) => item.event === 'compaction-loss-accepted').length, 0);

    await guard.flush();
    guard.stop();
    // stop = session-ended 兜底结算：一条终态 resolved(unacceptable) + 一条 loss。
    const resolved = audits.filter((item) => item.event === 'surface-rebuild-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].details.disposition, 'unacceptable');
    assert.equal(resolved[0].details.reason, 'session-ended');
    const loss = audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(loss.length, 1);
    assert.equal(loss[0].details.disposition, 'unacceptable');
    assert.deepEqual(loss[0].details.failures, ['rule-injection']);
  } finally {
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
