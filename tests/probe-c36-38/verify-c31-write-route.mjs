/**
 * 测试角色 · C31「A2 写入接口安全」常驻门（2026-11-15 补；审核 `e0f4c04` 裁定 loopback=实现缺口）。
 *
 * rc.10（`7d72ad8`）缺口：无 `req.socket.remoteAddress` loopback 校验；Origin/Host 缺失时同源判定放行。
 * 判据（7 例）：
 *   ① 非 loopback 拒（`loopback-only`）；
 *   ② Origin 缺失拒（`missing-origin`）；
 *   ③ Host 缺失拒；
 *   ④ 跨源拒（`cross-origin`）；
 *   ⑤ 合法同源放行（200，`{ok,at,source:session:A2}`，写入回落调 writeSessionAt）；
 *   ⑥ `::1` 放行；
 *   ⑦ `::ffff:127.0.0.1` 放行。
 *
 * 只打 `createSessionPolicyHandler`（真实 handler + 假 req/res），不装、不联网、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-c31-write-route.mjs
 */
import path from 'node:path';

import { createSessionPolicyHandler, SESSION_POLICY_PATH } from '../../packages/dsh-context-governance/src/session-policy-route.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const sid = 'session-c31-aaaa-1111-2222-333344445555';
const HOME_ORIGIN = 'http://127.0.0.1:4167';
const HOME_HOST = '127.0.0.1:4167';

function makeReq({ remoteAddress = '127.0.0.1', headers = {}, body = { sessionId: sid, at: 0.5 }, omit = [] } = {}) {
  const payload = JSON.stringify(body);
  const merged = { host: HOME_HOST, origin: HOME_ORIGIN, 'content-type': 'application/json', ...headers };
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
  });
  let status = 0;
  let payload = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { payload += chunk ?? ''; } };
  await handler(req, res);
  let parsed = null;
  try { parsed = JSON.parse(payload); } catch { parsed = null; }
  return { status, body: parsed, payload, calls };
}

function without(headers, ...keys) {
  const copy = { ...headers };
  for (const key of keys) delete copy[key];
  return copy;
}

try {
  // ① 非 loopback 拒
  {
    const out = await post(makeReq({ remoteAddress: '10.0.0.5' }));
    check('C31-1-non-loopback-rejected', out.status === 403 && /loopback/i.test(String(out.body?.error ?? '')),
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403，错误码含 loopback）`);
  }
  // ② Origin 缺失（无 sec-fetch-site）拒
  {
    const out = await post(makeReq({ omit: ['origin'] }));
    check('C31-3-missing-origin-rejected', out.status === 403 && /origin/i.test(String(out.body?.error ?? '')),
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403，错误码 missing-origin/cross-origin）`);
  }
  // ③ Host 缺失拒
  {
    const out = await post(makeReq({ omit: ['host'] }));
    check('C31-3-missing-host-rejected', out.status === 403,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403）`);
  }
  // ④ 跨源拒
  {
    const out = await post(makeReq({ headers: { origin: 'https://evil.example' } }));
    check('C31-3-cross-origin-rejected', out.status === 403 && out.body?.error === 'cross-origin',
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 403 cross-origin）`);
  }
  // ⑤ 合法同源放行 + 写回落调
  {
    const out = await post(makeReq());
    check('C31-3-same-origin-allowed',
      out.status === 200 && out.body?.ok === true && out.body?.at === 0.5 && out.body?.source === 'session:A2'
      && out.calls.writes.length === 1 && out.calls.writes[0]?.sessionId === sid && out.calls.writes[0]?.at === 0.5,
      `status=${out.status} body=${JSON.stringify(out.body)} writes=${JSON.stringify(out.calls.writes)}`);
  }
  // ⑥ ::1 放行
  {
    const out = await post(makeReq({ remoteAddress: '::1' }));
    check('C31-1-ipv6-loopback-allowed', out.status === 200 && out.body?.ok === true,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200）`);
  }
  // ⑦ ::ffff:127.0.0.1 放行
  {
    const out = await post(makeReq({ remoteAddress: '::ffff:127.0.0.1' }));
    check('C31-1-ipv4-mapped-loopback-allowed', out.status === 200 && out.body?.ok === true,
      `status=${out.status} body=${JSON.stringify(out.body)}（期望 200）`);
  }
} catch (error) {
  check('C31-window', false, `抛错：${String(error?.stack ?? error).slice(0, 400)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC31 写入路由安全 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
