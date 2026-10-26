/**
 * 第三批（1.0 #4 窗上界 + #5 空窗）：
 * - `at ≥ native−0.02` 一律拒绝（above-effective-window）；
 * - 运行时窗口收缩导致生效层/回落落入非可用区间 → window-shrunk / fallback-over-native；
 * - status 的 early= 不得假 on；unvalidated 窗口标 unvalidated。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { buildPolicyState, resolveConfig } from '../src/index.js';
import {
  NATIVE_DEFAULT_RATIO,
  WINDOW_USABLE_MARGIN,
  summarizePolicy,
  usableAtCeiling,
  validateLayer,
} from '../src/policy.js';

const SESSION = 'session-aaaaaaaa-1111';
const WINDOW_1M = 1_048_576;

function missingProjectFile() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

function makeState({ values = {}, reservedTokens = 256_000 } = {}) {
  const config = resolveConfig({
    projectRoot: 'D:/tmp/window',
    policy: { reservedTokens, values },
  });
  return buildPolicyState(config, { readFile: missingProjectFile });
}

function provider({ current = null, conservative = null } = {}) {
  return () => ({
    current: current === null ? null : { sessionId: SESSION, tokens: current, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: conservative === null ? null : { sessionId: SESSION, tokens: conservative, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  });
}

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); return true; } };
}

function cmd({ policy, audit = null, sessionId = SESSION }) {
  return createStatusCommand({ policy, audit, sessionIdOf: () => sessionId });
}

test('3b 校验边界：at ≥ native−0.02 拒绝（含边界），差 0.0001 可用', () => {
  const native = 0.6934;
  const ceiling = usableAtCeiling(native);
  assert.equal(ceiling, native - WINDOW_USABLE_MARGIN);
  const boundary = validateLayer({ 'compact.at': ceiling }, { source: 'plugin', native });
  assert.equal(boundary.invalid[0].reason, 'above-effective-window');
  const justAbove = validateLayer({ 'compact.at': ceiling + 0.0001 }, { source: 'plugin', native });
  assert.equal(justAbove.invalid[0].reason, 'above-effective-window');
  const justBelow = validateLayer({ 'compact.at': ceiling - 0.0001 }, { source: 'plugin', native });
  assert.deepEqual(justBelow.invalid, []);
  assert.equal(justBelow.values['compact.at'], ceiling - 0.0001);
  const overNative = validateLayer({ 'compact.at': 0.7 }, { source: 'plugin', native });
  assert.equal(overNative.invalid[0].reason, 'above-effective-window', '不再新写 over-native');
});

test('3b 跨机器口径：0.6934 与 0.6785 下 at=0.68 都拒绝，detail 带各自 native', () => {
  for (const native of [0.6934, NATIVE_DEFAULT_RATIO]) {
    const result = validateLayer({ 'compact.at': 0.68 }, { source: 'plugin', native });
    assert.equal(result.invalid[0].reason, 'above-effective-window');
    assert.match(result.invalid[0].detail, new RegExp(`native=${native}`));
  }
});

test('3b /cg set：高于可用界拒绝 above-effective-window、不建桶、审计可见', async () => {
  const state = makeState();
  const audit = makeAudit();
  const command = cmd({ policy: state, audit });
  const result = await command.handler({ rawInput: 'set compact.at=0.69' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /above-effective-window/);
  assert.deepEqual(state.sessionValues(SESSION, { create: false }), {}, '不得留下半截覆盖');
  const rejected = audit.entries.filter((entry) => entry.event === 'policy-invalid');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].source, 'session');
  assert.equal(rejected[0].reason, 'above-effective-window');
  const resolved = state.resolve(SESSION);
  assert.ok(resolved.invalid.some((item) => item.source === 'session' && item.reason === 'above-effective-window'));
});

test('3b 运行时收缩：合法层落入非可用区间 → 该层失效（window-shrunk），回落下一层', () => {
  const state = makeState({ values: { 'compact.at': 0.30 }, reservedTokens: 16_384 });
  state.sessionValues(SESSION, { create: true })['compact.at'] = 0.7; // 1M native 0.8 下合法（<0.78）
  state.setWindowProvider(provider({ current: WINDOW_1M, conservative: WINDOW_1M }));
  const wide = state.resolve(SESSION);
  assert.equal(wide.values['compact.at'], 0.7);
  assert.equal(wide.values['compact.at'] < wide.window.nativeConservative - WINDOW_USABLE_MARGIN, true);

  state.setWindowProvider(provider({ current: WINDOW_1M, conservative: 131_072 })); // 保守 native 0.375
  const shrunk = state.resolve(SESSION);
  assert.equal(shrunk.values['compact.at'], 0.30, '越界层被拒后回落到下一层');
  assert.ok(shrunk.invalid.some((item) =>
    item.source === 'session' && item.reason === 'window-shrunk' && item.key === 'compact.at'));
  assert.equal(shrunk.invalid.some((item) => item.reason === 'over-native-runtime'), false, '不再新写旧 reason');
});

test('3b 回落也不可用：fallback-over-native + status early=off（window-shrunk）', () => {
  const state = makeState({ values: { 'compact.at': 0.5 }, reservedTokens: 16_384 });
  state.setWindowProvider(provider({ current: WINDOW_1M, conservative: 131_072 }));
  const resolved = state.resolve(SESSION);
  assert.equal(resolved.values['compact.at'], 0.6, 'builtin 回落');
  assert.ok(resolved.invalid.some((item) => item.source === 'builtin' && item.reason === 'fallback-over-native'));
  assert.equal(resolved.earlyWindow.usable, false);
  assert.equal(resolved.earlyWindow.reason, 'window-shrunk');
  const line = summarizePolicy(resolved);
  assert.match(line, /early=off \(window-shrunk\)/);
  assert.doesNotMatch(line, /early=on/);
});

test('3b 边界不误伤：at < native−0.02 时 early 正常 on', () => {
  const state = makeState({ values: { 'compact.at': 0.30 }, reservedTokens: 16_384 });
  state.setWindowProvider(provider({ current: 131_072, conservative: 131_072 })); // native 0.375，上界 0.355
  const resolved = state.resolve(SESSION);
  assert.equal(resolved.values['compact.at'], 0.30);
  assert.equal(resolved.earlyWindow.usable, true);
  assert.match(summarizePolicy(resolved), /early=on \(default\)/);
});

test('3b 一次收缩只出新 reason（不混 over-native-runtime/fallback-over-native）', () => {
  const state = makeState({ values: { 'compact.at': 0.30 }, reservedTokens: 16_384 });
  state.sessionValues(SESSION, { create: true })['compact.at'] = 0.7;
  state.setWindowProvider(provider({ current: 131_072, conservative: 131_072 }));
  const resolved = state.resolve(SESSION);
  const reasons = resolved.invalid
    .filter((item) => item.key === 'compact.at')
    .map((item) => item.reason);
  assert.deepEqual(reasons, ['window-shrunk']);
});

test('3b 窗口恢复：原层重新可用、status 回 early=on', () => {
  const state = makeState({ values: { 'compact.at': 0.30 }, reservedTokens: 16_384 });
  state.sessionValues(SESSION, { create: true })['compact.at'] = 0.7;
  state.setWindowProvider(provider({ current: 131_072, conservative: 131_072 }));
  assert.equal(state.resolve(SESSION).values['compact.at'], 0.30);
  state.setWindowProvider(provider({ current: WINDOW_1M, conservative: WINDOW_1M }));
  const recovered = state.resolve(SESSION);
  assert.equal(recovered.values['compact.at'], 0.7);
  assert.equal(recovered.invalid.some((item) => item.reason === 'window-shrunk'), false);
  assert.match(summarizePolicy(recovered), /early=on \(default\)/);
});

test('3b unvalidated 窗口：status 显示 early=on (default; unvalidated)，不得裸 on', async () => {
  const state = makeState({ values: { 'compact.at': 0.6 } });
  state.setWindowProvider(provider({ current: null, conservative: null }));
  const resolved = state.resolve(SESSION);
  assert.equal(resolved.window.validated, false);
  const line = summarizePolicy(resolved);
  assert.match(line, /early=on \(default; unvalidated\)/);
  assert.doesNotMatch(line, /early=on \(default\)(?!;)/);
  const status = await cmd({ policy: state }).handler({ rawInput: 'status' });
  assert.match(status.text, /early=on \(default; unvalidated\)/);
});

test('3b transient 兼容分支：无 rejectSessionSet 时按 sessionId 去重（不跨会话少写审计）', async () => {
  const state = makeState();
  const policy = { ...state, rejectSessionSet: undefined };
  const sessionA = 'session-aaaaaaaa-1111';
  const sessionB = 'session-bbbbbbbb-2222';
  const auditA = makeAudit();
  const auditB = makeAudit();
  await cmd({ policy, audit: auditA, sessionId: sessionA }).handler({ rawInput: 'set compact.at=0.69' });
  await cmd({ policy, audit: auditB, sessionId: sessionB }).handler({ rawInput: 'set compact.at=0.69' });
  assert.equal(auditA.entries.filter((entry) => entry.event === 'policy-invalid').length, 1);
  assert.equal(auditB.entries.filter((entry) => entry.event === 'policy-invalid').length, 1, 'B 不得被判成 A 的重复');
});

test('3b transient：A 会话被拒不串到 B 会话 status', async () => {
  const state = makeState();
  const sessionA = 'session-aaaaaaaa-1111';
  const sessionB = 'session-bbbbbbbb-2222';
  const rejected = await cmd({ policy: state, sessionId: sessionA }).handler({ rawInput: 'set compact.at=0.69' });
  assert.equal(rejected.kind, 'error');
  const statusB = await cmd({ policy: state, sessionId: sessionB }).handler({ rawInput: 'status' });
  assert.doesNotMatch(statusB.text, /above-effective-window/);
  assert.doesNotMatch(statusB.text, /policy-invalid: 1 \(session\/compact\.at/);
  const statusA = await cmd({ policy: state, sessionId: sessionA }).handler({ rawInput: 'status' });
  assert.match(statusA.text, /above-effective-window/);
  assert.equal(state.sessionRejections(sessionA).length, 1);
  assert.equal(state.sessionRejections(sessionB).length, 0);
});

test('3b transient：A 先被拒、再成功设置更低 at → (rejected) 消失', async () => {
  const state = makeState();
  const audit = makeAudit();
  const command = cmd({ policy: state, audit });
  const rejected = await command.handler({ rawInput: 'set compact.at=0.69' });
  assert.equal(rejected.kind, 'error');
  assert.equal(state.sessionRejections(SESSION).length, 1);
  const applied = await command.handler({ rawInput: 'set compact.at=0.5' });
  assert.equal(applied.kind, 'success');
  assert.equal(state.sessionRejections(SESSION).length, 0, '成功设置后 transient 必须清掉');
  const status = await command.handler({ rawInput: 'status' });
  assert.doesNotMatch(status.text, /above-effective-window/);
  assert.doesNotMatch(status.text, /policy-invalid: 1 \(session\/compact\.at/);
});

test('3b status：生效 at 落入空窗区间 → early=off，不显示 on', async () => {
  const state = makeState({ values: { 'compact.at': 0.5 }, reservedTokens: 16_384 });
  state.setWindowProvider(provider({ current: WINDOW_1M, conservative: 131_072 }));
  const status = await cmd({ policy: state }).handler({ rawInput: 'status' });
  assert.match(status.text, /early=off \(window-shrunk\)/);
  assert.doesNotMatch(status.text, /early=on/);
});
