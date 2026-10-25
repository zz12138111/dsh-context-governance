/**
 * 0.2.4 T4：三层回退都必须能证明「0 触发」（compactNow 调用计数为 0）。
 * 这里用真实 policy 合成 + wiring，不碰宿 主。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { wireEarlyCompaction } from '../src/compress/early-wiring.js';
import { resolvePolicy } from '../src/policy.js';

function makeCtx(engine) {
  return {
    on: () => () => {},
    get: (service) => {
      if (service === 'agents') return { list: () => [{ session: { id: 's1' } }] };
      if (service === 'agentPresets') return { serviceFor: () => engine };
      return null;
    },
  };
}

function makeGuard() {
  return { status: { pressure: { measuredTokens: 680000, estimatedTokens: 400000 }, stats: { pending: 0 }, lastReport: null } };
}

function makeEngine() {
  return { calls: 0, async compactNow() { this.calls += 1; } };
}

test('0.2.4 T4-①：会话 disarm → wiring 0 调用、0 early-forced', async () => {
  const engine = makeEngine();
  const session = { source: 'session', values: { 'compact.early.armed': false } };
  const policy = resolvePolicy([session], { native: 0.6934 });
  assert.equal(policy.earlyArmed, false);
  assert.equal(policy.armedSource, 'session');
  const audit = { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
  const wiring = wireEarlyCompaction({
    ctx: makeCtx(engine),
    getGuard: makeGuard,
    getPolicy: () => policy,
    getArmed: () => policy.earlyArmed === true,
    audit,
    now: () => 0,
  });
  await wiring.check({ id: 's1' });
  assert.equal(engine.calls, 0, 'compactNow 调用计数必须为 0');
  assert.equal(audit.entries.filter((entry) => entry.event === 'early-forced').length, 0);
});

test('0.2.4 T4-②：配置 compact.early.armed=false（加载后）→ 0 调用、status 显示 config', async () => {
  const engine = makeEngine();
  const plugin = { source: 'plugin', values: { 'compact.early.armed': false } };
  const policy = resolvePolicy([plugin], { native: 0.6934 });
  assert.equal(policy.earlyArmed, false);
  assert.equal(policy.armedSource, 'plugin');
  const wiring = wireEarlyCompaction({
    ctx: makeCtx(engine),
    getGuard: makeGuard,
    getPolicy: () => policy,
    getArmed: () => policy.earlyArmed === true,
    now: () => 0,
  });
  await wiring.check({ id: 's1' });
  assert.equal(engine.calls, 0);
});

test('0.2.4 T4-③：profile research（compact.early=false）→ 0 调用，优先于 armed', async () => {
  const engine = makeEngine();
  const profile = { source: 'profile=research', values: { 'compact.early': false } };
  const policy = resolvePolicy([profile], { native: 0.6934 });
  assert.equal(policy.early, false);
  assert.equal(policy.earlyArmed, true, 'armed 仍为默认开，但 policy.early 优先');
  const wiring = wireEarlyCompaction({
    ctx: makeCtx(engine),
    getGuard: makeGuard,
    getPolicy: () => policy,
    getArmed: () => policy.earlyArmed === true,
    now: () => 0,
  });
  await wiring.check({ id: 's1' });
  assert.equal(engine.calls, 0);
});
