/**
 * 测试角色 · 1.1.0 D2 离线契约探针（C18 快照路由正确性）。
 * 判据：REQUIREMENTS.md:1151（2026-11-15 新增；真机 500 后补）。
 *
 * 背景：第 2 次预验 chip 已出现（C17 修复生效），但快照路由 500 → chip 只能显示 `压 —`。
 * C18 要求：①禁空 session；②会话感知（session 覆盖时 source=session）；③500 可诊断（onError+日志原文）；
 * ④用例（getPolicy 抛错 / onError 抛错 / 正常 200）；⑤真机 GET 200+JSON。
 *
 * 修复落地前预期为基线红。运行：node tests\probe-1.1.0\verify-c18.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}

const PKG = 'packages/dsh-context-governance';
const policyPath = path.join(process.cwd(), PKG, 'src/settings-policy.js');
const indexSource = await fs.readFile(path.join(PKG, 'src/index.js'), 'utf8');
const policySource = await fs.readFile(policyPath, 'utf8');

const { createSnapshotHandler } = await import(pathToFileURL(policyPath).href);

function makeRes() {
  const record = { status: 0, headers: null, body: '' };
  return {
    record,
    writeHead(code, headers) { record.status = code; record.headers = headers ?? null; },
    end(body) { record.body = body ?? ''; },
  };
}

// ── C18(a)：getPolicy 抛错 → onError 收到原 message + 500（禁止静默空 body） ──
{
  const captured = [];
  const handler = createSnapshotHandler({
    getPolicy: () => { throw new Error('boom-policy'); },
    getNative: () => 0.6785,
    onError: (error) => { captured.push(String(error?.message ?? error)); },
  });
  const res = makeRes();
  let threw = null;
  try { handler({ method: 'GET' }, res); } catch (error) { threw = String(error?.message ?? error); }
  check('C18-error-onError-and-500',
    threw === null && res.record.status === 500 && captured.length === 1 && /boom-policy/.test(captured[0]),
    `抛错=${threw} status=${res.record.status} onError=${JSON.stringify(captured)}`);
}

// ── C18(b)：onError 自身抛错 → 仍 500、不得把异常抛出 handler ──
{
  const handler = createSnapshotHandler({
    getPolicy: () => { throw new Error('boom-policy'); },
    getNative: () => null,
    onError: () => { throw new Error('boom-onError'); },
  });
  const res = makeRes();
  let threw = null;
  try { handler({ method: 'GET' }, res); } catch (error) { threw = String(error?.message ?? error); }
  check('C18-onError-throws-still-500', threw === null && res.record.status === 500,
    `抛错=${threw} status=${res.record.status}`);
}

// ── C18(c)：正常 → 200 + JSON（含 at/source/effectiveAt/native/sessionOverride） ──
{
  const handler = createSnapshotHandler({
    getPolicy: () => ({ values: { 'compact.at': 0.6 }, sources: { 'compact.at': 'plugin' } }),
    getNative: () => 0.6785,
    onError: () => {},
  });
  const res = makeRes();
  handler({ method: 'GET' }, res);
  let body = null;
  try { body = JSON.parse(res.record.body); } catch { body = null; }
  check('C18-normal-200-json',
    res.record.status === 200 && body !== null
    && body.at === 0.6 && body.source === 'plugin' && Number.isFinite(body.native) === true,
    `status=${res.record.status} body=${JSON.stringify(body)}`);

  // U6（40f9db1）：快照必须带 defaultAt（宿主 POLICY_DEFAULTS['compact.at']，默认 0.60）
  check('C18-defaultAt-field', body !== null && Number.isFinite(body.defaultAt) && body.defaultAt === 0.6,
    `body.defaultAt=${JSON.stringify(body?.defaultAt)}（期望 0.6）`);
}

// ── C18(d) 升为功能级（需求 8bec593）：必须有可注入接缝，注入"最近会话快照"→ session 视图；
//   无会话快照 → 全局视图。**只查静态痕迹不算过**（同 C17⑤ 口径）。
{
  const sessionPolicy = { values: { 'compact.at': 0.5 }, sources: { 'compact.at': 'session' } };
  const globalPolicy = { values: { 'compact.at': 0.6 }, sources: { 'compact.at': 'plugin' } };
  let factory = null;
  let factorySource = null;
  for (const candidate of ['src/settings-policy.js', 'src/index.js']) {
    try {
      const mod = await import(pathToFileURL(path.join(process.cwd(), PKG, candidate)).href);
      if (typeof mod.createSnapshotPolicyResolver === 'function') {
        factory = mod.createSnapshotPolicyResolver;
        factorySource = candidate;
        break;
      }
    } catch (error) {
      console.log(`INFO resolver 导入失败(${candidate})：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  check('C18-resolver-export', factory !== null,
    `可注入接缝 createSnapshotPolicyResolver：${factory === null ? '未找到（静态痕迹不算过）' : factorySource}`);

  if (factory !== null) {
    const policyState = { resolve: () => globalPolicy };
    const sessionVariants = [
      { resolvable: { resolve: () => sessionPolicy }, sessionId: 'session-test' },
      { policy: sessionPolicy },
      sessionPolicy,
    ];
    const toView = (result) => {
      if (result === null || result === undefined) return null;
      if (result.at !== undefined || result.source !== undefined) return result;
      if (result.values !== undefined) {
        const at = Number.isFinite(result.values['compact.at']) ? result.values['compact.at'] : null;
        const source = typeof result.sources?.['compact.at'] === 'string' ? result.sources['compact.at'] : 'builtin';
        return { at, source, sessionOverride: source === 'session' && at !== null ? at : null };
      }
      return null;
    };
    // 兼容等价接缝：值形式（latestSessionPolicy）与读函数形式（readLatestSessionPolicy）都注入。
    const callResolver = (latestSessionPolicy) => {
      const options = {
        policyState,
        latestSessionPolicy,
        readLatestSessionPolicy: () => latestSessionPolicy,
      };
      const built = factory(options);
      const value = typeof built === 'function' ? built() : built;
      return toView(value);
    };

    let sessionView = null;
    for (const variant of sessionVariants) {
      try {
        const view = callResolver(variant);
        if (view !== null && view.source === 'session') { sessionView = view; break; }
      } catch { /* 尝试下一种形状 */ }
    }
    check('C18-resolver-session', sessionView !== null && sessionView.at === 0.5 && sessionView.sessionOverride === 0.5,
      `注入会话快照 → ${JSON.stringify(sessionView)}`);

    const globalView = (() => {
      try { return callResolver(null); } catch (error) { return { error: String(error?.message ?? error) }; }
    })();
    check('C18-resolver-global', globalView !== null && globalView.at === 0.6 && globalView.source === 'plugin',
      `无会话快照 → 全局视图 ${JSON.stringify(globalView)}`);
  }
}

// ── C18(e)：日志原文契约 —— onError 接 ctx.logger.warn 时日志须含 `policy-snapshot failed: <message>` ──
{
  const logContract = /policy-snapshot failed/.test(indexSource) || /policy-snapshot failed/.test(policySource);
  check('C18-log-contract', logContract, `源码含 'policy-snapshot failed' 文案=${logContract}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC18 TOTAL ${results.length - failed.length}/${results.length} PASS（修复落地前预期为基线红）`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
