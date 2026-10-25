/**
 * M2 策略层纯函数单测（REQ-20261025-09 T1/T2，0.2.0 第一部分）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_DEFAULT_RATIO,
  POLICY_DEFAULTS,
  nativeRatio,
  profileLayer,
  resolvePolicy,
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
