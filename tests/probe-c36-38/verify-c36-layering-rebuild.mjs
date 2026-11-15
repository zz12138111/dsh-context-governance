/**
 * 测试角色 · C36③ 层级回归探针：`rebuildPolicies()` 之后会话层（A2/A1）不得丢失
 *
 * 背景（rc.8 缺陷）：设置页保存触发 `rebuildPolicies()`，per-root 重建
 * `buildPolicyState(mergePluginPolicy(rootConfig))` **漏传 a2Store/onPolicyResolved**
 * → 该 root 的 guard policy / policyCache 丢 A2 层，status 由 `session:A2` 掉到 `project`（值同才掩盖）。
 *
 * 用例（门级）：
 *   1. 重建后，有 A2 的会话仍解析 `session:A2`（单根）
 *   2. 重建后，有 A1 的会话仍解析 `session:A1`（同进程内层不丢）
 *   3. 设置页保存 plugin（触发 rebuild）后，已存 A2 的会话不被降级到 project/plugin
 *   4. 多根：每个 root 重建后都不丢会话层
 *
 * 手法：临时 home + 两个临时根；fake ctx 提供 settings 服务（让 apply 注册 config-reload），
 *      发一次 session/event 建 guard（真机 status 走 guard policy），再触发 config-reload 对比。
 * 不装、不启用、不重启。用法：node tests\probe-c36-38\verify-c36-layering-rebuild.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../../packages/dsh-context-governance/src/index.js';
import { createA2Store } from '../../packages/dsh-context-governance/src/a2-store.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rebuild-'));
const home = path.join(base, 'home');
const rootA = path.join(base, 'rootA');
const rootB = path.join(base, 'rootB');
for (const dir of [home, rootA, rootB]) fs.mkdirSync(dir, { recursive: true });
const previousProfile = process.env.USERPROFILE;
process.env.USERPROFILE = home;

const sidA = 'session-rebuild-aaaa-1111-2222-333344445555';
const sidB = 'session-rebuild-bbbb-1111-2222-333344445555';

function makeCtx() {
  const captured = { handlers: [], commands: [], tools: [] };
  const ctx = {
    commands: captured.commands,
    tools: { register: (d) => captured.tools.push(d) },
    get(name) {
      if (name === 'profileContext') {
        return { name: 'iso-rebuild', dir: path.join(base, 'profile'), home: path.join(base, 'dshhome') };
      }
      if (name === 'commands') return { register: (d) => captured.commands.push(d) };
      if (name === 'settings') return { subscribe: () => () => {} }; // 让 apply 注册 config-reload
      return undefined;
    },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, captured };
}

const statusFor = async (captured, sid) => {
  const cg = captured.commands.find((d) => d.name === 'cg');
  return String((await cg.handler({ rawInput: 'status', agent: { session: { id: sid } } })).text ?? '');
};
const policySource = (text) => (text.split('\n').find((line) => line.startsWith('policy:')) ?? '')
  .match(/source=([^)\s]+)/)?.[1] ?? null;
const policyAt = (text) => (text.split('\n').find((line) => line.startsWith('policy:')) ?? '')
  .match(/compact\.at=([0-9.]+)/)?.[1] ?? null;

try {
  const { ctx, captured } = makeCtx();
  // A2 必须在 apply 前落盘（插件 a2 store 在 apply 时加载；外部写入不会被重读）
  const a2Seed = createA2Store({ file: path.join(home, '.dsh', 'context-governance', 'session-policy.json') });
  a2Seed.write(sidA, 0.62);
  a2Seed.write(sidB, 0.66);
  await apply(ctx, { projectRoot: rootA, project: 'iso-rebuild' });

  // 发一次 session/event 建 guard（真机 status 走 guard policy）
  const reload = captured.handlers.filter((entry) => entry.event === 'app-boot/config-reload');
  for (const entry of captured.handlers.filter((item) => item.event === 'session/event')) {
    try { await entry.handler({ header: { id: sidA, cwd: rootA } }, { type: 'turn/start', seq: 1, data: { turn: 1 } }, async () => undefined); } catch { /* 忽略 */ }
  }
  await sleep(120);
  for (const entry of captured.handlers.filter((item) => item.event === 'session/event')) {
    try { await entry.handler({ header: { id: sidB, cwd: rootB } }, { type: 'turn/start', seq: 1, data: { turn: 1 } }, async () => undefined); } catch { /* 忽略 */ }
  }
  await sleep(120);

  const before = await statusFor(captured, sidA);
  check('C36-rebuild-precondition-a2', policySource(before) === 'session:A2',
    `before=${policySource(before)} at=${policyAt(before)}`);
  const beforeB = await statusFor(captured, sidB);
  check('C36-rebuild-precondition-a2-rootB', policySource(beforeB) === 'session:A2',
    `beforeB=${policySource(beforeB)} at=${policyAt(beforeB)}`);

  // 触发 rebuild（= 设置页保存后 Host 广播 config-reload 同路径）
  for (const entry of reload) { try { await entry.handler({}); } catch { /* 忽略 */ } }
  await sleep(120);

  const after = await statusFor(captured, sidA);
  check('C36-rebuild-1-a2-kept', policySource(after) === 'session:A2' && policyAt(after) === '0.62',
    `after=${policySource(after)} at=${policyAt(after)}`);
  const afterB = await statusFor(captured, sidB);
  check('C36-rebuild-4-multiroot-a2-kept', policySource(afterB) === 'session:A2' && policyAt(afterB) === '0.66',
    `afterB=${policySource(afterB)} at=${policyAt(afterB)}`);

  // A1：进程内会话层（用 /cg set 写 A1，再 rebuild 看是否仍 session:A1）
  const cg = captured.commands.find((d) => d.name === 'cg');
  await cg.handler({ rawInput: 'set compact.at=0.5', agent: { session: { id: sidA } } });
  const beforeA1 = await statusFor(captured, sidA);
  for (const entry of reload) { try { await entry.handler({}); } catch { /* 忽略 */ } }
  await sleep(120);
  const afterA1 = await statusFor(captured, sidA);
  check('C36-rebuild-2-a1-kept', policySource(afterA1) === 'session:A1',
    `beforeA1=${policySource(beforeA1)}(${policyAt(beforeA1)}) afterA1=${policySource(afterA1)}(${policyAt(afterA1)})`);

  // 用例 3：设置页保存 plugin（写 plugin-policy.json + rebuild）后 A2 会话不被降级
  const pluginFile = path.join(home, '.dsh', 'context-governance', 'plugin-policy.json');
  fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
  fs.writeFileSync(pluginFile, JSON.stringify({ version: 1, at: 0.58, source: 'plugin', updatedAt: new Date().toISOString() }), 'utf8');
  for (const entry of reload) { try { await entry.handler({}); } catch { /* 忽略 */ } }
  await sleep(120);
  const afterPlugin = await statusFor(captured, sidB);
  check('C36-rebuild-3-plugin-save-a2-not-downgraded', policySource(afterPlugin) === 'session:A2',
    `afterPlugin=${policySource(afterPlugin)} at=${policyAt(afterPlugin)}`);
} finally {
  process.env.USERPROFILE = previousProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC36 层级/重建 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
