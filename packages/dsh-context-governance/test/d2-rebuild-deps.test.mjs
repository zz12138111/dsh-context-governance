/**
 * rc.8 真机缺陷回归：策略重算（设置页保存 plugin 后）不得丢会话层。
 *
 * 缺陷：per-root 重建漏传 deps（无 a2Store）→ 同会话从 `session:A2 0.45` 掉成 `project 0.45`。
 * 门要求（审核）：① 重建后某 root 的会话仍 `session:A2`、A1 仍在；② 设置页保存 plugin 后已存 A2
 * 的会话不被降级；③ 多根各自重建后都不丢会话层、不串。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildPolicyState, resolveConfig } from '../src/index.js';
import { rebuildPolicyStates } from '../src/policy-rebuild.js';
import { createPluginPolicyStore } from '../src/plugin-policy.js';
import { resolvePluginAt } from '../src/settings-policy.js';
import { tempDir } from './helpers.mjs';

function fakeA2(initial = new Map()) {
  const sessions = new Map(initial);
  return {
    sessions,
    read: (sessionId) => (sessions.has(sessionId) ? { at: sessions.get(sessionId), source: 'session:A2' } : null),
    write: (sessionId, at) => { sessions.set(sessionId, at); return true; },
    clear: (sessionId) => { sessions.delete(sessionId); return true; },
  };
}

const noProjectFile = () => { throw new Error('no project file'); };

/** 与 index.js 生产一致的依赖集合（a2Store + markActive + policy-resolved 审计）。 */
const makeDeps = (a2Store, resolved = []) => () => ({
  a2Store,
  markActive: () => {},
  onPolicyResolved: (payload) => resolved.push(payload),
});

test('rc.8 回归①：重建后该 root 的会话仍是 session:A2，A1 仍在', () => {
  const a2 = fakeA2(new Map([['s-a2', 0.45]]));
  const deps = makeDeps(a2);
  const mainConfig = resolveConfig({ projectRoot: 'D:/tmp/rebuild-main' });
  const rootConfig = resolveConfig({ projectRoot: 'D:/tmp/rebuild-a' });

  const { main, roots } = rebuildPolicyStates({
    config: mainConfig,
    rootConfigs: [['root-a', rootConfig]],
    buildPolicyState,
    mergePluginPolicy: (config) => config,
    deps,
  });
  assert.equal(main.resolve('s-a2').sources['compact.at'], 'session:A2');
  const rootA = roots.get('root-a');
  assert.equal(rootA.resolve('s-a2').values['compact.at'], 0.45, 'root 的 state 必须带 a2Store');
  assert.equal(rootA.resolve('s-a2').sources['compact.at'], 'session:A2');

  // A1（本进程 /cg set）在重建后仍压 A2。
  rootA.sessionValues('s-a2', { create: true })['compact.at'] = 0.62;
  assert.equal(rootA.resolve('s-a2').values['compact.at'], 0.62);
  assert.equal(rootA.resolve('s-a2').sources['compact.at'], 'session:A1');
});

test('rc.8 回归②：设置页保存 plugin 后，已存 A2 的会话不被降级（真机样本）', async () => {
  const dir = await tempDir('cg-rebuild-plugin-');
  try {
    const a2 = fakeA2(new Map([['s-a2', 0.45]]));
    const deps = makeDeps(a2);
    const file = path.join(dir, 'context-governance', 'plugin-policy.json');
    const store = createPluginPolicyStore({ file });
    const mergePluginPolicy = (config) => {
      const persisted = store.read();
      const at = resolvePluginAt(config, { persistedAt: persisted === null ? null : persisted.at });
      if (!Number.isFinite(at)) return config;
      return { ...config, policy: { ...config.policy, values: { ...(config.policy?.values ?? {}), 'compact.at': at } } };
    };
    const config = resolveConfig({ projectRoot: 'D:/tmp/rebuild-plugin' });
    const rootConfig = resolveConfig({ projectRoot: 'D:/tmp/rebuild-plugin-a' });

    // 设置页保存 0.6（写路由落盘）→ 重算。
    assert.equal(store.writeAt(0.6), true);
    const after = rebuildPolicyStates({
      config,
      rootConfigs: [['root-a', rootConfig]],
      buildPolicyState,
      mergePluginPolicy,
      deps,
    });
    // plugin 层拿到 0.6，但会话 A2 仍然压它（不得降级成 project/plugin）。
    assert.equal(after.main.resolve(null).values['compact.at'], 0.6);
    assert.equal(after.main.resolve(null).sources['compact.at'], 'plugin');
    const rootA = after.roots.get('root-a');
    assert.equal(rootA.resolve('s-a2').values['compact.at'], 0.45, '会话 A2 不得被 plugin 保存冲掉');
    assert.equal(rootA.resolve('s-a2').sources['compact.at'], 'session:A2');

    // 无 A2 的会话：按 plugin 新值走（保存确实生效）。
    assert.equal(rootA.resolve('s-other').values['compact.at'], 0.6);
    assert.equal(rootA.resolve('s-other').sources['compact.at'], 'plugin');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('rc.8 回归③：多根各自重建都不丢会话层，且不串', () => {
  const a2 = fakeA2(new Map([['s-a', 0.55], ['s-b', 0.65]]));
  const deps = makeDeps(a2);
  const config = resolveConfig({ projectRoot: 'D:/tmp/rebuild-multi' });
  const rootA = resolveConfig({ projectRoot: 'D:/tmp/rebuild-multi-a' });
  const rootB = resolveConfig({ projectRoot: 'D:/tmp/rebuild-multi-b' });
  const { roots } = rebuildPolicyStates({
    config,
    rootConfigs: [['root-a', rootA], ['root-b', rootB]],
    buildPolicyState,
    mergePluginPolicy: (input) => input,
    deps,
  });
  assert.deepEqual([...roots.keys()], ['root-a', 'root-b']);
  assert.equal(roots.get('root-a').resolve('s-a').sources['compact.at'], 'session:A2');
  assert.equal(roots.get('root-a').resolve('s-a').values['compact.at'], 0.55);
  assert.equal(roots.get('root-b').resolve('s-b').sources['compact.at'], 'session:A2');
  assert.equal(roots.get('root-b').resolve('s-b').values['compact.at'], 0.65);
  // A2 是用户级、按 sessionId 存的（不分根），所以两个 root 都各自解析到同一会话层——
  // 关键是"重建后不丢"，而不是"跨根隐藏"。
  assert.equal(roots.get('root-a').resolve('s-b').sources['compact.at'], 'session:A2');
  assert.equal(roots.get('root-b').resolve('s-a').values['compact.at'], 0.55);
});

test('rc.8 回归④：deps 出厂即校验——漏传 build/merge/deps 直接报错，不静默降级', () => {
  assert.throws(() => rebuildPolicyStates({ config: {}, buildPolicyState: null, mergePluginPolicy: (c) => c, deps: () => ({}) }), /buildPolicyState/);
  assert.throws(() => rebuildPolicyStates({ config: {}, buildPolicyState: () => ({}), mergePluginPolicy: null, deps: () => ({}) }), /mergePluginPolicy/);
  assert.throws(() => rebuildPolicyStates({ config: {}, buildPolicyState: () => ({}), mergePluginPolicy: (c) => c, deps: null }), /deps/);
});
