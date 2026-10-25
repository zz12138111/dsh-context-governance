/**
 * M2 策略层纯函数单测（REQ-20261025-09 T1/T2，0.2.0 第一部分）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_DEFAULT_RATIO,
  POLICY_DEFAULTS,
  computePressure,
  layerChain,
  nativeRatio,
  profileLayer,
  resolvePolicy,
  summarizePressure,
  validateLayer,
  summarizePolicy,
  policyTable,
} from '../src/policy.js';

const NATIVE = nativeRatio({ windowTokens: 1_000_000, reservedTokens: 256_000 });

test('0.2.0 native 公式：1M 窗口/256k 预留 ≈ 67.85%', () => {
  assert.equal(NATIVE, 0.6785);
  assert.equal(nativeRatio({}), NATIVE_DEFAULT_RATIO);
});

test('0.2.0 内置默认：at=0.60 early=true', () => {
  const policy = resolvePolicy([], { native: NATIVE });
  assert.equal(policy.values['compact.at'], 0.60);
  assert.equal(policy.values['compact.early'], true);
  assert.equal(policy.sources['compact.at'], 'builtin');
  assert.equal(policy.native, NATIVE);
  assert.equal(policy.early, true);
});

test('0.2.0 四层合成顺序：会话 > 项目 > 插件 > profile 标签 > 内置', () => {
  const profile = profileLayer('batch');
  assert.ok(profile, 'batch profile 应存在');
  const plugin = validateLayer({ 'compact.at': 0.58 }, { source: 'plugin', native: NATIVE });
  const project = validateLayer({ 'compact.at': 0.52 }, { source: 'project', native: NATIVE });
  const session = validateLayer({ 'compact.at': 0.47 }, { source: 'session', native: NATIVE, sessionLayer: true });
  const policy = resolvePolicy([
    { source: 'plugin', values: plugin.values },
    { source: profile.source, values: profile.values },
    { source: 'project', values: project.values },
    { source: 'session', values: session.values },
  ], { native: NATIVE });
  assert.equal(policy.values['compact.at'], 0.47);
  assert.equal(policy.sources['compact.at'], 'session');
});

test('0.2.0 越界拒绝：compact.at > native 提示不支持推迟', () => {
  const result = validateLayer({ 'compact.at': 0.9 }, { source: 'session', native: NATIVE, sessionLayer: true });
  assert.equal(result.values['compact.at'], undefined);
  assert.equal(result.invalid[0].reason, 'over-native');
  assert.match(result.invalid[0].detail, /不支持推迟/);
});

test('0.2.0 未知键整层拒绝；config-only 键不允许 /cg set', () => {
  const unknown = validateLayer({ 'compact.nope': 1 }, { source: 'plugin', native: NATIVE });
  assert.equal(unknown.invalid[0].reason, 'unknown-key');
  const configOnly = validateLayer({ 'compact.estimateSafety': 1.4 }, { source: 'session', native: NATIVE, sessionLayer: true });
  assert.equal(configOnly.invalid[0].reason, 'config-only');
  const configOk = validateLayer({ 'compact.estimateSafety': 1.4 }, { source: 'plugin', native: NATIVE });
  assert.equal(configOk.values['compact.estimateSafety'], 1.4);
});

test('0.2.0 at<0.30 未确认则回退 builtin', () => {
  const low = resolvePolicy([{ source: 'plugin', values: { 'compact.at': 0.25 } }], { native: NATIVE });
  assert.equal(low.values['compact.at'], POLICY_DEFAULTS['compact.at']);
  assert.equal(low.sources['compact.at'], 'builtin');
  assert.ok(low.invalid.some((item) => item.reason === 'low-threshold-unacked'));
});

test('0.2.0 research profile 默认 early=false', () => {
  const ring = profileLayer('research');
  assert.ok(ring);
  const policy = resolvePolicy([{ source: ring.source, values: ring.values }], { native: NATIVE });
  assert.equal(policy.values['compact.early'], false);
  assert.equal(policy.early, false);
  assert.match(summarizePolicy(policy), /early=off/);
});

test('0.2.0 show 展开：每键一行含 source', () => {
  const policy = resolvePolicy([{ source: 'project', values: { 'compact.at': 0.52 } }], { native: NATIVE });
  const table = policyTable(policy);
  assert.equal(table.length, Object.keys(POLICY_DEFAULTS).length);
  assert.ok(table.some((line) => line.startsWith('compact.at=0.52 (source=project)')));
});

test('0.2.0 压力四段：adjusted 用 estimateSafety，effective 取 max，ratio=实测/估算', () => {
  const pressure = computePressure({ measuredTokens: 583000, estimatedTokens: 412000, windowTokens: 1_000_000 });
  assert.equal(pressure.measured, 0.583);
  assert.equal(pressure.estimated, 0.412);
  assert.equal(pressure.adjusted, 0.556);
  assert.equal(pressure.effective, 0.583);
  assert.equal(pressure.ratio, 1.42);
  const line = summarizePressure(pressure, { at: 0.60 });
  assert.match(line, /adjusted=0\.556\(×1\.35\) effective=0\.583 ratio=1\.42 at=0\.60 effective<at/);
});

test('0.2.0 压力四段：来源缺失保持 null，不伪造；effective 只取已知项', () => {
  const onlyMeasured = computePressure({ measuredTokens: 500000, estimatedTokens: null, windowTokens: 1_000_000 });
  assert.equal(onlyMeasured.estimated, null);
  assert.equal(onlyMeasured.adjusted, null);
  assert.equal(onlyMeasured.effective, 0.5);
  assert.equal(onlyMeasured.ratio, null);
  const empty = computePressure({ windowTokens: 1_000_000 });
  assert.equal(empty.effective, null);
  assert.match(summarizePressure(empty), /\(no usage\/tokenMeter yet\)/);
  const badWindow = computePressure({ measuredTokens: 1, estimatedTokens: 1, windowTokens: 0 });
  assert.equal(badWindow.measured, null);
  assert.equal(badWindow.effective, null);
});

test('0.2.0 层级链：空层标 (empty)，不被读成已生效', () => {
  const policy = { layers: [{ source: 'plugin', values: { 'compact.at': 0.58 } }, { source: 'project', values: {} }] };
  assert.equal(layerChain(policy), 'plugin -> project (empty)');
  assert.equal(layerChain({ layers: [] }), 'builtin');
});
