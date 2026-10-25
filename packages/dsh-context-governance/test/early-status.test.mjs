/**
 * 0.2.4 T3：`/cg status` 的 early 显示 + 最近一次 early 决策。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { resolvePolicy } from '../src/policy.js';

function makeCommand({ invalid = [], configureSession = null, getEarlyStatus = null } = {}) {
  const sessionLayer = { source: 'session', values: {} };
  if (configureSession !== null) configureSession(sessionLayer.values);
  const policy = {
    sessionLayer,
    invalid,
    native: 0.6934,
    validationNative: () => 0.6934,
    resolve: () => {
      const resolved = resolvePolicy([sessionLayer], { native: 0.6934 });
      return { ...resolved, window: null, invalid: [...invalid, ...resolved.invalid] };
    },
  };
  return createStatusCommand({ policy, getEarlyStatus, now: () => new Date('2026-10-26T00:00:00Z') });
}

async function status(command) {
  const result = await command.handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  return result.text;
}

test('0.2.4 T3：默认 armed → early=on (default)，无决策时 last-early: none', async () => {
  const text = await status(makeCommand());
  assert.match(text, /early=on \(default\)/);
  assert.match(text, /last-early: none/);
});

test('0.2.4 T3：会话 disarm → early=off (session)', async () => {
  const text = await status(makeCommand({ configureSession: (values) => { values['compact.early.armed'] = false; } }));
  assert.match(text, /early=off \(session\)/);
});

test('0.2.4 T3：最近决策 forced/skipped 带原因、effective、时间', async () => {
  const forced = await status(makeCommand({
    getEarlyStatus: () => ({ event: 'early-forced', reason: null, effective: 0.65, time: '2026-10-26T02:00:00.000Z' }),
  }));
  assert.match(forced, /last-early: forced effective=0\.650 at=2026-10-26T02:00:00\.000Z/);

  const skipped = await status(makeCommand({
    getEarlyStatus: () => ({ event: 'early-skipped', reason: 'not-armed', effective: 0.7, time: '2026-10-26T02:01:00.000Z' }),
  }));
  assert.match(skipped, /last-early: skipped \(not-armed\) effective=0\.700/);
});

test('0.2.4 T3：项目层 armed 被拒必须在 status 可见', async () => {
  const text = await status(makeCommand({
    invalid: [{ source: 'project', key: 'compact.early.armed', reason: 'project-excluded' }],
  }));
  assert.match(text, /policy-invalid: 1 \(project\/compact\.early\.armed:project-excluded\)/);
});
