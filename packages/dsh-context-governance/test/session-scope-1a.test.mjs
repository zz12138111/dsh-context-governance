/**
 * 1a：真会话级分桶 + 压力按发起会话 + 死键接线 + B-4（审计全/短 id、空 id 拒绝）。
 *
 * 覆盖审核红线要求的五项：双会话 A/B 隔离、disarm 只影响 A、空 id 拒绝且不写桶、
 * 进程内重建清空、审计同时有全 id 与短 id。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { wireEarlyCompaction } from '../src/compress/early-wiring.js';
import { buildPolicyState, resolveConfig } from '../src/index.js';
import { shortSessionId } from '../src/policy.js';

const SID_A = 'session-aaaaaaaa-0000-0000-0000-000000000001';
const SID_B = 'session-bbbbbbbb-0000-0000-0000-000000000002';

function makePolicy(values = {}) {
  const config = resolveConfig({
    projectRoot: 'D:/tmp/session-scope',
    policy: {
      windowTokens: 1_000_000,
      reservedTokens: 256_000,
      values,
    },
  });
  const state = buildPolicyState(config, {
    readFile: () => {
      const error = new Error('missing project policy file');
      error.code = 'ENOENT';
      throw error;
    },
  });
  state.setWindowProvider(() => ({
    current: { sessionId: SID_A, tokens: 1_000_000, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: null,
    observed: [],
    source: 'projection',
    removed: false,
  }));
  return state;
}

function makeAudit() {
  const list = [];
  return { list, append(event, details) { list.push({ event, ...details }); }, entries() { return list; } };
}

function session(id) {
  return { id };
}

function makeGuard({ bySession = null, statusPressure = null } = {}) {
  return {
    pressureFor: (target) => (bySession === null
      ? { sessionId: target?.id ?? null, measuredTokens: null, estimatedTokens: null }
      : bySession(target)),
    status: {
      pressure: statusPressure ?? { measuredTokens: null, estimatedTokens: null },
      stats: { pending: 0 },
      lastReport: null,
    },
  };
}

function makeWiring({ state, guard, audit, clock }) {
  const agents = [session(SID_A), session(SID_B)].map((target) => ({ session: target }));
  const engine = { compactNow: async () => ({ accepted: true }) };
  const ctx = {
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => agents };
      if (name === 'agentPresets') {
        return { serviceFor: (agent) => (agent === null || agent === undefined ? null : engine) };
      }
      return undefined;
    },
  };
  return wireEarlyCompaction({
    ctx,
    getGuard: () => guard,
    getPolicy: (target) => state.resolve(target?.id ?? null),
    getArmed: (target) => state.resolve(target?.id ?? null).values['compact.early.armed'] === true,
    audit,
    now: () => clock.now,
    schedule: (fn) => { fn(); },
  });
}

function makeCommand(state, audit) {
  return createStatusCommand({
    policy: state,
    audit,
    now: () => new Date('2026-10-26T00:00:00Z'),
  });
}

test('1a：/cg set 只写当前会话（A 设了 B 不受影响）', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  const set = await command.handler({ rawInput: 'set compact.at=0.55', agent: { session: { id: SID_A } } });
  assert.equal(set.kind, 'success');
  assert.equal(state.resolve(SID_A).values['compact.at'], 0.55);
  assert.equal(state.resolve(SID_B).values['compact.at'], 0.6);
  assert.equal(state.resolve(SID_B).sources['compact.at'], 'builtin');
  assert.deepEqual(state.sessionIds(), [SID_A]);
});

test('1a：/cg compact disarm 只关 A；审计同时带全 id 与短 id', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  const off = await command.handler({ rawInput: 'compact disarm', agent: { session: { id: SID_A } } });
  assert.equal(off.kind, 'success');
  assert.equal(state.resolve(SID_A).values['compact.early.armed'], false);
  assert.equal(state.resolve(SID_B).values['compact.early.armed'], true);

  const disarmed = audit.list.find((entry) => entry.event === 'early-disarmed');
  assert.equal(disarmed.sessionId, SID_A, 'sessionId 写全 id（与 early-forced 一致）');
  assert.equal(disarmed.sessionShortId, shortSessionId(SID_A), 'sessionShortId 复用 policy.shortSessionId');
  assert.equal(disarmed.sessionShortId, 'aaaaaaaa');
});

test('1a：disarm 只影响 A —— wiring 对 A 静默、对 B 仍决策', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  await command.handler({ rawInput: 'compact disarm', agent: { session: { id: SID_A } } });
  audit.list.length = 0;

  const guard = makeGuard({
    bySession: (target) => ({ sessionId: target.id, measuredTokens: 650_000, estimatedTokens: null }),
  });
  const wiring = makeWiring({ state, guard, audit, clock: { now: 1_000_000 } });

  await wiring.check(session(SID_A));
  assert.equal(audit.list.filter((entry) => entry.event === 'early-decision').length, 0, 'A 已 disarm，必须完全静默');

  await wiring.check(session(SID_B));
  const decisions = audit.list.filter((entry) => entry.event === 'early-decision');
  assert.equal(decisions.length, 1, 'B 未 disarm，应产生决策');
  assert.equal(decisions[0].sessionId, SID_B);
  assert.equal(decisions[0].action, 'force');
  assert.equal(decisions[0].effective, 0.65);
});

test('1a：set reset 只清当前会话', async () => {
  const state = makePolicy();
  const command = makeCommand(state, makeAudit());
  await command.handler({ rawInput: 'set compact.at=0.55', agent: { session: { id: SID_A } } });
  await command.handler({ rawInput: 'set compact.at=0.57', agent: { session: { id: SID_B } } });
  const reset = await command.handler({ rawInput: 'set reset', agent: { session: { id: SID_A } } });
  assert.equal(reset.kind, 'success');
  assert.equal(state.resolve(SID_A).values['compact.at'], 0.6, 'A 回到内置');
  assert.equal(state.resolve(SID_B).values['compact.at'], 0.57, 'B 不受影响');
});

test('1a：无会话标识 → 三类命令都拒绝，且不写桶、不写审计', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  for (const rawInput of ['set compact.at=0.55', 'compact disarm', 'header off']) {
    const result = await command.handler({ rawInput });
    assert.equal(result.kind, 'error', `${rawInput} 必须拒绝`);
    assert.match(result.text, /会话级不可用/);
  }
  assert.deepEqual(state.sessionIds(), [], '空 id 不得建桶');
  assert.equal(audit.list.length, 0, '空 id 不得写任何审计');
  const status = await command.handler({ rawInput: 'status' });
  assert.match(status.text, /policy-session: unavailable \(no session id\)/);
});

test('1a：进程内重建（重启语义）清空覆盖', async () => {
  const first = makePolicy();
  const command = makeCommand(first, makeAudit());
  await command.handler({ rawInput: 'set compact.at=0.55', agent: { session: { id: SID_A } } });
  assert.equal(first.resolve(SID_A).values['compact.at'], 0.55);

  const second = makePolicy();
  assert.deepEqual(second.sessionIds(), [], '重建后没有会话桶');
  assert.equal(second.resolve(SID_A).values['compact.at'], 0.6, '重启后回到内置');
});

test('1a：压力按发起会话取（pressureFor），不回落到全局 status.pressure', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const guard = makeGuard({
    bySession: (target) => ({
      sessionId: target.id,
      measuredTokens: target.id === SID_A ? 650_000 : 100_000,
      estimatedTokens: null,
    }),
    statusPressure: { measuredTokens: 990_000, estimatedTokens: null },
  });
  const wiring = makeWiring({ state, guard, audit, clock: { now: 1_000_000 } });

  await wiring.check(session(SID_A));
  await wiring.check(session(SID_B));
  const decisions = audit.list.filter((entry) => entry.event === 'early-decision');
  const byId = new Map(decisions.map((entry) => [entry.sessionId, entry]));
  assert.equal(byId.get(SID_A).effective, 0.65, 'A 用自己的压力');
  assert.equal(byId.get(SID_A).action, 'force');
  assert.equal(byId.get(SID_B).effective, 0.1, 'B 用自己的压力，不取全局 0.99');
  assert.equal(byId.get(SID_B).action, 'skip');
  assert.equal(byId.get(SID_B).reason, 'below-threshold');
});

test('1a：compact.cooldownMin 真消费（30s 冷却跳过、61s 不再以 cooldown 跳过）', async () => {
  const state = makePolicy({ 'compact.cooldownMin': 1 });
  const audit = makeAudit();
  const clock = { now: 1_000_000 };
  const guard = makeGuard({
    bySession: (target) => ({ sessionId: target.id, measuredTokens: 650_000, estimatedTokens: null }),
  });
  const wiring = makeWiring({ state, guard, audit, clock });

  await wiring.check(session(SID_A));
  assert.equal(audit.list.filter((entry) => entry.event === 'early-decision').at(-1).action, 'force');

  clock.now += 30_000;
  await wiring.check(session(SID_A));
  assert.equal(audit.list.filter((entry) => entry.event === 'early-skipped').at(-1).reason, 'cooldown');

  clock.now += 31_000;
  await wiring.check(session(SID_A));
  const last = audit.list.filter((entry) => entry.event === 'early-skipped').at(-1);
  assert.equal(last.reason, 'min-delta', '61s 后已过 1 分钟冷却，改由增量门槛挡住');
});

test('1a：compact.minDeltaTokens 真消费（1M 窗口下 2 万 tokens = 2pp）', async () => {
  const state = makePolicy({ 'compact.cooldownMin': 1 });
  const audit = makeAudit();
  const clock = { now: 1_000_000 };
  let tokens = 620_000;
  const guard = makeGuard({
    bySession: (target) => ({ sessionId: target.id, measuredTokens: tokens, estimatedTokens: null }),
  });
  const wiring = makeWiring({ state, guard, audit, clock });

  await wiring.check(session(SID_A));
  assert.equal(audit.list.filter((entry) => entry.event === 'early-decision').at(-1).action, 'force');

  tokens = 625_000; // +0.5pp < 2pp
  clock.now += 61_000;
  await wiring.check(session(SID_A));
  assert.equal(audit.list.filter((entry) => entry.event === 'early-skipped').at(-1).reason, 'min-delta');

  tokens = 645_000; // +2.5pp（相对首次 0.62）≥ 2pp
  clock.now += 61_000;
  await wiring.check(session(SID_A));
  assert.equal(audit.list.filter((entry) => entry.event === 'early-decision').at(-1).action, 'force');
});
