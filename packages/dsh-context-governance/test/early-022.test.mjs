/**
 * 0.2.2 骨架单测（复核后）：async 契约 / safe timing / busy 映射 / 三参对齐 / ask-deny。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EARLY_SKIP_REASONS, EarlyCompactor, isBusyCompactionError, preExecuteAsk, preExecuteDeny, shouldEscalateEarly } from '../src/compress/early.js';

function asyncEngine(mode = 'resolve') {
  const calls = [];
  return {
    calls,
    async compactNow(agent, signal, sourceCommandId) {
      calls.push({ agent, signal, sourceCommandId });
      if (mode === 'busy') {
        const error = new Error('compaction engine is busy: current turn not idle');
        error.name = 'ManualCompactionError';
        throw error;
      }
      if (mode === 'reject') throw new Error('provider exploded');
      return undefined;
    },
  };
}

test('0.2.2 默认不执行：armed=false 时连引擎都不取', async () => {
  let engineTaken = 0;
  const compactor = new EarlyCompactor({ getEngine: () => { engineTaken += 1; return asyncEngine(); } });
  const result = await compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.deepEqual(result, { accepted: false, reason: EARLY_SKIP_REASONS.DISABLED });
  assert.equal(engineTaken, 0);
});

test('0.2.2 safe timing：turn 未结束 / agent 非 idle 都不调用 compactNow', async () => {
  const fake = asyncEngine();
  const compactor = new EarlyCompactor({ getEngine: () => fake, armed: true });
  assert.equal((await compactor.attempt({ turnEnded: false, agentIdle: true })).reason, EARLY_SKIP_REASONS.NOT_IDLE);
  assert.equal((await compactor.attempt({ turnEnded: true, agentIdle: false })).reason, EARLY_SKIP_REASONS.NOT_IDLE);
  assert.equal((await compactor.attempt({})).reason, EARLY_SKIP_REASONS.NOT_IDLE);
  assert.equal(fake.calls.length, 0, 'turn 中绝不试探引擎');
});

test('0.2.2 三参对齐：compactNow(agent, signal, sourceCommandId)，成功 await 后 ok', async () => {
  const fake = asyncEngine();
  const compactor = new EarlyCompactor({ getEngine: () => fake, armed: true });
  const agent = { id: 'agent-1' };
  const signal = new AbortController().signal;
  const result = await compactor.attempt({ agent, signal, sourceCommandId: 'cmd-9', turnEnded: true, agentIdle: true });
  assert.deepEqual(result, { accepted: true });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].agent, agent);
  assert.equal(fake.calls[0].signal, signal);
  assert.equal(fake.calls[0].sourceCommandId, 'cmd-9');
});

test('0.2.2 G2 busy（async reject）：reason=busy，不抛宿主、不 unhandled', async () => {
  const compactor = new EarlyCompactor({ getEngine: () => asyncEngine('busy'), armed: true });
  const result = await compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, EARLY_SKIP_REASONS.BUSY);
  const error = new Error('compaction engine is busy');
  error.name = 'ManualCompactionError';
  assert.equal(isBusyCompactionError(error), true);
  assert.equal(isBusyCompactionError(new Error('boom')), false);
});

test('0.2.2 其他 async 失败：reason=failed + logger，不抛', async () => {
  const logs = [];
  const compactor = new EarlyCompactor({ getEngine: () => asyncEngine('reject'), armed: true, logger: { warn: (line) => logs.push(line) } });
  const result = await compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.equal(result.reason, EARLY_SKIP_REASONS.FAILED);
  assert.ok(logs.some((line) => line.includes('provider exploded')));
});

test('0.2.2 引擎缺失 → no-engine（不猜、不降级）', async () => {
  const compactor = new EarlyCompactor({ getEngine: () => null, armed: true });
  assert.equal((await compactor.attempt({ turnEnded: true, agentIdle: true })).reason, EARLY_SKIP_REASONS.NO_ENGINE);
});

test('0.2.2 P3-1：宿主真实 idle 文案 / 小写 code 识别为 busy（G2-B 实测）', () => {
  const real = new Error('manual compaction requires an idle agent with no waking queued work');
  real.name = 'ManualCompactionError';
  real.code = 'busy';
  assert.equal(isBusyCompactionError(real), true);

  const codeOnly = new Error('engine rejected');
  codeOnly.code = 'Busy';
  assert.equal(isBusyCompactionError(codeOnly), true);

  const nameAndMessageOnly = new Error('manual compaction requires an idle agent with no waking queued work');
  nameAndMessageOnly.name = 'ManualCompactionError';
  assert.equal(isBusyCompactionError(nameAndMessageOnly), true);

  const unrelated = new Error('summary model returned empty');
  unrelated.name = 'ManualCompactionError';
  assert.equal(isBusyCompactionError(unrelated), false, '不含 idle/busy 的 ManualCompactionError 仍归 failed');
});

test('0.2.2 P3-1 回归：attempt 对 G2-B 真实文案返回 busy 而非 failed', async () => {
  const engine = {
    async compactNow() {
      const error = new Error('manual compaction requires an idle agent with no waking queued work');
      error.name = 'ManualCompactionError';
      error.code = 'busy';
      throw error;
    },
  };
  const compactor = new EarlyCompactor({ getEngine: () => engine, armed: true });
  const result = await compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.deepEqual(result, { accepted: false, reason: EARLY_SKIP_REASONS.BUSY });
});

test('0.2.2 升级判据：protection 失败不升级，compaction 失败/回注失败才升级', () => {
  assert.equal(shouldEscalateEarly({ compaction: 'committed', protection: 'failed', reinjected: true }), false);
  assert.equal(shouldEscalateEarly({ compaction: 'committed', protection: 'ok', reinjected: true }), false);
  assert.equal(shouldEscalateEarly({ compaction: 'skipped', protection: 'failed', reinjected: true }), false);
  assert.equal(shouldEscalateEarly({ compaction: 'failed', protection: 'ok', reinjected: true }), true);
  assert.equal(shouldEscalateEarly({ compaction: 'committed', protection: 'ok', reinjected: false }), true);
});

test('0.2.2 P3-1 第二句：同步 busy 文案 already has active work → busy（无 idle/code）', async () => {
  const syncError = new Error('agent "agent-7" already has active work');
  assert.equal(isBusyCompactionError(syncError), true, '同步路径（无 code/idle）必须命中');

  const engine = {
    async compactNow() {
      throw new Error('agent "agent-7" already has active work');
    },
  };
  const compactor = new EarlyCompactor({ getEngine: () => engine, armed: true });
  const result = await compactor.attempt({ turnEnded: true, agentIdle: true });
  assert.deepEqual(result, { accepted: false, reason: EARLY_SKIP_REASONS.BUSY });

  const unrelated = new Error('agent has active work but not compaction');
  assert.equal(isBusyCompactionError(unrelated), false, '缺少 already/requires idle 文案时仍归 failed');
});

test('0.2.2 ask/deny 语义：pre-execute 决策形状正确', () => {
  assert.deepEqual(preExecuteAsk(), { kind: 'ask', reason: 'context-governance requires confirmation' });
  assert.deepEqual(preExecuteDeny('rm -rf outside whitelist'), { kind: 'deny', reason: 'rm -rf outside whitelist' });
});
