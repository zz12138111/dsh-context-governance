/**
 * 1b：profile 按会话（#7）——复用 1a 的 session registry，不另起存储。
 *
 * 覆盖：会话隔离、/cg status 显示本会话 profile 与来源、立即生效、reset 只清当前、
 * 缺会话标识拒绝且不写桶/不碰全局、非法档位拒绝、重启（进程内重建）回配置/默认、wiring 侧生效。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { wireEarlyCompaction } from '../src/compress/early-wiring.js';
import { buildPolicyState, resolveConfig } from '../src/index.js';

const SID_A = 'session-aaaaaaaa-0000-0000-0000-00000000000a';
const SID_B = 'session-bbbbbbbb-0000-0000-0000-00000000000b';

function makePolicy({ profile = '', values = {} } = {}) {
  const config = resolveConfig({
    projectRoot: 'D:/tmp/profile-scope',
    policy: {
      profile,
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

function makeCommand(state, audit) {
  return createStatusCommand({
    policy: state,
    audit,
    now: () => new Date('2026-10-26T00:00:00Z'),
  });
}

function makeWiring(state, audit) {
  const agents = [SID_A, SID_B].map((id) => ({ session: { id } }));
  const engine = { compactNow: async () => ({ accepted: true }) };
  const ctx = {
    on: () => () => {},
    get: (name) => {
      if (name === 'agents') return { list: () => agents };
      if (name === 'agentPresets') return { serviceFor: () => engine };
      return undefined;
    },
  };
  return wireEarlyCompaction({
    ctx,
    getGuard: () => ({
      pressureFor: (target) => ({ sessionId: target?.id ?? null, measuredTokens: 650_000, estimatedTokens: null }),
      status: {
        pressure: { measuredTokens: null, estimatedTokens: null },
        stats: { pending: 0 },
        lastReport: null,
      },
    }),
    getPolicy: (target) => state.resolve(target?.id ?? null),
    getArmed: (target) => state.resolve(target?.id ?? null).values['compact.early.armed'] === true,
    audit,
    now: () => 1_000_000,
    schedule: (fn) => { fn(); },
  });
}

test('1b：A=review 只影响 A（at=0.55），B 仍默认 0.60', async () => {
  const state = makePolicy();
  const command = makeCommand(state, makeAudit());
  const set = await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_A } } });
  assert.equal(set.kind, 'success');
  assert.match(set.text, /profile: review \(source=session\)/);

  assert.equal(state.resolve(SID_A).values['compact.at'], 0.55);
  assert.equal(state.resolve(SID_A).sources['compact.at'], 'profile=review');
  assert.equal(state.resolve(SID_B).values['compact.at'], 0.6);
  assert.equal(state.resolve(SID_B).sources['compact.at'], 'builtin');
  assert.deepEqual(state.sessionIds(), [SID_A]);
});

test('1b：A=research 时 A 的 early 总闸关闭，B 不受影响', async () => {
  const state = makePolicy();
  const command = makeCommand(state, makeAudit());
  await command.handler({ rawInput: 'profile research', agent: { session: { id: SID_A } } });
  assert.equal(state.resolve(SID_A).early, false, 'A 应 early=off (policy:research)');
  assert.equal(state.resolve(SID_B).early, true, 'B 仍 early=on');
});

test('1b：/cg status 显示本会话 profile 与来源（A=session，B=default）', async () => {
  const state = makePolicy();
  const command = makeCommand(state, makeAudit());
  await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_A } } });

  const a = await command.handler({ rawInput: 'status', agent: { session: { id: SID_A } } });
  assert.match(a.text, /profile: review \(source=session\)/);
  const b = await command.handler({ rawInput: 'status', agent: { session: { id: SID_B } } });
  assert.match(b.text, /profile: \(none\) \(source=default\)/);
  assert.doesNotMatch(b.text, /profile: review/);
});

test('1b：reset 只清当前会话，B 的 profile 不受影响', async () => {
  const state = makePolicy();
  const command = makeCommand(state, makeAudit());
  await command.handler({ rawInput: 'profile batch', agent: { session: { id: SID_A } } });
  await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_B } } });
  const reset = await command.handler({ rawInput: 'profile reset', agent: { session: { id: SID_A } } });
  assert.equal(reset.kind, 'success');
  assert.equal(state.profileInfo(SID_A).profile, '');
  assert.equal(state.resolve(SID_A).values['compact.at'], 0.6);
  assert.equal(state.profileInfo(SID_B).profile, 'review');
  assert.equal(state.resolve(SID_B).values['compact.at'], 0.55);
});

test('1b：缺会话标识 → 拒绝、不建桶、不写审计、不冒充全局', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  for (const rawInput of ['profile review', 'profile reset', 'profile status']) {
    const result = await command.handler({ rawInput });
    if (rawInput === 'profile status') {
      assert.equal(result.kind, 'success');
      assert.match(result.text, /session-level: unavailable \(no session id\)/);
    } else {
      assert.equal(result.kind, 'error', `${rawInput} 必须拒绝`);
      assert.match(result.text, /会话级不可用/);
    }
  }
  assert.deepEqual(state.sessionIds(), []);
  assert.equal(audit.list.length, 0);
  assert.equal(state.profileInfo(null).source, 'default');
});

test('1b：非法 profile 名拒绝、不写桶、不写审计（精确大小写）', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  for (const name of ['nope', 'Batch', 'REVIEW']) {
    const result = await command.handler({ rawInput: `profile ${name}`, agent: { session: { id: SID_A } } });
    assert.equal(result.kind, 'error', `${name} 必须拒绝`);
    assert.match(result.text, /未知档位/);
    assert.match(result.text, /batch, coding, review, research/, '错误文本必须带可用名清单');
  }
  assert.deepEqual(state.sessionIds(), []);
  assert.equal(audit.list.length, 0, '非法名不得写审计');
});

test('1b：profile 只是标签层——插件配置 compact.at=0.58 赢过 review 0.55', async () => {
  const state = makePolicy({ values: { 'compact.at': 0.58 } });
  const command = makeCommand(state, makeAudit());
  await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_A } } });
  assert.equal(state.resolve(SID_A).values['compact.at'], 0.58, '显式层（plugin）必须赢标签层');
  assert.equal(state.resolve(SID_A).sources['compact.at'], 'plugin');
});

test('1b：会话显式 /cg set compact.at=0.50 赢过 profile review', async () => {
  const state = makePolicy();
  const command = makeCommand(state, makeAudit());
  await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_A } } });
  const set = await command.handler({ rawInput: 'set compact.at=0.50', agent: { session: { id: SID_A } } });
  assert.equal(set.kind, 'success');
  assert.equal(state.resolve(SID_A).values['compact.at'], 0.50);
  assert.equal(state.resolve(SID_A).sources['compact.at'], 'session');
});

test('1b：/cg set profile= 仍按未知键拒绝（唯一入口是 /cg profile）', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  const result = await command.handler({ rawInput: 'set profile=review', agent: { session: { id: SID_A } } });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /未知键 profile/);
  assert.deepEqual(state.sessionIds(), [], '被拒的 set 不得留空桶');
  assert.equal(audit.list.length, 0);
});

test('1b：reset 后按生效值渲染（配置 profile=research 时不得硬编码 none）', async () => {
  const state = makePolicy({ profile: 'research' });
  const command = makeCommand(state, makeAudit());
  await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_A } } });
  const reset = await command.handler({ rawInput: 'profile reset', agent: { session: { id: SID_A } } });
  assert.equal(reset.kind, 'success');
  assert.match(reset.text, /profile: research \(source=config\)/, '清除会话后应回配置 profile，不是 none');
  assert.equal(state.profileInfo(SID_A).profile, 'research');
});

test('1b：不持久——进程内重建后回配置/默认', async () => {
  const first = makePolicy();
  const command = makeCommand(first, makeAudit());
  await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_A } } });
  assert.equal(first.resolve(SID_A).values['compact.at'], 0.55);

  const second = makePolicy();
  assert.deepEqual(second.sessionIds(), []);
  assert.equal(second.profileInfo(SID_A).source, 'default');
  assert.equal(second.resolve(SID_A).values['compact.at'], 0.6);
});

test('1b：配置 profile 作为全局默认（source=config），会话覆盖仍优先', async () => {
  const state = makePolicy({ profile: 'coding' });
  const command = makeCommand(state, makeAudit());
  const b = await command.handler({ rawInput: 'status', agent: { session: { id: SID_B } } });
  assert.match(b.text, /profile: coding \(source=config\)/);

  await command.handler({ rawInput: 'profile review', agent: { session: { id: SID_A } } });
  assert.equal(state.profileInfo(SID_A).profile, 'review');
  assert.equal(state.profileInfo(SID_A).source, 'session');
  assert.equal(state.profileInfo(SID_B).profile, 'coding');
  assert.equal(state.profileInfo(SID_B).source, 'config');
});

test('1b：wiring 按会话生效——A=research 静默，B 仍决策', async () => {
  const state = makePolicy();
  const audit = makeAudit();
  const command = makeCommand(state, audit);
  await command.handler({ rawInput: 'profile research', agent: { session: { id: SID_A } } });
  audit.list.length = 0;

  const wiring = makeWiring(state, audit);
  await wiring.check({ id: SID_A });
  assert.equal(audit.list.filter((entry) => entry.event === 'early-decision').length, 0, 'A 的 early 总闸关闭，必须静默');

  await wiring.check({ id: SID_B });
  const decisions = audit.list.filter((entry) => entry.event === 'early-decision');
  assert.equal(decisions.length, 1, 'B 不受 A 的 profile 影响');
  assert.equal(decisions[0].sessionId, SID_B);
  assert.equal(decisions[0].action, 'force');
});
