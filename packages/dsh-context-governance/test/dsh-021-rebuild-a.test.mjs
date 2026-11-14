/**
 * 用户 A（官方自愈口径）回归：
 *  - 指令/目录（含 skill-catalog）不再重建 → 无 surface-rebuild-skipped/resolved/pending；
 *    rule-injection 记 skip(host-self-heal)，不计 compaction-loss；
 *  - latestUser 仍重建；
 *  - 回滚开关 rebuild.enabled=false → 无重建、旧口径 loss（无分型字段）；
 *  - 重启恢复：无 pending 时不写 resolved/loss；审计轮转 → recovery-incomplete。
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

function liveSession(built, id = 'session-user-a') {
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

async function runGuard({ rebuildEnabled, auditFile } = {}) {
  const base = await tempDir('cg-user-a-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({
      mode: 'single-root', root: 'D:/work/user-a', cwd: '', governed: true,
      skipReason: null, unattributed: false,
    }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; } },
    rootId: 'root-user-a',
    projectRoot: 'D:/work/user-a',
    logger: ctx.logger,
    ...(rebuildEnabled === undefined ? {} : { rebuildEnabled }),
    ...(auditFile === undefined ? {} : { auditFile }),
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
  handler(session, eventOf(built, 'compaction/end'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    guard, audits, session, built, handler,
    cleanup: async () => {
      await guard.flush().catch(() => {});
      guard.stop();
      await store.close().catch(() => {});
      await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

test('用户 A：指令/目录不重建 → 零 skip/resolved/loss，rule-injection skip，latestUser 仍重建', async () => {
  const g = await runGuard();
  try {
    // 只重建 latestUser。
    assert.ok(g.session.appended.some((item) => item.type === 'user/message'
      && item.data?.content?.[0]?.text === '最新一条用户消息：继续。'));
    assert.equal(g.session.appended.filter((item) => item.type === 'system/message').length, 0);
    assert.equal(g.session.appended.filter((item) => item.type === 'user/message'
      && item.data?.content?.[0]?.text === 'AGENTS.md rules').length, 0, '指令不得重建');
    // 无 pending 三态、无 loss。
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-skipped').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-resolved').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss-accepted').length, 0);
    const report = g.guard.status.lastReport;
    const ruleCheck = report?.checks?.find((item) => item.name === 'rule-injection');
    assert.equal(ruleCheck?.status, 'skip');
    assert.equal(ruleCheck.reason, 'host-self-heal');
    assert.equal(report.ok, true);
  } finally {
    await g.cleanup();
  }
});

test('回滚开关：rebuild.enabled=false → 无重建、旧口径 loss（无分型字段）', async () => {
  const g = await runGuard({ rebuildEnabled: false });
  try {
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-disabled').length, 1);
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-skipped').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-resolved').length, 0);
    assert.equal(g.session.appended.filter((item) => item.type === 'user/message'
      && item.data?.source?.form === 'surface-rebuild').length, 0);
    const loss = g.audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(loss.length, 1);
    assert.equal(loss[0].details.disposition, undefined);
    assert.equal(loss[0].details.lossClass, undefined);
  } finally {
    await g.cleanup();
  }
});

test('重启恢复：审计无 pending → 不写 resolved/loss，也不误报 recovery-incomplete', async () => {
  const base = await tempDir('cg-user-a-restart-');
  const auditFile = path.join(base, 'audit.jsonl');
  await fs.writeFile(auditFile, '{"ts":"2026-11-15T00:00:00.000Z","event":"apply"}\n', 'utf8');
  const audits = [];
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/x', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx: makeCtx(),
    hostVersion: '0.2.2-rc.3',
    store: null,
    rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; } },
    projectRoot: 'D:/x',
    auditFile,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    guard.start();
    assert.equal(audits.filter((item) => item.event === 'surface-rebuild-resolved').length, 0);
    assert.equal(audits.filter((item) => item.event === 'compaction-loss').length, 0);
    assert.equal(audits.filter((item) => item.event === 'surface-rebuild-recovery-incomplete').length, 0);
  } finally {
    guard.stop();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('重启恢复盲区：审计已轮转 → recovery-incomplete（写明可能存在未结算 pending）', async () => {
  const base = await tempDir('cg-user-a-rotated-');
  const auditFile = path.join(base, 'audit.jsonl');
  await fs.writeFile(auditFile, '{"ts":"2026-11-15T00:00:00.000Z","event":"apply"}\n', 'utf8');
  await fs.writeFile(`${auditFile}.1`, '{"ts":"2026-11-14T00:00:00.000Z","event":"apply"}\n', 'utf8');
  const audits = [];
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/x', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx: makeCtx(),
    hostVersion: '0.2.2-rc.3',
    store: null,
    rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; } },
    projectRoot: 'D:/x',
    auditFile,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    guard.start();
    const incomplete = audits.filter((item) => item.event === 'surface-rebuild-recovery-incomplete');
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].details.rotated, true);
    assert.match(String(incomplete[0].details.reason), /未结算 pending/);
  } finally {
    guard.stop();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
