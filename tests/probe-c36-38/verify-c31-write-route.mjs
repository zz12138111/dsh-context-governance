/**
 * 测试角色 · C31「A2 写入接口安全」门（2026-11-15 口径：需求 `504cc15` 裁定 + 审核修订）。
 *
 * 口径（C31③ 按意图解释）：**①合法同源 `Origin` ②`Sec-Fetch-Site: same-origin` ③宿主 token/nonce**
 *   三者**任一** + loopback 即放行；**三者皆无才拒**（`missing-proof`）。
 *   —— 这正是 rc.10 P5 的现实场景：宿主同源 fetch 不带 Origin/Sec-Fetch，必须靠 token 或三者任一放行，
 *      不能反过来把自家 UI 拒掉（rc.10 真机 403 missing-origin = BLOCKER）。
 *
 * 判据（10 条）：
 *   ① 合法同源 Origin（无 token）→ 200           ② 合法 token + 同源 → 200
 *   ③ 三者皆无 → 403                             ④ 错 token 且无 Origin/Sec-Fetch → 403
 *   ⑤ 合法 token + 跨源 Origin → 403 `cross-origin`
 *   ⑥ 非 loopback（带 origin+token，离线假 socket）→ 403 `not-loopback`
 *   ⑦ `::1` → 200                                ⑧ `::ffff:127.0.0.1` → 200
 *   ⑨ `Sec-Fetch-Site: same-origin`（无 Origin/token）→ 200
 *   ⑩ 正向请求必须真的调到写回落调 `{sessionId, at}`
 *
 * 只打 `createSessionPolicyHandler`（真实 handler + 假 req/res），不装、不联网、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-c31-write-route.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionPolicyHandler, mountPluginPolicyRoute, mountSessionPolicyRoute, PLUGIN_POLICY_PATH, SESSION_POLICY_PATH } from '../../packages/dsh-context-governance/src/session-policy-route.js';
import { createPluginPolicyStore } from '../../packages/dsh-context-governance/src/plugin-policy.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const sid = 'session-c31-aaaa-1111-2222-333344445555';
const HOME_ORIGIN = 'http://127.0.0.1:4167';
const HOME_HOST = '127.0.0.1:4167';
const TOKEN = 'c31-token-abc-123';
const CSRF_HEADER = 'x-context-governance-csrf';

function makeReq({ remoteAddress = '127.0.0.1', headers = {}, body = { sessionId: sid, at: 0.5 }, omit = [] } = {}) {
  const payload = JSON.stringify(body);
  const merged = { host: HOME_HOST, 'content-type': 'application/json', ...headers };
  for (const key of omit) delete merged[key];
  return {
    method: 'POST',
    url: SESSION_POLICY_PATH,
    socket: { remoteAddress },
    headers: merged,
    [Symbol.asyncIterator]: async function* iterate() { yield Buffer.from(payload); },
  };
}

async function post(req) {
  const calls = { writes: [], resets: [] };
  const handler = createSessionPolicyHandler({
    writeSessionAt: async (args) => { calls.writes.push(args); return { ok: true }; },
    resetSessionAt: async (args) => { calls.resets.push(args); return { ok: true }; },
    csrfToken: TOKEN,
  });
  let status = 0;
  let payload = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { payload += chunk ?? ''; } };
  await handler(req, res);
  let body = null;
  try { body = JSON.parse(payload); } catch { body = null; }
  return { status, body, calls };
}

/** 走真实挂载入口（mountPluginPolicyRoute）打 plugin 层写：验证 token 是否被挂载层转发。 */
async function postPluginMounted(req, { csrfToken = TOKEN } = {}) {
  const calls = [];
  let mounted = null;
  const fakeHost = {
    webServer: { register({ handler }) { mounted = handler; return () => {}; } },
    effect() { return () => {}; },
  };
  const ctx = { inject(services, fn) { fn(fakeHost); }, get() { return undefined; } };
  mountPluginPolicyRoute(ctx, { writePluginAt: async (args) => { calls.push(args); return { ok: true }; }, csrfToken });
  if (typeof mounted !== 'function') return { status: 0, body: null, calls, mounted: false };
  let status = 0;
  let payload = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { payload += chunk ?? ''; } };
  await mounted(req, res);
  let body = null;
  try { body = JSON.parse(payload); } catch { body = null; }
  return { status, body, calls, mounted: true };
}

