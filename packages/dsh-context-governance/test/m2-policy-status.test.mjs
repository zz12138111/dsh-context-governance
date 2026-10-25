/**
 * M2 0.2.0 接线测试：/cg policy show 与 /cg status 的策略行。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { profileLayer, resolvePolicy, validateLayer } from '../src/policy.js';

const NATIVE = 0.6785;

function policyState(profileName = '') {
  const layers = [];
  const profile = profileLayer(profileName);
  if (profile !== null) layers.push({ source: profile.source, values: profile.values });
  const plugin = validateLayer({ 'compact.at': 0.58 }, { source: 'plugin', native: NATIVE });
  layers.push({ source: 'plugin', values: plugin.values });
  return {
    native: NATIVE,
    layers,
    invalid: [],
    resolve: () => resolvePolicy(layers, { native: NATIVE }),
  };
}

function guardWithPressure() {
  return {
    status: {
      started: true,
      mode: 'event-level',
      perception: 'event',
      eventApi: true,
      readOnly: false,
      readOnlyReason: null,
      reasons: [],
      degradedReasons: [],
      conflicts: [],
      fallback: null,
      adapter: {
        kind: 'none',
        label: 'no-compaction-service',
        versions: { host: '0.2.1-rc.3', backend: 'unknown' },
        perception: 'none',
        control: 'unknown',
        hooks: { before: 'best-effort', after: 'event' },
        protectionRole: 'validator',
        summary: { readability: 'readable', style: 'free-form' },
        inference: { kind: 'unknown', label: 'unknown', inferred: false, styles: [] },
        matrix: { host: 'in', backend: 'unknown' },
        selfCheck: { state: 'pending', checks: [] },
        notes: [],
      },
      protection: { enabled: false, storeRoot: null, auditFile: null, auditMaxBytes: null, auditSizeBytes: 0, auditRotations: 0, pendingJournals: 0, reinjectionFailureStreak: 0, reinjectionSuspended: false, maxReinjectionFailures: 3 },
      memory: { enabled: false, counts: {} },
      stats: { events: 0, protectionWrites: 0, protectionWriteFailures: 0, reinjections: 0, reinjectionFailures: 0, auditWriteFailures: 0, auditSkippedReadOnly: 0 },
      writeLatency: { count: 0, p50Ms: null, p95Ms: null, maxMs: null, minMs: null },
      lastReport: null,
      lastCost: null,
    },
  };
}

test('0.2.0 /cg policy show：逐层来源 + native + early', async () => {
  const command = createStatusCommand({ policy: policyState('research'), now: () => new Date('2026-10-25T00:00:00Z') });
  const result = await command.handler({ rawInput: 'policy show' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /layers: profile=research -> plugin/);
  assert.match(result.text, /compact\.at=0\.58 \(source=plugin\)/);
  assert.match(result.text, /native=0\.6785 early=off/);
  assert.match(result.text, /invalid: none/);
  if (process.env.CG_SAMPLE === '1') console.log('### policy show ###\n' + result.text);
});

test('0.2.0 /cg status：出现 policy 合成链行', async () => {
  const command = createStatusCommand({ guard: guardWithPressure(), policy: policyState(''), now: () => new Date('2026-10-25T00:00:00Z') });
  const result = await command.handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /policy: compact\.at=0\.58 \(source=plugin\) native=0\.6785 early=on/);
  if (process.env.CG_SAMPLE === '1') console.log('### status tail ###\n' + result.text.split('\n').filter((line) => line.startsWith('compression:') || line.startsWith('policy:') || line.startsWith('degraded:')).join('\n'));
});
