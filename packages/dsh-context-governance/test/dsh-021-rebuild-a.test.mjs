/**
 * D-MGMT-021 v3b（pending 第三态）回归：
 *  - 真实时序 accepted：compaction/end 之后的下一轮宿主重发同 kind 原生 system/message
 *    → pending 转 accepted（hashMatch 仅观察，可为 false），不落 compaction-loss；
 *  - kind=null：只有 sha256 相等才 accepted；否则 pending → 终态 unacceptable；
 *  - 窗口到期：turn/start 绑定 → turn/end 未命中 → ttl-expired + loss；
 *  - 异常轮：turn/abort → turn-aborted + loss；
 *  - 回滚开关：rebuild.enabled=false → 无 skip/resolved，loss 回旧口径；
 *  - 重启恢复：audit 里 pending 无 resolved → resolved(unacceptable, reason=restart)；
 *    轮转/窗口未覆盖 → surface-rebuild-recovery-incomplete；
 *  - 报告在 pending 期间 disposition='pending'，不计为通过。
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

async function makeGuard({ rebuildEnabled, auditFile, before } = {}) {
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
    ...(auditFile === undefined ? {} : { auditFile }),
  });
  guard.start();
  const built = buildCompaction({
    before: before ?? healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 0, end: 13, manual: true,
  });
  const session = liveSession(built);
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointOf(built));
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cleanup = async () => {
    await guard.flush().catch(() => {});
    guard.stop();
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  };
  return { guard, audits, session, built, handler, cleanup };
}

const repost = (session, { text = 'SYSTEM PROMPT', kind = 'system-prompt', turn = 2 } = {}) => session.append('system/message', {
  turn,
  step: 1,
  message: {
    role: 'system',
    id: `sys-repost-${turn}`,
    content: [{ type: 'text', text }],
    source: { kind },
  },
}, { surfaceOp: 'append' });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('accepted（真实时序）：end 后下一轮重发同 kind、内容不同 → accepted，hashMatch=false，无 loss', async () => {
  const g = await makeGuard();
  try {
    repost(g.session, { text: 'DIFFERENT CONTENT' });
    await wait(650);
    const skipped = g.audits.filter((item) => item.event === 'surface-rebuild-skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].details.disposition, 'pending');
    const resolved = g.audits.filter((item) => item.event === 'surface-rebuild-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].details.disposition, 'accepted');
    assert.equal(resolved[0].details.match, 'kind');
    assert.equal(resolved[0].details.hashMatch, false, '内容不同也应 accepted（只看 kind）');
    assert.equal(resolved[0].details.compactionId, g.built.compactionId);
    assert.equal(resolved[0].details.ruleSeq, 0);
    const accepted = g.audits.filter((item) => item.event === 'compaction-loss-accepted');
    assert.equal(accepted.length, 1);
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 0);
  } finally {
    await g.cleanup();
  }
});

const noKindBefore = () => [
  {
    type: 'system/message',
    seq: 0,
    time: 0,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'system', content: [{ type: 'text', text: 'NO KIND PROMPT' }], source: {} },
    },
  },
  ...healthyMessages().slice(1),
];

test('kind=null：重发但 sha256 不等 → 保持 pending；stop 后 session-ended + loss', async () => {
  const g = await makeGuard({ before: noKindBefore() });
  try {
    const skipped = g.audits.filter((item) => item.event === 'surface-rebuild-skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].details.kind, null);
    assert.equal(skipped[0].details.disposition, 'pending');
    repost(g.session, { text: 'DIFFERENT', kind: 'system-prompt' });
    await wait(650);
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-resolved').length, 0);
    g.guard.stop();
    const resolved = g.audits.filter((item) => item.event === 'surface-rebuild-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].details.disposition, 'unacceptable');
    assert.equal(resolved[0].details.reason, 'session-ended');
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 1);
  } finally {
    await g.cleanup();
  }
});

test('kind=null：重发且 sha256 相等（同文本）→ accepted', async () => {
  const g = await makeGuard({ before: noKindBefore() });
  try {
    repost(g.session, { text: 'NO KIND PROMPT', kind: 'system-prompt' });
    await wait(650);
    const resolved = g.audits.filter((item) => item.event === 'surface-rebuild-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].details.disposition, 'accepted');
    assert.equal(resolved[0].details.match, 'sha256');
    assert.equal(resolved[0].details.hashMatch, true);
  } finally {
    await g.cleanup();
  }
});

test('窗口到期：turn/start 绑定后 turn/end 未命中 → ttl-expired + loss', async () => {
  const g = await makeGuard();
  try {
    g.handler(g.session, { type: 'turn/start', seq: 9500, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/end', seq: 9501, data: { turn: 2, reason: { kind: 'completed' } } });
    const resolved = g.audits.filter((item) => item.event === 'surface-rebuild-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].details.disposition, 'unacceptable');
    assert.equal(resolved[0].details.reason, 'ttl-expired');
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 1);
  } finally {
    await g.cleanup();
  }
});

test('异常轮：turn/abort → turn-aborted + loss，不悬空', async () => {
  const g = await makeGuard();
  try {
    g.handler(g.session, { type: 'turn/start', seq: 9510, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/abort', seq: 9511, data: { turn: 2 } });
    const resolved = g.audits.filter((item) => item.event === 'surface-rebuild-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].details.reason, 'turn-aborted');
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 1);
  } finally {
    await g.cleanup();
  }
});

test('回滚开关：rebuild.enabled=false → 无 skip/resolved，loss 回旧口径（无分型字段）', async () => {
  const g = await makeGuard({ rebuildEnabled: false });
  try {
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-skipped').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-resolved').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'surface-rebuild-disabled').length, 1);
    const loss = g.audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(loss.length, 1);
    assert.equal(loss[0].details.disposition, undefined);
    assert.equal(loss[0].details.lossClass, undefined);
  } finally {
    await g.cleanup();
  }
});

test('重启恢复：audit 里 pending 无 resolved → resolved(restart) + loss', async () => {
  const base = await tempDir('cg-dsh-021-restart-');
  const auditFile = path.join(base, 'audit.jsonl');
  const pendingRow = {
    ts: new Date().toISOString(),
    event: 'surface-rebuild-skipped',
    sessionId: 'session-old',
    cycle: 'cmp-1',
    compactionId: 'cmp-old',
    ruleSeq: 3,
    kind: 'system-prompt',
    disposition: 'pending',
  };
  await fs.writeFile(auditFile, `${JSON.stringify(pendingRow)}\n`, 'utf8');
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
    const resolved = audits.filter((item) => item.event === 'surface-rebuild-resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].details.reason, 'restart');
    assert.equal(resolved[0].details.disposition, 'unacceptable');
    assert.equal(audits.filter((item) => item.event === 'compaction-loss').length, 1);
    assert.equal(audits.filter((item) => item.event === 'surface-rebuild-recovery-incomplete').length, 0);
  } finally {
    guard.stop();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('重启恢复盲区：审计已轮转 → recovery-incomplete 且写明可能存在未结算 pending', async () => {
  const base = await tempDir('cg-dsh-021-rotated-');
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
