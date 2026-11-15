/**
 * C11②（实现②·保承诺）：plugin 层自持久化 —— 设置页保存后重启仍有效、source=plugin。
 *
 * 覆盖：
 * - 存储：写入 → 新实例读回；损坏/未知版本 → 视为无持久值 + `plugin-policy-load-failed`；外部改文件后下一次读即生效；
 * - 合并：持久值只替代 plugin 层默认，**不越级**压 A1/A2/项目模板；
 * - 路由：`POST /context-governance/plugin-policy` 的 405/400/403/413/409/503 与成功响应；
 * - client：设置页保存走 plugin 写路由（不是只写宿主 volatile 表单）；
 * - 端到端：保存 0.6 → 「重启」（新 store + 新 policy state）→ source=plugin、值 0.6。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildPolicyState, resolveConfig } from '../src/index.js';
import { createPluginPolicyStore, pluginPolicyFile, PLUGIN_POLICY_VERSION } from '../src/plugin-policy.js';
import { mergeSettingsAt } from '../src/settings-policy.js';
import { createPluginPolicyHandler, PLUGIN_POLICY_PATH } from '../src/session-policy-route.js';
import { tempDir } from './helpers.mjs';

function makeRes() {
  const res = { status: 0, headers: null, body: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? null; };
  res.end = (payload) => { res.body = payload === undefined ? '' : String(payload); };
  return res;
}
function makeReq({ method = 'POST', headers = {}, body = undefined, raw = undefined } = {}) {
  const req = { method, headers };
  if (body !== undefined) req.body = body;
  if (raw !== undefined) req[Symbol.asyncIterator] = async function* iterate() { yield Buffer.from(raw, 'utf8'); };
  return req;
}
const json = (res) => (res.body === '' ? null : JSON.parse(res.body));

const projectState = (persistedAt) => buildPolicyState(
  mergeSettingsAt(resolveConfig({ projectRoot: 'D:/tmp/plugin-persist' }), persistedAt),
  { readFile: () => { throw new Error('no project file'); }, onPolicyResolved: () => {} },
);

test('C11② 存储：写入 → 新实例读回；文件带版本/来源/时间', async () => {
  const dir = await tempDir('cg-plugin-policy-');
  try {
    const file = path.join(dir, 'context-governance', 'plugin-policy.json');
    const audits = [];
    const first = createPluginPolicyStore({ file, audit: (event, details) => audits.push({ event, details }) });
    assert.equal(first.writeAt(0.6), true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.version, PLUGIN_POLICY_VERSION);
    assert.equal(onDisk.at, 0.6);
    assert.equal(onDisk.source, 'plugin');
    assert.match(onDisk.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(audits.map((row) => row.event), ['plugin-policy-persisted']);

    // 「重启」：全新实例读回同一值。
    const second = createPluginPolicyStore({ file });
    assert.equal(second.read().at, 0.6);
    assert.equal(second.read().source, 'plugin');

    // 同值不重复落盘/不刷审计；不同值才写。
    assert.equal(second.writeAtIfChanged(0.6), false);
    assert.equal(second.writeAtIfChanged(0.65), true);
    assert.equal(createPluginPolicyStore({ file }).read().at, 0.65);

    // 非法值拒绝。
    assert.equal(second.writeAt(1.5), false);
    assert.equal(second.writeAt(Number.NaN), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C11② 存储：损坏/未知版本 → 视为无持久值并写 plugin-policy-load-failed，不抛错', async () => {
  const dir = await tempDir('cg-plugin-policy-bad-');
  try {
    const file = path.join(dir, 'plugin-policy.json');
    await fsp.writeFile(file, '{not json', 'utf8');
    const audits = [];
    const store = createPluginPolicyStore({ file, audit: (event, details) => audits.push({ event, details }) });
    assert.equal(store.read(), null);
    assert.equal(audits.some((row) => row.event === 'plugin-policy-load-failed'), true);

    await fsp.writeFile(file, JSON.stringify({ version: 99, at: 0.5 }), 'utf8');
    const unknown = createPluginPolicyStore({ file, audit: (event, details) => audits.push({ event, details }) });
    assert.equal(unknown.read(), null);
    assert.equal(audits.filter((row) => row.event === 'plugin-policy-load-failed').length >= 2, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C11② 存储：外部改文件后下一次读即生效（不缓存旧值）', async () => {
  const dir = await tempDir('cg-plugin-policy-ext-');
  try {
    const file = path.join(dir, 'plugin-policy.json');
    const store = createPluginPolicyStore({ file });
    store.writeAt(0.6);
    assert.equal(store.read().at, 0.6);
    // 外部改写 + 显式推进 mtime（避免同毫秒粒度命中缓存）。
    const later = new Date(Date.now() + 5000);
    await fsp.writeFile(file, JSON.stringify({ version: 1, at: 0.72, source: 'plugin' }), 'utf8');
    await fsp.utimes(file, later, later);
    assert.equal(store.read().at, 0.72);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C11② 合并优先级：持久值只替代 plugin 默认，不越级压 A1/A2/项目模板', async () => {
  // 只有持久值：source=plugin、值=持久值。
  const only = projectState(0.5);
  assert.equal(only.resolve(null).values['compact.at'], 0.5);
  assert.equal(only.resolve(null).sources['compact.at'], 'plugin');

  // A2 更高：会话持久值 0.55 赢。
  const withA2 = buildPolicyState(mergeSettingsAt(resolveConfig({ projectRoot: 'D:/tmp/plugin-persist' }), 0.5), {
    readFile: () => { throw new Error('no project file'); },
    a2Store: { read: (id) => (id === 's-a2' ? { at: 0.55, source: 'session:A2' } : null), write: () => true, clear: () => true },
    onPolicyResolved: () => {},
  });
  assert.equal(withA2.resolve('s-a2').values['compact.at'], 0.55);
  assert.equal(withA2.resolve('s-a2').sources['compact.at'], 'session:A2');

  // A1 更高：运行时覆盖赢。
  const bucket = withA2.sessionValues('s-a2', { create: true });
  bucket['compact.at'] = 0.62;
  assert.equal(withA2.resolve('s-a2').values['compact.at'], 0.62);
  assert.equal(withA2.resolve('s-a2').sources['compact.at'], 'session:A1');

  // 项目模板更高：project 赢过 plugin 持久值。
  const dir = await tempDir('cg-plugin-persist-proj-');
  try {
    const config = resolveConfig({ projectRoot: dir });
    await fsp.writeFile(path.join(dir, config.policy.projectFile), JSON.stringify({ version: 1, values: { 'compact.at': 0.48 } }), 'utf8');
    const withProject = buildPolicyState(mergeSettingsAt(config, 0.5), { onPolicyResolved: () => {} });
    assert.equal(withProject.resolve(null).sources['compact.at'], 'project');
    assert.equal(withProject.resolve(null).values['compact.at'], 0.48);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C11② 路由：POST 成功回 source=plugin；405/400/403/413/409/503 齐', async () => {
  assert.equal(PLUGIN_POLICY_PATH, '/context-governance/plugin-policy');
  const calls = [];
  const handler = createPluginPolicyHandler({ writePluginAt: ({ at }) => { calls.push(at); return { ok: true }; } });

  const ok = makeRes();
  await handler(makeReq({ body: { at: 0.6 } }), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(json(ok), { ok: true, at: 0.6, source: 'plugin' });
  assert.deepEqual(calls, [0.6]);

  const get = makeRes();
  await handler(makeReq({ method: 'GET' }), get);
  assert.equal(get.status, 405);

  for (const at of [-1, 2, 'x']) {
    const bad = makeRes();
    await handler(makeReq({ body: { at } }), bad);
    assert.equal(bad.status, 400);
    assert.equal(json(bad).error, 'invalid-at');
  }

  const cross = makeRes();
  await handler(makeReq({ headers: { origin: 'https://evil.example', host: '127.0.0.1:10915' }, body: { at: 0.6 } }), cross);
  assert.equal(cross.status, 403);

  const big = makeRes();
  await handler(makeReq({ raw: 'x'.repeat(9000) }), big);
  assert.equal(big.status, 413);

  const rejected = createPluginPolicyHandler({ writePluginAt: () => ({ ok: false, error: 'persist-failed' }) });
  const rejectedRes = makeRes();
  await rejected(makeReq({ body: { at: 0.6 } }), rejectedRes);
  assert.equal(rejectedRes.status, 409);
  assert.equal(json(rejectedRes).error, 'persist-failed');

  const unavailable = createPluginPolicyHandler({ writePluginAt: null });
  const unavailableRes = makeRes();
  await unavailable(makeReq({ body: { at: 0.6 } }), unavailableRes);
  assert.equal(unavailableRes.status, 503);
  assert.deepEqual(calls, [0.6], '非法请求不得进入写入口');
});

test('C11② 端到端：设置页保存 0.6 → 重启 → plugin 层值保留、source=plugin', async () => {
  const dir = await tempDir('cg-plugin-e2e-');
  try {
    const file = path.join(dir, 'context-governance', 'plugin-policy.json');
    const store = createPluginPolicyStore({ file });
    const handler = createPluginPolicyHandler({
      writePluginAt: ({ at }) => (store.writeAt(at) ? { ok: true } : { ok: false, error: 'persist-failed' }),
    });
    const res = makeRes();
    await handler(makeReq({ body: { at: 0.6 } }), res);
    assert.equal(res.status, 200);

    // 「重启」：新 store 读回持久值，按 volatile 为空处理（host 未恢复表单）→ 用持久值。
    const restarted = createPluginPolicyStore({ file });
    const persisted = restarted.read();
    assert.equal(persisted.at, 0.6);
    const state = buildPolicyState(mergeSettingsAt(resolveConfig({ projectRoot: 'D:/tmp/plugin-e2e' }), persisted.at), {
      readFile: () => { throw new Error('no project file'); },
      onPolicyResolved: () => {},
    });
    assert.equal(state.resolve(null).values['compact.at'], 0.6);
    assert.equal(state.resolve(null).sources['compact.at'], 'plugin');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C11② 路径：默认落在用户级 ~/.dsh/context-governance/plugin-policy.json', () => {
  const file = pluginPolicyFile('C:/Users/x');
  assert.equal(file, path.join('C:/Users/x', '.dsh', 'context-governance', 'plugin-policy.json'));
  assert.equal(pluginPolicyFile(''), null);
});

test('C11② client：设置页保存走 plugin 写路由（不只写宿主 volatile 表单）', async () => {
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

  const posts = [];
  const formWrites = [];
  const fetchStub = async (url, init) => {
    posts.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, at: 0.6, source: 'plugin' }) };
  };
  const saved = await client.savePluginAt({
    raw: '60',
    snapshot: { at: 0.55, source: 'plugin' },
    fetchImpl: fetchStub,
    configForms: { get: () => ({ set: (field, value) => { formWrites.push([field, value]); return Promise.resolve(); } }) },
  });
  assert.equal(saved.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, PLUGIN_POLICY_PATH);
  assert.deepEqual(JSON.parse(posts[0].init.body), { at: 0.6 });
  assert.deepEqual(formWrites, [['policy.at', 0.6]], '宿主表单是尽力同步，不是唯一存储');

  // 服务端拒绝：报错且不写宿主表单。
  const rejected = await client.savePluginAt({
    raw: '60',
    snapshot: { at: 0.55 },
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'persist-failed' }) }),
    configForms: { get: () => ({ set: (field, value) => { formWrites.push([field, value]); return Promise.resolve(); } }) },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /persist-failed/);
  assert.equal(formWrites.length, 1, '落盘失败不得假装成功去写宿主表单');
});
