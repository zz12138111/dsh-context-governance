/**
 * 测试角色 · C38 P3「记忆/header 审计按会话根路由」门（2026-11-15 审核 `52630bc` 判 P3 实现缺口）。
 *
 * 缺陷（rc.10 真机）：G 根会话的 `memory-pointer-miss` / `header-injected` / `header-truncated`
 *   全落主根（D）审计，会话根（G）0 行 → 窗口汇总漏读；且 `header-injected.lines` 记的是指针条数。
 *
 * 判据（apply 级，两根本地模拟：rootA=主根、rootB=会话根）：
 *   ① 会话 B 的 `memory-pointer-miss` 落 **rootB** 的 `audit.jsonl`，rootA 0 行；
 *   ② `header-injected` 落 **rootB**；③ `header-truncated` 落 **rootB 且与 injected 同 sessionId**；
 *   ④ `lines` = 实际注入行数（≤ maxLines）、`pointers` = 指针总数，两者分开且 lines≠pointers；
 *   ⑤（INFO）不带 sessionId 的事件仍落用户级主审计（开发声明"有意为之"，仅记录）。
 *
 * 隔离：临时双根 + 假 profileContext；不装、不启用、不重启、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-p3-audit-root.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../../packages/dsh-context-governance/src/index.js';
import { HEADER_DEFAULTS } from '../../packages/dsh-context-governance/src/memory/header.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p3-'));
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

try {
  const captured = { tools: [], commands: [], handlers: [] };
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { name: 'p3', dir, home };
      if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
      if (name === 'settings') return { subscribe: () => () => {} };
      return undefined;
    },
    tools: { register: (definition) => captured.tools.push(definition) },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  await apply(ctx, { projectRoot: rootA, project: 'p3' });

  const sidB = 'session-p3b-1111-2222-3333-444455556666';
  const sessionB = { id: sidB, cwd: rootB, header: { id: sidB, cwd: rootB } };
  const noop = async () => undefined;
  // 用 rootB 内的会话把它纳管成第二个根
  for (const entry of captured.handlers.filter((item) => item.event === 'session/event')) {
    try { await entry.handler(sessionB, { type: 'turn/start', seq: 1, data: { turn: 1 } }, noop); } catch { /* ignore */ }
  }
  await sleep(80);

  const cg = captured.commands.find((definition) => definition.name === 'cg');
  const execB = { agent: { session: { id: sidB, cwd: rootB } } };
  const missingBody = path.join(base, 'p3-missing-body.md');
  // 注册 12 条指向不存在正文的指针：既产生 miss，又足以触发 header 截断
  for (let index = 1; index <= 12; index += 1) {
    try { await cg.handler({ rawInput: `memory register fact ${missingBody}:1 p3 pointer ${index}`, agent: execB.agent }); } catch { /* ignore */ }
  }
  // 再读一次，确保 miss 行落盘
  try { await cg.handler({ rawInput: 'memory show', agent: execB.agent }); } catch { /* ignore */ }
  await sleep(60);

  const rowsA = readRows(auditFile(rootA));
  const rowsB = readRows(auditFile(rootB));
  const missB = rowsB.filter((row) => row.event === 'memory-pointer-miss' && row.sessionId === sidB);
  const missA = rowsA.filter((row) => row.event === 'memory-pointer-miss');
  check('C38-P3-miss-in-session-root', missB.length >= 1, `rootB miss=${missB.length} ids=${JSON.stringify(missB.slice(0, 3).map((row) => row.id))}`);
  check('C38-P3-miss-not-in-primary-root', missA.length === 0, `rootA miss=${missA.length}（期望 0）`);

  // header 注入：agent/pre-step + step:1
  const payload = { agent: { session: { id: sidB, cwd: rootB } }, step: 1, messages: [] };
  const nextDecision = async () => ({ kind: 'messages', messages: [] });
  for (const entry of captured.handlers.filter((item) => item.event === 'agent/pre-step')) {
    try { await entry.handler(payload, nextDecision); } catch { /* ignore */ }
  }
  await sleep(120);
  const rowsB2 = readRows(auditFile(rootB));
  const rowsA2 = readRows(auditFile(rootA));
  const injectedB = rowsB2.filter((row) => row.event === 'header-injected');
  const truncatedB = rowsB2.filter((row) => row.event === 'header-truncated');
  const injectedA = rowsA2.filter((row) => row.event === 'header-injected');
  const truncatedA = rowsA2.filter((row) => row.event === 'header-truncated');
  check('C38-P3-header-injected-in-session-root', injectedB.length === 1 && injectedB[0].sessionId === sidB,
    `rootB injected=${injectedB.length} sessionId=${injectedB[0]?.sessionId ?? null}`);
  check('C38-P3-header-not-in-primary-root', injectedA.length === 0 && truncatedA.length === 0,
    `rootA injected=${injectedA.length} truncated=${truncatedA.length}（期望 0/0）`);
  check('C38-P3-header-truncated-same-root-and-session',
    truncatedB.length === 1 && truncatedB[0].sessionId === sidB && injectedB.length === 1 && injectedB[0].sessionId === sidB,
    `rootB truncated=${truncatedB.length} sid=${truncatedB[0]?.sessionId ?? null} injectedSid=${injectedB[0]?.sessionId ?? null}`);
  const injectedRow = injectedB[0] ?? {};
  check('C38-P3-lines-vs-pointers-separate',
    Number.isFinite(injectedRow.lines) && Number.isFinite(injectedRow.pointers)
      && injectedRow.pointers === injectedRow.count && injectedRow.lines !== injectedRow.pointers,
    `lines=${injectedRow.lines} pointers=${injectedRow.pointers} count=${injectedRow.count}（期望 lines=实际文本行、pointers=条数且两者分开）`);

  const rootAudit = path.join(home, 'context-governance', 'root-audit-p3.jsonl');
  const userRows = readRows(rootAudit);
  console.log(`INFO C38-P3-non-session-events-in-primary :: userLevel=${JSON.stringify([...new Set(userRows.map((row) => row.event))])}（不带 sessionId 的事件仍在用户级主审计，开发声明有意为之）`);
} catch (error) {
  check('C38-P3-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
} finally {
  process.env.USERPROFILE = previousProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC38 P3 审计按会话根路由 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
