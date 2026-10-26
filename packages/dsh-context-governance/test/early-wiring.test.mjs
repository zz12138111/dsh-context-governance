/**
 * 0.2.2 第 5 步：early 接线单测（`turn/end` 门禁 + `early-*` 审计）。
 * 全部用 fake ctx/guard/policy/engine；不碰宿主。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EARLY_DELAY_MS, EARLY_REPORT_WAIT_MS, wireEarlyCompaction } from '../src/compress/early-wiring.js';

function makeCtx({ agent = { session: { id: 's1' } }, engine = null } = {}) {
  const handlers = [];
  const ctx = {
    on: (event, handler) => { handlers.push({ event, handler }); return () => {}; },
    get: (service) => {
      if (service === 'agents') return { list: () => (agent === null ? [] : [agent]) };
      if (service === 'agentPresets') return engine === null ? null : { serviceFor: () => engine };
      return null;
    },
  };
  return { ctx, handlers };
}

function makeGuard({ measuredTokens = 680000, estimatedTokens = 400000, pending = 0, lastReport = null } = {}) {
  return { status: { pressure: { measuredTokens, estimatedTokens }, stats: { pending }, lastReport } };
}

const POLICY = {
  early: true,
  values: { 'compact.at': 0.6, 'compact.estimateSafety': 1.35 },
  window: { currentTokens: 1048576, native: 0.6934 },
};

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
}

function makeEngine(behavior = 'resolve') {
  return {
    calls: 0,
    async compactNow() {
      this.calls += 1;
      if (behavior === 'busy') {
        const error = new Error('manual compaction requires an idle agent with no waking queued work');
        error.name = 'ManualCompactionError';
        throw error;
      }
      if (behavior === 'fail') throw new Error('provider exploded');
    },
  };
}

test('0.2.2 接线：armed=false 时静默（不审计、不取服务、不调用）', async () => {
  const engine = makeEngine();
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => makeGuard(), getPolicy: () => POLICY, audit, now: () => 0 });
  await wiring.check({ id: 's1' });
  assert.equal(audit.entries.length, 0);
  assert.equal(engine.calls, 0);
});

test('0.2.2 接线：armed=true + 压力在位 → early-decision + early-forced（带 protection/failures/reinjected）', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null },
  });
  const fresh = { compactionId: 'new', sessionId: 's1', compaction: 'committed', protection: 'failed', failures: [{ name: 'latest-user-message' }], reinjected: true };
  const engine = {
    calls: 0,
    async compactNow() { this.calls += 1; guard.status.lastReport = fresh; },
  };
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const logs = [];
  const logger = { info: (line) => logs.push(['info', line]), warn: (line) => logs.push(['warn', line]) };
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, logger, getArmed: () => true, now: () => 0 });
  await wiring.check({ id: 's1' });
  assert.equal(engine.calls, 1);
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision', 'early-forced']);
  const forced = audit.entries[1];
  assert.equal(forced.accepted, true);
  assert.equal(forced.compaction, 'committed');
  assert.equal(forced.compactionId, 'new');
  assert.equal(forced.protection, 'failed');
  assert.deepEqual(forced.failures, ['latest-user-message']);
  assert.equal(forced.reinjected, true);
  assert.equal(forced.delayMs, EARLY_DELAY_MS);
  assert.equal(wiring.getLast().event, 'early-forced');
  assert.equal(wiring.getLast().accepted, true);
  const info = logs.find(([level, line]) => level === 'info' && line.includes('early compaction forced'));
  assert.ok(info, 'T2 首触提示：必须写一行 logger info');
  assert.match(info[1], /effective=0\.\d{3} threshold=0\.\d{2} compactionId=new protection=failed/);
  assert.equal(info[1].includes('latest-user-message'), false, 'logger 不得带失败项/正文');
});

test('S1：即时命中——waitForReport 返回本 cycle 报告 → committed + host compactionId', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null },
  });
  const fresh = {
    compactionId: 'host-uuid-new',
    sessionId: 's1',
    cycle: 'early-cycle-1',
    compaction: 'committed',
    protection: 'failed',
    failures: [{ name: 'latest-user-message' }],
    reinjected: true,
  };
  let waitArgs = null;
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-1' });
  guard.markEarlyAccepted = () => {};
  guard.waitForReport = (input) => {
    waitArgs = input;
    return Promise.resolve({ ok: true, reason: 'none', report: fresh, waitedMs: 4 });
  };
  const engine = makeEngine();
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await wiring.check({ id: 's1' });
  assert.equal(waitArgs.previousCompactionId, 'old');
  assert.equal(waitArgs.sessionId, 's1');
  assert.equal(waitArgs.cycleKey, 'early-cycle-1');
  assert.equal(waitArgs.timeoutMs, EARLY_REPORT_WAIT_MS);
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'committed');
  assert.equal(forced.compactionId, 'host-uuid-new');
  assert.equal(forced.cycle, 'early-cycle-1');
  // 审核 S1.1-④：命中路径不得写 early-report-wait。
  assert.equal(audit.entries.some((entry) => entry.event === 'early-report-wait'), false, '命中时不得写诊断行');
});

test('S1：等待中命中——报告回来前只写 early-decision，回来后写 forced', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null },
  });
  let resolveReport = null;
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-2' });
  guard.markEarlyAccepted = () => {};
  guard.waitForReport = () => new Promise((resolve) => {
    resolveReport = resolve;
  });
  const { ctx } = makeCtx({ engine: makeEngine() });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  const pending = wiring.check({ id: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision'], '报告未回前不得写 early-forced');
  resolveReport({
    ok: true,
    reason: 'none',
    waitedMs: 12,
    report: {
      compactionId: 'host-uuid-late',
      sessionId: 's1',
      cycle: 'early-cycle-2',
      compaction: 'committed',
      protection: 'ok',
      failures: [],
      reinjected: true,
    },
  });
  await pending;
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'committed');
  assert.equal(forced.compactionId, 'host-uuid-late');
});

test('S1.1：超时——等待窗口内无报告写 unknown，并留 early-report-wait(timeout)', async () => {
  assert.equal(EARLY_REPORT_WAIT_MS, 3000, '上限必须是 3000ms（唯一数字定义点在 runtime.js）');
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
  });
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-3' });
  guard.waitForReport = () => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, reason: 'timeout', report: null, waitedMs: 20 }), 20);
  });
  const { ctx } = makeCtx({ engine: makeEngine() });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, reportWaitMs: 20, now: () => 0,
  });
  await assert.doesNotReject(() => wiring.check({ id: 's1' }));
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'unknown');
  assert.equal(forced.compactionId, null);
  const wait = audit.entries.find((entry) => entry.event === 'early-report-wait');
  assert.ok(wait, '超时必须留一条诊断审计');
  assert.equal(wait.sessionId, 's1');
  assert.equal(wait.cycle, 'early-cycle-3');
  assert.equal(wait.reason, 'timeout');
  assert.equal(wait.waitedMs, 20);
  assert.deepEqual(Object.keys(wait).sort(), ['cycle', 'event', 'reason', 'sessionId', 'waitedMs'], '只记 id/毫秒，不记正文');
});

test('S1.1：过滤不匹配写 early-report-wait(mismatch)，仍写 unknown', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null },
  });
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-6' });
  // 别的会话抢先报告：落到 mismatch 而不是 timeout。
  guard.waitForReport = () => Promise.resolve({ ok: false, reason: 'mismatch', report: null, waitedMs: 7 });
  const { ctx } = makeCtx({ engine: makeEngine() });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await wiring.check({ id: 's1' });
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'unknown');
  assert.equal(forced.compactionId, null);
  const wait = audit.entries.find((entry) => entry.event === 'early-report-wait');
  assert.equal(wait.reason, 'mismatch');
  assert.equal(wait.waitedMs, 7);
  assert.equal(wait.cycle, 'early-cycle-6');
});

test('S1.1：报告 600ms 后才 resolve → wiring 仍写 committed + host compactionId', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null },
  });
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-7' });
  guard.markEarlyAccepted = () => {};
  guard.waitForReport = () => new Promise((resolve) => {
    setTimeout(() => resolve({
      ok: true,
      reason: 'none',
      waitedMs: 600,
      report: {
        compactionId: 'host-uuid-600',
        sessionId: 's1',
        cycle: 'early-cycle-7',
        compaction: 'committed',
        protection: 'ok',
        failures: [],
        reinjected: true,
      },
    }), 600);
  });
  const { ctx } = makeCtx({ engine: makeEngine() });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await wiring.check({ id: 's1' });
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'committed', '600ms 迟到也必须写成 committed');
  assert.equal(forced.compactionId, 'host-uuid-600');
  assert.equal(audit.entries.some((entry) => entry.event === 'early-report-wait'), false);
});

test('S1.1：waitForReport 抛错 → early-report-wait(error) + unknown，不抛给主流程', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
  });
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-8' });
  guard.markEarlyAccepted = () => {};
  guard.waitForReport = () => Promise.reject(new Error('wait exploded'));
  const { ctx } = makeCtx({ engine: makeEngine() });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await assert.doesNotReject(() => wiring.check({ id: 's1' }));
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'unknown');
  assert.equal(forced.compactionId, null, '不得抄 prevReport 的 old');
  const wait = audit.entries.find((entry) => entry.event === 'early-report-wait');
  assert.equal(wait.reason, 'error');
  assert.equal(wait.cycle, 'early-cycle-8');
  assert.equal(Number.isInteger(wait.waitedMs), true, `waitedMs 必须是整数毫秒，实际 ${wait.waitedMs}`);
  assert.equal(wait.waitedMs >= 0, true);
});

test('S1.1：ok=false 时即使带报告也不采用（以 ok 为准）', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null },
  });
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-9' });
  guard.waitForReport = () => Promise.resolve({
    ok: false,
    reason: 'timeout',
    report: {
      compactionId: 'host-uuid-half-baked',
      sessionId: 's1',
      cycle: 'early-cycle-9',
      compaction: 'committed',
      protection: 'ok',
      failures: [],
      reinjected: true,
    },
    waitedMs: 5,
  });
  const { ctx } = makeCtx({ engine: makeEngine() });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await wiring.check({ id: 's1' });
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'unknown', 'ok=false 不得因 report 非空就写 committed');
  assert.equal(forced.compactionId, null);
  assert.equal(audit.entries.find((entry) => entry.event === 'early-report-wait').reason, 'timeout');
});

test('S1：跨会话/跨 cycle 的报告不得写进本会话 early-forced', async () => {
  for (const fresh of [
    { compactionId: 'host-other-session', sessionId: 's2', cycle: 'early-cycle-4', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
    { compactionId: 'host-other-cycle', sessionId: 's1', cycle: 'early-cycle-other', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
  ]) {
    const guard = makeGuard({
      lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null },
    });
    guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-4' });
    guard.waitForReport = () => Promise.resolve(fresh);
    const { ctx } = makeCtx({ engine: makeEngine() });
    const audit = makeAudit();
    const wiring = wireEarlyCompaction({
      ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
    });
    await wiring.check({ id: 's1' });
    const forced = audit.entries.find((entry) => entry.event === 'early-forced');
    assert.equal(forced.compaction, 'unknown', JSON.stringify(fresh));
    assert.equal(forced.compactionId, null);
  }
});

test('S1：accepted=false 不等待报告，直接 early-aborted', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', sessionId: 's1', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
  });
  let waitCalls = 0;
  guard.preProtect = async () => ({ ok: true, cycleKey: 'early-cycle-5' });
  guard.discardEarlyProtection = async () => {};
  guard.waitForReport = () => {
    waitCalls += 1;
    return Promise.resolve(null);
  };
  const { ctx } = makeCtx({ engine: makeEngine('busy') });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await wiring.check({ id: 's1' });
  assert.equal(waitCalls, 0);
  assert.equal(audit.entries.at(-1).event, 'early-aborted');
});

test('S1：session/event handler 不 await 报告等待', () => {
  const { ctx, handlers } = makeCtx();
  const scheduled = [];
  const guard = makeGuard();
  guard.waitForReport = () => new Promise(() => {});
  const wiring = wireEarlyCompaction({
    ctx,
    getGuard: () => guard,
    getPolicy: () => POLICY,
    getArmed: () => true,
    schedule: (fn, ms) => { scheduled.push(ms); return 0; },
  });
  const handler = handlers.find((item) => item.event === 'session/event').handler;
  const returned = handler({ id: 's1' }, { type: 'turn/end' });
  assert.equal(returned, undefined);
  assert.deepEqual(scheduled, [EARLY_DELAY_MS]);
  wiring.stop();
});

test('0.2.2 接线：accepted 但无新报告 → compaction=unknown（B-2）、protection=null', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
  });
  const engine = makeEngine(); // resolve，但不产生新报告（guard.lastReport 不变）
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0 });
  await wiring.check({ id: 's1' });
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision', 'early-forced']);
  const forced = audit.entries[1];
  assert.equal(forced.accepted, true);
  assert.equal(forced.compaction, 'unknown', 'B-2：没有新报告必须写 unknown，不得写 committed');
  assert.equal(forced.compactionId, null, '不得抄 prevReport 的 old id');
  assert.equal(forced.protection, null, '没有新报告时必须写未知 null，不得写 ok');
  assert.deepEqual(forced.failures, []);
  assert.equal(forced.reinjected, null);
});

test('0.2.2 接线：busy → early-aborted；其他失败 → early-failed', async () => {
  const busyEngine = makeEngine('busy');
  const audit = makeAudit();
  const { ctx } = makeCtx({ engine: busyEngine });
  const guard = makeGuard({
    lastReport: { compactionId: 'old', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
  });
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0 });
  await wiring.check({ id: 's1' });
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision', 'early-aborted']);
  const aborted = audit.entries[1];
  assert.equal(aborted.compaction, 'failed', '不得抄上一轮的 committed');
  assert.equal(aborted.protection, null, '失败路径 protection 必须 null');
  assert.deepEqual(aborted.failures, []);
  assert.equal(aborted.reinjected, null);

  const failEngine = makeEngine('fail');
  const audit2 = makeAudit();
  const { ctx: ctx2 } = makeCtx({ engine: failEngine });
  const wiring2 = wireEarlyCompaction({ ctx: ctx2, getGuard: () => guard, getPolicy: () => POLICY, audit: audit2, getArmed: () => true, now: () => 0 });
  await wiring2.check({ id: 's1' });
  assert.deepEqual(audit2.entries.map((entry) => entry.event), ['early-decision', 'early-failed']);
  const failed = audit2.entries[1];
  assert.equal(failed.compaction, 'failed');
  assert.equal(failed.protection, null);
  assert.deepEqual(failed.failures, []);
  assert.equal(failed.reinjected, null);
});

test('0.2.2 接线：低于 at → early-skipped(below-threshold)，不调用', async () => {
  const engine = makeEngine();
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const guard = makeGuard({ measuredTokens: 500000, estimatedTokens: 300000 });
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0 });
  await wiring.check({ id: 's1' });
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision', 'early-skipped']);
  assert.equal(audit.entries[1].reason, 'below-threshold');
  assert.equal(engine.calls, 0);
  assert.equal(wiring.getLast().event, 'early-skipped');
  assert.equal(wiring.getLast().reason, 'below-threshold');
});

test('0.2.2 接线：冷却期内不重复压（cooldown）', async () => {
  const engine = makeEngine();
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  let clock = 0;
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => makeGuard(), getPolicy: () => POLICY, audit, getArmed: () => true, now: () => clock });
  await wiring.check({ id: 's1' });
  clock += 1000;
  await wiring.check({ id: 's1' });
  assert.equal(engine.calls, 1);
  const skipped = audit.entries.filter((entry) => entry.event === 'early-skipped');
  assert.equal(skipped.at(-1).reason, 'cooldown');
});

test('0.2.2 接线：只在 turn/end 后调度（armed=false 不排定时器）', () => {
  const scheduled = [];
  const { ctx, handlers } = makeCtx();
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => makeGuard(), getPolicy: () => POLICY, getArmed: () => true, schedule: (fn, ms) => { scheduled.push(ms); return 0; } });
  const handler = handlers.find((item) => item.event === 'session/event').handler;
  handler({ id: 's1' }, { type: 'assistant/message' });
  assert.equal(scheduled.length, 0);
  handler({ id: 's1' }, { type: 'turn/end' });
  assert.deepEqual(scheduled, [EARLY_DELAY_MS]);
  wiring.stop();

  const scheduled2 = [];
  const second = makeCtx();
  const wiring2 = wireEarlyCompaction({ ctx: second.ctx, getGuard: () => makeGuard(), getPolicy: () => POLICY, getArmed: () => false, schedule: (fn, ms) => { scheduled2.push(ms); return 0; } });
  second.handlers.find((item) => item.event === 'session/event').handler({ id: 's1' }, { type: 'turn/end' });
  assert.equal(scheduled2.length, 0, 'armed=false 不得排定时器');
  wiring2.stop();
});
