/**
 * rc.9：chip/气泡「UI 跟随会话」——快照链的两处断点回归。
 *
 * 断点 A：`createSnapshotPolicyResolver` 原来签名无参 → 客户端传会话无处可去；
 * 断点 B：resolver 值捕获 apply 时的 `policyState` → `rebuildPolicies()` 之后仍读旧对象（永远 builtin 0.6）。
 *
 * 覆盖：
 * - `parseSnapshotQuery`：`?session=` / `?scope=global` / 非法值；
 * - handler：把会话上下文传给 getPolicy；非 GET 仍 405；
 * - resolver：按 sessionId 走 resolveSession；`scope=global` 走全局；**每次动态取 state**（重建后立即新值）；
 * - client：快照 URL 带 `session=` / `scope=global`；chip 带 sessionId，设置页要全局。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildPolicyState, resolveConfig } from '../src/index.js';
import { createA2Store } from '../src/a2-store.js';
import { createSnapshotHandler, createSnapshotPolicyResolver, parseSnapshotQuery } from '../src/settings-policy.js';
import { tempDir } from './helpers.mjs';

function makeRes() {
  const res = { status: 0, headers: null, body: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? null; };
  res.end = (payload) => { res.body = payload === undefined ? '' : String(payload); };
  return res;
}
const json = (res) => (res.body === '' ? null : JSON.parse(res.body));

test('rc.9 parseSnapshotQuery：只认合法 session 与 scope=global', () => {
  assert.deepEqual(parseSnapshotQuery('/context-governance/policy-snapshot'), { sessionId: null, scope: null });
  assert.deepEqual(parseSnapshotQuery('/context-governance/policy-snapshot?session=session-abc_1'), { sessionId: 'session-abc_1', scope: null });
  assert.deepEqual(parseSnapshotQuery('/context-governance/policy-snapshot?scope=global'), { sessionId: null, scope: 'global' });
  // 非法会话（空白/超长/非法字符）一律丢，退化为无参数口径。
  assert.equal(parseSnapshotQuery('/context-governance/policy-snapshot?session=bad%20id').sessionId, null);
  assert.equal(parseSnapshotQuery(`/context-governance/policy-snapshot?session=${'a'.repeat(200)}`).sessionId, null);
  assert.equal(parseSnapshotQuery('/x?scope=other').scope, null);
});

test('rc.9 handler：把 ?session/?scope 交给 getPolicy；非 GET 仍 405', () => {
  const calls = [];
  const handler = createSnapshotHandler({
    getPolicy: (input) => { calls.push(input); return { values: { 'compact.at': 0.45 }, sources: { 'compact.at': 'session:A2' } }; },
    getNative: () => 0.6785,
  });

  const withSession = makeRes();
  handler({ method: 'GET', url: '/context-governance/policy-snapshot?session=session-abc' }, withSession);
  assert.equal(withSession.status, 200);
  assert.deepEqual(json(withSession).at, 0.45);
  assert.deepEqual(calls.at(-1), { sessionId: 'session-abc', scope: null });

  const global = makeRes();
  handler({ method: 'GET', url: '/context-governance/policy-snapshot?scope=global' }, global);
  assert.deepEqual(calls.at(-1), { sessionId: null, scope: 'global' });

  const plain = makeRes();
  handler({ method: 'GET', url: '/context-governance/policy-snapshot' }, plain);
  assert.deepEqual(calls.at(-1), { sessionId: null, scope: null });

  const post = makeRes();
  handler({ method: 'POST', url: '/context-governance/policy-snapshot' }, post);
  assert.equal(post.status, 405);
});

test('rc.9 resolver：按会话解析、global 明确、每次动态取当前 state（不闭包捕获）', async () => {
  const dir = await tempDir('cg-snapshot-');
  try {
    const a2File = path.join(dir, 'session-policy.json');
    const a2 = createA2Store({ file: a2File });
    a2.write('s-a', 0.45);
    const config = resolveConfig({ projectRoot: 'D:/tmp/snapshot', policy: { values: { 'compact.at': 0.58 } } });
    const makeState = () => buildPolicyState(config, {
      readFile: () => { throw new Error('no project file'); },
      a2Store: createA2Store({ file: a2File }),
      onPolicyResolved: () => {},
    });

    let current = makeState();
    const resolved = [];
    const resolver = createSnapshotPolicyResolver({
      getPolicyState: () => current,
      resolveSession: (sessionId) => { resolved.push(sessionId); return null; },
    });

    // 按会话：走 resolveSession 钩子 → 退回当前 state 的 resolve(sessionId)。
    assert.equal(resolver({ sessionId: 's-a' }).values['compact.at'], 0.45);
    assert.deepEqual(resolved, ['s-a']);
    // 另一会话无 A2 时按 plugin 0.58（同一 state）。
    assert.equal(resolver({ sessionId: 's-other' }).values['compact.at'], 0.58);

    // 全局：必须 resolve(null) → plugin 0.58，不得落最近会话。
    assert.equal(resolver({ scope: 'global' }).values['compact.at'], 0.58);
    assert.equal(resolver({ scope: 'global' }).sources['compact.at'], 'plugin');

    // 断点 B：换掉 state（= rebuildPolicies 后）→ 下一次调用必须读新值。
    current = buildPolicyState(resolveConfig({ projectRoot: 'D:/tmp/snapshot', policy: { values: { 'compact.at': 0.52 } } }), {
      readFile: () => { throw new Error('no project file'); },
      a2Store: createA2Store({ file: a2File }),
      onPolicyResolved: () => {},
    });
    assert.equal(resolver({ scope: 'global' }).values['compact.at'], 0.52, 'resolver 不得持有旧 state');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('rc.9 client：快照 URL 带会话上下文；chip 带 sessionId、设置页要 global', async () => {
  let seq = 0;
  const captured = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href + `?v=${seq += 1}`);
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

  const urls = [];
  const fakeFetch = async (url) => { urls.push(url); return { ok: true, json: async () => ({ at: 0.45, source: 'session:A2' }) }; };
  await client.fetchSnapshot(fakeFetch, { sessionId: 'session-abc' });
  await client.fetchSnapshot(fakeFetch, { scope: 'global' });
  await client.fetchSnapshot(fakeFetch);
  assert.deepEqual(urls, [
    '/context-governance/policy-snapshot?session=session-abc',
    '/context-governance/policy-snapshot?scope=global',
    '/context-governance/policy-snapshot',
  ]);

  const source = fs.readFileSync(path.join(process.cwd(), 'lib/client.js'), 'utf8');
  const chipBody = source.slice(source.indexOf('const createChip ='), source.indexOf('const createBubble ='));
  assert.match(chipBody, /sessionIdOf\(props, ctx\)/, 'chip 必须把自己的会话带进快照请求');
  const settingsBody = source.slice(source.indexOf('const createSettingsCard ='));
  assert.match(settingsBody, /scope: 'global'/, '设置页卡片必须显式要全局口径');
});
