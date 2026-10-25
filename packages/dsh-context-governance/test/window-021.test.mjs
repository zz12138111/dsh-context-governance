/**
 * 0.2.1 窗口/校验层（DEC-20261025-66/67）：
 * 窗口观察、动态 native、conservative 校验、状态双显、删除不沿用、本版无压缩触发。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import { apply, buildPolicyState, resolveConfig } from '../src/index.js';
import { nativeFromWindow, summarizeWindow } from '../src/policy.js';
import { tempDir } from './helpers.mjs';

function makeCtx() {
  const handlers = [];
  const calls = { compactNow: 0, compactRegion: 0 };
  const engine = {
    compactNow() { calls.compactNow += 1; },
    compactRegion() { calls.compactRegion += 1; },
  };
  const ctx = {
    get: (name) => (name === 'compaction' ? engine : undefined),
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    logger: { info: () => {}, warn: () => {} },
  };
  return { ctx, handlers, calls };
}

function session(id) {
  return { id, header: { id, cwd: process.cwd() } };
}

function makePolicyState(provider) {
  const config = resolveConfig({
    projectRoot: 'D:/tmp/window',
    policy: { reservedTokens: 16384, values: { 'compact.at': 0.30 } },
  });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  state.setWindowProvider(provider);
  return state;
}

function guardStatus(pressure = null) {
  return {
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
    pressure,
    adapter: {
      kind: 'none',
      label: 'no-compaction-service',
      versions: { host: '0.2.1-rc.3', backend: 'unknown' },
      perception: 'none',
      control: 'unknown',
      hooks: { before: 'best-effort', after: 'event' },
      protectionRole: 'validator',
      summary: { readability: 'unknown', style: 'unknown' },
      inference: { kind: 'unknown', label: 'unknown', inferred: false, styles: [] },
      matrix: { host: 'in', backend: 'unknown' },
      selfCheck: { state: 'pending', checks: [] },
      notes: [],
    },
    protection: { enabled: false, storeRoot: null, auditFile: null, auditMaxBytes: null, auditSizeBytes: 0, auditRotations: 0, pendingJournals: 0, reinjectionFailureStreak: 0, reinjectionSuspended: false, maxReinjectionFailures: 3 },
    stats: { events: 0, protectionWrites: 0, protectionWriteFailures: 0, reinjections: 0, reinjectionFailures: 0, auditWriteFailures: 0, auditSkippedReadOnly: 0 },
    writeLatency: { count: 0, p50Ms: null, p95Ms: null, maxMs: null, minMs: null },
    lastReport: null,
    lastCost: null,
  };
}

test('0.2.1 nativeFromWindow：观测窗口现算，非法→unknown，退化→unknown（不造 0/0.6785）', () => {
  assert.equal(nativeFromWindow({ windowTokens: 1_048_576, reservedTokens: 16_384 }).native, 0.8);
  assert.equal(nativeFromWindow({ windowTokens: 131_072, reservedTokens: 16_384 }).native, 0.375);
  assert.equal(nativeFromWindow({ windowTokens: 1_000_000, reservedTokens: 256_000 }).native, 0.6785);
  assert.deepEqual(nativeFromWindow({ windowTokens: 0, reservedTokens: 1 }), { native: null, reason: 'window-invalid' });
  // DEC-20261025-68 A：W ≤ O+65536 时 native 不可计算，禁止冒充常数。
  assert.deepEqual(nativeFromWindow({ windowTokens: 131_072, reservedTokens: 256_000 }), { native: null, reason: 'degenerate' });
});

test('0.2.1 窗口观察：current=#lastSession、conservative=min(已观察)、observed 全量', () => {
  const { ctx, handlers } = makeCtx();
  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const first = session('session-aaaaaaaa-1111');
    const second = session('session-bbbbbbbb-2222');
    handlers[0](first, { type: 'request/context', seq: 1, data: { contextWindow: 1_048_576 } });
    handlers[0](second, { type: 'request/context', seq: 2, data: { contextWindow: 131_072 } });
    const state = guard.windowState;
    assert.equal(state.current.sessionId, second.id, 'current 跟 #lastSession');
    assert.equal(state.current.tokens, 131_072);
    assert.equal(state.conservative.tokens, 131_072, 'conservative 取最小');
    assert.equal(state.conservative.sessionId, second.id);
    assert.equal(state.observed.length, 2);
    assert.equal(state.source, 'projection');
    assert.equal(state.removed, false);
  } finally {
    guard.stop();
  }
});

test('0.2.1 窗口删除：request/context 不带 contextWindow → 删除置 unknown，不沿用旧值', () => {
  const { ctx, handlers } = makeCtx();
  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const first = session('session-aaaaaaaa-1111');
    const second = session('session-bbbbbbbb-2222');
    handlers[0](first, { type: 'request/context', seq: 1, data: { contextWindow: 1_048_576 } });
    handlers[0](second, { type: 'request/context', seq: 2, data: { contextWindow: 131_072 } });
    handlers[0](second, { type: 'request/context', seq: 3, data: { provider: 'deepseek-account' } });
    const state = guard.windowState;
    assert.equal(state.current, null, '删除后 current 必须为 null，不能沿用 131072');
    assert.equal(state.removed, true);
    assert.equal(state.conservative.tokens, 1_048_576, 'conservative 从剩余观察里取');
  } finally {
    guard.stop();
  }
});

test('0.2.1 动态 native + conservative 校验：1M/128k 双会话下 at=0.6 被拒且状态一致', () => {
  const config = resolveConfig({
    projectRoot: 'D:/tmp/window',
    policy: { reservedTokens: 16_384, values: { 'compact.at': 0.30 } },
  });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  state.sessionLayer.values['compact.at'] = 0.6; // 1M 下合法（native 0.8），128k 保守窗口下非法（0.375）
  state.setWindowProvider(() => ({
    current: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-bbbbbbbb', tokens: 131_072, observedAt: '2026-10-26T00:00:01.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const resolved = state.resolve();
  assert.equal(resolved.window.native, 0.8, '展示/native 用 current');
  assert.equal(resolved.window.nativeConservative, 0.375, '校验用 conservative');
  assert.equal(resolved.window.validated, true);
  assert.equal(resolved.values['compact.at'], 0.30, '越界层被拒后回落到下一层');
  assert.equal(resolved.sources['compact.at'], 'plugin');
  assert.ok(resolved.invalid.some((item) =>
    item.source === 'session' && item.reason === 'over-native-runtime' && item.key === 'compact.at'));
  // 同一份 native 函数：status 的 pressure 分母也用 current
  assert.equal(resolved.window.currentTokens, 1_048_576);
});

test('0.2.1 /cg status 双显：session 短 id、current/conservative、来源/时间、校验按 conservative', async () => {
  const state = makePolicyState(() => ({
    current: { sessionId: 'session-58a2e845-9999', tokens: 1_048_576, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-bbbbbbbb-2222', tokens: 131_072, observedAt: '2026-10-26T00:00:01.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const command = createStatusCommand({
    guard: { status: guardStatus({ measuredTokens: 262_144, estimatedTokens: 200_000 }) },
    policy: state,
    now: () => new Date('2026-10-26T00:00:00Z'),
  });
  const status = await command.handler({ rawInput: 'status' });
  assert.match(status.text, /window: current=1M \(session 58a2e845\) observed 2026-10-26T00:00:00\.000Z source=projection/);
  assert.match(status.text, /conservative=128k \(session bbbbbbbb\)/);
  assert.match(status.text, /native-current=0\.8000\(projection\)/);
  assert.match(status.text, /native-conservative=0\.3750/);
  assert.match(status.text, /校验按 conservative/);
  assert.match(status.text, /pressure: .*window=1M \(session 58a2e845\)/);
});

test('0.2.1 无观察：窗口 unknown + 允许设 at 但状态标未校验；不沿用旧值', async () => {
  const state = makePolicyState(() => ({
    current: null,
    conservative: null,
    observed: [],
    source: 'unknown',
    removed: true,
  }));
  const resolved = state.resolve();
  assert.equal(resolved.window.validated, false);
  assert.equal(resolved.values['compact.at'], 0.30);
  const line = summarizeWindow(resolved.window);
  assert.match(line, /current=unknown/);
  assert.match(line, /removed by request\/context/);
  assert.match(line, /unvalidated/);
  const command = createStatusCommand({ policy: state, guard: { status: guardStatus(null) }, now: () => new Date('2026-10-26T00:00:00Z') });
  const set = await command.handler({ rawInput: 'set compact.at=0.5' });
  assert.equal(set.kind, 'success', '无观察时允许设 at');
  const show = await command.handler({ rawInput: 'policy show' });
  assert.match(show.text, /compact\.at=0\.5 \(source=session\)/);
});

test('0.2.1 /cg set：有保守窗口时按 conservative 校验（0.55 > 0.375 被拒）', async () => {
  const state = makePolicyState(() => ({
    current: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-bbbbbbbb', tokens: 131_072, observedAt: '2026-10-26T00:00:01.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const command = createStatusCommand({ policy: state, now: () => new Date('2026-10-26T00:00:00Z') });
  const rejected = await command.handler({ rawInput: 'set compact.at=0.55' });
  assert.equal(rejected.kind, 'error');
  assert.match(rejected.text, /over-native/);
  const allowed = await command.handler({ rawInput: 'set compact.at=0.30' });
  assert.equal(allowed.kind, 'success');
});

test('0.2.1 验收#6：窗口观察/策略/状态全过程不产生任何压缩调用', () => {
  const { ctx, handlers, calls } = makeCtx();
  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  const state = makePolicyState(() => guard.windowState);
  try {
    const first = session('session-aaaaaaaa-1111');
    handlers[0](first, { type: 'request/context', seq: 1, data: { contextWindow: 1_048_576 } });
    handlers[0](first, { type: 'request/context', seq: 2, data: { contextWindow: 131_072 } });
    handlers[0](first, { type: 'assistant/message', seq: 3, data: { usage: { inputTokens: 100_000 } } });
    state.resolve();
    state.validationNative();
    guard.pressure();
    guard.windowState;
    assert.equal(calls.compactNow, 0, '不得调用 compactNow');
    assert.equal(calls.compactRegion, 0, '不得调用 compactRegion');
  } finally {
    guard.stop();
  }
});

test('0.2.1 退化口径 A（DEC-68）：W=128k O=256k → native unknown、at 层一律拒绝、恢复后自动可校验', () => {
  const config = resolveConfig({
    projectRoot: 'D:/tmp/window',
    policy: { reservedTokens: 256_000, values: { 'compact.at': 0.30 } },
  });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  state.sessionLayer.values['compact.at'] = 0.6;
  const degenerateWindow = {
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  };
  state.setWindowProvider(() => degenerateWindow);
  const resolved = state.resolve();
  assert.equal(resolved.window.degenerate, true);
  assert.equal(resolved.window.native, null, '退化时 native 必须是 null，不能造数');
  assert.equal(resolved.window.nativeConservative, null);
  assert.equal(resolved.values['compact.at'], 0.60, '继承值保留但标 unverified-degenerate');
  assert.equal(state.validationNative(), null, '退化时校验 native 是 unknown（拒绝设置）');
  assert.ok(resolved.invalid.some((item) => item.source === 'session' && item.reason === 'native-uncomputable'));
  assert.ok(resolved.invalid.some((item) => item.source === 'plugin' && item.reason === 'native-uncomputable'));
  const line = summarizeWindow(resolved.window);
  assert.match(line, /unknown \(degenerate: W=128k O=256k\)/);
  assert.match(line, /unverified-degenerate/);

  // W 恢复 → 自动恢复可校验（不锁到 apply）
  state.setWindowProvider(() => ({
    current: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:05.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:05.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const recovered = state.resolve();
  assert.equal(recovered.window.degenerate, false);
  assert.equal(recovered.values['compact.at'], 0.6, '恢复后会话层 0.6 生效');
  assert.equal(recovered.sources['compact.at'], 'session');
  assert.ok(recovered.window.native > 0.6);
});

test('0.2.1 /cg status 退化显示 + /cg set 拒绝 at（native-uncomputable）', async () => {
  const state = buildPolicyState(
    resolveConfig({ projectRoot: 'D:/tmp/window', policy: { reservedTokens: 256_000, values: { 'compact.at': 0.30 } } }),
    { readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
  );
  state.setWindowProvider(() => ({
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const command = createStatusCommand({
    guard: { status: guardStatus(null) },
    policy: state,
    now: () => new Date('2026-10-26T00:00:00Z'),
  });
  const status = await command.handler({ rawInput: 'status' });
  assert.match(status.text, /policy: .*native=unknown \(degenerate\)/);
  assert.match(status.text, /unknown \(degenerate: W=128k O=256k\)/);
  assert.match(status.text, /native-uncomputable/);
  const set = await command.handler({ rawInput: 'set compact.at=0.5' });
  assert.equal(set.kind, 'error');
  assert.match(set.text, /native-uncomputable/);
});

test('0.2.1 P2-1 退化拒层必须落审计（policy-invalid reason=native-uncomputable）', async () => {
  const rootDir = await tempDir('cg-window-audit-');
  const handlers = [];
  const logs = [];
  const disposers = [];
  const ctx = {
    tools: { register: () => () => {} },
    logger: { info: () => {}, warn: (...args) => logs.push(args.join(' ')) },
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    get: (name) => (name === 'commands' ? { register: () => () => {} } : undefined),
    effect: (callback) => { disposers.push(callback()); },
  };
  try {
    // 退化配置：128k 窗口 + 256k 预留 → native 不可计算；插件层设 at=0.5 必须被拒且落审计。
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'window-audit',
      compression: { enabled: true },
      policy: { reservedTokens: 256_000, values: { 'compact.at': 0.5 } },
    });
    const session = { id: 'session-aaaaaaaa', header: { id: 'session-aaaaaaaa', cwd: rootDir } };
    handlers[0](session, { type: 'request/context', seq: 1, data: { contextWindow: 131_072 } });
    const auditFile = path.join(rootDir, '.dsh', 'memory', 'audit.jsonl');
    const records = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const rejected = records.filter((record) => record.event === 'policy-invalid');
    assert.equal(rejected.length, 1, `退化应只写 1 条 policy-invalid，实际 ${JSON.stringify(rejected)}`);
    assert.equal(rejected[0].reason, 'native-uncomputable');
    assert.equal(rejected[0].code, 'compact.at');
    assert.equal(rejected[0].source, 'plugin');
    assert.ok(logs.some((line) => /policy layer rejected at runtime: plugin\/compact\.at:native-uncomputable/.test(line)));
  } finally {
    for (const dispose of disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
