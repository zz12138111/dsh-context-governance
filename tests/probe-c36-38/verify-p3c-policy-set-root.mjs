/**
 * 开发自测 · rc.12「P3-c 命令面写审计按会话根路由」门（审核 `P3-c` / 需求 `:462`）。
 *
 * 缺陷（rc.11 真机）：同一 G 根会话的 UI 保存 `policy-set` 两行落 **D 主根**审计
 *   （`04:39:36/04:39:42`），而 reset 行落 G 根（`04:41:21`）——同一动作两处落点。
 *   根因：`getAuditForSession` 只在根 guard 已打开时拿到该根审计，否则回落 primaryAudit。
 *
 * 判据（apply 级，两根本地模拟：rootA=主根、rootB=会话根）：
 *   ① 会话 B 保存（`/cg set compact.at=`，与 UI 写入口同一命令链）→ `policy-set` 落 **rootB**，rootA 0 行；
 *   ② 会话 B reset → `policy-set{key:'*'?}` 同样落 **rootB**，rootA 0 行；
 *   ③ （INFO）`plugin-policy-persisted` 无会话根 → 落主根/用户级（文档已注明，非缺口）。
 *
 * 隔离：临时双根 + 假 profileContext；不装、不启用、不重启。
 * 用法：node tests\probe-c36-38\verify-p3c-policy-set-root.mjs
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
for (const target of [rootA, rootB, home, dir, fakeProfile]) fs.mkdirSync(target, { recursive: true });
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
      if (name === 'profileContext') return { name: 'p3c', dir, home };
      if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
      if (name === 'settings') return { subscribe: () => () => {} };
      return undefined;
    },
    tools: { register: (definition) => captured.tools.push(definition) },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  await apply(ctx, { projectRoot: rootA, project: 'p3c' });

  const sidB = 'session-p3c-1111-2222-3333-444455556666';
  const sessionB = { id: sidB, cwd: rootB, header: { id: sidB, cwd: rootB } };
  const noop = async () => undefined;
  for (const entry of captured.handlers.filter((item) => item.event === 'session/event')) {
    try { await entry.handler(sessionB, { type: 'turn/start', seq: 1, data: { turn: 1 } }, noop); } catch { /* ignore */ }
  }
  await sleep(80);

  const cg = captured.commands.find((definition) => definition.name === 'cg');
  const execB = { agent: { session: { id: sidB, cwd: rootB } } };
  // ① 保存：与 UI `saveSessionAt` 同一条命令链（`set compact.at=`）。
  const saveResult = await cg.handler({ rawInput: 'set compact.at=0.45', agent: execB.agent, via: 'token' });
  await sleep(60);
  let rowsA = readRows(auditFile(rootA));
  let rowsB = readRows(auditFile(rootB));
  const saveB = rowsB.filter((row) => row.event === 'policy-set' && row.sessionId === sidB
    && String(row.key ?? '') === 'compact.at');
  const saveA = rowsA.filter((row) => row.event === 'policy-set');
  check('P3c-save-in-session-root', saveB.length >= 1,
    `rootB save rows=${saveB.length} ${JSON.stringify(saveB.slice(0, 1))}`);
  check('P3c-save-not-in-primary-root', saveA.length === 0, `rootA policy-set=${saveA.length}（期望 0）`);
  check('P3c-save-keeps-via', saveB.every((row) => row.via === 'token'),
    `via=${JSON.stringify(saveB.map((row) => row.via))}（UI 路径必须带 via）`);

  // ② reset：与 UI `resetSessionAt` 同链（`set reset`）。
  const resetResult = await cg.handler({ rawInput: 'set reset', agent: execB.agent, via: 'token' });
  check('P3c-reset-command-succeeded', /cleared:/.test(String(resetResult?.text ?? '')),
    `resetText=${JSON.stringify(String(resetResult?.text ?? '').slice(0, 80))}`);  await sleep(60);
  rowsA = readRows(auditFile(rootA));
  rowsB = readRows(auditFile(rootB));
  const resetB = rowsB.filter((row) => row.event === 'policy-set' && row.sessionId === sidB
    && String(row.value ?? '') === 'reset');
  const resetA = rowsA.filter((row) => row.event === 'policy-set');
  check('P3c-reset-in-session-root', resetB.length >= 1,
    `rootB reset rows=${resetB.length} ${JSON.stringify(resetB.slice(-1))}`);
  check('P3c-reset-not-in-primary-root', resetA.length === 0, `rootA policy-set=${resetA.length}（期望 0）`);
  check('P3c-save-and-reset-same-root',
    saveB.length >= 1 && resetB.length >= 1 && saveA.length === 0 && resetA.length === 0,
    `save@rootB=${saveB.length} reset@rootB=${resetB.length} save@rootA=${saveA.length} reset@rootA=${resetA.length}`);
} finally {
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nP3-c 命令面写审计落会话根 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
