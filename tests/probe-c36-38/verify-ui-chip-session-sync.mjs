/**
 * 测试角色 · C11③「UI 跟随会话」探针：chip/气泡显示值必须 == 当前会话 `/cg status` 的 `policy:` 值
 *
 * 缺陷背景（2026-11-15，00 真机）：chip 显示「压 60%」，而 00 会话实际 0.45、全局 plugin 0.58
 * （60% = builtin 默认 0.6）→ UI 未跟随会话。
 *
 * 判据（门级）：
 *  1. 快照解析器必须能按「请求会话」解析：`resolver({sessionId})` 返回该会话生效值（A2 0.45），
 *     不能只返回全局/默认；
 *  2. client 取快照时必须带会话上下文（query/header 任一），否则服务端无从跟随；
 *  3. chip 与气泡同源（同一 snapshot 数据源），不得各算一套；
 *  4. 静态兜底：client 不得把 60/builtin 默认硬编码为显示值。
 *
 * 用法：node tests\probe-c36-38\verify-ui-chip-session-sync.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPolicyState, resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { createA2Store } from '../../packages/dsh-context-governance/src/a2-store.js';
import { createSnapshotPolicyResolver } from '../../packages/dsh-context-governance/src/settings-policy.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const client = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-chip-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const sid = 'session-chip-1111-2222-3333-444455556666';
const a2File = path.join(home, '.dsh', 'context-governance', 'session-policy.json');
const a2 = createA2Store({ file: a2File });
a2.write(sid, 0.45); // 会话真实生效值

const config = resolveConfig({ projectRoot: proj, policy: { values: { 'compact.at': 0.58 } } });
const state = buildPolicyState(config, {
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  a2Store: createA2Store({ file: a2File }),
  onPolicyResolved: () => {},
});
const sessionPolicy = state.resolve(sid);
check('C11-5-precondition-session-value', sessionPolicy.values['compact.at'] === 0.45
  && String(sessionPolicy.sources['compact.at']).startsWith('session'),
  `sessionAt=${sessionPolicy.values['compact.at']} source=${sessionPolicy.sources['compact.at']}`);

// 1) 解析器必须按"请求会话"给值（当前实现忽略入参 → 返回全局/最近会话）
const resolver = createSnapshotPolicyResolver({ policyState: state, readLatestSessionPolicy: null });
const bySession = resolver({ sessionId: sid });
check('C11-5-resolver-honours-session', bySession?.values?.['compact.at'] === 0.45,
  `resolver({sessionId})→at=${bySession?.values?.['compact.at']} source=${bySession?.sources?.['compact.at']}（期望 0.45/session）`);

// 1b) 切换会话：解析器必须随请求会话变化（不能用"最近一次/latest"或全局）
const sid2 = 'session-chip-bbbb-1111-2222-3333-444455556666';
a2.write(sid2, 0.62);
const state2 = buildPolicyState(config, {
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  a2Store: createA2Store({ file: a2File }),
  onPolicyResolved: () => {},
});
const resolver2 = createSnapshotPolicyResolver({ policyState: state2, readLatestSessionPolicy: null });
const bySession2 = resolver2({ sessionId: sid2 });
check('C11-5-resolver-switch-sessions', bySession2?.values?.['compact.at'] === 0.62,
  `resolver({sessionId:sid2})→at=${bySession2?.values?.['compact.at']} source=${bySession2?.sources?.['compact.at']}（期望 0.62/session）`);

const fetchHasSession = /SESSION_POLICY_PATH|sessionId|X-Session|session=/.test(
  (client.match(/const fetchSnapshotWithRetry = \([\s\S]*?\n    \};/) ?? [])[0] ?? '',
);
const snapshotUrl = /policy-snapshot[^'`]*session/.test(client);
check('C11-5-client-sends-session-context', fetchHasSession || snapshotUrl,
  `fetch 带会话上下文=${fetchHasSession} 快照 URL 带 session=${snapshotUrl}`);

// 3) chip 与气泡同源
const chipBody = (client.match(/const createChip = \([\s\S]*?\n    \};/) ?? [])[0] ?? '';
const bubbleBody = (client.match(/const createBubble = \([\s\S]*?\n    \};/) ?? [])[0] ?? '';
check('C11-5-chip-bubble-same-source', /fetchSnapshot|store\.set\(\{ snapshot/.test(chipBody)
  && /fetchSnapshot|store\.set\(\{ snapshot/.test(bubbleBody),
  `chip 用 snapshot=${/fetchSnapshot/.test(chipBody)} bubble 用 snapshot=${/fetchSnapshot/.test(bubbleBody)}`);

// 4) 不得把 60 / builtin 硬编码成显示值（静态兜底）
const hardcoded60 = /chip[^\n]*60%/.test(client) || /'压 60%'/.test(client);
check('C11-5-no-hardcoded-60', hardcoded60 === false, `client 硬编码 60%=${hardcoded60}`);

// 5) apply 级：设置页保存（写 plugin-policy 0.58 + config-reload 重建）后，快照端点必须跟着变
{
  const { apply } = await import('../../packages/dsh-context-governance/src/index.js');
  const handlers = [];
  const commands = [];
  let snapshotHandler = null;
  const webServer = { register: ({ path: p, handler }) => { if (String(p).includes('policy-snapshot')) snapshotHandler = handler; return () => {}; } };
  const ctx = {
    webServer,
    commands,
    tools: { register() {} },
    get(name) {
      if (name === 'profileContext') return { name: 'iso-chip', dir: path.join(base, 'profile'), home: path.join(base, 'dshhome') };
      if (name === 'commands') return { register: (d) => commands.push(d) };
      if (name === 'settings') return { subscribe: () => () => {} };
      if (name === 'webServer') return { register: ({ path: p, handler }) => { if (p.includes('policy-snapshot')) snapshotHandler = handler; return () => {}; } };
      return undefined;
    },
    inject(services, fn) { try { fn(this); } catch { /* ignore */ } },
    effect() { return () => {}; },
    on(event, handler) { handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  const proj2 = path.join(base, 'proj2');
  fs.mkdirSync(proj2, { recursive: true });
  const home2 = path.join(base, 'dshhome');
  fs.mkdirSync(home2, { recursive: true });
  const prev = process.env.USERPROFILE;
  process.env.USERPROFILE = home2;
  try {
    await apply(ctx, { projectRoot: proj2, project: 'iso-chip' });
    const readSnapshot = async () => {
      if (snapshotHandler === null) return null;
      let body = '';
      const res = { writeHead() {}, end: (chunk) => { body += chunk ?? ''; } };
      await snapshotHandler({ method: 'GET' }, res);
      try { return JSON.parse(body); } catch { return null; }
    };
    const before = await readSnapshot();
    const pluginFile = path.join(home2, '.dsh', 'context-governance', 'plugin-policy.json');
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, JSON.stringify({ version: 1, at: 0.58, source: 'plugin', updatedAt: new Date().toISOString() }), 'utf8');
    for (const entry of handlers.filter((item) => item.event === 'app-boot/config-reload')) {
      try { await entry.handler({}); } catch { /* ignore */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = await readSnapshot();
    check('C11-5-snapshot-refreshes-after-rebuild', after?.at === 0.58,
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}（期望 after.at=0.58）`);
  } finally {
    process.env.USERPROFILE = prev;
  }
}

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
const failed = results.filter((item) => !item.ok);
console.log(`\nC11③ UI 跟随会话 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
