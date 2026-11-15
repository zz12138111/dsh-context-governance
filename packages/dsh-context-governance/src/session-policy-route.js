/**
 * C11③：会话级保存的写入口（chip / 气泡 → A2）。
 *
 * 为什么需要这条路由：浏览器侧拿不到宿主命令面，只能走 HTTP；本插件已有一个只读快照路由，
 * 这里补一个**只写会话层**的写路由。写本身不在这里做——真正的校验/审计/A1+A2 双写
 * 全部复用 `/cg set compact.at=<at>` 的同一条命令处理链（见 index.js 的 sessionWriteRef），
 * 避免 UI 与命令两套规则漂移。
 *
 * 安全边界：
 * - 只接受 POST；只接受 `{ sessionId, at }`；
 * - sessionId 必须匹配白名单字符集与长度上限，否则 400（不写任何东西）；
 * - at 必须是 [0,1] 的有限数；真正的业务校验（下限/窗口上限/未确认）由命令链裁决，失败映射成 409；
 * - 带 Origin 且与 Host 不同源 → 403（本机服务也不接受跨站写入）；
 * - 响应只回 at/source/失败码，不回会话内容、不回本机路径。
 */

export const SESSION_POLICY_PATH = '/context-governance/session-policy';

/** 会话 id：宿主是 uuid，历史/别名统一按白名单字符集收口。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const DEFAULT_MAX_BYTES = 4096;

/** C31①：只接受 loopback 来源（IPv4 / IPv6 / IPv4-mapped）；取不到 socket 地址按拒绝处理。 */
export const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function isLoopbackRequest(req) {
  let address = null;
  try {
    address = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? null;
  } catch {
    address = null;
  }
  if (typeof address !== 'string' || address === '') return false;
  const normalized = address.startsWith('::ffff:') ? address : address.replace(/^\[|\]$/g, '');
  return LOOPBACK_ADDRESSES.includes(normalized);
}

/** C31③：同源必做——`Origin`+`Host` 同源，或 `Sec-Fetch-Site ∈ {same-origin, none}`；否则拒绝。 */
export function isSameOriginRequest(req) {
  const headers = req?.headers ?? {};
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'same-origin') return true;
  const origin = headers.origin;
  const host = headers.host;
  if (typeof origin !== 'string' || origin === '' || typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 同源失败时的错误码：两处头都缺 = `missing-origin`；给了但不同源 = `cross-origin`。 */
export function sameOriginErrorCode(req) {
  const headers = req?.headers ?? {};
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase();
  const hasOrigin = typeof headers.origin === 'string' && headers.origin !== '';
  return site === '' && hasOrigin !== true ? 'missing-origin' : 'cross-origin';
}

/** C31②：只接受 JSON 请求体（浏览器 fetch 会带 application/json）。 */
function isJsonContentType(req) {
  const type = String(req?.headers?.['content-type'] ?? '').toLowerCase();
  return type.includes('application/json');
}

/** 读请求体：优先 `req.body`（已解析），否则按流读；超限直接失败。 */
async function readBody(req, maxBytes) {
  if (req?.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;
  if (typeof req?.[Symbol.asyncIterator] !== 'function') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > maxBytes) return null;
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}



/**
 * @param {{writeSessionAt: (input:{sessionId:string, at:number}) => Promise<{ok:boolean, error?:string, detail?:string, text?:string}>,
 *   onError?: (error: unknown) => void, maxBytes?: number}} deps
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createSessionPolicyHandler({ writeSessionAt, resetSessionAt = null, onError = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return async (req, res) => {
    const send = (status, payload) => {
      try {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch {
        /* 连接已关：不影响其它请求 */
      }
    };
    if (req?.method !== 'POST') {
      try {
        res.writeHead(405, { allow: 'POST' });
        res.end();
      } catch { /* ignore */ }
      return;
    }
    // C31①：仅 loopback。
    if (isLoopbackRequest(req) !== true) {
      send(403, { ok: false, error: 'not-loopback' });
      return;
    }
    // C31③：同源必做（缺失即拒，不作为可选）。
    if (isSameOriginRequest(req) !== true) {
      send(403, { ok: false, error: sameOriginErrorCode(req) });
      return;
    }
    // C31②：只收 JSON。
    if (isJsonContentType(req) !== true) {
      send(415, { ok: false, error: 'json-required' });
      return;
    }
    if (typeof writeSessionAt !== 'function') {
      send(503, { ok: false, error: 'write-unavailable' });
      return;
    }
    const body = await readBody(req, maxBytes);
    if (body === null) {
      send(413, { ok: false, error: 'body-too-large' });
      return;
    }
    if (body === undefined) {
      send(400, { ok: false, error: 'invalid-json' });
      return;
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (SESSION_ID_PATTERN.test(sessionId) !== true) {
      send(400, { ok: false, error: 'invalid-session' });
      return;
    }
    // C29：`{ reset: true }` = 恢复全局设置（A1+A2 同清），走与 `/cg set reset` 同一条命令链。
    const wantsReset = body?.reset === true;
    const at = typeof body?.at === 'number' ? body.at : Number(body?.at);
    if (wantsReset !== true && (Number.isFinite(at) !== true || at < 0 || at > 1)) {
      send(400, { ok: false, error: 'invalid-at' });
      return;
    }
    try {
      const result = wantsReset === true
        ? (typeof resetSessionAt === 'function'
          ? await resetSessionAt({ sessionId })
          : { ok: false, error: 'reset-unavailable' })
        : await writeSessionAt({ sessionId, at });
      if (result?.ok !== true) {
        send(409, {
          ok: false,
          error: typeof result?.error === 'string' ? result.error : 'rejected',
          detail: typeof result?.detail === 'string' ? result.detail : null,
        });
        return;
      }
      send(200, wantsReset === true ? { ok: true, reset: true, source: 'plugin' } : { ok: true, at, source: 'session:A2' });
    } catch (error) {
      try { onError?.(error); } catch { /* logger 自身失败不得影响响应 */ }
      send(500, { ok: false, error: 'internal' });
    }
  };
}

