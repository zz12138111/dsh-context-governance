/**
 * 0.2.2 骨架单测：safe timing / busy 映射 / 默认不执行 / ask-deny 语义。
 * 不开真调压缩：所有成功路径都用 fake engine。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EARLY_SKIP_REASONS, EarlyCompactor, isBusyCompactionError, preExecuteAsk, preExecuteDeny } from '../src/compress/early.js';

function engine() {
  const calls = [];
  return {
    calls,
    compactNow(session) { calls.push(session ?? null); },
  };
}

function busyError() {
  const error = new Error('compaction engine is busy: current turn not idle');
  error.name = 'ManualCompactionError';
  return error;
}

test('0.2.2 默认不执行：armed=false 时连引擎都不取', () => {
  let engineTaken = 0;
  const compactor = new EarlyCompactor({ getEngine: () => { engineTaken += 1; return engine(); } });
  const result = compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.deepEqual(result, { ok: false, reason: EARLY_SKIP_REASONS.DISABLED });
  assert.equal(engineTaken, 0);
});

test('0.2.2 safe timing：turn 未结束 / agent 非 idle 都不调用 compactNow', () => {
  const fake = engine();
  const compactor = new EarlyCompactor({ getEngine: () => fake, armed: true });
  assert.equal(compactor.attempt({ turnEnded: false, agentIdle: true }).reason, EARLY_SKIP_REASONS.NOT_IDLE);
  assert.equal(compactor.attempt({ turnEnded: true, agentIdle: false }).reason, EARLY_SKIP_REASONS.NOT_IDLE);
  assert.equal(compactor.attempt({}).reason, EARLY_SKIP_REASONS.NOT_IDLE);
  assert.equal(fake.calls.length, 0, 'turn 中绝不试探引擎');
});

test('0.2.2 成功路径：turn 结束 + idle → 调用一次 compactNow', () => {
  const fake = engine();
  const compactor = new EarlyCompactor({ getEngine: () => fake, armed: true });
  const result = compactor.attempt({ session: { id: 's1' }, turnEnded: true, agentIdle: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].id, 's1');
});

test('0.2.2 G2 busy：ManualCompactionError(busy) → reason=busy，不抛宿主', () => {
  const compactor = new EarlyCompactor({
    getEngine: () => ({ compactNow() { throw busyError(); } }),
    armed: true,
  });
  const result = compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, EARLY_SKIP_REASONS.BUSY);
  assert.equal(isBusyCompactionError(busyError()), true);
  assert.equal(isBusyCompactionError(new Error('boom')), false);
});

test('0.2.2 其他失败：捕获后 reason=failed、留给 logger，不抛', () => {
  const logs = [];
  const compactor = new EarlyCompactor({
    getEngine: () => ({ compactNow() { throw new Error('provider exploded'); } }),
    armed: true,
    logger: { warn: (line) => logs.push(line) },
  });
  const result = compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.equal(result.reason, EARLY_SKIP_REASONS.FAILED);
  assert.ok(logs.some((line) => line.includes('provider exploded')));
});

test('0.2.2 引擎缺失 → no-engine（不猜、不降级）', () => {
  const compactor = new EarlyCompactor({ getEngine: () => null, armed: true });
  assert.equal(compactor.attempt({ turnEnded: true, agentIdle: true }).reason, EARLY_SKIP_REASONS.NO_ENGINE);
});

test('0.2.2 ask/deny 语义：pre-execute 决策形状正确', () => {
  assert.deepEqual(preExecuteAsk(), { kind: 'ask', reason: 'context-governance requires confirmation' });
  assert.deepEqual(preExecuteDeny('rm -rf outside whitelist'), { kind: 'deny', reason: 'rm -rf outside whitelist' });
});
