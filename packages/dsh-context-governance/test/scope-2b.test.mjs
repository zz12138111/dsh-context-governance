/**
 * 1.0 #1/#2（2b 第一批）：作用域纯函数 + B-2 `unknown` 口径。
 *
 * 本文件只覆盖不依赖真机 armed 前提的部分（审核已定口径）：
 * - `resolveScope` 三枚举互斥、onlyProject 不扩大作用域、out-of-scope 与位置无关；
 * - `early-forced.compaction`：无 fresh report → `unknown`，有报告才 `committed`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { wireEarlyCompaction } from '../src/compress/early-wiring.js';
import { shortSessionId } from '../src/policy.js';
import { SCOPE_MODE, SCOPE_SKIP, resolveScope } from '../src/scope.js';

const ROOT = 'D:\\DS-PROJECT\\DSH插件开发';
const OUTSIDE = 'G:\\DS-HARNESS';

test('2b 作用域：根内/根外/根未知/cwd 空 的 governed 与 skipReason', () => {
  const inside = resolveScope({ root: ROOT, cwd: `${ROOT}\\src` });
  assert.equal(inside.mode, SCOPE_MODE.SINGLE_ROOT);
  assert.equal(inside.governed, true);
  assert.equal(inside.skipReason, null);
  assert.equal(inside.unattributed, false);

  const atRoot = resolveScope({ root: ROOT, cwd: ROOT });
  assert.equal(atRoot.governed, true);
  assert.equal(atRoot.skipReason, null);

  const driveCase = resolveScope({ root: 'd:\\ds-project\\dsh插件开发', cwd: `${ROOT}\\src` });
  assert.equal(driveCase.governed, process.platform === 'win32', 'Windows 大小写/盘符应归一');

  const outside = resolveScope({ root: ROOT, cwd: OUTSIDE });
  assert.equal(outside.governed, false);
  assert.equal(outside.skipReason, SCOPE_SKIP.UNMANAGED, 'P1 非主根 = unmanaged-root（不再有 foreign-session）');

  const noRoot = resolveScope({ root: null, cwd: OUTSIDE });
  assert.equal(noRoot.mode, SCOPE_MODE.UNRESOLVED);
  assert.equal(noRoot.governed, false);
  assert.equal(noRoot.skipReason, SCOPE_SKIP.NO_ROOT);
  assert.equal(noRoot.root, null);

  const noCwd = resolveScope({ root: ROOT, cwd: '' });
  assert.equal(noCwd.governed, false, 'B：空 cwd fail-closed（不再放行给主根）');
  assert.equal(noCwd.unattributed, true);
  assert.equal(noCwd.skipReason, SCOPE_SKIP.NO_ROOT);
});

test('2b 作用域：三枚举互斥（同一入参只出现一个 skipReason）', () => {
  const cases = [
    { root: ROOT, cwd: `${ROOT}\\src`, earlyEnabled: true },
    { root: ROOT, cwd: OUTSIDE, earlyEnabled: true },
    { root: null, cwd: OUTSIDE, earlyEnabled: true },
    { root: ROOT, cwd: `${ROOT}\\src`, earlyEnabled: false },
    { root: ROOT, cwd: OUTSIDE, earlyEnabled: false },
    { root: null, cwd: OUTSIDE, earlyEnabled: false },
    { root: ROOT, cwd: '', earlyEnabled: true },
    { root: ROOT, cwd: OUTSIDE, managed: false, earlyEnabled: true },
  ];
  const allowed = new Set([SCOPE_SKIP.UNMANAGED, SCOPE_SKIP.NO_ROOT, SCOPE_SKIP.OUT_OF_SCOPE, null]);
  for (const input of cases) {
    const scope = resolveScope(input);
    assert.equal(allowed.has(scope.skipReason), true, `非法 skipReason：${String(scope.skipReason)}`);
    const hits = [SCOPE_SKIP.UNMANAGED, SCOPE_SKIP.NO_ROOT, SCOPE_SKIP.OUT_OF_SCOPE]
      .filter((reason) => reason === scope.skipReason).length;
    assert.ok(hits <= 1, `skipReason 必须互斥，输入=${JSON.stringify(input)}`);
  }
  // 根内 + 策略关闭：governed 仍为真（保护/观测照常），只是提前压 out-of-scope。
  const insideDisabled = resolveScope({ root: ROOT, cwd: `${ROOT}\\src`, earlyEnabled: false });
  assert.equal(insideDisabled.governed, true);
  assert.equal(insideDisabled.skipReason, SCOPE_SKIP.OUT_OF_SCOPE);
});

test('2b 作用域：out-of-scope 与位置无关；managed=false 优先于位置', () => {
  const inside = resolveScope({ root: ROOT, cwd: `${ROOT}\\src`, earlyEnabled: false });
  const outside = resolveScope({ root: ROOT, cwd: OUTSIDE, earlyEnabled: false });
  assert.equal(inside.skipReason, SCOPE_SKIP.OUT_OF_SCOPE);
  assert.equal(outside.skipReason, SCOPE_SKIP.OUT_OF_SCOPE, '策略层禁用时根外也报 out-of-scope');

  // P1：非主根（managed=false）即使在根内也不纳管；onlyProject 已弃用、不参与判定。
  const unmanagedInside = resolveScope({ root: ROOT, cwd: `${ROOT}\\src`, managed: false });
  assert.equal(unmanagedInside.governed, false);
  assert.equal(unmanagedInside.skipReason, SCOPE_SKIP.UNMANAGED);
  const legacyOffInside = resolveScope({ root: ROOT, cwd: `${ROOT}\\src`, onlyProject: false });
  assert.equal(legacyOffInside.skipReason, null);
  assert.equal(legacyOffInside.governed, true);
});

// ---------------------------------------------------------------- B-2

function makeCtx({ agent = { session: { id: 's1' } }, engine = null } = {}) {
  const handlers = [];
  const ctx = {
    on: (event, handler) => { handlers.push({ event, handler }); return () => {}; },
    get: (service) => {
      if (service === 'agents') return { list: () => (agent === null ? [] : [agent]) };
      if (service === 'agentPresets') return engine === null ? null : { serviceFor: () => engine };
      return null;
    },
  };
  return { ctx, handlers };
}

function makeGuard({ measuredTokens = 680000, estimatedTokens = 400000, pending = 0, lastReport = null } = {}) {
  return { status: { pressure: { measuredTokens, estimatedTokens }, stats: { pending }, lastReport } };
}

const POLICY = {
  early: true,
  values: { 'compact.at': 0.6, 'compact.estimateSafety': 1.35 },
  window: { currentTokens: 1048576, native: 0.6934 },
};

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
}

test('2b B-2：accepted 但无 fresh report → compaction=unknown（不得写 committed）', async () => {
  const guard = makeGuard({
    lastReport: { compactionId: 'old', compaction: 'committed', protection: 'ok', failures: [], reinjected: true },
  });
  const engine = { calls: 0, async compactNow() { this.calls += 1; } };
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await wiring.check({ id: 's1' });
  assert.equal(engine.calls, 1);
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.ok(forced, '应写 early-forced');
  assert.equal(forced.compaction, 'unknown');
  assert.equal(forced.protection, null);
  assert.equal(audit.entries.some((entry) => entry.compaction === 'committed'), false, '不得回退 committed');
});

test('2b B-2：accepted 且有 fresh report → compaction 采用报告枚举（committed）', async () => {
  const guard = makeGuard({ lastReport: { compactionId: 'old', compaction: 'skipped', protection: 'ok', failures: [], reinjected: null } });
  const engine = {
    calls: 0,
    async compactNow() {
      this.calls += 1;
      guard.status.lastReport = {
        compactionId: 'new', compaction: 'committed', protection: 'ok', failures: [], reinjected: true,
      };
    },
  };
  const { ctx } = makeCtx({ engine });
  const audit = makeAudit();
  const wiring = wireEarlyCompaction({
    ctx, getGuard: () => guard, getPolicy: () => POLICY, audit, getArmed: () => true, now: () => 0,
  });
  await wiring.check({ id: 's1' });
  const forced = audit.entries.find((entry) => entry.event === 'early-forced');
  assert.equal(forced.compaction, 'committed');
  assert.equal(forced.protection, 'ok');
});

// ---------------------------------------------------------------- 接线顺序（armed→policy→scope→pressure）

function scopeFor(session, earlyEnabled = true) {
  return resolveScope({ root: ROOT, cwd: session?.cwd, earlyEnabled });
}

function makeScopeWiring({ guard = makeGuard(), policy = POLICY, audit = makeAudit(), engine = null } = {}) {
  const built = makeCtx({ engine });
  const wiring = wireEarlyCompaction({
    ctx: built.ctx,
    getGuard: () => guard,
    getPolicy: () => policy,
    audit,
    getArmed: () => true,
    getScope: (session) => scopeFor(session, policy.early !== false),
    now: () => 0,
  });
  return { wiring, audit, engine };
}

test('2b 接线：外部会话 + 已知压力 → compactNow=0、无 early-forced、reason=unmanaged-root', async () => {
  const engine = { calls: 0, async compactNow() { this.calls += 1; } };
  const audit = makeAudit();
  const { wiring } = makeScopeWiring({ engine, audit });
  await wiring.check({ id: 's-external', cwd: OUTSIDE });
  assert.equal(engine.calls, 0);
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-skipped']);
  assert.equal(audit.entries[0].reason, SCOPE_SKIP.UNMANAGED);
  assert.equal(audit.entries[0].sessionId, 's-external');
  assert.equal(audit.entries[0].sessionShortId, shortSessionId('s-external'));
  assert.equal(wiring.getLast().event, 'early-skipped');
});

test('2b 接线：外部会话 + unknown 压力 → 仍是 unmanaged-root（不是 unknown-pressure）', async () => {
  const engine = { calls: 0, async compactNow() { this.calls += 1; } };
  const audit = makeAudit();
  const { wiring } = makeScopeWiring({
    engine, audit, guard: makeGuard({ measuredTokens: null, estimatedTokens: null }),
  });
  await wiring.check({ id: 's-external', cwd: OUTSIDE });
  assert.equal(engine.calls, 0);
  assert.equal(audit.entries[0].reason, SCOPE_SKIP.UNMANAGED);
  assert.notEqual(audit.entries[0].reason, 'unknown-pressure');
});

test('2b 接线：本项目 + 已知压力 → early-forced；本项目 + unknown → unknown-pressure', async () => {
  const engine = {
    calls: 0,
    async compactNow() {
      this.calls += 1;
      guard.status.lastReport = {
        compactionId: 'new', compaction: 'committed', protection: 'ok', failures: [], reinjected: true,
      };
    },
  };
  const guard = makeGuard({ lastReport: { compactionId: 'old', compaction: 'committed', protection: 'ok', failures: [], reinjected: true } });
  const audit = makeAudit();
  const { wiring } = makeScopeWiring({ engine, audit, guard });
  await wiring.check({ id: 's1', cwd: `${ROOT}\\src` });
  assert.equal(engine.calls, 1);
  assert.deepEqual(audit.entries.map((entry) => entry.event), ['early-decision', 'early-forced']);

  const unknownAudit = makeAudit();
  const unknown = makeScopeWiring({
    guard: makeGuard({ measuredTokens: null, estimatedTokens: null }),
    audit: unknownAudit,
    engine: { calls: 0, async compactNow() {} },
  });
  await unknown.wiring.check({ id: 's1', cwd: `${ROOT}\\src` });
  assert.deepEqual(unknownAudit.entries.map((entry) => entry.event), ['early-decision', 'early-skipped']);
  assert.equal(unknownAudit.entries.at(-1).reason, 'unknown-pressure');
});

test('2b 接线：总闸 early=false → out-of-scope（根内/根外一致），不取 pressure', async () => {
  for (const cwd of [`${ROOT}\\src`, OUTSIDE]) {
    const engine = { calls: 0, async compactNow() { this.calls += 1; } };
    const audit = makeAudit();
    const { wiring } = makeScopeWiring({ engine, audit, policy: { ...POLICY, early: false } });
    await wiring.check({ id: 's1', cwd });
    assert.equal(engine.calls, 0);
    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0].event, 'early-skipped');
    assert.equal(audit.entries[0].reason, SCOPE_SKIP.OUT_OF_SCOPE);
  }
});

