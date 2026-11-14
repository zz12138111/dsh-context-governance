/**
 * 1.1.0 D2（C8-C11）：设置页百分比换算 / 校验复用 / 快照视图与只读路由 / 多根策略热更新 / 客户端渲染文本。
 * 宿主侧与 client 侧都在纯 Node 里可测；真机渲染由窗口 R7 验（本仓不装插件）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { mountSnapshotRoute } from '../src/index.js';
import { RootGuardPool } from '../src/compress/root-guards.js';
import {
  PERSISTENT_LIFECYCLE_TEXT,
  createSnapshotHandler,
  createSnapshotPolicyResolver,
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
  assert.equal(view.effectiveAt, PERSISTENT_LIFECYCLE_TEXT);

  const session = policySnapshot({ values: { 'compact.at': 0.5 }, sources: { 'compact.at': 'session' } });
  assert.equal(session.source, 'session');
  assert.equal(session.sessionOverride, 0.5);
  assert.equal(session.effectiveAt, '本会话有效，重启后失效', 'C8：session 层必须用会话有效期文案');
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

let clientImportSeq = 0;
async function loadClient() {
  const captured = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href + `?v=${clientImportSeq += 1}`);
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

test('C13/C8/C11 气泡四行：当前生效 / 来源层 / 生命周期（随 source 派生）/ 写入层（静态）', async () => {
  const client = await loadClient();
  const text = client.renderBubbleText({ at: 0.55, source: 'plugin' });
  const lines = text.split('\n');
  assert.equal(lines.length, 4, 'C13 三行信息 + C11 写入层 = 四行');
  assert.match(lines[0], /55%/);
  assert.match(lines[1], /plugin/);
  assert.equal(lines[2], `生效时点: ${PERSISTENT_LIFECYCLE_TEXT}`, '持久层：保存后生效、重启仍有效');
  assert.equal(lines[3], '本次修改写入：plugin 层（profile patch）', 'C11：静态写入层文案');

  const sessionText = client.renderBubbleText({ at: 0.5, source: 'session' });
  assert.match(sessionText, /本会话有效，重启后失效/, 'C8：session 必须用会话生命周期文案');
  assert.equal(client.effectiveTextFor('session'), '本会话有效，重启后失效');
  assert.equal(client.effectiveTextFor('plugin'), '保存后生效、重启仍有效');
  assert.match(client.renderBubbleText({}, {}), /unknown/);
});

test('C14 保存调用注入面：走 configForms.set / mutate，不可用返回 false（不抛）', async () => {
  const client = await loadClient();
  const calls = [];
  const setContext = {
    configForms: { get: (id) => ({ set: (field, value) => { calls.push([id, field, value]); return Promise.resolve(); } }) },
  };
  assert.equal(await client.saveRatio(setContext, 0.55), true);
  assert.deepEqual(calls, [['dsh-context-governance', 'policy.at', 0.55]]);

  const mutateCalls = [];
  const mutateContext = {
    configForms: { get: () => ({ revision: 7, mutate: (ops, revision) => { mutateCalls.push([ops, revision]); return Promise.resolve(); } }) },
  };
  assert.equal(await client.saveRatio(mutateContext, 0.6), true);
  assert.deepEqual(mutateCalls, [[[{ path: 'policy.at', value: 0.6 }], 7]]);

  assert.equal(await client.saveRatio({}, 0.5), false, '无 configForms → false');
  const throwing = { configForms: { get: () => ({ set: () => { throw new Error('rejected'); } }) } };
  assert.equal(await client.saveRatio(throwing, 0.5), false, '写入抛错 → false（不崩）');
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

test('C17 迟挂 slots：先 inject 等声明，声明后 register 成功；注册抛错带 slot 名 warn 不吞', async () => {
  const client = await loadClient();
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try {
    const injected = [];
    const registered = [];
    const disposers = [];
    const ctx = {
      locale: { language: 'zh' },
      get: () => undefined,
      effect: (factory) => { disposers.push(factory()); },
      slots: {
        inject: (slot, callback) => { injected.push({ slot, callback }); return () => {}; },
        register: (spec) => { if (spec.name === 'conversation.input.overlay') throw new Error('slot not declared'); registered.push(spec.name); },
      },
    };
    client.apply(ctx);
    assert.deepEqual(injected.map((item) => item.slot), ['conversation.composer.dock', 'conversation.input.overlay', 'settings.section'],
      '三处入口各自 inject 等声明（不是直调 register）');
    assert.deepEqual(registered, [], '声明之前不得 register');

    // 模拟宿主随后声明 docks 与 settings.section：回调触发后注册成功；overlay 回调用同一 register（会抛 → 必须 warn）。
    for (const item of injected) {
      try { item.callback(); } catch { /* callback 内部已由 apply 包装的 try? 这里只验 register 行为 */ }
    }
    assert.deepEqual(registered, ['conversation.composer.dock', 'settings.section'], '一个 slot 抛错不得中断其余入口');
    assert.equal(warned.some((line) => /slot (inject|register) failed/.test(line) && /conversation\.input\.overlay/.test(line)), true,
      '失败必须 warn 带 slot 名（不许无痕吞）');
  } finally {
    console.warn = originalWarn;
  }
});

