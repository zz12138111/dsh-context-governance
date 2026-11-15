/**
 * 测试角色 · C38 rc.10 两处缺口回归探针
 *  ① `/cg memory ...` 的 `root:` 必须是该会话已解析 rootId（旧实现读 policy.projectRoot 恒空）
 *  ② 同指针 miss 去重跨路径共享（`/cg memory show` ×2 只 1 行；mem_query 再读也不加行）
 *  ③ `shared` / `promote` / `import --from legacy` 在已解析 root 下不再 root-unresolved
 *
 * 隔离：临时 home + 临时项目 + 命令层真实 handler + 真实 session store；不装、不启用、不重启。
 * 用法：node tests\probe-c36-38\verify-c38-command-root-dedupe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPolicyState, resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { createStatusCommand } from '../../packages/dsh-context-governance/src/commands/cg-status.js';
import { createDedupedMemoryAudit } from '../../packages/dsh-context-governance/src/memory-audit.js';
import { openSessionMemory } from '../../packages/dsh-context-governance/src/memory/session-store.js';
import { createMemoryTools } from '../../packages/dsh-context-governance/src/tools/mem-tools.js';
import { rootIdOf } from '../../packages/dsh-context-governance/src/roots/identity.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-c38rc10-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const sid = 'session-rc10-1111-2222-3333-444455556666';
const expectedRootId = rootIdOf(proj);

const rows = [];
const dedupe = createDedupedMemoryAudit({ sink: (event, details) => rows.push({ event, details }) });
const audit = { append: (event, details) => rows.push({ event, details }), entries: () => rows, file: null };

// 指针 → 目标文件（随后删除以制造 miss）
const body = path.join(base, 'body.md');
fs.writeFileSync(body, 'LINE-ONE\nLINE-TWO\n', 'utf8');
const store = openSessionMemory({ home, sessionId: sid, audit: dedupe });
const pointerId = store.append({ type: 'fact', title: '[test] rc10 dedupe', target: `${body}:1` }).id;
fs.rmSync(body, { force: true });

const policy = buildPolicyState(resolveConfig({ projectRoot: proj }), {
  readFile: (f) => fs.readFileSync(f, 'utf8'), a2Store: null, onPolicyResolved: () => {},
});
const command = createStatusCommand({
  policy,
  audit,
  auditMemoryEvent: dedupe,
  resolveSessionRoot: () => ({ entry: { root: proj, rootId: expectedRootId } }),
  home,
  sessionIdOf: () => sid,
});
const run = async (rawInput) => String((await command.handler({ rawInput, agent: { session: { id: sid } } })).text ?? '');

// ① root 行 = 已解析 rootId；② 连跑两次 show，miss 只 1 行
const show1 = await run('memory show');
const show2 = await run('memory show');
const missRows = () => rows.filter((row) => row.event === 'memory-pointer-miss'
  && (row.details?.sessionId ?? row.sessionId) === sid && (row.details?.id ?? row.id) === pointerId);
check('C38-rc10-show-root-resolved', show1.includes(`root: ${expectedRootId}`),
  `rootLine=${JSON.stringify(show1.split('\n').find((line) => line.startsWith('root:')) ?? null)} expected=${expectedRootId}`);
check('C38-rc10-miss-marked-with-id', show1.includes(pointerId) && show1.includes('[miss]'),
  `show1Head=${JSON.stringify(show1.split('\n').slice(-2))}`);
check('C38-rc10-dedupe-across-two-shows', missRows().length === 1, `missRows=${missRows().length}（期望 1）`);

// ③ shared / promote / import legacy 不再 root-unresolved
const sharedText = await run('memory shared');
check('C38-rc10-shared-usable', !sharedText.includes('root-unresolved'), `text=${JSON.stringify(sharedText.split('\n').slice(-1))}`);
const promoteText = await run(`memory promote ${pointerId}`);
check('C38-rc10-promote-usable', !promoteText.includes('root-unresolved') && /promoted:\s*1/.test(promoteText),
  `text=${JSON.stringify(promoteText.split('\n'))}`);
const importText = await run('memory import --from legacy');
check('C38-rc10-import-legacy-usable', !importText.includes('root-unresolved'),
  `text=${JSON.stringify(importText.split('\n'))}`);

// ④ 跨路径：mem_query 再读同指针 → 去重器共享，仍 1 行
const tools = createMemoryTools(null, {
  audit,
  resolveSessionMemory: () => openSessionMemory({ home, sessionId: sid, audit: dedupe }),
});
await tools.mem_query.definition.execute({}, { agent: { session: { id: sid } } });
check('C38-rc10-dedupe-across-tool-path', missRows().length === 1, `missRows=${missRows().length}（期望 1，跨命令/工具路径共享）`);

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
const failed = results.filter((item) => !item.ok);
console.log(`\nC38 rc.10 缺口回归 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
