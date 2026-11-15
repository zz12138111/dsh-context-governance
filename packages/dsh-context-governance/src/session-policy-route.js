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
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

const DEFAULT_MAX_BYTES = 4096;

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

/** Origin 与 Host 不同源 → 拒绝（缺任一头按未提供处理，交给宿主自身同源策略）。 */
function crossOrigin(req) {
  const origin = req?.headers?.origin;
  const host = req?.headers?.host;
  if (typeof origin !== 'string' || origin === '' || typeof host !== 'string' || host === '') return false;
  try {
    const parsed = new URL(origin);
    return parsed.host !== host;
  } catch {
    return true;
  }
}

/**
 * @param {{writeSessionAt: (input:{sessionId:string, at:number}) => Promise<{ok:boolean, error?:string, detail?:string, text?:string}>,
 *   onError?: (error: unknown) => void, maxBytes?: number}} deps
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createSessionPolicyHandler({ writeSessionAt, onError = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
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
    if (crossOrigin(req) === true) {
      send(403, { ok: false, error: 'cross-origin' });
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
    const at = typeof body?.at === 'number' ? body.at : Number(body?.at);
    if (Number.isFinite(at) !== true || at < 0 || at > 1) {
      send(400, { ok: false, error: 'invalid-at' });
      return;
    }
    try {
      const result = await writeSessionAt({ sessionId, at });
      if (result?.ok !== true) {
        send(409, {
          ok: false,
          error: typeof result?.error === 'string' ? result.error : 'rejected',
          detail: typeof result?.detail === 'string' ? result.detail : null,
        });
        return;
      }
      send(200, { ok: true, at, source: 'session:A2' });
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
  const handler = createSessionPolicyHandler({ writeSessionAt, onError });
  const mount = (host) => {
    if (host === null || host === undefined || typeof host.webServer?.register !== 'function') return false;
    try {
      const dispose = host.webServer.register({ kind: 'exact', path, handler });
      if (typeof dispose === 'function' && typeof host.effect === 'function') {
        host.effect(() => () => { try { dispose(); } catch { /* ignore */ } }, 'context-governance: session-policy route');
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