test('C17 无 slots：warn 一次、不抛、不注册', async () => {
  const client = await loadClient();
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try {
    assert.doesNotThrow(() => client.apply({ locale: { language: 'zh' } }));
    assert.equal(warned.some((line) => /slots service unavailable/.test(line)), true);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(client.inject.includes('configForms'), true, '卡片的写入口仍是 configForms');
  assert.equal(client.inject.includes('estimateSafety'), false, '安全参数不在客户端注入面');
});

test('C16 静态断言：apply 用到的服务 ⊆ 导出 inject ∪ dsh.client.inject（且不含安全参数）', async () => {
  const client = await loadClient();
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(path.join(process.cwd(), 'lib/client.js'), 'utf8');
  const declared = new Set([...client.inject]);
  const used = new Set();
  for (const match of source.matchAll(/ctx\??\.get\(\s*'([a-zA-Z][\w.]*)'\s*\)/g)) used.add(match[1]);
  for (const match of source.matchAll(/ctx\??\.(slots|locale|configForms|webServer)\b/g)) used.add(match[1]);
  for (const service of used) {
    assert.ok(declared.has(service) || service === 'webServer', `apply 使用了未声明的服务 ${service}`);
  }
  for (const forbidden of ['estimateSafety', 'lowThresholdAck', 'armed']) {
    assert.equal(declared.has(forbidden), false, `安全参数不得进入客户端注入面：${forbidden}`);
  }
  assert.equal(declared.has('slots') && declared.has('locale') && declared.has('configForms'), true);

  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dsh.client, { platform: 'web' }, 'C16：dsh.client 只声明 platform（inject 非服务注入，Q1 已核）');
  assert.equal(manifest.exports['./client'], './lib/client.js');
});
test('C17 迟挂 webServer：注入回调之后才注册；GET→200、非 GET→405', () => {
  const injected = [];
  const routes = [];
  const disposeCalls = [];
  const fakeIframe = () => {
    const record = { status: 0, headers: null, body: '' };
    return {
      record,
      writeHead(code, headers) { record.status = code; record.headers = headers ?? null; },
      end(body) { record.body = body ?? ''; },
    };
  };
  const ctx = {
    inject: (deps, callback) => { injected.push({ deps, callback }); },
  };
  const mounted = mountSnapshotRoute(ctx, {
    getPolicy: () => ({ values: { 'compact.at': 0.55 }, sources: { 'compact.at': 'plugin' } }),
    getNative: () => 0.6785,
  });
  assert.equal(mounted, true);
  assert.deepEqual(injected.map((item) => item.deps), [['webServer']], 'late service：经 inject([\'webServer\']) 排队');
  assert.deepEqual(routes, [], '注入回调触发前不得注册路由');

  // 模拟宿主 webServer 就绪：注入回调被调用。
  injected[0].callback({
    webServer: { register: (route) => { routes.push(route); return () => disposeCalls.push(route.path); } },
    effect: (factory) => { factory(); },
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'exact');
  assert.equal(routes[0].path, '/context-governance/policy-snapshot');

  const ok = fakeIframe();
  routes[0].handler({ method: 'GET' }, ok);
  assert.equal(ok.record.status, 200);
  assert.match(ok.record.headers['content-type'], /application\/json/);
  assert.equal(JSON.parse(ok.record.body).at, 0.55);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const denied = fakeIframe();
    routes[0].handler({ method }, denied);
    assert.equal(denied.record.status, 405, method);
    assert.equal(denied.record.body, '');
  }
  // 直挂路径（无 inject 的测试 ctx）也返回布尔，不抛。
  assert.equal(mountSnapshotRoute({ webServer: { register: () => () => {} }, effect: () => {} }, { getPolicy: () => ({}), getNative: () => null }), true);
  assert.equal(mountSnapshotRoute({}, { getPolicy: () => ({}), getNative: () => null }), false);
});


