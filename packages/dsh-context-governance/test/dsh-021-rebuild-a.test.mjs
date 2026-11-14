/**
 * D-MGMT-021（A 形态 / v3b）回归：
 *  - accepted 分型：跳过 system 规则但宿主在压缩后重发同 kind 副本 → 只汇总不报警；
 *  - 回滚开关：protection.rebuild.enabled=false → 整段跳过 + surface-rebuild-disabled；
 *  - 时序边界：replace 早于重建才命中（旧 head 不在 post surface）→ skip；
 *              replace 晚于重建（旧 head 仍在 surface）→ 不命中、不写 skip。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { rebuildProtectionSurface, shadowedSeqsOf, snapshotProtection } from '../src/compress/protection.js';
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

function liveSession(built, id = 'session-dsh-021-a') {
  const bySeq = new Map(built.events.map((item) => [item.seq, item]));
  const appended = [];
  let nextSeq = 9000;
  return {
    id,
    appended,
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt(seq) { return bySeq.get(seq); },
    append(type, data, opts) {
      const item = { seq: nextSeq, type, data, time: Date.now(), ...opts };
      nextSeq += 1;
      bySeq.set(item.seq, item);
      if (opts?.surfaceOp === 'append') this.surface.nodes.push(item.seq);
      appended.push(item);
      return item;
    },
  };
}

const eventOf = (built, type) => built.events.find((item) => item.type === type);
const checkpointOf = (built) => built.events.find(
  (item) => item.type === 'user/message' && item.data.source?.kind === 'compact-checkpoint',
);

async function runGuard({ rebuildEnabled, repostSystem, repostText = 'SYSTEM PROMPT', repostKind = 'system-prompt' }) {
  const base = await tempDir('cg-dsh-021-a-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({
      mode: 'single-root', root: 'D:/work/dsh-021', cwd: '', governed: true,
      skipReason: null, unattributed: false,
    }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; } },
    rootId: 'root-dsh-021',
    projectRoot: 'D:/work/dsh-021',
    logger: ctx.logger,
    ...(rebuildEnabled === undefined ? {} : { rebuildEnabled }),
  });
  guard.start();
  const built = buildCompaction({
    before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 0, end: 13, manual: true,
  });
  const session = liveSession(built);
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointOf(built));
  session.surface.nodes = [...built.postSurface];
  if (repostSystem === true) {
    // 宿主在压缩后重发同 kind 的 system/message（a 类：逐字节重发）。
    session.append('system/message', {
      turn: 7,
      step: 1,
      message: {
        role: 'system',
        id: 'sys-repost',
        content: [{ type: 'text', text: repostText }],
        source: { kind: repostKind },
      },
    }, { surfaceOp: 'append' });
  }
  handler(session, eventOf(built, 'compaction/end'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    result: { guard, audits, session, built },
    cleanup: async () => {
      await guard.flush().catch(() => {});
      guard.stop();
      await store.close().catch(() => {});
      await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

test('accepted：宿主重发同 kind 副本 → skip 标 system-prompt-skip，accepted 汇总、无 compaction-loss', async () => {
  const { result, cleanup } = await runGuard({ repostSystem: true });
  try {
    const { audits, session, built } = result;
    const skipped = audits.filter((item) => item.event === 'surface-rebuild-skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].details.kind, 'system-prompt');
    assert.equal(skipped[0].details.lossClass, 'system-prompt-skip');
    assert.equal(skipped[0].details.disposition, 'accepted');
    assert.equal(skipped[0].details.hashMatch, true);
    const accepted = audits.filter((item) => item.event === 'compaction-loss-accepted');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].details.disposition, 'accepted');
    assert.equal(accepted[0].details.lossClass, 'system-prompt-skip');
    assert.equal(accepted[0].details.acceptedCount, 1);
    assert.deepEqual(accepted[0].details.acceptedSeqs, [0]);
    assert.equal(accepted[0].details.compactionId, built.compactionId);
    assert.equal(audits.filter((item) => item.event === 'compaction-loss').length, 0);
    // 治理自身不得再 append 任何 system/message（重发的那条是宿主的）。
    const ownSystem = session.appended.filter((item) => item.type === 'system/message' && item.data?.message?.id !== 'sys-repost');
    assert.equal(ownSystem.length, 0);
  } finally {
    await cleanup();
  }
});

test('null kind / 文本不同 → 一律 b 类，不得误判 accepted', async () => {
  for (const [label, options] of [
    ['null-kind', { repostSystem: true, repostKind: null }],
    ['text-differs', { repostSystem: true, repostText: 'DIFFERENT TEXT' }],
  ]) {
    const { result, cleanup } = await runGuard(options);
    try {
      const { audits } = result;
      const skipped = audits.filter((item) => item.event === 'surface-rebuild-skipped');
      assert.equal(skipped.length, 1, label);
      assert.equal(skipped[0].details.lossClass, 'b-class-loss', label);
      assert.equal(skipped[0].details.disposition, 'unacceptable', label);
      assert.equal(skipped[0].details.hashMatch, false, label);
      assert.equal(audits.filter((item) => item.event === 'compaction-loss-accepted').length, 0, label);
      const loss = audits.filter((item) => item.event === 'compaction-loss');
      assert.equal(loss.length, 1, label);
      assert.equal(loss[0].details.disposition, 'unacceptable', label);
    } finally {
      await cleanup();
    }
  }
});

test('回滚开关：protection.rebuild.enabled=false → 零重建 + surface-rebuild-disabled + loss 仍在', async () => {
  const { result, cleanup } = await runGuard({ rebuildEnabled: false });
  try {
    const { audits, session } = result;
    assert.equal(audits.filter((item) => item.event === 'surface-rebuild-disabled').length, 1);
    assert.equal(audits.filter((item) => item.event === 'surface-rebuild-skipped').length, 0);
    assert.equal(audits.filter((item) => item.event === 'compaction-loss-accepted').length, 0);
    // 回注（reinjection）是另一条路径；这里只断言重建副本为 0。
    assert.equal(
      session.appended.filter((item) => item.type === 'user/message' && item.data?.source?.form === 'surface-rebuild').length,
      0,
      '开关关闭时连 user 也不重建',
    );
    const loss = audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(loss.length, 1);
    // 回滚开关 = 旧口径：failures 列表在、分型字段不写。
    assert.ok(Array.isArray(loss[0].details.failures));
    assert.equal(loss[0].details.disposition, undefined);
    assert.equal(loss[0].details.lossClass, undefined);
  } finally {
    await cleanup();
  }
});

test('时序边界：replace 早于重建（旧 head 不在 post surface）→ skip；晚于重建（仍在）→ 不命中', () => {
  const built = buildCompaction({
    before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 13, manual: true,
  });
  const bySeq = new Map(built.events.map((item) => [item.seq, item]));
  // snapshot 在压缩前拍（rules 含 seq0）；after 由 postSurfaceNodes 控制。
  const snapshotSession = {
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt(seq) { return bySeq.get(seq); },
  };
  const snap = snapshotProtection(snapshotSession);
  const shadowed = shadowedSeqsOf(built.summaryEvent, snap);
  const makeLive = () => ({
    id: 'session-boundary',
    surface: { nodes: [] },
    eventAt(seq) { return bySeq.get(seq); },
    append() { return { seq: 7000 }; },
  });

  // 晚于重建：post surface 仍含旧 head（seq0）→ 不命中。
  const rebuiltLate = rebuildProtectionSurface(makeLive(), snap, {
    shadowedSeqs: shadowed,
    postSurfaceNodes: [...built.postSurface, 0],
    compactionId: built.compactionId,
  });
  assert.equal(rebuiltLate.skipped.length, 0, '旧 head 仍在 surface 时不得命中');

  // 早于重建：post surface 已不含 seq0（replace 已发生）→ 命中 skip。
  const rebuiltEarly = rebuildProtectionSurface(makeLive(), snap, {
    shadowedSeqs: shadowed,
    postSurfaceNodes: built.postSurface.filter((seq) => seq !== 0),
    compactionId: built.compactionId,
  });
  assert.equal(rebuiltEarly.skipped.length, 1);
  assert.equal(rebuiltEarly.skipped[0].ruleSeq, 0);
  assert.equal(rebuiltEarly.skipped[0].reason, 'no-open-step');
});
