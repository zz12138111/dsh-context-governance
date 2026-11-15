/**
 * 开发自测 · P4-b（rc.12a）「dispose 写审计不得重建已删根目录」门。
 *
 * 真机证据（审核 2026-11-15）：`…\Temp\cg-cp5-…` 被删后于 `12:39:20.202` 重建，
 * 内容只有 `root-guard-disposed{rootId:d2bc70ad8f518f98,reason:'dispose'}`，
 * 目录创建时间 = 审计时间 +1ms —— dispose 分支走了会 `mkdir` 的 audit append。
 *
 * 判据：
 *   ① 删掉受治根目录 → 触发 guard dispose → 目录**仍不存在**（`fs.existsSync === false`）；
 *   ② 根审计（用户级 root-audit）有 `root-unresolved{reason:'root-gone'}`（不静默）；
 *   ③ 根目录健康时 dispose 仍写 `root-guard-disposed` 到该根审计（不误伤正常路径）。
 *
 * 用法：node tests\probe-c36-38\verify-p4b-dispose-no-rebuild.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../../packages/dsh-context-governance/src/index.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p4b-'));
const proj = path.join(base, 'proj');
const home = path.join(base, 'home');
const dir = path.join(base, 'dir');
const fakeProfile = path.join(base, 'fakehome');
for (const target of [proj, home, dir, fakeProfile]) fs.mkdirSync(target, { recursive: true });
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
  const captured = { tools: [], commands: [], handlers: [], disposers: [] };
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { name: 'p4b', dir, home };
      if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
      if (name === 'settings') return { subscribe: () => () => {} };
      return undefined;
    },
    tools: { register: (definition) => captured.tools.push(definition) },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    effect(factory) { captured.disposers.push(factory()); return () => {}; },
    inject(_services, fn) { try { fn({}); } catch { /* ignore */ } },
    logger: { info() {}, warn() {}, error() {} },
  };
  await apply(ctx, { projectRoot: proj, project: 'p4b' });

  const sid = 'session-p4b-1111-2222-3333-444455556666';
  const session = { id: sid, cwd: proj, header: { id: sid, cwd: proj } };
  const noop = async () => undefined;
  for (const entry of captured.handlers.filter((item) => item.event === 'session/event')) {
    try { await entry.handler(session, { type: 'turn/start', seq: 1, data: { turn: 1 } }, noop); } catch { /* ignore */ }
  }
  await sleep(80);
  const storeDir = path.join(proj, 'memory', 'governance');
  check('P4b-precondition-store-existed', fs.existsSync(storeDir) === true, `storeDir 存在=${fs.existsSync(storeDir)}`);

  // 删根 → 触发插件 dispose（guardPool.closeAll → 每个 guard dispose → 写 root-guard-disposed）
  fs.rmSync(proj, { recursive: true, force: true });
  for (const dispose of captured.disposers) {
    try { await dispose(); } catch { /* 插件 dispose 允许报错，但不得重建目录 */ }
  }
  await sleep(120);

  check('P4b-dispose-no-root-rebuild', fs.existsSync(storeDir) === false,
    `storeDir 重建=${fs.existsSync(storeDir)}（期望 false；真机曾 +1ms 重建）`);
  check('P4b-root-dir-gone', fs.existsSync(proj) === false, `proj 存在=${fs.existsSync(proj)}（期望 false）`);

  // 根审计（用户级）必须有 root-unresolved{reason:'root-gone'}
  const rootAuditDir = path.join(fakeProfile, '.dsh', 'context-governance');
  const candidates = [
    path.join(home, 'context-governance'),
    rootAuditDir,
  ];
  const rows = candidates.flatMap((target) => fs.existsSync(target)
    ? fs.readdirSync(target).filter((name) => name.endsWith('.jsonl')).flatMap((name) => readRows(path.join(target, name)))
    : []);
  const gone = rows.filter((row) => row.event === 'root-unresolved' && row.reason === 'root-gone');
  check('P4b-root-unresolved-root-gone', gone.length >= 1,
    `root-unresolved{root-gone}=${gone.length}（期望 ≥1；候选目录=${JSON.stringify(candidates.filter((item) => fs.existsSync(item)))}）`);
} finally {
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nP4-b dispose 不重建根 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