test('C18 500 可定位：handler 抛错必须 onError 带原错、响应 500 非空日志', () => {
  const seen = [];
  const responses = [];
  const response = () => {
    const record = { status: 0, body: '' };
    responses.push(record);
    return {
      record,
      writeHead(code) { record.status = code; },
      end(body) { record.body = body ?? ''; },
    };
  };
  const handler = createSnapshotHandler({
    getPolicy: () => { throw new Error('empty session broke policyForSession'); },
    getNative: () => null,
    onError: (error) => seen.push(String(error?.message ?? error)),
  });
  const broken = response();
  assert.doesNotThrow(() => handler({ method: 'GET' }, broken));
  assert.equal(broken.record.status, 500);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /empty session broke policyForSession/);

  // logger 自身抛错也不得影响 500 响应
  const throwingLogger = createSnapshotHandler({
    getPolicy: () => { throw new Error('boom'); },
    getNative: () => null,
    onError: () => { throw new Error('logger failed'); },
  });
  const still = response();
  assert.doesNotThrow(() => throwingLogger({ method: 'GET' }, still));
  assert.equal(still.record.status, 500);

  // 正常路径不受影响
  const ok = response();
  createSnapshotHandler({ getPolicy: () => ({ values: { 'compact.at': 0.55 }, sources: { 'compact.at': 'builtin' } }), getNative: () => 0.6785 })({ method: 'GET' }, ok);
  assert.equal(ok.record.status, 200);
  assert.equal(JSON.parse(ok.record.body).at, 0.55);
});

test('C18② 会话感知：存在会话覆盖 → source=session；无会话 → 全局 builtin', () => {
  const render = (policy) => {
    const record = { status: 0, body: '' };
    const res = { writeHead(code) { record.status = code; }, end(body) { record.body = body ?? ''; } };
    createSnapshotHandler({ getPolicy: () => policy, getNative: () => 0.6785 })({ method: 'GET' }, res);
    assert.equal(record.status, 200);
    return JSON.parse(record.body);
  };
  const session = render({ values: { 'compact.at': 0.5 }, sources: { 'compact.at': 'session' } });
  assert.equal(session.source, 'session');
  assert.equal(session.at, 0.5);
  assert.equal(session.sessionOverride, 0.5);
  assert.equal(session.effectiveAt, '本会话有效，重启后失效');

  const global = render({ values: { 'compact.at': 0.6 }, sources: { 'compact.at': 'plugin' } });
  assert.equal(global.source, 'plugin');
  assert.equal(global.sessionOverride, null);
  assert.equal(global.effectiveAt, PERSISTENT_LIFECYCLE_TEXT);
});


test('C18② 会话感知可注入接缝：最近会话→session；无会话→全局；双失败→空视图（生产同源工厂）', () => {
  const globalState = { resolve: (id) => ({ values: { 'compact.at': 0.6 }, sources: { 'compact.at': 'plugin' }, via: `global:${id}` }) };
  const sessionPolicy = { resolve: (id) => ({ values: { 'compact.at': 0.5 }, sources: { 'compact.at': 'session' }, via: `session:${id}` }) };

  const withSession = createSnapshotPolicyResolver({ policyState: globalState, readLatestSessionPolicy: () => ({ resolvable: sessionPolicy, sessionId: 's-1' }) })();
  assert.equal(withSession.sources['compact.at'], 'session');
  assert.equal(withSession.values['compact.at'], 0.5);
  assert.equal(withSession.via, 'session:s-1', '必须用缓存的 sessionId 解析');

  const noSession = createSnapshotPolicyResolver({ policyState: globalState, readLatestSessionPolicy: () => null })();
  assert.equal(noSession.sources['compact.at'], 'plugin');
  assert.equal(noSession.via, 'global:null');

  const latestThrows = createSnapshotPolicyResolver({ policyState: globalState, readLatestSessionPolicy: () => ({ resolvable: { resolve: () => { throw new Error('session boom'); } }, sessionId: 's' }) })();
  assert.equal(latestThrows.via, 'global:null', '会话解析抛错退回全局');

  assert.deepEqual(createSnapshotPolicyResolver({})(), { values: {}, sources: {} });

  // 生产路径：mountSnapshotRoute 的 getPolicy 复用同一工厂（功能级：handler 输出 source=session）
  const routes = [];
  mountSnapshotRoute({ inject: (deps, callback) => callback({ webServer: { register: (route) => { routes.push(route); return () => {}; } }, effect: (factory) => factory() }) }, {
    getPolicy: createSnapshotPolicyResolver({ policyState: globalState, readLatestSessionPolicy: () => ({ resolvable: sessionPolicy, sessionId: 's-9' }) }),
    getNative: () => 0.6785,
  });
  const res = { body: '', writeHead() {}, end(body) { this.body = body ?? ''; } };
  routes[0].handler({ method: 'GET' }, res);
  const view = JSON.parse(res.body);
  assert.equal(view.source, 'session');
  assert.equal(view.at, 0.5);
  assert.equal(view.effectiveAt, '本会话有效，重启后失效');
});
