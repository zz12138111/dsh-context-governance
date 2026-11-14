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

test('C11 客户端渲染文本三态（builtin / plugin / session 覆盖）', async () => {
  const captured = [];
  const fakeWindow = {
    __ModuleLoader__: { load: (spec) => captured.push(spec) },
  };
  const previousWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    await import(pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(captured.length, 1, 'client.js 必须自执行 load');
  const spec = captured[0];
  assert.equal(spec.id, 'dsh-context-governance');
  const stubReact = { createElement: () => null, useState: () => ['', () => {}], useEffect: () => {} };
  const exports = spec.factory((name) => {
    assert.equal(name, 'react');
    return stubReact;
  });
  assert.equal(exports.apply.length, 1);

  const builtin = exports.renderPolicyText({ at: 0.6, source: 'builtin', effectiveAt: EFFECTIVE_AT_TEXT });
  assert.match(builtin, /60%/);
  assert.match(builtin, /builtin/);
  assert.match(builtin, new RegExp(EFFECTIVE_AT_TEXT.replace(/[()]/g, '\\$&')));
  const plugin = exports.renderPolicyText({ at: 0.55, source: 'plugin', effectiveAt: EFFECTIVE_AT_TEXT });
  assert.match(plugin, /55%/);
  assert.match(plugin, /plugin/);
  const session = exports.renderPolicyText({ at: 0.5, source: 'session', effectiveAt: EFFECTIVE_AT_TEXT });
  assert.match(session, /50%/);
  assert.match(session, /session/);
  assert.match(exports.renderPolicyText({}, {}), /unknown/);

  assert.equal(exports.toRatio('55'), 0.55);
  assert.equal(exports.toRatio('101'), null);
  assert.equal(exports.validateRatio(0.55), null);
  assert.match(exports.validateRatio(0.15), /下限 0\.2/);
  assert.match(exports.validateRatio(0.25), /lowThresholdAck/);
  assert.match(exports.validateRatio(null), /0–100/);
});
