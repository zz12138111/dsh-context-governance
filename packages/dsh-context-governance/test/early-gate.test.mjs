/**
 * 0.2.2 第 5 步：`turn/end` 门禁（纯函数）单测。
 * 只测判定；不触发压缩、不碰宿主。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EARLY_DECISION, EARLY_NEAR_NATIVE_MARGIN, EARLY_SKIP, decideEarly } from '../src/compress/early-gate.js';

const SAFE = Object.freeze({
  armed: true,
  early: true,
  turnEnded: true,
  agentIdle: true,
  hasAgent: true,
  hasEngine: true,
  inProgress: false,
  cooldownOk: true,
  deltaOk: true,
  effective: 0.65,
  at: 0.60,
  native: 0.6934,
});

test('0.2.2 门禁：默认（armed=false）永远 skip(not-armed)，与压力无关', () => {
  assert.deepEqual(decideEarly({}), { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NOT_ARMED });
  assert.deepEqual(decideEarly({ ...SAFE, armed: false }), { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NOT_ARMED });
});

test('0.2.2 门禁：policy compact.early=false 优先于 armed', () => {
  assert.deepEqual(decideEarly({ ...SAFE, early: false }), { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.DISABLED });
});

test('0.2.2 门禁：硬条件按顺序短路（turn/idle/in-progress/agent/engine/cooldown/delta）', () => {
  const cases = [
    [{ turnEnded: false }, EARLY_SKIP.TURN_IN_PROGRESS],
    [{ agentIdle: false }, EARLY_SKIP.NOT_IDLE],
    [{ inProgress: true }, EARLY_SKIP.IN_PROGRESS],
    [{ hasAgent: false }, EARLY_SKIP.NO_AGENT],
    [{ hasEngine: false }, EARLY_SKIP.NO_ENGINE],
    [{ cooldownOk: false }, EARLY_SKIP.COOLDOWN],
    [{ deltaOk: false }, EARLY_SKIP.MIN_DELTA],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(decideEarly({ ...SAFE, ...patch }), { action: EARLY_DECISION.SKIP, reason }, reason);
  }
});

test('0.2.2 门禁：压力门槛（未知/低于 at/接近 native/强制）', () => {
  assert.deepEqual(decideEarly({ ...SAFE, effective: null }), { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.UNKNOWN_PRESSURE });
  assert.deepEqual(decideEarly({ ...SAFE, effective: 0.59 }), { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.BELOW_THRESHOLD });
  assert.deepEqual(
    decideEarly({ ...SAFE, effective: 0.6934 - EARLY_NEAR_NATIVE_MARGIN }),
    { action: EARLY_DECISION.SKIP, reason: EARLY_SKIP.NEAR_NATIVE },
  );
  assert.deepEqual(decideEarly(SAFE), { action: EARLY_DECISION.FORCE, reason: 'forced' });
  assert.deepEqual(
    decideEarly({ ...SAFE, effective: 0.60 }),
    { action: EARLY_DECISION.FORCE, reason: 'forced' },
    'effective == at 即可触发',
  );
  assert.deepEqual(
    decideEarly({ ...SAFE, native: null }),
    { action: EARLY_DECISION.FORCE, reason: 'forced' },
    'native 未知时不做 near-native 拦截（由 /cg status 标 unverified）',
  );
});
