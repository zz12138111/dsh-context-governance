/**
 * C35③（事件级口径）：压缩后等待宿主下个 pre-step 自愈。
 *  - pass：窗口内出现该 kind 的非治理新节点（seq>compaction、plugin≠治理、form≠surface-rebuild）；
 *  - fail：窗口（end→首个 turn/start→该 turn/end）结束仍无 → self-heal-missing + compaction-loss；
 *  - 无下一轮到 stop → session-ended；重启 → restart；
 *  - agent-instructions 的 baseline digest 必过：一致 pass(baseline-digest)、不一致 baseline-stale fail、
 *    读盘失败/字段缺失 unverified warn 且仍 pass；skill-catalog 只走事件级。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { FIVE_SECTION_SUMMARY, agentInstructions, buildCompaction, healthyMessages, skillCatalog } from './compress-helpers.mjs';
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

function liveSession(built, id = 'session-c35') {
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
    post(type, data) {
      const seq = nextSeq;
      nextSeq += 1;
      const item = { seq, type, data, time: Date.now(), surfaceOp: 'append' };
      bySeq.set(seq, item);
      this.surface.nodes.push(seq);
      return item;
    },
  };
}

const eventOf = (built, type) => built.events.find((item) => item.type === type);
const checkpointOf = (built) => built.events.find(
  (item) => item.type === 'user/message' && item.data.source?.kind === 'compact-checkpoint',
);

async function runGuard({ auditFile } = {}) {
  const base = await tempDir('cg-c35-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({
      mode: 'single-root', root: 'D:/work/c35', cwd: '', governed: true,
      skipReason: null, unattributed: false,
    }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; } },
    rootId: 'root-c35',
    projectRoot: 'D:/work/c35',
    logger: ctx.logger,
    ...(auditFile === undefined ? {} : { auditFile }),
  });
  guard.start();
  const messages = healthyMessages();
  const built = buildCompaction({
    // 让 rules 同时覆盖两类：agent-instructions(seq1) + skill-catalog(seq2)。
    before: [messages[0], messages[1], skillCatalog(2, 'skill catalog'), ...messages.slice(3)],
    summary: FIVE_SECTION_SUMMARY, start: 0, end: 13, manual: true,
  });
  const session = liveSession(built);
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointOf(built));
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const maxSurfaceSeq = Math.max(...session.surface.nodes);
  const cleanup = async () => {
    await guard.flush().catch(() => {});
    guard.stop();
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  };
  return { guard, audits, session, built, handler, maxSurfaceSeq, cleanup, base };
}

const hostHeal = (session, seq, { kind = 'agent-instructions', plugin = undefined, form = 'instructions', changes = undefined } = {}) => {
  const source = { kind, form, ...(plugin === undefined ? {} : { plugin }), ...(changes === undefined ? {} : { changes }) };
  const event = { seq, type: 'user/message', time: Date.now(), surfaceOp: 'append', data: { role: 'user', id: `heal-${seq}`, content: [{ type: 'text', text: 'current' }], source } };
  session.surface.nodes.push(seq);
  return event;
};

test('C35③ pass：窗口内出现该 kind 的非治理新节点 → self-heal-verified，无 loss', async () => {
  const g = await runGuard();
  try {
    const pending = g.audits.filter((item) => item.event === 'self-heal-pending');
    assert.equal(pending.length, 2, 'agent-instructions + skill-catalog 各一条');
    assert.deepEqual(pending.map((item) => item.details.kind).sort(), ['agent-instructions', 'skill-catalog']);
    const event = hostHeal(g.session, g.maxSurfaceSeq + 1, { kind: 'agent-instructions' });
    g.handler(g.session, event);
    const verified = g.audits.filter((item) => item.event === 'self-heal-verified');
    assert.equal(verified.length, 1);
    assert.equal(verified[0].details.kind, 'agent-instructions');
    assert.equal(verified[0].details.form, 'instructions');
    // 另一类别仍未自愈：下一轮结束应 fail。
    g.handler(g.session, { type: 'turn/start', seq: g.maxSurfaceSeq + 10, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/end', seq: g.maxSurfaceSeq + 11, data: { turn: 2, reason: { kind: 'completed' } } });
    const missing = g.audits.filter((item) => item.event === 'self-heal-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].details.kind, 'skill-catalog');
    assert.equal(missing[0].details.reason, 'host-self-heal-missing');
    const loss = g.audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(loss.length, 1);
    assert.equal(loss[0].details.lossClass, 'b-class-loss');
  } finally {
    await g.cleanup();
  }
});

test('C35③ fail：窗口内无自愈 → self-heal-missing(host-self-heal-missing) + loss', async () => {
  const g = await runGuard();
  try {
    g.handler(g.session, { type: 'turn/start', seq: g.maxSurfaceSeq + 10, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/end', seq: g.maxSurfaceSeq + 11, data: { turn: 2, reason: { kind: 'completed' } } });
    const missing = g.audits.filter((item) => item.event === 'self-heal-missing');
    assert.equal(missing.length, 2, '两个类别各自结算');
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 2);
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-verified').length, 0);
  } finally {
    await g.cleanup();
  }
});

test('C35③ 空闲到 stop：无下一轮 → session-ended fail+loss，不静默', async () => {
  const g = await runGuard();
  try {
    g.guard.stop();
    const missing = g.audits.filter((item) => item.event === 'self-heal-missing');
    assert.equal(missing.length, 2);
    assert.equal(missing[0].details.reason, 'session-ended');
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 2);
  } finally {
    await g.cleanup();
  }
});

test('C35③ 重启：audit 有 pending 无终态 → restart fail+loss', async () => {
  const base = await tempDir('cg-c35-restart-');
  const auditFile = path.join(base, 'audit.jsonl');
  await fs.writeFile(auditFile, [
    '{"ts":"2026-11-15T00:00:00.000Z","event":"self-heal-pending","sessionId":"s","compactionId":"cmp-x","kind":"skill-catalog"}',
  ].join('\n') + '\n', 'utf8');
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
    const missing = audits.filter((item) => item.event === 'self-heal-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].details.reason, 'restart');
    assert.equal(audits.filter((item) => item.event === 'compaction-loss').length, 1);
  } finally {
    guard.stop();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('C35③ 治理写/旧节点不算命中：非治理新节点才 pass', async () => {
  const g = await runGuard();
  try {
    // 治理自己写的副本（plugin=context-governance）→ 不算。
    const governed = hostHeal(g.session, g.maxSurfaceSeq + 1, { plugin: 'context-governance' });
    g.handler(g.session, governed);
    // 旧节点（seq 小于 compaction 结束时 surface 尾）→ 不算。
    const oldSeq = g.maxSurfaceSeq - 1;
    g.handler(g.session, hostHeal(g.session, oldSeq, { kind: 'skill-catalog' }));
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-verified').length, 0);
    g.handler(g.session, { type: 'turn/start', seq: g.maxSurfaceSeq + 10, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/end', seq: g.maxSurfaceSeq + 11, data: { turn: 2, reason: { kind: 'completed' } } });
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-missing').length, 2);
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 2);
  } finally {
    await g.cleanup();
  }
});

test('C35③ 窗口外节点不补判：结算后再出现自愈节点不产生 verified', async () => {
  const g = await runGuard();
  try {
    g.handler(g.session, { type: 'turn/start', seq: g.maxSurfaceSeq + 10, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/end', seq: g.maxSurfaceSeq + 11, data: { turn: 2, reason: { kind: 'completed' } } });
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-missing').length, 2);
    // 结算后到达的同 kind 节点：不补判、不产生 verified。
    g.handler(g.session, hostHeal(g.session, g.maxSurfaceSeq + 99, { kind: 'agent-instructions' }));
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-verified').length, 0);
  } finally {
    await g.cleanup();
  }
});

const sha1 = (text) => createHash('sha1').update(text).digest('hex');

test('C35③ 签发 v4：digest match → self-heal-verified(event-level, hashMatch=match)，无 loss', async () => {
  const g = await runGuard();
  try {
    g.session.cwd = g.base;
    // raw 口径：宿主 digest = sha1(raw content)，含尾随换行，不 trim。
    const content = 'baseline instructions\nsecond line\n';
    await fs.writeFile(path.join(g.base, 'AGENTS.md'), content, 'utf8');
    g.handler(g.session, hostHeal(g.session, g.maxSurfaceSeq + 1, {
      kind: 'agent-instructions',
      changes: [{ path: 'AGENTS.md', digest: sha1(content) }],
    }));
    const verified = g.audits.filter((item) => item.event === 'self-heal-verified'
      && item.details.kind === 'agent-instructions');
    assert.equal(verified.length, 1);
    assert.equal(verified[0].details.mode, 'event-level');
    assert.equal(verified[0].details.hashMatch, 'match');
    assert.equal(verified[0].details.expected, sha1(content));
    assert.equal(verified[0].details.actual, sha1(content));
    assert.equal(verified[0].details.reason, 'baseline-event-level');
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-suspect').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-unverified').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 0);
  } finally {
    await g.cleanup();
  }
});

test('C35③ 签发 v4：digest mismatch → self-heal-suspect(warn) + verified pass + 0 loss', async () => {
  const g = await runGuard();
  try {
    g.session.cwd = g.base;
    const content = 'disk content now\n';
    await fs.writeFile(path.join(g.base, 'AGENTS.md'), content, 'utf8');
    g.handler(g.session, hostHeal(g.session, g.maxSurfaceSeq + 1, {
      kind: 'agent-instructions',
      // 宿主记的是另一版内容（历史节点），复算必然不一致——v4 只 warn，不 fail。
      changes: [{ path: 'AGENTS.md', digest: sha1('old baseline that is no longer on disk') }],
    }));
    const suspect = g.audits.filter((item) => item.event === 'self-heal-suspect');
    assert.equal(suspect.length, 1);
    assert.equal(suspect[0].details.kind, 'agent-instructions');
    assert.equal(suspect[0].details.hashMatch, 'mismatch');
    assert.equal(suspect[0].details.path, 'AGENTS.md');
    assert.equal(suspect[0].details.expected, sha1('old baseline that is no longer on disk'));
    assert.equal(suspect[0].details.actual, sha1(content));
    assert.equal(suspect[0].details.disposition, 'warn');
    const verified = g.audits.filter((item) => item.event === 'self-heal-verified'
      && item.details.kind === 'agent-instructions');
    assert.equal(verified.length, 1, '事件级主判仍 pass');
    assert.equal(verified[0].details.hashMatch, 'mismatch');
    assert.equal(verified[0].details.mode, 'event-level');
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-missing').length, 0, '不得产 missing');
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 0, '不得产 loss');
  } finally {
    await g.cleanup();
  }
});

test('C35③ 签发 v4：raw 与 trim 口径差异不再导致 fail（尾随空白）', async () => {
  const g = await runGuard();
  try {
    g.session.cwd = g.base;
    const content = 'line one\nline two\n\n';
    await fs.writeFile(path.join(g.base, 'AGENTS.md'), content, 'utf8');
    assert.notEqual(sha1(content), sha1(content.trim()), '前提：raw 与 trim 的 digest 不同');
    g.handler(g.session, hostHeal(g.session, g.maxSurfaceSeq + 1, {
      kind: 'agent-instructions',
      changes: [{ path: 'AGENTS.md', digest: sha1(content) }],
    }));
    const verified = g.audits.filter((item) => item.event === 'self-heal-verified'
      && item.details.kind === 'agent-instructions');
    assert.equal(verified.length, 1);
    assert.equal(verified[0].details.hashMatch, 'match', 'raw 复算才对得上宿主');
    assert.equal(g.audits.filter((item) => item.event === 'self-heal-suspect').length, 0);
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss').length, 0);
  } finally {
    await g.cleanup();
  }
});
test('C35③ baseline 无法核对（读盘失败/字段缺失）：self-heal-unverified warn 且仍 pass', async () => {
  const g = await runGuard();
  try {
    g.session.cwd = g.base;
    // 读盘失败：path 指向不存在的文件。
    g.handler(g.session, hostHeal(g.session, g.maxSurfaceSeq + 1, {
      kind: 'agent-instructions',
      changes: [{ path: 'MISSING-baseline.md', digest: 'a'.repeat(40) }],
    }));
    const unverified = g.audits.filter((item) => item.event === 'self-heal-unverified');
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0].details.kind, 'agent-instructions');
    assert.equal(unverified[0].details.mode, 'event-level');
    const verified = g.audits.filter((item) => item.event === 'self-heal-verified'
      && item.details.kind === 'agent-instructions');
    assert.equal(verified.length, 1);
    assert.equal(verified[0].details.mode, 'event-level');
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss'
      && item.details.reason === 'baseline-stale').length, 0);
    // 字段缺失：changes 里没有 digest。
    const g2 = await runGuard();
    try {
      g2.session.cwd = g2.base;
      g2.handler(g2.session, hostHeal(g2.session, g2.maxSurfaceSeq + 1, {
        kind: 'agent-instructions',
        changes: [{ path: 'AGENTS.md' }],
      }));
      const u2 = g2.audits.filter((item) => item.event === 'self-heal-unverified');
      assert.equal(u2.length, 1);
      assert.equal(u2[0].details.reason, 'change-path-or-digest-missing');
      assert.equal(g2.audits.filter((item) => item.event === 'self-heal-verified').length >= 1, true);
    } finally {
      await g2.cleanup();
    }
  } finally {
    await g.cleanup();
  }
});

// 审核复核 a：四条结算路径的 compaction-loss 必须与 missing 同 reason，能对账出原因。
test('C35③ loss 带 reason：turn/end / stop() / turn/abort / restart 与 missing 一致', async () => {
  const g = await runGuard();
  try {
    g.handler(g.session, { type: 'turn/start', seq: g.maxSurfaceSeq + 10, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/end', seq: g.maxSurfaceSeq + 11, data: { turn: 2, reason: { kind: 'completed' } } });
    const endLoss = g.audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(endLoss.length, 2);
    assert.deepEqual(endLoss.map((item) => item.details.reason), ['host-self-heal-missing', 'host-self-heal-missing']);
  } finally {
    await g.cleanup();
  }

  const aborted = await runGuard();
  try {
    aborted.handler(aborted.session, { type: 'turn/start', seq: aborted.maxSurfaceSeq + 10, data: { turn: 2 } });
    aborted.handler(aborted.session, { type: 'turn/abort', seq: aborted.maxSurfaceSeq + 11, data: { turn: 2 } });
    const lost = aborted.audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(lost.length, 2);
    assert.deepEqual(lost.map((item) => item.details.reason), ['turn-aborted', 'turn-aborted']);
    const missing = aborted.audits.filter((item) => item.event === 'self-heal-missing');
    assert.deepEqual(missing.map((item) => item.details.reason), ['turn-aborted', 'turn-aborted']);
  } finally {
    await aborted.cleanup();
  }

  const stopped = await runGuard();
  try {
    stopped.guard.stop();
    const lost = stopped.audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(lost.length, 2);
    assert.deepEqual(lost.map((item) => item.details.reason), ['session-ended', 'session-ended']);
  } finally {
    await stopped.cleanup();
  }

  const base = await tempDir('cg-c35-restart-reason-');
  const auditFile = path.join(base, 'audit.jsonl');
  await fs.writeFile(auditFile, [
    '{"ts":"2026-11-15T00:00:00.000Z","event":"self-heal-pending","sessionId":"s","compactionId":"cmp-x","kind":"skill-catalog"}',
  ].join('\n') + '\n', 'utf8');
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
    const lost = audits.filter((item) => item.event === 'compaction-loss');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].details.reason, 'restart');
  } finally {
    guard.stop();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// rc.2 真机回归：一个周期里同类别有多份被 shadow 的规则节点时，只登记一条 pending，
// 自愈命中只产生一条 verified（真机曾出现 5 条重复 self-heal-pending）。
test('rc.2 同类别多份规则只登记一条 pending，命中只产一条 verified', async () => {
  const base = await tempDir('cg-rc2-dedupe-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/work/rc2', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(event, details) { audits.push({ event, details }); return true; } },
    rootId: 'root-rc2',
    projectRoot: 'D:/work/rc2',
    logger: ctx.logger,
  });
  guard.start();
  try {
    const messages = healthyMessages();
    const built = buildCompaction({
      // 三份 agent-instructions + 两份 skill-catalog（seq 1..5），其余沿用健康消息 0/6..12，
      // 全部落在 shadow 区间 [0, 13]。
      before: [
        messages[0],
        agentInstructions(1),
        agentInstructions(2),
        agentInstructions(3),
        skillCatalog(4),
        skillCatalog(5),
        ...messages.slice(6),
      ],
      summary: FIVE_SECTION_SUMMARY, start: 0, end: 13, manual: true,
    });
    const session = liveSession(built);
    const handler = ctx.handlers[0].handler;
    handler(session, eventOf(built, 'compaction/start'));
    handler(session, eventOf(built, 'compaction/summary'));
    handler(session, checkpointOf(built));
    session.surface.nodes = [...built.postSurface];
    handler(session, eventOf(built, 'compaction/end'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = audits.filter((item) => item.event === 'self-heal-pending');
    assert.equal(pending.length, 2, '每个 kind 只登记一条');
    assert.deepEqual(pending.map((item) => item.details.kind).sort(), ['agent-instructions', 'skill-catalog']);
    const maxSeq = Math.max(...session.surface.nodes);
    handler(session, hostHeal(session, maxSeq + 1, { kind: 'agent-instructions' }));
    handler(session, hostHeal(session, maxSeq + 2, { kind: 'skill-catalog' }));
    const verified = audits.filter((item) => item.event === 'self-heal-verified');
    assert.equal(verified.length, 2, '每个 kind 只产一条 verified');
    assert.equal(audits.filter((item) => item.event === 'self-heal-missing').length, 0);
  } finally {
    await guard.flush().catch(() => {});
    guard.stop();
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});




test('C35③ 签发 v4：窗口内已自愈则 settle 不产 missing/loss，全库无 baseline-stale', async () => {
  const g = await runGuard();
  try {
    g.session.cwd = g.base;
    const content = 'x\n';
    await fs.writeFile(path.join(g.base, 'AGENTS.md'), content, 'utf8');
    g.handler(g.session, hostHeal(g.session, g.maxSurfaceSeq + 1, {
      kind: 'agent-instructions',
      changes: [{ path: 'AGENTS.md', digest: sha1('mismatch-but-only-warn') }],
    }));
    g.handler(g.session, { type: 'turn/start', seq: g.maxSurfaceSeq + 10, data: { turn: 2 } });
    g.handler(g.session, { type: 'turn/end', seq: g.maxSurfaceSeq + 11, data: { turn: 2, reason: { kind: 'completed' } } });
    for (const name of ['agent-instructions']) {
      assert.equal(g.audits.filter((item) => item.event === 'self-heal-missing'
        && item.details.kind === name).length, 0);
    }
    assert.equal(g.audits.filter((item) => item.event === 'compaction-loss'
      && item.details.reason === 'baseline-stale').length, 0);
    assert.equal(g.audits.some((item) => JSON.stringify(item.details ?? {}).includes('baseline-stale')), false,
      '任何审计细节都不应再出现 baseline-stale');
  } finally {
    await g.cleanup();
  }
});
