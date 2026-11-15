/**
 * C27/C29：恢复全局设置必须"真清"——重启后只有 A2（无 A1 桶）时 `/cg set reset` 也要清 A2 并回落；
 * UI 必须有「恢复全局设置」入口（C29 明文），走同一链路。
 * C31：写路由的 loopback/同源/JSON/白名单边界。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPolicyState, resolveConfig } from '../src/index.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import { createSessionPolicyHandler } from '../src/session-policy-route.js';

function fakeA2(initial = new Map()) {
  const sessions = new Map(initial);
  const clears = [];
  return {
    sessions,
    clears,
    read: (sessionId) => (sessions.has(sessionId) ? { at: sessions.get(sessionId), source: 'session:A2' } : null),
    write: (sessionId, at) => { sessions.set(sessionId, at); return true; },
    clear: (sessionId) => { clears.push(sessionId); sessions.delete(sessionId); return true; },
  };
}

// 包根由本文件位置推导（不依赖测试运行时 cwd）。
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const makeState = (a2) => buildPolicyState(
  resolveConfig({ projectRoot: 'D:/tmp/c27c29', policy: { values: { 'compact.at': 0.58 } } }),
  { readFile: () => { throw new Error('no project file'); }, a2Store: a2, onPolicyResolved: () => {} },
);
const makeCommand = (state) => createStatusCommand({ policy: state, now: () => new Date('2026-11-15T05:00:00Z') });

test('C27/C29 ①：重启后只有 A2、无 A1 桶 → /cg set reset 必须真清 A2 并回落 plugin', async () => {
  const a2 = fakeA2(new Map([['s-a2only', 0.5]]));
  const state = makeState(a2);
  assert.equal(state.resolve('s-a2only').sources['compact.at'], 'session:A2', '前置：只有 A2');
  const command = makeCommand(state);
  const result = await command.handler({ rawInput: 'set reset', agent: { session: { id: 's-a2only' } } });
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /cleared: 1/, 'A2 这一层必须计入 cleared');
  assert.deepEqual(a2.clears, ['s-a2only'], 'A2 落盘必须被清');
  assert.equal(a2.read('s-a2only'), null);
  const after = state.resolve('s-a2only');
  assert.equal(after.sources['compact.at'], 'plugin', '必须回落到 plugin');
  assert.equal(after.values['compact.at'], 0.58);
});

test('C27/C29 ②：A1 + A2 同时在 → reset 两层都清（cleared 计 2）', async () => {
  const a2 = fakeA2(new Map([['s-both', 0.5]]));
  const state = makeState(a2);
  state.sessionValues('s-both', { create: true })['compact.at'] = 0.4;
  assert.equal(state.resolve('s-both').sources['compact.at'], 'session:A1');
  const command = makeCommand(state);
  const result = await command.handler({ rawInput: 'set reset', agent: { session: { id: 's-both' } } });
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /cleared: 2/);
  assert.equal(a2.read('s-both'), null);
  const after = state.resolve('s-both');
  assert.equal(after.sources['compact.at'], 'plugin');
});

test('C29 ③：写路由支持 {reset:true} 且走 reset 链路（不是写值）', async () => {
  const calls = { set: [], reset: [] };
  const handler = createSessionPolicyHandler({
    writeSessionAt: async ({ sessionId, at }) => { calls.set.push({ sessionId, at }); return { ok: true }; },
    resetSessionAt: async ({ sessionId }) => { calls.reset.push({ sessionId }); return { ok: true }; },
  });
  const makeRes = () => {
    const res = { status: 0, body: null };
    res.writeHead = (status) => { res.status = status; };
    res.end = (payload) => { res.body = payload === undefined ? '' : String(payload); };
    return res;
  };
  const req = (body) => ({
    method: 'POST',
    socket: { remoteAddress: '::1' },
    headers: { 'content-type': 'application/json', host: '127.0.0.1:14915', origin: 'http://127.0.0.1:14915' },
    body,
  });

  const res = makeRes();
  await handler(req({ sessionId: 'session-c29', reset: true }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, reset: true, source: 'plugin' });
  assert.deepEqual(calls.reset, [{ sessionId: 'session-c29' }]);
  assert.deepEqual(calls.set, [], 'reset 不得走写值路径');
});

test('C31：写路由边界——仅 loopback、同源必做、只收 JSON、sessionId 白名单', async () => {
  const handler = createSessionPolicyHandler({ writeSessionAt: async () => ({ ok: true }) });
  const makeRes = () => {
    const res = { status: 0, body: null };
    res.writeHead = (status) => { res.status = status; };
    res.end = (payload) => { res.body = payload === undefined ? '' : String(payload); };
    return res;
  };
  const base = () => ({
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'content-type': 'application/json', host: '127.0.0.1:14915', origin: 'http://127.0.0.1:14915' },
    body: { sessionId: 'session-c31', at: 0.58 },
  });

  const ok = makeRes();
  await handler(base(), ok);
  assert.equal(ok.status, 200);

  // ① 非 loopback 一律 403。
  const remote = base();
  remote.socket = { remoteAddress: '10.0.0.5' };
  const remoteRes = makeRes();
  await handler(remote, remoteRes);
  assert.equal(remoteRes.status, 403);
  assert.equal(JSON.parse(remoteRes.body).error, 'not-loopback');

  // ③ 同源必做：Origin 缺失且无 Sec-Fetch-Site → 403（不再"缺省放行"）。
  const noOrigin = base();
  noOrigin.headers = { 'content-type': 'application/json', host: '127.0.0.1:14915' };
  const noOriginRes = makeRes();
  await handler(noOrigin, noOriginRes);
  assert.equal(noOriginRes.status, 403);
  assert.equal(JSON.parse(noOriginRes.body).error, 'missing-origin');

  // Sec-Fetch-Site: same-origin 可替代 Origin。
  const secFetch = base();
  secFetch.headers = { 'content-type': 'application/json', host: '127.0.0.1:14915', 'sec-fetch-site': 'same-origin' };
  const secFetchRes = makeRes();
  await handler(secFetch, secFetchRes);
  assert.equal(secFetchRes.status, 200);

  // Host 缺失（有 Origin 无 Host）→ 403，不放行。
  const noHost = base();
  noHost.headers = { 'content-type': 'application/json', origin: 'http://127.0.0.1:14915' };
  const noHostRes = makeRes();
  await handler(noHost, noHostRes);
  assert.equal(noHostRes.status, 403);

  // ::1 放行。
  const v6 = base();
  v6.socket = { remoteAddress: '::1' };
  const v6Res = makeRes();
  await handler(v6, v6Res);
  assert.equal(v6Res.status, 200);

  // ② 非 JSON Content-Type 且无已解析 body → 415。
  const notJson = base();
  notJson.headers = { 'content-type': 'text/plain', host: '127.0.0.1:14915', origin: 'http://127.0.0.1:14915' };
  const notJsonRes = makeRes();
  await handler(notJson, notJsonRes);
  assert.equal(notJsonRes.status, 415);

  // ④ sessionId 白名单：冒号/超长都拒。
  for (const sessionId of ['a:b', 'a'.repeat(129)]) {
    const bad = base();
    bad.body = { sessionId, at: 0.58 };
    const badRes = makeRes();
    await handler(bad, badRes);
    assert.equal(badRes.status, 400);
    assert.equal(JSON.parse(badRes.body).error, 'invalid-session');
  }
});

test('C29 ④：client 有「恢复全局设置」入口且走 reset 链路（静态断言）', async () => {
  let seq = 0;
  const captured = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(path.join(PKG_ROOT, 'lib/client.js')).href + `?v=${seq += 1}`);
  } finally {
    globalThis.window = previousWindow;
  }
  const reactStub = {
    Component: class { constructor(props) { this.props = props; this.state = {}; } },
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
  const client = captured[0].factory(() => reactStub);
  const source = fs.readFileSync(path.join(PKG_ROOT, 'lib/client.js'), 'utf8');
  assert.match(source, /cg-reset-global/, '必须有独立的恢复全局入口元素');
  assert.match(source, /resetGlobal: '恢复全局设置'/, '文案必须与行为一致');
  assert.match(source, /resetSessionAt/, '必须走 reset 链路');
  assert.match(source, /reset: true/, 'reset 请求体必须带 reset:true');

  const posts = [];
  const fakeFetch = async (url, init) => {
    posts.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, reset: true, source: 'plugin' }) };
  };
  const reset = await client.resetSessionAt({ sessionId: 'session-c29', fetchImpl: fakeFetch });
  assert.equal(reset.ok, true);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body), { sessionId: 'session-c29', reset: true });
  // 无会话标识时不发请求。
  const noSession = await client.resetSessionAt({ sessionId: null, fetchImpl: fakeFetch });
  assert.equal(noSession.ok, false);
  assert.equal(posts.length, 1);
});

test('C31：::ffff:127.0.0.1 与 Sec-Fetch-Site:none 也放行；跨源 `cross-origin`', async () => {
  const handler = createSessionPolicyHandler({ writeSessionAt: async () => ({ ok: true }) });
  const makeRes = () => {
    const res = { status: 0, body: null };
    res.writeHead = (status) => { res.status = status; };
    res.end = (payload) => { res.body = payload === undefined ? '' : String(payload); };
    return res;
  };
  const req = ({ remote = '::ffff:127.0.0.1', headers = {} } = {}) => ({
    method: 'POST',
    socket: { remoteAddress: remote },
    headers: { 'content-type': 'application/json', host: '127.0.0.1:14915', ...headers },
    body: { sessionId: 'session-c31b', at: 0.58 },
  });

  const mapped = makeRes();
  await handler(req({ headers: { 'sec-fetch-site': 'same-origin' } }), mapped);
  assert.equal(mapped.status, 200, '::ffff:127.0.0.1 + Sec-Fetch-Site:same-origin 必须放行');

  // 严格口径（需求 C31③ 只认 same-origin）：Sec-Fetch-Site:none 且无 Origin → 403。
  const noneSite = makeRes();
  await handler(req({ headers: { 'sec-fetch-site': 'none' } }), noneSite);
  assert.equal(noneSite.status, 403);
  assert.equal(JSON.parse(noneSite.body).error, 'cross-origin');

  const cross = makeRes();
  await handler(req({ headers: { origin: 'https://evil.example' } }), cross);
  assert.equal(cross.status, 403);
  assert.equal(JSON.parse(cross.body).error, 'cross-origin');
});
