/**
 * M3 T2（0.3.1）header 专项用例：配额边界、[Old] 边界、子会话三判据、审计字段、/cg header off。
 * 用轻量 fake store（只依赖 allEntries）把条目时间完全控制在测试里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { buildPolicyState, resolveConfig } from '../src/index.js';
import { buildMemoryHeader, registerMemoryHeader } from '../src/memory/header.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1);

function entry(id, type, title, ageDays = 0) {
  const stamp = new Date(NOW - ageDays * DAY).toISOString();
  return { id, type, title, status: 'active', createdAt: stamp, updatedAt: stamp };
}

function fakeStore(entries) {
  return { allEntries: () => entries.map((item) => ({ ...item })) };
}

test('T2 配额边界：刚好 2/2/2/1/1 不截断；多 1 条截最旧并写 conflicts', () => {
  const entries = [
    entry('MEM-t1', 'todo', 'todo-新', 0),
    entry('MEM-t2', 'todo', 'todo-中', 1),
    entry('MEM-t3', 'todo', 'todo-旧', 2),
    entry('MEM-p1', 'progress', 'progress-1'),
    entry('MEM-p2', 'progress', 'progress-2'),
    entry('MEM-d1', 'decision', 'decision-1'),
    entry('MEM-d2', 'decision', 'decision-2'),
    entry('MEM-a1', 'anchor', 'anchor-1'),
    entry('MEM-f1', 'preference', 'pref-1'),
  ];
  const header = buildMemoryHeader(fakeStore(entries), { hasRuleFile: false, now: NOW });
  assert.ok(header);
  assert.equal(header.dropped, 1, '多 1 条 todo 应被截断');
  assert.match(header.text, /conflicts: 1 条被配额截断/);
  assert.equal(header.count, 8, '截断后正好 8 行（2+2+2+1+1）');
  assert.ok(!header.ids.includes('MEM-t3'), '应截最旧的 todo');
});

test('T2 [Old] 边界：恰好 14 天仍注入；30 天标 [Old] 且排末尾；oldLimit=0 时不注入旧条目', () => {
  const entries = [
    entry('MEM-new', 'decision', 'new', 0),
    entry('MEM-14d', 'decision', 'exact-14d', 14),
    entry('MEM-30d', 'anchor', 'old-30d', 30),
  ];
  const header = buildMemoryHeader(fakeStore(entries), { hasRuleFile: true, now: NOW });
  assert.ok(header);
  assert.match(header.text, /exact-14d/);
  assert.doesNotMatch(header.text, /\[Old\].*exact-14d/);
  assert.match(header.text, /\[Old\].*old-30d/);
  assert.ok(header.text.indexOf('old-30d') > header.text.indexOf('exact-14d'), '[Old] 必须排末尾');

  const limited = buildMemoryHeader(fakeStore(entries), { hasRuleFile: true, now: NOW, oldLimit: 0 });
  assert.ok(limited === null || !limited.ids.includes('MEM-30d'), 'oldLimit=0 时旧条目不得注入');
});

test('T2 子会话三判据各自单独命中（不是只测组合）', async () => {
  const store = fakeStore([entry('MEM-d1', 'decision', '需要注入')]);
  const variants = [
    { payload: { agent: { session: { id: 's1' }, parent: {} }, step: 1 }, label: 'agent.parent' },
    { payload: { agent: { session: { id: 's2' }, isSubagent: true }, step: 1 }, label: 'agent.isSubagent' },
    { payload: { agent: { session: { id: 's3', header: { parentSessionId: 'parent-1' } } }, step: 1 }, label: 'header.parentSessionId' },
  ];
  for (const { payload, label } of variants) {
    const handlers = [];
    const ctx = { on: (event, handler) => { handlers.push({ event, handler }); return () => {}; }, logger: { warn: () => {} } };
    registerMemoryHeader(ctx, store, { enabled: true, hasRuleFile: true, now: NOW });
    const handler = handlers.find((item) => item.event === 'agent/pre-step').handler;
    const decision = await handler(payload, async () => ({ kind: 'accept', messages: [] }));
    assert.equal(decision.messages.length, 0, `${label} 必须单独触发跳过`);
  }
});

test('T2 header-injected：五个字段都有真实值，mode 区分两形态', async () => {
  const store = fakeStore([
    entry('MEM-d1', 'decision', '规则在场时的状态'),
    entry('MEM-f1', 'preference', '无规则时的偏好'),
  ]);
  const run = async (hasRuleFile) => {
    const captured = [];
    const handlers = [];
    const ctx = { on: (event, handler) => { handlers.push({ event, handler }); return () => {}; }, logger: { warn: () => {} } };
    registerMemoryHeader(ctx, store, { enabled: true, hasRuleFile, now: NOW, onInjected: (built) => captured.push(built) });
    const handler = handlers.find((item) => item.event === 'agent/pre-step').handler;
    await handler(
      { agent: { session: { id: `session-${hasRuleFile}` } }, step: 1 },
      async () => ({ kind: 'accept', messages: [] }),
    );
    return captured[0];
  };
  const stateOnly = await run(true);
  const withPref = await run(false);
  assert.equal(stateOnly.mode, 'state-only');
  assert.equal(withPref.mode, 'state-only+preference');
  assert.equal(stateOnly.count, 1);
  assert.equal(withPref.count, 2, 'state-only+preference 应含偏好 1 行');
  for (const built of [stateOnly, withPref]) {
    assert.ok(built.count > 0);
    assert.equal(built.ids.length, built.count);
    assert.ok(built.text.length > 0);
    assert.ok(Math.ceil(built.text.length / 4) > 0, 'tokensInjected 估算必须 > 0');
  }
});

test('T2 /cg header off 后完全不注入（不是空包裹）', async () => {
  const store = fakeStore([entry('MEM-d1', 'decision', '关掉后不得出现')]);
  const config = resolveConfig({ projectRoot: 'D:/tmp/header-off', policy: {} });
  const state = buildPolicyState(config, { readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } });
  const handlers = [];
  const ctx = { on: (event, handler) => { handlers.push({ event, handler }); return () => {}; }, logger: { warn: () => {} } };
  registerMemoryHeader(ctx, store, {
    enabled: true,
    hasRuleFile: true,
    now: NOW,
    isEnabled: () => state.resolve().values['header.enabled'] !== false,
  });
  const handler = handlers.find((item) => item.event === 'agent/pre-step').handler;
  const command = createStatusCommand({ policy: state, now: () => new Date('2026-10-26T00:00:00Z') });
  const off = await command.handler({ rawInput: 'header off' });
  assert.equal(off.kind, 'success');
  assert.match(off.text, /header: off/);
  const decision = await handler({ agent: { session: { id: 'session-off' } }, step: 1 }, async () => ({ kind: 'accept', messages: [] }));
  assert.equal(decision.messages.length, 0, 'off 后必须完全不注入');
});