/** 走真实挂载入口（mountSessionPolicyRoute）打会话层写：防第三处漏传 token。 */
async function postSessionMounted(req) {
  const calls = [];
  let mounted = null;
  const fakeHost = {
    webServer: { register({ handler }) { mounted = handler; return () => {}; } },
    effect() { return () => {}; },
  };
  const ctx = { inject(services, fn) { fn(fakeHost); }, get() { return undefined; } };
  mountSessionPolicyRoute(ctx, {
    writeSessionAt: async (args) => { calls.push(args); return { ok: true }; },
    resetSessionAt: async (args) => { calls.push(args); return { ok: true }; },
    csrfToken: TOKEN,
  });
  if (typeof mounted !== 'function') return { status: 0, body: null, calls, mounted: false };
  let status = 0;
  let payload = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { payload += chunk ?? ''; } };
  await mounted(req, res);
  let body = null;
  try { body = JSON.parse(payload); } catch { body = null; }
  return { status, body, calls, mounted: true };
}

function makePluginReq({ headers = {}, body = { at: 0.55 }, omit = [] } = {}) {
  const payload = JSON.stringify(body);
  const merged = { host: HOME_HOST, 'content-type': 'application/json', ...headers };
  for (const key of omit) delete merged[key];
  return {
    method: 'POST',
    url: PLUGIN_POLICY_PATH,
    socket: { remoteAddress: '127.0.0.1' },
    headers: merged,
    [Symbol.asyncIterator]: async function* iterate() { yield Buffer.from(payload); },
  };
}

const proofCode = (body) => String(body?.error ?? '');

