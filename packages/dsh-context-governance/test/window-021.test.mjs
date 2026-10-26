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

const SESSION = 'session-window-00000000001';
/** 1a：测试通过工厂注入会话标识（生产默认读 agent.session.id）。 */
const cmd = (options = {}) => createStatusCommand({ sessionIdOf: () => SESSION, ...options });

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
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
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
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
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
  state.sessionValues(SESSION, { create: true })['compact.at'] = 0.6; // 1M 下合法（native 0.8），128k 保守窗口下非法（0.375）
  state.setWindowProvider(() => ({
    current: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-bbbbbbbb', tokens: 131_072, observedAt: '2026-10-26T00:00:01.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const resolved = state.resolve(SESSION);
  assert.equal(resolved.window.native, 0.8, '展示/native 用 current');
  assert.equal(resolved.window.nativeConservative, 0.375, '校验用 conservative');
  assert.equal(resolved.window.validated, true);
  assert.equal(resolved.values['compact.at'], 0.30, '越界层被拒后回落到下一层');
  assert.equal(resolved.sources['compact.at'], 'plugin');
  assert.ok(resolved.invalid.some((item) =>
    item.source === 'session' && item.reason === 'window-shrunk' && item.key === 'compact.at'));
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
  const command = cmd({
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
  const resolved = state.resolve(SESSION);
  assert.equal(resolved.window.validated, false);
  assert.equal(resolved.values['compact.at'], 0.30);
  const line = summarizeWindow(resolved.window);
  assert.match(line, /current=unknown/);
  assert.match(line, /removed by request\/context/);
  assert.match(line, /unvalidated/);
  const command = cmd({ policy: state, guard: { status: guardStatus(null) }, now: () => new Date('2026-10-26T00:00:00Z') });
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
  const command = cmd({ policy: state, now: () => new Date('2026-10-26T00:00:00Z') });
  const rejected = await command.handler({ rawInput: 'set compact.at=0.55' });
  assert.equal(rejected.kind, 'error');
  assert.match(rejected.text, /above-effective-window/);
  const allowed = await command.handler({ rawInput: 'set compact.at=0.30' });
  assert.equal(allowed.kind, 'success');
});

test('0.2.1 验收#6：窗口观察/策略/状态全过程不产生任何压缩调用', () => {
  const { ctx, handlers, calls } = makeCtx();
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  const state = makePolicyState(() => guard.windowState);
  try {
    const first = session('session-aaaaaaaa-1111');
    handlers[0](first, { type: 'request/context', seq: 1, data: { contextWindow: 1_048_576 } });
    handlers[0](first, { type: 'request/context', seq: 2, data: { contextWindow: 131_072 } });
    handlers[0](first, { type: 'assistant/message', seq: 3, data: { usage: { inputTokens: 100_000 } } });
    state.resolve(SESSION);
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
  state.sessionValues(SESSION, { create: true })['compact.at'] = 0.6;
  const degenerateWindow = {
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  };
  state.setWindowProvider(() => degenerateWindow);
  const resolved = state.resolve(SESSION);
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
  const recovered = state.resolve(SESSION);
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
  const command = cmd({
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
    const auditFile = path.join(rootDir, 'memory', 'governance', 'audit.jsonl');
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

test('0.2.1 P3-11 退化时 /cg set 被拒：审计恰 1 条 + warn + status 可见；成功路径不误写 policy-invalid', async () => {
  const state = buildPolicyState(
    resolveConfig({ projectRoot: 'D:/tmp/window', policy: { reservedTokens: 256_000 } }),
    { readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
  );
  state.setWindowProvider(() => ({
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const records = [];
  const logs = [];
  const audit = {
    append: (event, details) => { records.push({ event, ...details }); },
    entries: () => records,
    file: null,
    maxBytes: null,
    sizeBytes: null,
    rotations: 0,
  };
  const logger = { warn: (...args) => logs.push(args.join(' ')) };
  const command = cmd({ policy: state, audit, logger, now: () => new Date('2026-10-26T00:00:00Z') });

  const rejected = await command.handler({ rawInput: 'set compact.at=0.5' });
  assert.equal(rejected.kind, 'error');
  const invalid = records.filter((record) => record.event === 'policy-invalid');
  assert.equal(invalid.length, 1, '退化拒绝设置必须恰 1 条 policy-invalid');
  assert.equal(invalid[0].source, 'session');
  assert.equal(invalid[0].code, 'compact.at');
  assert.equal(invalid[0].reason, 'native-uncomputable');
  assert.ok(logs.some((line) => /native-uncomputable/.test(line)), 'warn 必须出现');
  const status = await command.handler({ rawInput: 'status' });
  assert.match(status.text, /policy-invalid: 1 \(session\/compact\.at:native-uncomputable\)/);

  // 成功路径：正常 /cg set 只写 policy-set，不得误写 policy-invalid
  const ok = await command.handler({ rawInput: 'set compact.early=off' });
  assert.equal(ok.kind, 'success');
  assert.equal(records.filter((record) => record.event === 'policy-invalid').length, 1);
  assert.ok(records.some((record) => record.event === 'policy-set' && record.source === 'session' && record.key === 'compact.early'));
});

test('0.2.1 P2-3/P3-2/P3-7：拒绝项 transient——恢复后 status/show 双干净，再退化仍能再审计', async () => {
  let windowState = {
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  };
  const config = resolveConfig({ projectRoot: 'D:/tmp/window', policy: { reservedTokens: 256_000 } });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  state.setWindowProvider(() => windowState);
  const records = [];
  const logs = [];
  const audit = {
    append: (event, details) => { records.push({ event, ...details }); },
    entries: () => records,
    file: null,
    maxBytes: null,
    sizeBytes: null,
    rotations: 0,
  };
  const command = cmd({ policy: state, audit, logger: { warn: (...args) => logs.push(args.join(' ')) }, now: () => new Date('2026-10-26T00:00:00Z') });

  // episode 1：退化 → 拒 1 条
  const first = await command.handler({ rawInput: 'set compact.at=0.5' });
  assert.equal(first.kind, 'error');
  assert.equal(records.filter((r) => r.event === 'policy-invalid').length, 1);
  // 恢复 1M：status 与 show 都不得再显示
  windowState = {
    current: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:05.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:05.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  };
  const statusAfterRecover = await command.handler({ rawInput: 'status' });
  assert.doesNotMatch(statusAfterRecover.text, /policy-invalid:/);
  const showAfterRecover = await command.handler({ rawInput: 'policy show' });
  assert.match(showAfterRecover.text, /invalid: none/);
  assert.doesNotMatch(showAfterRecover.text, /rejected/);
  assert.equal(state.resolve(SESSION).invalid.length, 0, '恢复后 resolve() 不得再带该条');

  // episode 2：再次退化 → 还能再写 1 条（总计 2）
  windowState = {
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:09.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:09.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  };
  const second = await command.handler({ rawInput: 'set compact.at=0.5' });
  assert.equal(second.kind, 'error');
  assert.equal(records.filter((r) => r.event === 'policy-invalid').length, 2, '跨 episode 必须能再写审计');
});

test('0.2.1 P3-7（apply 路径）：windowViolations 去重 Set 恢复后清空，第二次拒层仍写审计', async () => {
  const rootDir = await tempDir('cg-window-set-');
  const handlers = [];
  const disposers = [];
  const ctx = {
    tools: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {} },
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    get: (name) => (name === 'commands' ? { register: () => () => {} } : undefined),
    effect: (callback) => { disposers.push(callback()); },
  };
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'window-set',
      compression: { enabled: true },
      policy: { reservedTokens: 16_384, values: { 'compact.at': 0.5 } },
    });
    const session = { id: 'session-aaaaaaaa', header: { id: 'session-aaaaaaaa', cwd: rootDir } };
    const feed = (window) => handlers[0](session, { type: 'request/context', seq: 1, data: { contextWindow: window } });
    feed(1_048_576); // 初始：0.5 <= 0.8
    feed(131_072);   // 第一次拒层：0.5 > 0.375 → audit 1
    feed(1_048_576); // 恢复：Set 应清空
    feed(131_072);   // 第二次拒层：必须再写 1 条 → audit 2
    const auditFile = path.join(rootDir, 'memory', 'governance', 'audit.jsonl');
    const records = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const rejected = records.filter((record) => record.event === 'policy-invalid' && record.reason === 'window-shrunk');
    assert.equal(rejected.length, 2, `跨 episode 必须写 2 条，实际 ${JSON.stringify(rejected)}`);
  } finally {
    for (const dispose of disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('0.2.1 P3-3：回落 builtin 0.6 > conservative 0.375 必须显式提示', () => {
  const config = resolveConfig({
    projectRoot: 'D:/tmp/window',
    policy: { reservedTokens: 16_384, values: { 'compact.at': 0.5 } },
  });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  state.setWindowProvider(() => ({
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [],
    source: 'projection',
    removed: false,
  }));
  const resolved = state.resolve(SESSION);
  assert.equal(resolved.values['compact.at'], 0.6);
  assert.ok(resolved.invalid.some((item) => item.source === 'builtin' && item.reason === 'fallback-over-native'));
  assert.equal(state.sessionRejections().length, 0);
});

test('0.2.1 P3-1：无观察时压力行标 config-fallback', async () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/window', policy: {} });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  const command = cmd({
    guard: { status: guardStatus({ measuredTokens: 100_000, estimatedTokens: 80_000 }) },
    policy: state,
    now: () => new Date('2026-10-26T00:00:00Z'),
  });
  const status = await command.handler({ rawInput: 'status' });
  assert.match(status.text, /pressure: .*window=1M \(config-fallback\)/);
});

test('0.2.1 P3-6：非法 contextWindow 值不当作删除，仅缺失才删', () => {
  const { ctx, handlers } = makeCtx();
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const session = { id: 'session-aaaaaaaa', header: { id: 'session-aaaaaaaa', cwd: process.cwd() } };
    handlers[0](session, { type: 'request/context', seq: 1, data: { contextWindow: 1_048_576 } });
    handlers[0](session, { type: 'request/context', seq: 2, data: { contextWindow: '1M' } });
    assert.equal(guard.windowState.current.tokens, 1_048_576, '非法值不能覆盖/删除旧值');
    assert.equal(guard.windowState.removed, false);
    assert.equal(guard.status.stats.windowInvalidObservations, 1);
    handlers[0](session, { type: 'request/context', seq: 3, data: {} });
    assert.equal(guard.windowState.current, null);
    assert.equal(guard.windowState.removed, true);
  } finally {
    guard.stop();
  }
});

test('0.2.1 P3-2：被拒会话覆盖在 status 标 (rejected)，恢复后消失', async () => {
  let windowState = {
    current: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:00.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt: '2026-10-26T00:00:00.000Z' },
    observed: [], source: 'projection', removed: false,
  };
  const config = resolveConfig({ projectRoot: 'D:/tmp/window', policy: { reservedTokens: 16_384, values: { 'compact.at': 0.30 } } });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  state.setWindowProvider(() => windowState);
  state.sessionValues(SESSION, { create: true })['compact.at'] = 0.6; // 1M 下合法（0.8）
  const command = cmd({ policy: state, now: () => new Date('2026-10-26T00:00:00Z') });
  const before = await command.handler({ rawInput: 'status' });
  assert.match(before.text, /policy-session: compact\.at=0\.6/);
  assert.doesNotMatch(before.text, /rejected/);

  windowState = {
    current: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:05.000Z' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 131_072, observedAt: '2026-10-26T00:00:05.000Z' },
    observed: [], source: 'projection', removed: false,
  };
  const rejectedStatus = await command.handler({ rawInput: 'status' });
  assert.match(rejectedStatus.text, /policy-session: compact\.at=0\.6\(rejected\)/);
  const rejectedShow = await command.handler({ rawInput: 'policy show' });
  assert.match(rejectedShow.text, /session: compact\.at=0\.6\(rejected\)/);
});

test('0.2.1 backfill：首次事件从 contextPressure 回填历史窗口，observedAt=历史事件时间，stateOf 每会话一次', () => {
  let stateOfCalls = 0;
  const projections = {
    stateOf: () => { stateOfCalls += 1; return { contextWindow: 1_048_576, surfaceTokens: 10 }; },
  };
  const handlers = [];
  const ctx = {
    get: (name) => (name === 'sessionProjections' ? projections : undefined),
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    logger: { info: () => {}, warn: () => {} },
  };
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const historyTime = 1792940246973;
    const session = {
      id: 'session-58a2e845-1111',
      header: { id: 'session-58a2e845-1111', cwd: process.cwd() },
      ownEvents: () => [{ type: 'request/context', time: historyTime, data: { contextWindow: 1_048_576 } }],
    };
    handlers[0](session, { type: 'assistant/message', seq: 5, data: { usage: { inputTokens: 1000 } } });
    const state = guard.windowState;
    assert.equal(state.current.tokens, 1_048_576);
    assert.equal(state.current.source, 'backfilled');
    assert.equal(state.source, 'projection(backfilled)');
    assert.equal(state.current.observedAt, new Date(historyTime).toISOString(), 'observedAt 必须是历史事件时间');
    assert.equal(state.conservative.tokens, 1_048_576);
    handlers[0](session, { type: 'assistant/message', seq: 6, data: { usage: { inputTokens: 1001 } } });
    assert.equal(stateOfCalls, 1, 'stateOf 每会话至多一次');
  } finally {
    guard.stop();
  }
});

test('0.2.1 backfill：无历史窗口/字段缺失/非法值都不伪造（仍 unknown + config-fallback）', () => {
  const run = (stateValue) => {
    let calls = 0;
    const projections = { stateOf: () => { calls += 1; return stateValue; } };
    const handlers = [];
    const ctx = {
      get: (name) => (name === 'sessionProjections' ? projections : undefined),
      on: (event, handler) => { handlers.push(handler); return () => {}; },
      logger: { info: () => {}, warn: () => {} },
    };
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
    guard.start();
    const session = { id: 'session-bbbbbbbb-2222', header: { id: 'session-bbbbbbbb-2222', cwd: process.cwd() }, ownEvents: () => [] };
    handlers[0](session, { type: 'assistant/message', seq: 1, data: {} });
    const state = guard.windowState;
    const stats = guard.status.stats;
    guard.stop();
    return { state, stats, calls };
  };
  const missing = run({ surfaceTokens: 3 });
  assert.equal(missing.state.current, null);
  assert.equal(missing.state.source, 'unknown');
  assert.equal(missing.calls, 1);
  const invalid = run({ contextWindow: '1M' });
  assert.equal(invalid.state.current, null, '非法历史值不得回填');
  assert.equal(invalid.stats.windowInvalidObservations, 1);
});

test('0.2.1 backfill：投影服务晚到会重试；实时 request/context 优先并回到 source=projection', () => {
  let available = false;
  const projections = { stateOf: () => ({ contextWindow: 1_048_576 }) };
  const handlers = [];
  const ctx = {
    get: (name) => (name === 'sessionProjections' && available ? projections : undefined),
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    logger: { info: () => {}, warn: () => {} },
  };
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const session = { id: 'session-cccccccc-3333', header: { id: 'session-cccccccc-3333', cwd: process.cwd() }, ownEvents: () => [] };
    handlers[0](session, { type: 'assistant/message', seq: 1, data: {} });
    assert.equal(guard.windowState.current, null, '服务未就绪不得回填');
    available = true;
    handlers[0](session, { type: 'assistant/message', seq: 2, data: {} });
    assert.equal(guard.windowState.current.source, 'backfilled');
    // 实时观察优先
    handlers[0](session, { type: 'request/context', seq: 3, data: { contextWindow: 1_048_576 } });
    assert.equal(guard.windowState.current.source, 'live');
    assert.equal(guard.windowState.source, 'projection');
  } finally {
    guard.stop();
  }
});

test('0.2.1 backfill：/cg status 显示 source=projection(backfilled) + 历史 observed + native=0.6934', async () => {
  const historyTime = 1792940246973;
  const config = resolveConfig({ projectRoot: 'D:/tmp/window', policy: {} });
  const state = buildPolicyState(config, {
    readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  state.setWindowProvider(() => ({
    current: { sessionId: 'session-58a2e845', tokens: 1_048_576, observedAt: new Date(historyTime).toISOString(), source: 'backfilled' },
    conservative: { sessionId: 'session-58a2e845', tokens: 1_048_576, observedAt: new Date(historyTime).toISOString(), source: 'backfilled' },
    observed: [], source: 'projection(backfilled)', removed: false,
  }));
  const command = cmd({
    guard: { status: guardStatus({ measuredTokens: 500_000, estimatedTokens: 400_000 }) },
    policy: state,
    now: () => new Date('2026-10-26T00:00:00Z'),
  });
  const status = await command.handler({ rawInput: 'status' });
  assert.match(status.text, /window: current=1M \(session 58a2e845\) observed 2026-10-25T/);
  assert.match(status.text, /source=projection\(backfilled\)/);
  assert.match(status.text, /native-current=0\.6934\(projection\(backfilled\)\)/);
  assert.match(status.text, /native-conservative=0\.6934 validated/);
  assert.match(status.text, /pressure: .*window=1M \(session 58a2e845, backfilled\)/);
});

test('0.2.1 P3-12/P3-13 三来源字符串：backfilled/live/config 各自可辨、同行不叠两套括注', async () => {
  const render = async (window) => {
    const state = buildPolicyState(
      resolveConfig({ projectRoot: 'D:/tmp/window', policy: {} }),
      { readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
    );
    state.setWindowProvider(() => window);
    const command = cmd({
      guard: { status: guardStatus({ measuredTokens: 100_000, estimatedTokens: 80_000 }) },
      policy: state,
      now: () => new Date('2026-10-26T00:00:00Z'),
    });
    return (await command.handler({ rawInput: 'status' })).text;
  };
  const observedAt = '2026-10-25T08:00:00.000Z';
  const backfilled = await render({
    current: { sessionId: 'session-58a2e845', tokens: 1_048_576, observedAt, source: 'backfilled' },
    conservative: { sessionId: 'session-58a2e845', tokens: 1_048_576, observedAt, source: 'backfilled' },
    observed: [], source: 'projection(backfilled)', removed: false,
  });
  assert.match(backfilled, /native-current=0\.6934\(projection\(backfilled\)\)/);
  assert.match(backfilled, /pressure: .*window=1M \(session 58a2e845, backfilled\)/);

  const live = await render({
    current: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt, source: 'live' },
    conservative: { sessionId: 'session-aaaaaaaa', tokens: 1_048_576, observedAt, source: 'live' },
    observed: [], source: 'projection', removed: false,
  });
  assert.match(live, /native-current=0\.6934\(projection\)/);
  assert.match(live, /pressure: .*window=1M \(session aaaaaaaa\)/);
  assert.doesNotMatch(live, /backfilled/);

  const fallback = await render(null);
  assert.match(fallback, /native-current=0\.6785\(config-fallback\)/);
  assert.match(fallback, /pressure: .*window=1M \(config-fallback\)/);
});

test('0.2.1 P2-5 真机形态：sessionProjections 属性 getter 抛错、ctx.get 可用 → 回填成功', () => {
  let stateOfCalls = 0;
  const projections = { stateOf: () => { stateOfCalls += 1; return { contextWindow: 1_048_576 }; } };
  const handlers = [];
  const ctx = {
    get: (name) => (name === 'sessionProjections' ? projections : undefined),
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    logger: { info: () => {}, warn: () => {} },
  };
  Object.defineProperty(ctx, 'sessionProjections', {
    get() { throw new Error('proxy service property throws'); },
  });
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const session = { id: 'session-58a2e845-1111', header: { id: 'session-58a2e845-1111', cwd: process.cwd() }, ownEvents: () => [] };
    handlers[0](session, { type: 'assistant/message', seq: 1, data: {} });
    assert.equal(guard.windowState.current?.tokens, 1_048_576, 'getter 抛错不能短路 ctx.get');
    assert.equal(guard.windowState.current?.source, 'backfilled');
    assert.equal(stateOfCalls, 1);
  } finally {
    guard.stop();
  }
});

test('0.2.1 P2-5 tokenMeter 同形态：属性 getter 抛错、ctx.get 可用 → 估算仍可读', () => {
  const meter = { measure: () => ({ nodes: [{ tokens: 400_000 }] }) };
  const handlers = [];
  const ctx = {
    get: (name) => (name === 'tokenMeter' ? meter : undefined),
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    logger: { info: () => {}, warn: () => {} },
  };
  Object.defineProperty(ctx, 'tokenMeter', { get() { throw new Error('proxy service property throws'); } });
  const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const session = { id: 'session-aaaaaaaa-2222', header: { id: 'session-aaaaaaaa-2222', cwd: process.cwd() } };
    handlers[0](session, { type: 'assistant/message', seq: 2, data: { usage: { inputTokens: 5_000 } } });
    assert.equal(guard.pressure().estimatedTokens, 400_000, 'tokenMeter 取法也不能被抛错短路');
  } finally {
    guard.stop();
  }
});

test('0.2.1 P2-5 回填诊断：区分“服务取不到”与“state 无窗口”各记一条', () => {
  const run = (ctxExtra, label) => {
    const logs = [];
    const handlers = [];
    const ctx = {
      on: (event, handler) => { handlers.push(handler); return () => {}; },
      logger: { info: (...args) => logs.push(args.join(' ')), warn: () => {} },
      ...ctxExtra,
    };
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3' });
    guard.start();
    const session = { id: 'session-cccccccc-3333', header: { id: 'session-cccccccc-3333', cwd: process.cwd() }, ownEvents: () => [] };
    handlers[0](session, { type: 'assistant/message', seq: 1, data: {} });
    handlers[0](session, { type: 'assistant/message', seq: 2, data: {} });
    guard.stop();
    return logs.filter((line) => line.includes('window backfill:'));
  };
  const unavailable = run({ get: () => { throw new Error('not ready'); } });
  assert.ok(unavailable.some((line) => /sessionProjections-unavailable/.test(line)), JSON.stringify(unavailable));
  assert.equal(unavailable.length, 1, '每会话/每原因只记一条');
  const noWindow = run({ get: (name) => (name === 'sessionProjections' ? { stateOf: () => ({}) } : undefined) });
  assert.ok(noWindow.some((line) => /contextWindow-absent/.test(line)), JSON.stringify(noWindow));
});
