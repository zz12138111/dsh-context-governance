/**
 * 测试角色 · P3-c / B2 门（2026-11-15 审核真机发现，rc.12 待修）。
 *
 * P3-c：UI 保存 / 恢复全局 的 `policy-set` 行必须落**会话根**审计；主根 0 行。
 *   （真机：G 根会话 UI 保存两行落 D 根 `04:39:36/04:39:42`，reset 行落 G 根 `04:41:21`）
 *   `plugin-policy-persisted` 无会话根可落 → 落主根（断言落主根、会话根 0 行；已知口径）。
 * B2：reset 成功后展示必须回落 —— 快照（`/context-governance/policy-snapshot?session=`）
 *   的 `source` 要离开 `session:A2`、`at` 回 plugin 值；保存后快照应回 `session:A2`/新值。
 *
 * 手法：apply + 假 webServer 抓 mount 的写/快照 handler，两根本地模拟（rootA 主根 / rootB 会话根）；
 *   不装、不启用、不重启、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-p3c-b2-ui-write.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../../packages/dsh-context-governance/src/index.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p3c-'));
const rootA = path.join(base, 'rootA');
const rootB = path.join(base, 'rootB');
const home = path.join(base, 'home');
const dir = path.join(base, 'dir');
const fakeProfile = path.join(base, 'fakehome');
for (const target of [rootA, rootB, home, dir, fakeProfile, path.join(rootA, 'memory', 'topics'), path.join(rootB, 'memory', 'topics')]) {
  fs.mkdirSync(target, { recursive: true });
}
const previousProfile = process.env.USERPROFILE;
process.env.USERPROFILE = fakeProfile;

const auditFile = (root) => path.join(root, 'memory', 'governance', 'audit.jsonl');
function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bodyOf(req) {
  return JSON.stringify(req.__body ?? {});
}
function fakeReq(method, url, body, { origin = 'http://127.0.0.1:4167', host = '127.0.0.1:4167' } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    url,
    __body: body,
    headers: { host, 'content-type': 'application/json', ...(method === 'GET' ? {} : { origin }) },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* iterate() { if (payload !== '') yield Buffer.from(payload); },
  };
}
async function call(handler, req) {
  let status = 0;
  let text = '';
  const res = { writeHead(code) { status = code; }, end(chunk) { text += chunk ?? ''; } };
  await handler(req, res);
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status, body, text };
}

try {
  const routes = new Map();
  const captured = { tools: [], commands: [], handlers: [] };
  const ctx = {
    webServer: { register({ path: p, handler }) { routes.set(String(p), handler); return () => {}; } },
    effect(fn) { try { fn(); } catch { /* ignore */ } return () => {}; },
    inject(services, fn) { fn({ webServer: this.webServer, effect: this.effect }); },
    get(name) {
      if (name === 'profileContext') return { name: 'p3c', dir, home };
      if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
      if (name === 'settings') return { subscribe: () => () => {} };
      return undefined;
    },
    tools: { register: (definition) => captured.tools.push(definition) },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  await apply(ctx, { projectRoot: rootA, project: 'p3c', policy: { values: { 'compact.at': 0.58 } } });

  const sidB = 'session-p3c-1111-2222-3333-444455556666';
  const sessionB = { id: sidB, cwd: rootB, header: { id: sidB, cwd: rootB } };
  for (const entry of captured.handlers.filter((item) => item.event === 'session/event')) {
    try { await entry.handler(sessionB, { type: 'turn/start', seq: 1, data: { turn: 1 } }, async () => undefined); } catch { /* ignore */ }
  }
  await sleep(80);

  const writeSession = routes.get('/context-governance/session-policy');
  const snapshot = routes.get('/context-governance/policy-snapshot');
  const writePlugin = routes.get('/context-governance/plugin-policy');
  check('P3c-B2-routes-mounted', typeof writeSession === 'function' && typeof snapshot === 'function' && typeof writePlugin === 'function',
    `sessionRoute=${typeof writeSession} snapshot=${typeof snapshot} pluginRoute=${typeof writePlugin}`);

  // 真机形态：rootB 已登记，但该会话的 guard 还没建（用户先点 UI 保存）
  // → `auditForSessionId` 为 null，必须按 registry 解析会话根落审计，不得回落主根（P3-c）。
  const sidC = 'session-p3c-uuuu-1111-2222-333344445555';
  const save = await call(writeSession, fakeReq('POST', '/context-governance/session-policy', { sessionId: sidC, at: 0.45 }));
  await sleep(60);
  const saveRowsB = readRows(auditFile(rootB)).filter((row) => row.event === 'policy-set' && (row.sessionId ?? row.details?.sessionId) === sidC);
  const saveRowsA = readRows(auditFile(rootA)).filter((row) => row.event === 'policy-set' && (row.sessionId ?? row.details?.sessionId) === sidC);
  check('P3c-ui-save-policy-set-in-session-root', save.status === 200 && saveRowsB.length >= 1,
    `saveStatus=${save.status} rootB policy-set=${saveRowsB.length} keys=${JSON.stringify(saveRowsB.map((row) => row.key ?? row.details?.key))}`);
  check('P3c-ui-save-policy-set-not-in-primary-root', saveRowsA.length === 0,
    `rootA policy-set=${saveRowsA.length}（期望 0；真机曾落 D 根）`);

  // 保存后快照：at=0.45 且来源是会话层（A1/A2 均可，A1 优先属正确层序）
  const snapAfterSave = await call(snapshot, fakeReq('GET', `/context-governance/policy-snapshot?session=${sidC}`));
  check('B2-snapshot-after-save-is-session-layer',
    snapAfterSave.body?.at === 0.45 && /^session:/.test(String(snapAfterSave.body?.source ?? '')),
    `body=${JSON.stringify(snapAfterSave.body)}（期望 at=0.45 且 source=session:*）`);

  // 恢复全局（同一无 guard 会话）
  const reset = await call(writeSession, fakeReq('POST', '/context-governance/session-policy', { sessionId: sidC, reset: true }));
  await sleep(60);
  const resetRowsB = readRows(auditFile(rootB)).filter((row) => row.event === 'policy-set' && (row.key ?? row.details?.key) === '*' && (row.value ?? row.details?.value) === 'reset');
  const resetRowsA = readRows(auditFile(rootA)).filter((row) => row.event === 'policy-set' && (row.key ?? row.details?.key) === '*' && (row.value ?? row.details?.value) === 'reset');
  check('P3c-ui-reset-policy-set-in-session-root', reset.status === 200 && resetRowsB.length >= 1,
    `resetStatus=${reset.status} rootB reset policy-set=${resetRowsB.length}（期望 ≥1）`);
  check('P3c-ui-reset-policy-set-not-in-primary-root', resetRowsA.length === 0,
    `rootA reset policy-set=${resetRowsA.length}（期望 0；真机曾落 D 根）`);

  // B2：reset 后快照必须回落 plugin
  const snapAfterReset = await call(snapshot, fakeReq('GET', `/context-governance/policy-snapshot?session=${sidC}`));
  check('B2-snapshot-after-reset-falls-back-plugin',
    snapAfterReset.body?.source === 'plugin' && snapAfterReset.body?.at === 0.58,
    `body=${JSON.stringify(snapAfterReset.body)}（期望 {at:0.58, source:'plugin'}，不得仍 session:A2）`);

  // B2 前端：reset 成功后必须"立刻可读"——重取快照并写回 store（否则 chip/气泡/输入框会留旧值）
  const clientSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance', 'lib', 'client.js'), 'utf8');
  const resetRefetch = /resetSessionAt\([\s\S]{0,400}?fetchSnapshot\([\s\S]{0,600}?store\.set\(/.test(clientSource);
  check('B2-reset-refetches-snapshot-and-updates-store', resetRefetch,
    `resetToGlobal 重取+写回=${resetRefetch}（否则 reset 后 UI 留旧 A2/45）`);
  // plugin 层保存：plugin-policy-persisted 无会话根 → 落主根（已知口径）
  const pluginSave = await call(writePlugin, fakeReq('POST', '/context-governance/plugin-policy', { at: 0.6 }));
  await sleep(60);
  const rowsA3 = readRows(auditFile(rootA));
  const rowsB3 = readRows(auditFile(rootB));
  const persistedA = rowsA3.filter((row) => row.event === 'plugin-policy-persisted');
  const persistedB = rowsB3.filter((row) => row.event === 'plugin-policy-persisted');
  check('P3c-plugin-persisted-goes-primary-root',
    pluginSave.status === 200 && persistedA.length === 1 && persistedB.length === 0,
    `status=${pluginSave.status} rootA=${persistedA.length} rootB=${persistedB.length}（无会话根 → 落主根，口径已知）`);
} catch (error) {
  check('P3c-B2-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
} finally {
  process.env.USERPROFILE = previousProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nP3-c/B2 UI 写落根与回落 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
