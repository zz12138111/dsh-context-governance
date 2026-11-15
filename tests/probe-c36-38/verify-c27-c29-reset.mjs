/**
 * 测试角色 · C27/C29「清除会话自定义」两态门（常驻门，2026-11-15 补；审核 `a3f631b` 缺口）。
 *
 * 为什么存在：只测"有 A1 时 reset"会漏掉重启后的 A2-only 状态——
 * rc.10（`7d72ad8`）在该状态下 `/cg set reset` 返回 `cleared: 0`、A2 落盘残留、status 仍 `session:A2`。
 *
 * 判据（常驻清单 §3 / 审核 a3f631b §4）：
 *  ① A2-only（模拟重启后：只 seed A2、无 A1）→ reset 报 `cleared: 1`；A2 落盘无该 sid；
 *     status 回落项目模板/plugin（本次用 plugin 0.58）；再重启仍回落（不复活）。
 *  ② A1+A2 同时存在 → reset 后两层都清（`cleared: 2`），回落 plugin。
 *  ③ UI「恢复全局设置」入口存在、点击走同一条 reset 链路（POST `{reset:true}` → 服务端 resetSessionAt），
 *     文案不误导（"恢复默认"只填草稿值，不清层；"恢复全局设置"才是清本会话自定义）。
 *
 * 隔离：临时 profileContext + 临时 A2 文件 + 命令层真实 handler；不装、不启用、不重启、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-c27-c29-reset.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../../packages/dsh-context-governance/src/index.js';
import { createA2Store } from '../../packages/dsh-context-governance/src/a2-store.js';
import { createSessionPolicyHandler, SESSION_POLICY_PATH } from '../../packages/dsh-context-governance/src/session-policy-route.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-reset-'));
const dshHome = path.join(base, 'dshhome');
const profileDir = path.join(base, 'profile');
const proj = path.join(base, 'proj');
const fakeUserProfile = path.join(base, 'fakehome');
for (const dir of [dshHome, profileDir, proj, fakeUserProfile]) fs.mkdirSync(dir, { recursive: true });
const a2File = path.join(dshHome, 'context-governance', 'session-policy.json');
const sid = 'session-reset-aaaa-1111-2222-333344445555';
const previousProfile = process.env.USERPROFILE;
process.env.USERPROFILE = fakeUserProfile;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const policySource = (text) => (text.split('\n').find((line) => line.startsWith('policy:')) ?? '').match(/source=([^)\s]+)/)?.[1] ?? null;
const policyAt = (text) => (text.split('\n').find((line) => line.startsWith('policy:')) ?? '').match(/compact\.at=([0-9.]+)/)?.[1] ?? null;

function makeCtx() {
  const captured = { handlers: [], commands: [], tools: [] };
  const ctx = {
    commands: captured.commands,
    tools: { register: (definition) => captured.tools.push(definition) },
    get(name) {
      if (name === 'profileContext') return { name: 'iso-reset', dir: profileDir, home: dshHome };
      if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
      if (name === 'settings') return { subscribe: () => () => {} };
      return undefined;
    },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, captured };
}

async function boot({ seedA2 = true } = {}) {
  if (seedA2) {
    const store = createA2Store({ file: a2File });
    store.write(sid, 0.62);
  }
  const { ctx, captured } = makeCtx();
  await apply(ctx, { projectRoot: proj, project: 'iso-reset', policy: { values: { 'compact.at': 0.58 } } });
  for (const entry of captured.handlers.filter((item) => item.event === 'session/event')) {
    try {
      await entry.handler({ header: { id: sid, cwd: proj } }, { type: 'turn/start', seq: 1, data: { turn: 1 } }, async () => undefined);
    } catch { /* 中间件签名差异：忽略 */ }
  }
  await sleep(80);
  const cg = captured.commands.find((definition) => definition.name === 'cg');
  const run = async (rawInput) => String((await cg.handler({ rawInput, agent: { session: { id: sid, cwd: proj } } })).text ?? '');
  return { run, store: createA2Store({ file: a2File }) };
}

