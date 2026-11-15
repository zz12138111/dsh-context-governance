/**
 * C11③ / C32：UI 的会话级写入口（A2）+ 四层标签同字面。
 *
 * 覆盖：
 * - 写路由 POST /context-governance/session-policy：成功、405、非法 session/at、跨源、超限、命令链拒绝、命令面缺失；
 * - 端到端：写路由 → `/cg set compact.at` 同一命令链 → A2 落盘 → 「重启」后 source=session:A2；
 * - 标签：宿主 ui-labels 与 client 内联表逐项同字面（禁别名）；
 * - `/cg status` 摘要带 `层=` 中文并列（C8/C32）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildPolicyState, resolveConfig } from '../src/index.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import { summarizePolicy } from '../src/policy.js';
import { createSessionPolicyHandler, SESSION_POLICY_PATH, SESSION_ID_PATTERN } from '../src/session-policy-route.js';
import { LAYER_LABELS as HOST_LABELS, layerLabel } from '../src/ui-labels.js';

// ---- 假 req/res ----------------------------------------------------------
function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) { res.status = status; res.headers = headers ?? null; },
    end(payload) { res.body = payload === undefined ? '' : String(payload); },
  };
  return res;
}

const TEST_TOKEN = 'test-csrf-token';
function makeReq({ method = 'POST', headers = {}, body = undefined, raw = undefined, socket = { remoteAddress: '127.0.0.1' } } = {}) {
  const mergedHeaders = {
    'content-type': 'application/json',
    host: '127.0.0.1:14915',
    origin: 'http://127.0.0.1:14915',
    ...headers,
  };
  const req = { method, headers: mergedHeaders, socket };
  if (body !== undefined) req.body = body;
  if (raw !== undefined) req[Symbol.asyncIterator] = async function* iterate() { yield Buffer.from(raw, 'utf8'); };
  return req;
}

const json = (res) => (res.body === '' ? null : JSON.parse(res.body));

function fakeA2(initial = new Map()) {
  const sessions = initial;
  const writes = [];
  return {
    sessions,
    writes,
    read(sessionId) {
      const value = sessions.get(sessionId);
      return value === undefined ? null : { at: value, source: 'session:A2' };
    },
    write(sessionId, at) {
      sessions.set(sessionId, at);
      writes.push({ sessionId, at });
      return true;
    },
    clear(sessionId) { sessions.delete(sessionId); return true; },
  };
}

// ---- client bundle（手写 bundle：用假 window.__ModuleLoader__ 捕获工厂）----
let clientSeq = 0;
async function loadClient() {
  const captured = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href + `?v=${clientSeq += 1}`);
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
  return captured[0].factory(() => reactStub);
}

// ---- 路由 ---------------------------------------------------------------
test('C11③ 写路由：合法 POST 调用会话写入口并回 session:A2', async () => {
  const calls = [];
  const handler = createSessionPolicyHandler({ csrfToken: TEST_TOKEN,
    writeSessionAt: async (input) => { calls.push(input); return { ok: true }; },
  });
  const res = makeRes();
  await handler(makeReq({ body: { sessionId: 'ui-sess-1', at: 0.55 } }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ sessionId: 'ui-sess-1', at: 0.55 }]);
  assert.deepEqual(json(res), { ok: true, at: 0.55, source: 'session:A2' });
  assert.equal(SESSION_POLICY_PATH, '/context-governance/session-policy');
});

test('C11③ 写路由：非 POST → 405 且不写；缺会话/越界 → 400 且不写', async () => {
  const calls = [];
  const handler = createSessionPolicyHandler({ csrfToken: TEST_TOKEN, writeSessionAt: async (input) => { calls.push(input); return { ok: true }; } });

  const get = makeRes();
  await handler(makeReq({ method: 'GET' }), get);
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');

  for (const body of [{ at: 0.5 }, { sessionId: '', at: 0.5 }, { sessionId: 'bad id!', at: 0.5 }]) {
    const res = makeRes();
    await handler(makeReq({ body }), res);
    assert.equal(res.status, 400);
    assert.equal(json(res).error, 'invalid-session');
  }
  for (const at of [-0.1, 1.5, Number.NaN, 'abc']) {
    const res = makeRes();
    await handler(makeReq({ body: { sessionId: 'ui-sess-1', at } }), res);
    assert.equal(res.status, 400);
    assert.equal(json(res).error, 'invalid-at');
  }
  assert.deepEqual(calls, [], '非法请求一律不进入写入口');
});

test('C11③ 写路由：跨源 403、体超限 413、坏 JSON 400、命令链拒绝 409 带原因、无命令面 503', async () => {
  const handler = createSessionPolicyHandler({ csrfToken: TEST_TOKEN, writeSessionAt: async () => ({ ok: true }) });

  const cross = makeRes();
  await handler(makeReq({ headers: { origin: 'https://evil.example', host: '127.0.0.1:14915' }, body: { sessionId: 's1', at: 0.5 } }), cross);
  assert.equal(cross.status, 403);

  const sameOrigin = makeRes();
  await handler(makeReq({ headers: { origin: 'http://127.0.0.1:14915', host: '127.0.0.1:14915' }, body: { sessionId: 's1', at: 0.5 } }), sameOrigin);
  assert.equal(sameOrigin.status, 200, '同源必须放行');

  const big = makeRes();
  await handler(makeReq({ raw: 'x'.repeat(9000) }), big);
  assert.equal(big.status, 413);

  const broken = makeRes();
  await handler(makeReq({ raw: '{not json' }), broken);
  assert.equal(broken.status, 400);
  assert.equal(json(broken).error, 'invalid-json');

  const rejected = createSessionPolicyHandler({ csrfToken: TEST_TOKEN,
    writeSessionAt: async () => ({ ok: false, error: 'rejected', detail: '被拒绝: below-min' }),
  });
  const rejectedRes = makeRes();
  await rejected(makeReq({ body: { sessionId: 's1', at: 0.1 } }), rejectedRes);
  assert.equal(rejectedRes.status, 409);
  assert.equal(json(rejectedRes).error, 'rejected');
  assert.match(json(rejectedRes).detail, /below-min/);

  const unavailable = createSessionPolicyHandler({ csrfToken: TEST_TOKEN, writeSessionAt: null });
  const unavailableRes = makeRes();
  await unavailable(makeReq({ body: { sessionId: 's1', at: 0.5 } }), unavailableRes);
  assert.equal(unavailableRes.status, 503);
});

test('C11③ 端到端：UI 写 → 会话层即时生效且落 A2（重启后仍以 session:A2 读回）', async () => {
  const a2 = fakeA2(new Map());
  const config = resolveConfig({ projectRoot: 'D:/tmp/ui-a2-project' });
  const state = buildPolicyState(config, {
    readFile: () => { throw new Error('no project file'); },
    a2Store: a2,
    onPolicyResolved: () => {},
  });
  // 生产里 sessionWriteRef 就是跑这条命令链；这里同构地拿它当写入口。
  const command = createStatusCommand({ policy: state });
  const handler = createSessionPolicyHandler({ csrfToken: TEST_TOKEN,
    writeSessionAt: async ({ sessionId, at }) => {
      const result = await command.handler({ agent: { session: { id: sessionId } }, rawInput: `set compact.at=${at}` });
      return result.kind === 'success' ? { ok: true } : { ok: false, error: 'rejected', detail: result.text };
    },
  });

  const res = makeRes();
  await handler(makeReq({ body: { sessionId: 'ui-sess-1', at: 0.55 } }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(a2.writes.at(-1), { sessionId: 'ui-sess-1', at: 0.55 }, 'UI 保存必须落 A2');
  assert.equal(state.resolve('ui-sess-1').values['compact.at'], 0.55, 'A1 即时生效');
  assert.equal(state.resolve('ui-sess-1').sources['compact.at'], 'session:A1');

  // 重启：新 state 只从 A2 读回。
  const restarted = buildPolicyState(config, {
    readFile: () => { throw new Error('no project file'); },
    a2Store: fakeA2(a2.sessions),
    onPolicyResolved: () => {},
  });
  assert.equal(restarted.resolve('ui-sess-1').values['compact.at'], 0.55, '重启后保留');
  assert.equal(restarted.resolve('ui-sess-1').sources['compact.at'], 'session:A2');

  // 非法值：命令链拒绝 → 409，且不新增 A2 写入。
  const before = a2.writes.length;
  const bad = makeRes();
  await handler(makeReq({ body: { sessionId: 'ui-sess-1', at: 0.1 } }), bad);
  assert.equal(bad.status, 409);
  assert.equal(a2.writes.length, before, '被拒的保存不得落 A2');
});

test('C32：四层标签唯一映射，宿主与 client 内联表同字面（禁别名）', async () => {
  const client = await loadClient();
  assert.deepEqual(client.LAYER_LABELS, { ...HOST_LABELS }, '两侧标签表必须逐项相同');
  const cases = [
    ['session:A1', '本会话·临时（重启失效）'],
    ['session:A2', '本会话·已保存（重启保留）'],
    ['project', '项目模板（可选）'],
    ['plugin', '全局（影响所有会话）'],
    ['builtin', '内置默认'],
    ['profile=batch', '配置 profile=batch'],
    ['session', '本会话·临时（重启失效）'],
    ['weird', 'weird'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(layerLabel(source), expected, `宿主：${source}`);
    assert.equal(client.layerLabel(source), expected, `client：${source}`);
  }
  assert.equal(client.SESSION_POLICY_PATH, SESSION_POLICY_PATH);
  assert.equal(SESSION_ID_PATTERN.test('session-8b7b552a-bb46-462c-b084-e0711ea77310'), true);
});

test('C8/C32：/cg status 摘要在 source 之外并列中文层标签', () => {
  const line = summarizePolicy({
    values: { 'compact.at': 0.55, 'compact.early': true, 'compact.early.armed': true },
    sources: { 'compact.at': 'session:A2', 'compact.early': 'plugin', 'compact.early.armed': 'builtin' },
    native: 0.6785,
    early: true,
    earlyArmed: true,
    window: null,
  });
  assert.match(line, /\(source=session:A2\)/, '原始 source 口径不得被替换');
  assert.match(line, /层=本会话·已保存（重启保留）/, '必须并列中文标签（同字面）');
});

test('C11③ client：主入口保存发会话写请求，设置页仍走 configForms（plugin）', async () => {
  const client = await loadClient();
  const posts = [];
  const fetchStub = async (url, init) => {
    posts.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, at: 0.55, source: 'session:A2' }) };
  };
  const saved = await client.saveSessionAt({ raw: '55', snapshot: { at: 0.6, source: 'plugin' }, sessionId: 'ui-sess-1', fetchImpl: fetchStub });
  assert.equal(saved.ok, true);
  const postCalls = posts.filter((item) => item.init?.method === 'POST');
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].url, SESSION_POLICY_PATH);
  assert.equal(postCalls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(postCalls[0].init.body), { sessionId: 'ui-sess-1', at: 0.55 });
  // 无会话标识：拒绝保存且不发请求（不得退化写全局）。
  const noSession = await client.saveSessionAt({ raw: '55', snapshot: { at: 0.6 }, sessionId: null, fetchImpl: fetchStub });
  assert.equal(noSession.ok, false);
  assert.equal(posts.filter((item) => item.init?.method === 'POST').length, 1);

  // 服务端拒绝：带回原因，输入保留（requestSent 供用例断言）。
  const rejecting = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'rejected', detail: 'compact.at 被拒绝' }) });
  const failed = await client.saveSessionAt({ raw: '55', snapshot: { at: 0.6 }, sessionId: 'ui-sess-1', fetchImpl: rejecting });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /被拒绝/);

  // 设置页入口仍只写 plugin：configForms.set('policy.at', …)。
  const writes = [];
  const settingsSave = await client.saveAttempt({
    raw: '55',
    snapshot: { at: 0.6, source: 'plugin' },
    configForms: { get: () => ({ set: (field, value) => { writes.push([field, value]); return Promise.resolve(); } }) },
  });
  assert.equal(settingsSave.ok, true);
  assert.deepEqual(writes, [['policy.at', 0.55]]);
});

test('C38/真机归因：policy-set 审计必须带当前 sessionId（/cg set、/cg header、/cg profile）', async () => {
  const a2 = fakeA2(new Map());
  const config = resolveConfig({ projectRoot: 'D:/tmp/ui-a2-project2' });
  const state = buildPolicyState(config, {
    readFile: () => { throw new Error('no project file'); },
    a2Store: a2,
    onPolicyResolved: () => {},
  });
  const rows = [];
  const command = createStatusCommand({
    policy: state,
    audit: { append: (event, details) => rows.push({ event, details }) },
    now: () => new Date('2026-11-15T00:00:00Z'),
  });
  const run = (rawInput, id = 'ui-sess-1') => command.handler({ agent: { session: { id } }, rawInput });

  assert.equal((await run('set compact.at=0.55')).kind, 'success');
  const setRow = rows.filter((row) => row.event === 'policy-set').at(-1);
  assert.equal(setRow.details.sessionId, 'ui-sess-1', 'A2 写入必须能归因到会话');
  assert.equal(setRow.details.key, 'compact.at');

  assert.equal((await run('header off')).kind, 'success');
  assert.equal(rows.filter((row) => row.event === 'policy-set').at(-1).details.sessionId, 'ui-sess-1');

  assert.equal((await run('profile batch')).kind, 'success');
  const profileRow = rows.filter((row) => row.event === 'policy-set').at(-1);
  assert.equal(profileRow.details.sessionId, 'ui-sess-1');
  assert.equal(profileRow.details.key, 'profile');

  // 另一个会话的写入不得串号（归因必须区分 A/B）。
  assert.equal((await run('set compact.at=0.65', 'ui-sess-2')).kind, 'success');
  assert.equal(rows.filter((row) => row.event === 'policy-set').at(-1).details.sessionId, 'ui-sess-2');
});
