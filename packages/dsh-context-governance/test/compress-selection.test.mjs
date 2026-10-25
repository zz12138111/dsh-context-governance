import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContextZipAdapter,
  createHostBasicAdapter,
  detectAdapter,
  runSelfCheck,
} from '../src/compress/adapters.js';
import { detectConflicts, selectMode } from '../src/compress/selection.js';

class BasicCompactionEngine {
  compactNow() {}
}
class ContextZipEngine {
  constructor() {
    this.undoManualSeat = () => {};
  }
  compactNow() {}
}

const checked = (adapter, eventApi = true) => runSelfCheck({ adapter, eventApi });

test('没有压缩服务 → observe-only + 冲突', () => {
  const adapter = checked(detectAdapter({ compaction: null }));
  const selection = selectMode({ adapter });
  assert.equal(selection.mode, 'event-level');
  assert.ok(selection.reasons.includes('event-perception-only'));
  assert.ok(selection.conflicts.some((conflict) => conflict.code === 'no-compaction-service'));
  assert.equal(selection.conflicts.find((conflict) => conflict.code === 'no-compaction-service').severity, 'warning');

  const noEvents = selectMode({ adapter, eventApi: false });
  assert.equal(noEvents.mode, 'observe-only');
});

test('未知 provider → observe-only', () => {
  const adapter = checked(detectAdapter({ compaction: { compactNow() {} } }));
  const selection = selectMode({ adapter });
  assert.equal(selection.mode, 'observe-only');
  assert.ok(selection.reasons.includes('unknown-provider'));
});

test('宿主版本出矩阵 → observe-only', () => {
  const adapter = checked(detectAdapter({ compaction: new BasicCompactionEngine(), hostVersion: '0.3.0' }));
  const selection = selectMode({ adapter });
  assert.equal(selection.mode, 'observe-only');
  assert.ok(selection.conflicts.some((conflict) => conflict.code === 'host-version-out-of-matrix' && conflict.severity === 'error'));
});

test('context-zip 自检失败 → observe-only + 人工回退建议（不自动换引擎）', () => {
  const adapter = checked(detectAdapter({
    compaction: new ContextZipEngine(),
    hostVersion: '0.2.1-rc.2',
    backendVersion: '0.2.0',
  }));
  const selection = selectMode({ adapter });
  assert.equal(selection.mode, 'observe-only');
  assert.equal(selection.fallback.recommended, 'host-default');
  assert.equal(selection.fallback.manual, true);
  assert.match(selection.fallback.note, /不替换 provider/);
});

test('版本未知 → warning 但保持 full', () => {
  const adapter = checked(detectAdapter({ compaction: new ContextZipEngine(), hostVersion: 'unknown' }));
  assert.equal(adapter.selfCheck.state, 'pass');
  assert.ok(adapter.selfCheck.checks.find((check) => check.id === 'host-version').status === 'warn');
  const selection = selectMode({ adapter });
  assert.equal(selection.mode, 'full');
  assert.ok(selection.conflicts.some((conflict) => conflict.code === 'host-version-unverified'));
});

test('context-zip 矩阵内 → full；摘要不可读 → degraded', () => {
  const adapter = checked(detectAdapter({
    compaction: new ContextZipEngine(),
    hostVersion: '0.2.1-rc.2',
    backendVersion: '0.1.10',
  }));
  assert.equal(selectMode({ adapter }).mode, 'full');
  const degraded = selectMode({ adapter, summaryReadability: 'unreadable' });
  assert.equal(degraded.mode, 'degraded-summary-unreadable');
  assert.deepEqual(degraded.reasons, ['summary-unreadable']);
});

test('配置关闭 → disabled', () => {
  const adapter = checked(createHostBasicAdapter({ hostVersion: '0.2.1-rc.2' }));
  assert.equal(selectMode({ adapter, enabled: false }).mode, 'disabled');
});

test('provider 漂移：host-basic 看到五段摘要 → warning，但不改变模式', () => {
  const adapter = checked(createHostBasicAdapter({ hostVersion: '0.2.1-rc.2' }));
  const drifted = { ...adapter, summary: { ...adapter.summary, style: 'five-section' } };
  const conflicts = detectConflicts({ adapter: drifted });
  assert.ok(conflicts.some((conflict) => conflict.code === 'summary-provider-drift'));
  assert.equal(selectMode({ adapter: drifted }).mode, 'full');
});

test('事件面不可用 → self-check fail → observe-only', () => {
  const adapter = checked(createHostBasicAdapter({ hostVersion: '0.2.1-rc.2' }), false);
  const selection = selectMode({ adapter, eventApi: false });
  assert.equal(selection.mode, 'observe-only');
  assert.ok(selection.conflicts.some((conflict) => conflict.code === 'event-api-unavailable'));
});

test('宿主 0.2.1-rc.3 + backend unknown → full（只告警 backend unverified）', () => {
  const adapter = checked(detectAdapter({
    compaction: new ContextZipEngine(),
    hostVersion: '0.2.1-rc.3',
    backendVersion: 'unknown',
  }));
  assert.equal(adapter.matrix.host, 'in');
  assert.equal(adapter.selfCheck.state, 'pass');
  const selection = selectMode({ adapter });
  assert.equal(selection.mode, 'full');
  assert.ok(selection.conflicts.some((conflict) => conflict.code === 'backend-version-unverified'));
  assert.equal(selection.conflicts.some((conflict) => conflict.severity === 'error'), false);
});