try {
  // ── ① A2-only（模拟重启后：只有 A2，无 A1）──
  const a2Only = await boot();
  const before = await a2Only.run('status');
  check('C27-a2-only-precondition', policySource(before) === 'session:A2' && policyAt(before) === '0.62',
    `before=${policySource(before)} at=${policyAt(before)}（期望 session:A2 0.62）`);
  const resetText = await a2Only.run('set reset');
  check('C27-a2-only-reset-cleared-1', /cleared:\s*1 session override/.test(resetText),
    `text=${JSON.stringify(resetText.split('\n').slice(0, 3))}（期望 cleared: 1）`);
  check('C27-a2-only-disk-cleared', createA2Store({ file: a2File }).read(sid) === null,
    `a2.read(${sid})=${JSON.stringify(createA2Store({ file: a2File }).read(sid))}（期望 null；用新实例读盘，旧实例有内存缓存）`);
  const after = await a2Only.run('status');
  check('C27-a2-only-falls-back-plugin', policySource(after) === 'plugin' && policyAt(after) === '0.58',
    `after=${policySource(after)} at=${policyAt(after)}（期望 plugin 0.58，不得仍 session:A2）`);

  // ①b 再"重启"一次（新实例）→ 不得复活
  const restarted = await boot({ seedA2: false });
  const afterRestart = await restarted.run('status');
  check('C27-a2-only-restart-still-plugin', policySource(afterRestart) === 'plugin' && policyAt(afterRestart) === '0.58',
    `restart=${policySource(afterRestart)} at=${policyAt(afterRestart)}`);

  // ── ② A1+A2 同时存在 ──
  fs.rmSync(a2File, { force: true });
  const both = await boot();
  const setText = await both.run('set compact.at=0.5');
  const bothBefore = await both.run('status');
  check('C29-a1-a2-precondition', policySource(bothBefore) === 'session:A1' && policyAt(bothBefore) === '0.50',
    `set=${JSON.stringify(setText.split('\n')[1] ?? '')} before=${policySource(bothBefore)} at=${policyAt(bothBefore)}`);
  const bothReset = await both.run('set reset');
  check('C29-a1-a2-reset-clears-both', /cleared:\s*2 session override/.test(bothReset),
    `text=${JSON.stringify(bothReset.split('\n').slice(0, 3))}（期望 cleared: 2 = A1 1 键 + A2 1 条）`);
  const bothAfter = await both.run('status');
  check('C29-a1-a2-falls-back-plugin', policySource(bothAfter) === 'plugin' && policyAt(bothAfter) === '0.58',
    `after=${policySource(bothAfter)} at=${policyAt(bothAfter)}`);
  check('C29-a1-a2-disk-cleared', createA2Store({ file: a2File }).read(sid) === null,
    `a2.read=${JSON.stringify(createA2Store({ file: a2File }).read(sid))}（A2 不得残留孤儿记录）`);

  // ── ③ UI「恢复全局设置」入口 + 同链 + 文案 ──
  const client = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
  const hasEntry = /resetGlobal:\s*'恢复全局设置'/.test(client) && /resetToGlobal/.test(client);
  check('C29-ui-entry-exists', hasEntry, `label=${/resetGlobal:\s*'恢复全局设置'/.test(client)} handler=${/resetToGlobal/.test(client)}`);
  const resetSessionAtIndex = client.indexOf('resetSessionAt');
  const resetSessionAtBody = resetSessionAtIndex === -1 ? '' : client.slice(resetSessionAtIndex, resetSessionAtIndex + 1400);
  const postsSameRoute = resetSessionAtBody.includes('SESSION_POLICY_PATH') && /reset:\s*true/.test(resetSessionAtBody);
  // 服务端：reset:true → resetSessionAt 回调（与 `/cg set reset` 同一条链）
  let routeSessionId = null;
  let writeCalled = false;
  const handler = createSessionPolicyHandler({
    writeSessionAt: async () => { writeCalled = true; return { ok: true }; },
    resetSessionAt: async ({ sessionId }) => { routeSessionId = sessionId; return { ok: true }; },
  });
  let status = 0;
  let payload = '';
  const req = {
    method: 'POST',
    url: SESSION_POLICY_PATH,
    headers: {
      origin: 'http://127.0.0.1:4167',
      host: '127.0.0.1:4167',
      'content-type': 'application/json',
      'content-length': String(JSON.stringify({ sessionId: sid, reset: true }).length),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* iterate() { yield Buffer.from(JSON.stringify({ sessionId: sid, reset: true })); },
  };
  const res = { writeHead(code) { status = code; }, end(chunk) { payload += chunk ?? ''; } };
  await handler(req, res);
  check('C29-ui-entry-same-chain', postsSameRoute && status === 200 && routeSessionId === sid && writeCalled === false,
    `postsSameRoute=${postsSameRoute} status=${status} routeSessionId=${routeSessionId} writeCalled=${writeCalled} payload=${payload.slice(0, 80)}`);
  // B14（2026-11-15）：删除「恢复默认 60%」后，本断言不再依赖该控件是否存在（旧 `keepsDraftRestore` 恒 false）。
  // 保留 C29 本意：①提示给的是可点入口而不是只让用户敲命令；②文案不得宣称"一键回内置默认"（能力已变）。
  const notePointsToEntry = !/清除用 \/cg set reset/.test(client) || /恢复全局设置/.test(client);
  const noBuiltinDefaultPromise = !/一键回内置默认|一键恢复默认值|恢复默认值/.test(client);
  check('C29-ui-wording-not-misleading', notePointsToEntry && noBuiltinDefaultPromise,
    `提示不再只给命令=${notePointsToEntry} 无「一键回内置默认」承诺=${noBuiltinDefaultPromise}`
    + '（B14：恢复默认按钮已删，本断言不再检查该控件）');
} catch (error) {
  check('C27-C29-window', false, `抛错：${String(error?.stack ?? error).slice(0, 400)}`);
} finally {
  process.env.USERPROFILE = previousProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC27/C29 清除会话自定义 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
