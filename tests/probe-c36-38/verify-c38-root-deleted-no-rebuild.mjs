/**
 * 测试角色 · C38 P4「根被删后不得重建根存 / 必须 root-unresolved」门（2026-11-15 需求 `beb918f` 第 29 条）。
 *
 * 缺陷（离线可复现）：apply 后的受治根目录被删掉，再触发记忆路径时：
 *   - legacy 记忆写（`DSH_CG_SESSION_MEMORY=0` 的 `mem_write`）→ 插件**静默重建 `<root>/memory/governance`**；
 *   - **两种模式都不写 `root-unresolved`** 审计 → 违反"不得伪造根 + 无根必须显式"。
 *
 * 判据（需求 `:454②`）：
 *   ① 删根后触发记忆命令，**不得**新建 `<root>/memory/governance` 目录（不得伪造根）——两种模式都验；
 *   ② 必须写 `root-unresolved{sessionId,cwd,reason}` 审计行（不静默）——两种模式都验。
 *   观测项（非门级）：`/cg memory show` 的 `root:` 行在根被删后是否仍显伪根。
 *
 * 手法：子进程跑两次（legacy / 默认指针两模式；`DSH_CG_SESSION_MEMORY` 在模块装载期读取），
 *   假 profileContext + 临时根；不装、不启用、不重启、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-c38-root-deleted-no-rebuild.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p4-'));
const child = path.join(base, 'p4-child.mjs');
const indexUrl = new URL('../../packages/dsh-context-governance/src/index.js', import.meta.url).href;

fs.writeFileSync(child, `
import fs from 'node:fs';
import path from 'node:path';
import { apply } from ${JSON.stringify(indexUrl)};

const base = ${JSON.stringify(base)};
const proj = path.join(base, 'proj');
const home = path.join(base, 'home');
const dir = path.join(base, 'dir');
for (const d of [proj, home, dir, path.join(proj, 'memory', 'topics')]) fs.mkdirSync(d, { recursive: true });
process.env.USERPROFILE = home;
const captured = { tools: [], commands: [], handlers: [] };
const ctx = {
  get(name) {
    if (name === 'profileContext') return { name: 'p4', dir, home };
    if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
    return undefined;
  },
  tools: { register: (definition) => captured.tools.push(definition) },
  on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};
await apply(ctx, { projectRoot: proj, project: 'p4' });
const sid = 'session-p4deleted-1111-2222-3333-444455556666';
const session = { id: sid, cwd: proj, header: { id: sid, cwd: proj } };
const fire = async () => {
  for (const entry of captured.handlers) if (entry.event === 'session/event') {
    try { await entry.handler(session, { type: 'turn/start', seq: 1, data: { turn: 1 } }, async () => undefined); } catch { /* ignore */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
};
const storeDir = path.join(proj, 'memory', 'governance');
await fire();
const existedBefore = fs.existsSync(storeDir);
fs.rmSync(proj, { recursive: true, force: true });
await fire();
const memWrite = captured.tools.find((tool) => tool.name === 'mem_write');
const memQuery = captured.tools.find((tool) => tool.name === 'mem_query');
const attempts = {};
for (const [name, tool, args] of [
  ['mem_write', memWrite, { op: 'create', type: 'fact', title: 'p4', detail: 'body', writer: 'user' }],
  ['mem_query', memQuery, {}],
]) {
  if (tool === undefined) { attempts[name] = { skipped: true }; continue; }
  try {
    const out = await tool.execute(args, { agent: { session: { id: sid } } });
    attempts[name] = out?.error ? { error: String(out.error).slice(0, 120) } : { ok: true, id: out?.id ?? null };
  } catch (error) {
    attempts[name] = { error: String(error?.message ?? error).slice(0, 120) };
  }
}
const cg = captured.commands.find((definition) => definition.name === 'cg');
let showText = '';
try { showText = String((await cg.handler({ rawInput: 'memory show', agent: { session: { id: sid, cwd: proj } } })).text ?? ''); } catch (error) { showText = 'throw:' + String(error?.message ?? error); }
const auditFile = path.join(home, 'context-governance', 'root-audit-p4.jsonl');
const rows = fs.existsSync(auditFile)
  ? fs.readFileSync(auditFile, 'utf8').split(/\\r?\\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : [];
const unresolved = rows.filter((row) => row.event === 'root-unresolved');
console.log('CHILD ' + JSON.stringify({
  mode: process.env.DSH_CG_SESSION_MEMORY === '0' ? 'legacy' : 'pointer',
  existedBefore,
  rebuilt: fs.existsSync(storeDir),
  attempts,
  unresolved: unresolved.map((row) => ({ sessionId: row.sessionId ?? null, cwd: row.cwd ?? null, reason: row.reason ?? null })),
  showRootLine: showText.split('\\n').find((line) => line.startsWith('root:')) ?? null,
}));
`, 'utf8');

function runChild(mode) {
  const env = { ...process.env, USERPROFILE: path.join(base, 'home') };
  if (mode === 'legacy') env.DSH_CG_SESSION_MEMORY = '0';
  else delete env.DSH_CG_SESSION_MEMORY;
  const out = execFileSync(process.execPath, [child], { env, encoding: 'utf8', cwd: base, maxBuffer: 8 * 1024 * 1024 });
  const line = out.split(/\r?\n/).find((item) => item.startsWith('CHILD ')) ?? '';
  return JSON.parse(line.slice('CHILD '.length) || '{}');
}

try {
  const legacy = runChild('legacy');
  check('C38-P4-precondition-store-existed', legacy.existedBefore === true, `storeExistedBefore=${legacy.existedBefore}`);
  check('C38-P4-legacy-no-root-rebuild', legacy.rebuilt !== true,
    `legacy: rebuilt=${legacy.rebuilt} attempts=${JSON.stringify(legacy.attempts)}（期望 false）`);
  check('C38-P4-legacy-root-unresolved-audited',
    Array.isArray(legacy.unresolved) && legacy.unresolved.length >= 1
      && legacy.unresolved.some((row) => typeof row.sessionId === 'string' && typeof row.cwd === 'string' && typeof row.reason === 'string'),
    `legacy: root-unresolved=${JSON.stringify(legacy.unresolved)}（期望 ≥1 行带 sessionId/cwd/reason）`);
  console.log(`INFO C38-P4-legacy-show-root-line :: ${JSON.stringify(legacy.showRootLine)}（非门级）`);

  const pointer = runChild('pointer');
  check('C38-P4-pointer-no-root-rebuild', pointer.rebuilt !== true,
    `pointer: rebuilt=${pointer.rebuilt} attempts=${JSON.stringify(pointer.attempts)}（期望 false）`);
  check('C38-P4-pointer-root-unresolved-audited',
    Array.isArray(pointer.unresolved) && pointer.unresolved.length >= 1
      && pointer.unresolved.some((row) => typeof row.sessionId === 'string' && typeof row.cwd === 'string' && typeof row.reason === 'string'),
    `pointer: root-unresolved=${JSON.stringify(pointer.unresolved)}（期望 ≥1 行；POINTER_ONLY 拒写也不得静默）`);
} catch (error) {
  check('C38-P4-window', false, `子进程失败：${String(error?.stdout ?? error?.message ?? error).slice(0, 400)}`);
} finally {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC38 P4 根删后不重建 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
