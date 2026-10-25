/**
 * 0.2.2 第 5 步：early 接线单测（`turn/end` 门禁 + `early-*` 审计）。
 * 全部用 fake ctx/guard/policy/engine；不碰宿主。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EARLY_DELAY_MS, wireEarlyCompaction } from '../src/compress/early-wiring.js';

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
  const engine = makeEngine();
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const lastReport = { compaction: 'committed', protection: 'failed', failures: [{ name: 'latest-user-message' }], reinjected: true };
  const guard = makeGuard({ lastReport });
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0 });
  await wiring.check({ id: 's1' });
  assert.equal(engine.calls, 1);
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision', 'early-forced']);
  const forced = audit.entries[1];
  assert.equal(forced.accepted, true);
  assert.equal(forced.compaction, 'committed');
  assert.equal(forced.protection, 'failed');
  assert.deepEqual(forced.failures, ['latest-user-message']);
  assert.equal(forced.reinjected, true);
  assert.equal(forced.delayMs, EARLY_DELAY_MS);
});

test('0.2.2 接线：busy → early-aborted；其他失败 → early-failed', async () => {
  const busyEngine = makeEngine('busy');
  const audit = makeAudit();
  const { ctx } = makeCtx({ engine: busyEngine });
  const guard = makeGuard({ lastReport: { compaction: 'committed', protection: 'ok', failures: [], reinjected: null } });
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0 });
  await wiring.check({ id: 's1' });
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision', 'early-aborted']);

  const failEngine = makeEngine('fail');
  const audit2 = makeAudit();
  const { ctx: ctx2 } = makeCtx({ engine: failEngine });
  const wiring2 = wireEarlyCompaction({ ctx: ctx2, getGuard: () => guard, getPolicy: () => POLICY, audit: audit2, getArmed: () => true, now: () => 0 });
  await wiring2.check({ id: 's1' });
  assert.deepEqual(audit2.entries.map((entry) => entry.event), ['early-decision', 'early-failed']);
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

test('0.2.2 接线：只在 turn/end 后调度（其他事件不排）', () => {
  const { ctx, handlers } = makeCtx();
  const scheduled = [];
  const wiring = wireEarlyCompaction({ ctx, getGuard: () => makeGuard(), getPolicy: () => POLICY, getArmed: () => false, schedule: (fn, ms) => { scheduled.push(ms); return 0; } });
  const handler = handlers.find((item) => item.event === 'session/event').handler;
  handler({ id: 's1' }, { type: 'assistant/message' });
  assert.equal(scheduled.length, 0);
  handler({ id: 's1' }, { type: 'turn/end' });
  assert.deepEqual(scheduled, [EARLY_DELAY_MS]);
  wiring.stop();
});
