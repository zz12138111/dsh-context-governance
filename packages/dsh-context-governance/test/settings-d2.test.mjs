/**
 * 1.1.0 D2（C8-C11）：设置页百分比换算 / 校验复用 / 快照视图与只读路由 / 多根策略热更新 / 客户端渲染文本。
 * 宿主侧与 client 侧都在纯 Node 里可测；真机渲染由窗口 R7 验（本仓不装插件）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { RootGuardPool } from '../src/compress/root-guards.js';
import {
  EFFECTIVE_AT_TEXT,
  createSnapshotHandler,
  mergeSettingsAt,
  percentToRatio,
  policySnapshot,
  ratioToPercentText,
  readVolatileAt,
} from '../src/settings-policy.js';

const volatile = (value) => ({ get: () => value });

test('C8 百分比换算：55 ↔ 0.55、边界 0/100、越界/非数字拒绝', () => {
  assert.equal(percentToRatio('55'), 0.55);
  assert.equal(percentToRatio(60), 0.6);
  assert.equal(percentToRatio('0'), 0);
  assert.equal(percentToRatio('100'), 1);
  assert.equal(percentToRatio('101'), null);
  assert.equal(percentToRatio('-1'), null);
  assert.equal(percentToRatio('abc'), null);
  assert.equal(percentToRatio(''), 0); // Number('') === 0 —— 空串按 0 处理，由校验层拒绝（<0.20）
  assert.equal(ratioToPercentText(0.55), '55%');
  assert.equal(ratioToPercentText(null), '—');
});

test('C8/C9 设置值合入 plugin 层：只读 volatile 引用、缺省不改变 config', () => {
  const base = { policy: { values: { 'compact.at': 0.6 }, windowTokens: 1000, reservedTokens: 100 } };
  assert.equal(readVolatileAt({ policy: { at: volatile(0.55) } }), 0.55);
  assert.equal(readVolatileAt({ policy: { at: 0.7 } }), 0.7);
  assert.equal(readVolatileAt({ policy: {} }), null);
  assert.equal(readVolatileAt(null), null);

  const merged = mergeSettingsAt({ ...base, policy: { ...base.policy, at: volatile(0.55) } });
  assert.equal(merged.policy.values['compact.at'], 0.55);
  assert.equal(merged.policy.values.windowTokens, undefined);
  assert.equal(base.policy.values['compact.at'], 0.6, '不得改动入参');

  assert.deepEqual(mergeSettingsAt(base), base, '无 policy.at 时原样返回');
});

test('C9 快照视图：at/source/sessionOverride/effectiveAt/native 五键，来源层原样透出', () => {
  const policy = { values: { 'compact.at': 0.55 }, sources: { 'compact.at': 'plugin' } };
  const view = policySnapshot(policy, { native: 0.6785 });
  assert.deepEqual(Object.keys(view).sort(), ['at', 'effectiveAt', 'native', 'sessionOverride', 'source']);
  assert.equal(view.at, 0.55);
  assert.equal(view.source, 'plugin');
  assert.equal(view.sessionOverride, null);
  assert.equal(view.native, 0.6785);
  assert.equal(view.effectiveAt, EFFECTIVE_AT_TEXT);

  const session = policySnapshot({ values: { 'compact.at': 0.5 }, sources: { 'compact.at': 'session' } });
  assert.equal(session.source, 'session');
  assert.equal(session.sessionOverride, 0.5);
});

test('C10 只读快照路由：GET 200 JSON、非 GET 405、无副作用', () => {
  const calls = [];
  const res = () => {
    const record = { status: 0, headers: null, body: '' };
    return {
      record,
      writeHead(code, headers) { record.status = code; record.headers = headers ?? null; },
      end(body) { record.body = body ?? ''; },
    };
  };
  const handler = createSnapshotHandler({
    getPolicy: () => { calls.push('get'); return { values: { 'compact.at': 0.6 }, sources: { 'compact.at': 'builtin' } }; },
    getNative: () => 0.6785,
  });

  const ok = res();
  handler({ method: 'GET' }, ok);
  assert.equal(ok.record.status, 200);
  assert.match(ok.record.headers['content-type'], /application\/json/);
  const body = JSON.parse(ok.record.body);
  assert.equal(body.at, 0.6);
  assert.equal(body.source, 'builtin');
  assert.equal(calls.length, 1);

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const denied = res();
    handler({ method }, denied);
    assert.equal(denied.record.status, 405, method);
    assert.equal(denied.record.body, '');
  }
  assert.equal(calls.length, 1, '405 不得触发取值');
});

const entry = (rootId, root) => ({ rootId, root, project: 'p', state: 'active', name: 'p', memoryRoot: 'memory' });

function makePool(roots) {
  const guards = [];
  const pool = new RootGuardPool({
    ctx: { logger: { info() {}, warn() {}, error() {} } },
    registry: { resolveSessionRoot: (session) => {
      const found = roots[session?.cwd];
      return found === undefined
        ? { status: 'no-root', entry: null, isSubagent: false, cwd: session?.cwd ?? null }
        : { status: 'managed', entry: found, isSubagent: false, cwd: session.cwd };
    } },
    storePool: {
      async pin(rootEntry) {
        return {
          entry: rootEntry,
          store: { rootDir: rootEntry.root },
          audit: { rows: [], append() { return true; } },
          release() {},
        };
      },
    },
    createGuard: async (rootEntry, resources) => {
      const guard = { events: [], status: { stats: { pending: 0 } }, handleEvent() {}, stop() {} };
      guards.push({ entry: rootEntry, guard });
      return { guard, policy: { root: rootEntry.root, mark: 'initial' }, audit: resources.audit };
    },
    idleMs: 1000,
  });
  return { pool, guards };
}

test('C11 多根策略热更新：单 root 生效、两 root 不串、来源层随新策略变化', async () => {
  const roots = { A: entry('root-a', 'D:/work/a'), B: entry('root-b', 'D:/work/b') };
  const { pool } = makePool(roots);
  await pool.ensure(roots.A);
  await pool.ensure(roots.B);
  assert.equal(pool.policyForSessionId('x'), null);
  const policyA1 = pool.policyForSession({ cwd: 'A' });
  const policyB1 = pool.policyForSession({ cwd: 'B' });
  assert.equal(policyA1.mark, 'initial');
  assert.equal(policyB1.mark, 'initial');

  const nextA = { root: 'D:/work/a', mark: 'reloaded', values: { 'compact.at': 0.55 }, sources: { 'compact.at': 'plugin' } };
  assert.equal(pool.updatePolicy('root-a', nextA), true);
  assert.equal(pool.updatePolicy('root-missing', nextA), false);

  assert.deepEqual(pool.policyForSession({ cwd: 'A' }), nextA, 'A 应拿到新策略');
  assert.equal(pool.policyForSession({ cwd: 'B' }).mark, 'initial', 'B 不得被串改');
  assert.equal(pool.policyForSession({ cwd: 'B' }).sources, undefined);
});
// ---- 入口形态 A（C12-C15）：手写 client bundle 的纯函数与注册计划 ----

async function loadClient() {
  const captured = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href + `?t=${Date.now()}`);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(captured.length, 1, 'client.js 必须自执行 load');
  assert.equal(captured[0].id, 'dsh-context-governance');
  const reactStub = { createElement: () => null, useState: (initial) => [initial, () => {}], useEffect: () => {} };
  const exports = captured[0].factory((name) => {
    assert.equal(name, 'react');
    return reactStub;
  });
  return exports;
}

test('C12 主入口：dock 条目 id/order + chip 文案与快照一致（缺快照 → 压 —）', async () => {
  const client = await loadClient();
  const plan = client.registrationPlan({});
  const dock = plan.find((entry) => entry.slot === 'conversation.composer.dock');
  assert.ok(dock, '必须注册 conversation.composer.dock');
  assert.equal(dock.id, 'context-governance.at');
  assert.equal(dock.order, 6, '排在 usage(order 1) 之后');
  assert.ok(plan.some((entry) => entry.slot === 'conversation.input.overlay'), '必须注册输入框气泡');
  assert.ok(plan.some((entry) => entry.slot === 'settings.section'), '保留设置页入口');

  assert.equal(client.chipLabel({ at: 0.65, source: 'plugin' }), '压 65%');
  assert.equal(client.chipLabel({ at: 0.6 }), '压 60%');
  assert.equal(client.chipLabel(null), '压 —');
  assert.equal(client.chipLabel({}), '压 —');
  assert.equal(client.chipLabel({ at: 0.65 }, 'en'), 'At 65%');
});

test('C13 气泡三行：当前生效 / 来源层 / 生效时点', async () => {
  const client = await loadClient();
  const text = client.renderBubbleText({ at: 0.55, source: 'plugin', effectiveAt: EFFECTIVE_AT_TEXT });
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /55%/);
  assert.match(lines[1], /plugin/);
  assert.match(lines[2], new RegExp(EFFECTIVE_AT_TEXT.replace(/[()]/g, '\\$&')));
  assert.match(client.renderBubbleText({}, {}), /unknown/);
});

test('C14 保存前计算：校验与 /cg set 同源（<20% / <30% ack / 项目层 <45% / native 上限）', async () => {
  const client = await loadClient();
  assert.deepEqual(client.computeSave('55', { at: 0.6, source: 'plugin' }), { ok: true, ratio: 0.55 });
  assert.equal(client.computeSave('60', {}).ratio, 0.6);

  const low = client.computeSave('15', {});
  assert.equal(low.ok, false);
  assert.match(low.reason, /下限 0\.2/);
  const ack = client.computeSave('25', {});
  assert.equal(ack.ok, false);
  assert.match(ack.reason, /lowThresholdAck/);
  const project = client.computeSave('44', { source: 'project' });
  assert.equal(project.ok, false);
  assert.match(project.reason, /下限 0\.45/);
  const ceiling = client.computeSave('66', { native: 0.6785 });
  assert.equal(ceiling.ok, false);
  assert.match(ceiling.reason, /上限 0\.66/);
  const over = client.computeSave('101', {});
  assert.equal(over.ok, false);
  assert.match(over.reason, /0–100/);
});

test('C15 降级鲁棒：slot 缺失/注册抛错不崩，三处入口各自独立', async () => {
  const client = await loadClient();
  const registered = [];
  client.apply({
    locale: { language: 'zh' },
    slots: { register: (spec) => { if (spec.name === 'conversation.input.overlay') throw new Error('slot missing'); registered.push(spec.name); } },
  });
  assert.deepEqual(registered, ['conversation.composer.dock', 'settings.section'], '一个 slot 抛错不得中断其余入口');

  const none = [];
  client.apply({ slots: undefined });
  assert.deepEqual(none, [], '无 slots 时静默退化（不抛错）');
  assert.equal(client.chipLabel(null), '压 —');
  assert.equal(client.inject.includes('configForms'), true, '卡片的写入口仍是 configForms');
  assert.equal(client.inject.includes('estimateSafety'), false, '安全参数不在客户端注入面');
});