try {
  // ① 合法同源 Origin（无 token）→ 200：这是 P5 的现实场景，必须是门
  {
    const out = await post(makeReq({ headers: { origin: HOME_ORIGIN } }));
    check('C31-3-same-origin-origin-no-token-allowed',
      out.status === 200 && out.body?.ok === true && out.body?.at === 0.5 && out.body?.source === 'session:A2',
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200，不得再拒自家 UI）`);
  }
  // ② 合法 token + 同源 → 200
  {
    const out = await post(makeReq({ headers: { origin: HOME_ORIGIN, [CSRF_HEADER]: TOKEN } }));
    check('C31-3-valid-token-allowed', out.status === 200 && out.body?.ok === true,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200）`);
  }
  // ②b P5 现实场景：宿主同源 fetch **不带 Origin/Sec-Fetch-Site，只带 token** → 必须 200
  {
    const out = await post(makeReq({ headers: { [CSRF_HEADER]: TOKEN } }));
    check('C31-3-valid-token-no-origin-allowed', out.status === 200 && out.body?.ok === true,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200；rc.10 未修时在此 403 missing-origin = P5，修后必须绿）`);
  }
  // ③ 三者皆无 → 403
  {
    const out = await post(makeReq());
    check('C31-3-no-proof-rejected',
      out.status === 403 && /missing-proof|missing-origin|missing-token/.test(proofCode(out.body)),
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403，拒因 missing-proof 一类）`);
  }
  // ④ 错 token 且无 Origin/Sec-Fetch → 403
  {
    const out = await post(makeReq({ headers: { [CSRF_HEADER]: 'bogus-token' } }));
    check('C31-3-bad-token-rejected', out.status === 403,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403）`);
  }
  // ⑤ 合法 token + 跨源 Origin → 403 cross-origin
  {
    const out = await post(makeReq({ headers: { origin: 'https://evil.example', [CSRF_HEADER]: TOKEN } }));
    check('C31-3-cross-origin-rejected', out.status === 403 && /cross-origin/.test(proofCode(out.body)),
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403 cross-origin）`);
  }
  // ⑥ 非 loopback（带 origin+token，离线假 socket）→ 403 not-loopback
  {
    const out = await post(makeReq({ remoteAddress: '10.0.0.5', headers: { origin: HOME_ORIGIN, [CSRF_HEADER]: TOKEN } }));
    check('C31-1-non-loopback-rejected', out.status === 403 && /loopback/i.test(proofCode(out.body)),
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403，含 loopback）`);
  }
  // ⑦ ::1 → 200
  {
    const out = await post(makeReq({ remoteAddress: '::1', headers: { origin: HOME_ORIGIN } }));
    check('C31-1-ipv6-loopback-allowed', out.status === 200 && out.body?.ok === true,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200）`);
  }
  // ⑧ ::ffff:127.0.0.1 → 200
  {
    const out = await post(makeReq({ remoteAddress: '::ffff:127.0.0.1', headers: { origin: HOME_ORIGIN } }));
    check('C31-1-ipv4-mapped-loopback-allowed', out.status === 200 && out.body?.ok === true,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200）`);
  }
  // ⑨ Sec-Fetch-Site: same-origin（无 Origin/token）→ 200
  {
    const out = await post(makeReq({ headers: { 'sec-fetch-site': 'same-origin' } }));
    check('C31-3-sec-fetch-site-allowed', out.status === 200 && out.body?.ok === true,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200）`);
  }
  // ⑩ 正向必须调到写回落调
  {
    const out = await post(makeReq({ headers: { origin: HOME_ORIGIN } }));
    check('C31-3-write-callback-called',
      out.calls.writes.length === 1 && out.calls.writes[0]?.sessionId === sid && out.calls.writes[0]?.at === 0.5,
      `writes=${JSON.stringify(out.calls.writes)}（期望 1 次 {sessionId,at}）`);
  }
  // ⑪ plugin 层挂载入口必须转发 token：token-only 写 → 200 + `via:"token"`（rc.11 曾漏传 csrfToken，被 origin 路径掩盖）
  {
    const out = await postPluginMounted(makePluginReq({ headers: { [CSRF_HEADER]: TOKEN } }));
    check('C31-plugin-route-token-only-allowed',
      out.status === 200 && out.body?.ok === true && out.body?.source === 'plugin'
      && out.body?.via === 'token' && out.calls.length === 1 && out.calls[0]?.via === 'token',
      `status=${out.status} body=${JSON.stringify(out.body)} calls=${JSON.stringify(out.calls)}（期望 200 + via=token；403=挂载层没转发 csrfToken）`);
  }
  // ⑫ plugin 层无任何证明 → 403
  {
    const out = await postPluginMounted(makePluginReq());
    check('C31-plugin-route-no-proof-rejected', out.status === 403 && /missing-proof/.test(proofCode(out.body)),
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403 missing-proof）`);
  }
  // ⑫b 透传退化保护：mount 未配置 token 时，token-only 必须 403（防止将来又漏传）
  {
    const out = await postPluginMounted(makePluginReq({ headers: { [CSRF_HEADER]: TOKEN } }), { csrfToken: null });
    check('C31-plugin-route-mount-token-not-configured-rejected',
      out.status === 403 && /missing-proof/.test(proofCode(out.body)) && out.calls.length === 0,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403 missing-proof，写回落调不得触发）`);
  }
  // ⑫c `plugin-policy-persisted` 审计必须带 via:token（不记 token 值）
  {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c31-plugin-audit-')), 'plugin-policy.json');
    const rows = [];
    const store = createPluginPolicyStore({ file, audit: (event, details) => rows.push({ event, details }) });
    const wrote = store.writeAtIfChanged(0.55, 'token');
    const persisted = rows.filter((row) => row.event === 'plugin-policy-persisted');
    check('C31-plugin-policy-audit-via-token',
      wrote === true && persisted.length === 1 && persisted[0].details?.via === 'token'
        && !JSON.stringify(persisted[0].details).includes(TOKEN),
      `wrote=${wrote} rows=${JSON.stringify(persisted)}（期望 1 行 via=token，且不含 token 值）`);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  // ⑬ session 层挂载入口也必须转发 token：token-only 写 → 200
  {
    const out = await postSessionMounted(makeReq({ headers: { [CSRF_HEADER]: TOKEN } }));
    check('C31-session-route-mount-token-only-allowed',
      out.status === 200 && out.body?.ok === true && out.body?.source === 'session:A2' && out.calls.length === 1,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200；403=session 挂载层没转发 csrfToken）`);
  }
} catch (error) {
  check('C31-window', false, `抛错：${String(error?.stack ?? error).slice(0, 400)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC31 写入路由安全 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