/**
 * 注册写路由（与只读快照路由同写法：`ctx.inject(['webServer'], ...)`）。
 * @returns {boolean} 已挂载或已排队等待 webServer
 */
export function mountSessionPolicyRoute(ctx, { writeSessionAt, onError = null, path = SESSION_POLICY_PATH } = {}) {
  return mountWriteRoute(ctx, {
    path,
    handler: createSessionPolicyHandler({ writeSessionAt, onError }),
    label: 'context-governance: session-policy route',
  });
}

// ---- C11②：plugin 层（全局）写路由 --------------------------------------

export const PLUGIN_POLICY_PATH = '/context-governance/plugin-policy';

/**
 * 设置页保存 → 插件自持久化（`plugin-policy.json`）。
 * 与会话路由同源、同安全边界；区别是不需要 sessionId（全局层），响应 source='plugin'。
 * @param {{writePluginAt: (input:{at:number}) => {ok:boolean, error?:string, detail?:string},
 *   onError?: (error: unknown) => void, maxBytes?: number}} deps
 */
export function createPluginPolicyHandler({ writePluginAt, onError = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return async (req, res) => {
    const send = (status, payload) => {
      try {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch { /* 连接已关：不影响其它请求 */ }
    };
    if (req?.method !== 'POST') {
      try {
        res.writeHead(405, { allow: 'POST' });
        res.end();
      } catch { /* ignore */ }
      return;
    }
    // 与 A2 写路由同一安全边界（C31①③②）：仅 loopback、同源必做、只收 JSON。
    if (isLoopbackRequest(req) !== true) {
      send(403, { ok: false, error: 'not-loopback' });
      return;
    }
    if (isSameOriginRequest(req) !== true) {
      send(403, { ok: false, error: sameOriginErrorCode(req) });
      return;
    }
    if (isJsonContentType(req) !== true) {
      send(415, { ok: false, error: 'json-required' });
      return;
    }
    if (typeof writePluginAt !== 'function') {
      send(503, { ok: false, error: 'write-unavailable' });
      return;
    }
    const body = await readBody(req, maxBytes);
    if (body === null) {
      send(413, { ok: false, error: 'body-too-large' });
      return;
    }
    if (body === undefined) {
      send(400, { ok: false, error: 'invalid-json' });
      return;
    }
    const at = typeof body?.at === 'number' ? body.at : Number(body?.at);
    if (Number.isFinite(at) !== true || at < 0 || at > 1) {
      send(400, { ok: false, error: 'invalid-at' });
      return;
    }
    try {
      const result = await writePluginAt({ at });
      if (result?.ok !== true) {
        send(409, {
          ok: false,
          error: typeof result?.error === 'string' ? result.error : 'rejected',
          detail: typeof result?.detail === 'string' ? result.detail : null,
        });
        return;
      }
      send(200, { ok: true, at, source: 'plugin' });
    } catch (error) {
      try { onError?.(error); } catch { /* logger 自身失败不得影响响应 */ }
      send(500, { ok: false, error: 'internal' });
    }
  };
}

export function mountPluginPolicyRoute(ctx, { writePluginAt, onError = null, path = PLUGIN_POLICY_PATH } = {}) {
  return mountWriteRoute(ctx, {
    path,
    handler: createPluginPolicyHandler({ writePluginAt, onError }),
    label: 'context-governance: plugin-policy route',
  });
}

/** 两个写路由共用的挂载逻辑（webServer 后挂 → inject；dispose 随 effect 回收）。 */
function mountWriteRoute(ctx, { path, handler, label }) {
  const mount = (host) => {
    if (host === null || host === undefined || typeof host.webServer?.register !== 'function') return false;
    try {
      const dispose = host.webServer.register({ kind: 'exact', path, handler });
      if (typeof dispose === 'function' && typeof host.effect === 'function') {
        host.effect(() => () => { try { dispose(); } catch { /* ignore */ } }, label);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => { mount(scoped); });
    return true;
  }
  return mount(ctx);
}
