/**
 * 测试角色 · `policy-set` 审计归因探针（会话级写入必须带 sessionId）。
 *
 * 背景：审核/测试发现 5 处 `policy-set` emit 均不带 sessionId（`cg-status.js:617/748/792/807/836`），
 *       真机无法把"某处写了 A2"归因到具体会话。开发在 handler 入口统一注入 `sessionIdOf(exec)` 后，
 *       本探针应全绿；装机真机仍需验 `policy-set` 行是否带 sessionId（同一判据）。
 *
 * 用法：node tests\probe-c36-38\verify-policy-set-audit.mjs
 * 说明：不装、不启用、不重启；用 createStatusCommand 的真实 handler + 临时项目目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPolicyState, resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { createStatusCommand } from '../../packages/dsh-context-governance/src/commands/cg-status.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-policy-set-'));
const project = path.join(base, 'proj');
fs.mkdirSync(project, { recursive: true });
const audit = { rows: [], append(event, details) { this.rows.push({ event, details }); return true; }, entries() { return this.rows; }, file: null };
const state = buildPolicyState(resolveConfig({ projectRoot: project }), {
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  a2Store: null,
  onPolicyResolved: () => {},
});
const sessionId = 'session-pset-1111-2222-3333-444455556666';
const command = createStatusCommand({ policy: state, audit, sessionIdOf: () => sessionId });
const exec = { agent: { session: { id: sessionId, cwd: project } } };

const cases = [
  ['set-compact-at', 'set compact.at=0.55', 'compact.at'],
  ['set-reset', 'set reset', '*'],
  ['profile-set', 'profile coding', 'profile'],
  ['profile-reset', 'profile reset', 'profile'],
  ['header-off', 'header off', 'header.enabled'],
];
for (const [id, rawInput] of cases) {
  const before = audit.rows.length;
  let text = '';
  try { text = String((await command.handler({ rawInput, ...exec })).text ?? ''); } catch (error) { text = String(error?.message ?? error); }
  const rows = audit.rows.slice(before).filter((row) => row.event === 'policy-set');
  const withSession = rows.filter((row) => row.sessionId === sessionId || row.details?.sessionId === sessionId);
  check(`policy-set-${id}-has-sessionId`, rows.length >= 1 && withSession.length === rows.length,
    `rows=${JSON.stringify(rows.map((row) => ({ event: row.event, sessionId: row.sessionId ?? row.details?.sessionId ?? null, key: row.key ?? row.details?.key })))} text=${JSON.stringify(text.split('\n')[0])}`);
}

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
const failed = results.filter((item) => !item.ok);
console.log(`\npolicy-set 归因 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
