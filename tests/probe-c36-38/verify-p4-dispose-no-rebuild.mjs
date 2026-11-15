/**
 * 测试角色 · P4-a「guard dispose 不得重建已删根」门（2026-11-15 审核归口，rc.12a P4-b 修复的验收门）。
 *
 * 真机证据（00/审核）：删除 `%TEMP%\cg-cp5-20261115-121331` 后，该目录于 `12:39:20.202` 被重建，
 *   内容仅 `root-guard-disposed{rootId:d2bc70ad8f518f98,reason:'dispose'}`，
 *   **目录创建时间 = 审计时间 +1ms** → dispose 写审计时 `AuditLog.append` 的 `mkdir` 复活了已删根。
 *   既有 `verify-c38-root-deleted-no-rebuild` 5/5 绿，是因为它只测"删根后触发记忆命令"，**没覆盖 dispose 路径**。
 *
 * 判据：
 *   ① dispose 后**根目录仍不存在**（不得重建 `<root>/memory/governance`）；
 *   ② 写不进根审计时必须**显式留痕**：根审计出现 `root-unresolved{reason:'root-gone'}`（不静默）；
 *   ③ dispose 正常返回 true（不是异常吞掉）。
 *
 * 手法：真 `RootGuardPool` + 真 `AuditLog`（指向临时根内 audit）+ 假 registry/storePool/createGuard；
 *   先建 guard（根存在）→ 删根 → `dispose(rootId,'dispose')`。
 *   不装、不启用、不重启、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-p4-dispose-no-rebuild.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog } from '../../packages/dsh-context-governance/src/audit.js';
import { RootGuardPool } from '../../packages/dsh-context-governance/src/compress/root-guards.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p4d-'));
const root = path.join(base, 'proj');
const storeDir = path.join(root, 'memory', 'governance');
fs.mkdirSync(storeDir, { recursive: true });

const rootAuditRows = [];
const rootAudit = {
  append(event, details = {}) { rootAuditRows.push({ event, details }); return true; },
};
const audit = new AuditLog({ file: path.join(storeDir, 'audit.jsonl'), maxBytes: 4 * 1024 * 1024, allowedBase: root });
const entry = { root, rootId: 'p4d-root-1', state: 'active', project: 'p4d', managed: true };
const session = { id: 'session-p4dispose-1111-2222-3333-444455556666', cwd: root, header: { id: 'session-p4dispose-1111-2222-3333-444455556666', cwd: root } };
let pool = null;

try {
  check('P4d-audit-seeded', audit.append('seed', {}) === true, `seedAppend=${fs.existsSync(path.join(storeDir, 'audit.jsonl'))}`);

  pool = new RootGuardPool({
    registry: { resolveSessionRoot: () => ({ status: 'managed', entry, isSubagent: false, cwd: root }) },
    storePool: { pin: async () => ({ store: null, audit, release: async () => {} }) },
    createGuard: () => ({ guard: { stop() {} }, policy: null, early: null, dispose: async () => {} }),
    rootAudit,
  });
  const record = await pool.ensureForSession(session);
  check('P4d-guard-opened', record !== null && pool.size === 1, `size=${pool.size}`);

  // 真机形态：根目录被删（含 memory/governance）
  fs.rmSync(root, { recursive: true, force: true });
  check('P4d-root-deleted-precondition', fs.existsSync(root) === false, `rootExists=${fs.existsSync(root)}`);

  const disposed = await pool.dispose(entry.rootId, 'dispose');
  const rebuilt = fs.existsSync(root);
  check('P4d-dispose-returns-true', disposed === true, `disposed=${disposed}`);
  check('P4d-dispose-does-not-rebuild-root', rebuilt !== true,
    `rebuilt=${rebuilt}（期望 false；真机复现：删后 12:39:20.202 重建、仅含 root-guard-disposed）`);

  const audited = rootAuditRows.some((row) => row.event === 'root-unresolved' && row.details?.reason === 'root-gone');
  check('P4d-dispose-falls-back-to-root-audit', audited,
    `rootAuditRows=${JSON.stringify(rootAuditRows.map((row) => row.event))}（期望含 root-unresolved{reason:'root-gone'}）`);
} catch (error) {
  check('P4d-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
} finally {
  try { await pool?.closeAll?.('test'); } catch { /* ignore */ }
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nP4 dispose 不重建已删根 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
