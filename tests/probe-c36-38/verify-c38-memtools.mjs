/**
 * 测试角色 · C38 ⑮⑯⑰⑱ 独立隔离探针（mem_* 默认会话模式 / 模式审计 / legacy 检测 / 回退）。
 *
 * 手法：用**临时 profileContext（home/dir 都在临时目录）**装载插件 apply()，把 USERPROFILE 指向
 *       临时 home（插件按 USERPROFILE 取会话库根），再用注册到的 mem_* 工具 + /cg 命令驱动；
 *       legacy 回退用**子进程**跑（DSH_CG_SESSION_MEMORY 在模块装载期读取）。
 * 不装、不启用、不重启、不碰用户 profile/会话。
 *
 * 用法：node tests\probe-c36-38\verify-c38-memtools.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../../packages/dsh-context-governance/src/index.js';
import { openSessionMemory } from '../../packages/dsh-context-governance/src/memory/session-store.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-memtools-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(proj, '.dsh', 'memory', 'topics'), { recursive: true });

function makeCtx(profileContext, captured) {
  return {
    get(name) {
      if (name === 'profileContext') return profileContext;
      if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
      return undefined;
    },
    tools: { register: (definition) => captured.tools.push(definition) },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
}
function walkAudit(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkAudit(full, out);
    else if (entry.name.endsWith('.audit') || entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
function readRows(files) {
  const rows = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return rows;
}

const previousUserProfile = process.env.USERPROFILE;
process.env.USERPROFILE = home; // 插件按 USERPROFILE 取会话库根：显式指向临时 home（不碰真实用户目录）
try {
  const captured = { tools: [], commands: [], handlers: [] };
  const profileContext = { name: 'iso-probe', dir: path.join(base, 'profile'), home: path.join(base, 'dshhome') };
  fs.mkdirSync(profileContext.dir, { recursive: true });
  fs.mkdirSync(profileContext.home, { recursive: true });
  // 预置 legacy 内容：应触发 memory-legacy-detected（不自动迁移）
  fs.writeFileSync(path.join(proj, '.dsh', 'memory', 'MEMORY.md'), '- legacy entry\n', 'utf8');

  const ctx = makeCtx(profileContext, captured);
  await apply(ctx, { projectRoot: proj, project: 'iso-probe' });
  // 真机会话首个事件（建立 root pin / guard）；status 即时性需该 pin 才代表真机
  const earlySession = { id: 'session-isomem-1111-2222-3333-444455556666', cwd: proj, header: { id: 'session-isomem-1111-2222-3333-444455556666', cwd: proj } };
  const noopNext = async () => undefined;
  for (const entry of captured.handlers) {
    if (entry.event !== 'session/event') continue;
    try { await entry.handler(earlySession, { type: 'turn/start', seq: 1, data: { turn: 1 } }, noopNext); } catch { /* 中间件签名差异：忽略 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  const memWrite = captured.tools.find((tool) => tool.name === 'mem_write');
  const memQuery = captured.tools.find((tool) => tool.name === 'mem_query');
  const cg = captured.commands.find((definition) => definition.name === 'cg');
  check('C38-15-mem-tools-registered', memWrite !== undefined && memQuery !== undefined,
    `tools=${JSON.stringify(captured.tools.map((tool) => tool.name))}`);

  const sessionId = 'session-isomem-1111-2222-3333-444455556666';
  const sessionExec = { agent: { session: { id: sessionId } } };
  const noSessionExec = { agent: {} };

  // ⑯ 首次带 session 调用 → memory-mode{mode:session}（同会话去重）
  const query1 = await memQuery.execute({}, sessionExec);
  await memQuery.execute({}, sessionExec);
  const auditFiles = walkAudit(base);
  const rows = readRows(auditFiles);
  const modeRows = rows.filter((row) => row.event === 'memory-mode');
  check('C38-16-memory-mode-session-audited', modeRows.length === 1 && modeRows[0]?.mode === 'session'
    && modeRows[0]?.sessionId === sessionId,
    `rows=${JSON.stringify(modeRows)} auditFiles=${auditFiles.length}`);
  check('C38-17-legacy-detected-audited', rows.some((row) => row.event === 'memory-legacy-detected'),
    `legacy-detected=${rows.filter((row) => row.event === 'memory-legacy-detected').length}`);
  // legacy 只读：默认模式下无 session 写入被拒
  let legacyWriteCode = null;
  try { await memWrite.execute({ op: 'create', type: 'fact', title: 'x', detail: 'y' }, noSessionExec); } catch (error) { legacyWriteCode = String(error?.message ?? error); }
  check('C38-15-no-session-write-legacy-readonly', String(legacyWriteCode).includes('LEGACY_READ_ONLY'), `error=${legacyWriteCode}`);

  // ⑮ 默认会话模式：带 session 写被拒 POINTER_ONLY；query 读会话指针库
  let pointerWriteCode = null;
  try { await memWrite.execute({ op: 'create', type: 'fact', title: 'x', detail: 'y' }, sessionExec); } catch (error) { pointerWriteCode = String(error?.message ?? error); }
  check('C38-15-session-write-pointer-only', String(pointerWriteCode).includes('POINTER_ONLY'), `error=${pointerWriteCode}`);

  const body = path.join(base, 'body.md');
  fs.writeFileSync(body, 'BODY-LINE-1\nBODY-LINE-2\n', 'utf8');
  const store = openSessionMemory({ home, sessionId });
  const pointerId = store.append({ type: 'fact', title: '会话指针', target: `${body}:2`, summary: '第二行' }).id;
  const query2 = await memQuery.execute({}, sessionExec);
  check('C38-15-mem-query-reads-session-pointers', query2.count === 1 && query2.entries[0].id === pointerId,
    `count=${query2.count} ids=${JSON.stringify(query2.entries.map((entry) => entry.id))}`);
  // 删正文 → mem_query 标 miss；C38③ 要求同时审计（生产路径是否带 audit 是判据）
  fs.rmSync(body, { force: true });
  const query3 = await memQuery.execute({}, sessionExec);
  const rows2 = readRows(walkAudit(base));
  check('C38-5-miss-marked-through-tool', query3.entries[0]?.status === 'miss', `status=${query3.entries[0]?.status}`);
  await memQuery.execute({}, sessionExec);
  const missRowsAll = readRows(walkAudit(base)).filter((row) => row.event === 'memory-pointer-miss');
  const missRows = missRowsAll.filter((row) => row.target === `${body}:2` && row.reason === 'body-missing');
  check('C38-3-miss-audited-through-tool', missRows.length >= 1,
    `memory-pointer-miss=${missRowsAll.length} rows=${JSON.stringify(missRowsAll.slice(0, 2))}`);
  check('C38-3-miss-audit-deduped', missRows.length === 1, `sameTargetReasonRows=${missRows.length}（去重后应=1）`);
  check('C38-3-miss-audit-has-pointer-id', missRowsAll.some((row) => typeof row.id === 'string' || typeof row.entryId === 'string' || typeof row.pointerId === 'string'),
    `fields=${JSON.stringify(Object.keys(missRowsAll[0] ?? {}))}（需求要求 {sessionId,id,target,reason}）`);

  // ⑯ /cg status 显示模式
  const statusText = String((await cg.handler({ rawInput: 'status' })).text ?? '');
  check('C38-16-status-shows-mode', /memory-mode:\s*session/.test(statusText),
    `line=${JSON.stringify(statusText.split('\n').find((line) => line.includes('memory-mode')) ?? null)}`);

  // C37 即时生效（493d077）：改/删 .cg-policy.json，下一次 /cg status 立即按 project / 回落（不重启）
  const tplFile = path.join(proj, '.cg-policy.json');
  const inv = { rawInput: 'status', agent: { session: { id: sessionId, cwd: proj } } };
  const status0 = String((await cg.handler(inv)).text ?? '');
  fs.writeFileSync(tplFile, JSON.stringify({ version: 1, values: { 'compact.at': 0.5 } }), 'utf8');
  const status1 = String((await cg.handler(inv)).text ?? '');
  fs.rmSync(tplFile, { force: true });
  const status2 = String((await cg.handler(inv)).text ?? '');
  check('C37-status-immediacy-after-template-change', !status0.includes('source=project')
    && /compact\.at=0\.50 \(source=project\)/.test(status1) && !status2.includes('source=project'),
    `before=${(status0.split('\n').find((line) => line.startsWith('policy:')) ?? '').slice(0, 80)} | write=${(status1.split('\n').find((line) => line.startsWith('policy:')) ?? '').slice(0, 80)} | delete=${(status2.split('\n').find((line) => line.startsWith('policy:')) ?? '').slice(0, 80)}`);
  // 拒绝审计
  check('C38-15-reject-audited', readRows(walkAudit(base)).some((row) => row.event === 'memory-tool-rejected'
    && (row.code === 'POINTER_ONLY' || row.details?.code === 'POINTER_ONLY')),
    `rejected=${readRows(walkAudit(base)).filter((row) => row.event === 'memory-tool-rejected').length}`);

  // ⑱ legacy 回退（=0）：子进程（模块装载期读 env）
  const childScript = path.join(base, 'legacy-child.mjs');
  const indexUrl = new URL('../../packages/dsh-context-governance/src/index.js', import.meta.url).href;
  fs.writeFileSync(childScript, `
import fs from 'node:fs';
import path from 'node:path';
import { apply } from ${JSON.stringify(indexUrl)};
const base = ${JSON.stringify(base)};
const home = path.join(base, 'legacy-home');
const proj = path.join(base, 'legacy-proj');
fs.mkdirSync(path.join(proj, '.dsh', 'memory'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
process.env.USERPROFILE = home;
const captured = { tools: [], commands: [] };
const profileContext = { name: 'iso-legacy', dir: path.join(base, 'legacy-profile'), home: path.join(base, 'legacy-dshhome') };
fs.mkdirSync(profileContext.dir, { recursive: true });
fs.mkdirSync(profileContext.home, { recursive: true });
const ctx = {
  get(name) {
    if (name === 'profileContext') return profileContext;
    if (name === 'commands') return { register: (d) => captured.commands.push(d) };
    return undefined;
  },
  tools: { register: (d) => captured.tools.push(d) },
  on() { return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};
await apply(ctx, { projectRoot: proj, project: 'iso-legacy' });
const memWrite = captured.tools.find((tool) => tool.name === 'mem_write');
const cg = captured.commands.find((d) => d.name === 'cg');
let writeError = null;
try { await memWrite.execute({ op: 'create', type: 'fact', title: 'legacy-write', detail: 'body' }, { agent: { session: { id: 'session-isolegacy-root' } } }); } catch (error) { writeError = String(error?.message ?? error); }
const statusText = String((await cg.handler({ rawInput: 'status' })).text ?? '');
const out = { writeError, statusLine: statusText.split('\\n').find((line) => line.includes('memory-mode')) ?? null };
// 收审计
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.audit')) files.push(full);
  }
})(base);
out.events = [];
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\\r?\\n/)) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row.event === 'memory-mode') out.events.push(row); } catch { /* skip */ }
  }
}
console.log('CHILD ' + JSON.stringify(out));
`, 'utf8');
  const childOut = execFileSync(process.execPath, [childScript], {
    env: { ...process.env, DSH_CG_SESSION_MEMORY: '0', USERPROFILE: home },
    encoding: 'utf8',
    cwd: base,
    maxBuffer: 8 * 1024 * 1024,
  });
  const childLine = childOut.split(/\r?\n/).find((line) => line.startsWith('CHILD ')) ?? '';
  const child = JSON.parse(childLine.slice('CHILD '.length) || '{}');
  check('C38-15-optout-mode-audited', (child.events ?? []).some((row) => row.mode === 'legacy'),
    `events=${JSON.stringify(child.events)} reason=${(child.events ?? [])[0]?.reason ?? null}`);
  check('C38-15-optout-write-not-pointer-only', !String(child.writeError).includes('POINTER_ONLY'),
    `writeError=${child.writeError}`);
  check('C38-16-optout-status-line', String(child.statusLine).includes('legacy'), `statusLine=${child.statusLine}`);
} finally {
  process.env.USERPROFILE = previousUserProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC38 ⑮⑯⑰⑱ TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
