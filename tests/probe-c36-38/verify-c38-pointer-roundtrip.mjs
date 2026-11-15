/**
 * 测试角色 · C38 指针层「type/status 持久化」回归门（P2 缺口，2026-11-15 审核 `52630bc` 判实现缺口）。
 *
 * ⚠️ 已知缺陷门（审核 `9d1f...` 口径）：
 *   修前 **1/3 红是预期**（重开后 type/status 丢）；修好后必须 **3/3**；
 *   在此之前**不进放行绿灯集**——它留缺陷基线，不冒充绿门。
 *
 * 缺陷：`serializePointers` 只写 target/line-text/summary/title，`parsePointerBlock` 也只回这五个字段，
 *   重开（新进程/新 open）后条目 type/status 丢失 → `/cg memory show` 索引行显示 `undefined · undefined`。
 * 判据：①同一次 open 内追加 → 索引显示 `status · type`；②重开后 `query()` 的 type/status 保持；
 *   ③重开后再追加一条 → 旧条目的 type/status 仍保持。
 *
 * 隔离：临时 home；不装、不启用、不重启。
 * 用法：node tests\probe-c36-38\verify-c38-pointer-roundtrip.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openSessionMemory } from '../../packages/dsh-context-governance/src/memory/session-store.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ptr-rt-'));
const sessionId = 'session-roundtrip-1111-2222-3333-444455556666';
const body = path.join(base, 'body.md');
fs.writeFileSync(body, 'LINE-ONE\nLINE-TWO\n', 'utf8');
const indexFile = path.join(base, 'context-governance', 'sessions', sessionId, 'MEMORY.md');
const readIndex = () => (fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '');

try {
  // ① 同一次 open：索引显示 status · type
  const first = openSessionMemory({ home: base, sessionId });
  first.append({ type: 'fact', title: 'A', target: `${body}:1` });
  first.append({ type: 'criterion', title: 'B', target: `${body}:2` });
  const sameOpen = readIndex();
  check('C38-P2-same-open-index-has-type-status',
    /proposed · fact · A/.test(sameOpen) && /proposed · criterion · B/.test(sameOpen),
    `indexLines=${JSON.stringify(sameOpen.split('\n').filter((line) => line.startsWith('- ')))}`);

  // ② 重开（新实例）：type/status 必须保持
  const reopened = openSessionMemory({ home: base, sessionId });
  const entries = reopened.query();
  const byTitle = Object.fromEntries(entries.map((entry) => [entry.title, entry]));
  check('C38-P2-reopen-keeps-type-status',
    byTitle.A?.type === 'fact' && byTitle.A?.status === 'proposed'
      && byTitle.B?.type === 'criterion' && byTitle.B?.status === 'proposed',
    `A=${JSON.stringify({ type: byTitle.A?.type, status: byTitle.A?.status })} B=${JSON.stringify({ type: byTitle.B?.type, status: byTitle.B?.status })}`);

  // ③ 重开后再追加：旧条目仍保持（不被索引重写冲掉）
  reopened.append({ type: 'anchor', title: 'C', target: `${body}:1` });
  const afterAppend = readIndex();
  const oldLines = afterAppend.split('\n').filter((line) => line.includes('· A ·') || line.includes('· B ·'));
  check('C38-P2-old-entries-keep-type-status-after-append',
    oldLines.every((line) => !line.includes('undefined')),
    `oldLines=${JSON.stringify(oldLines)}`);
} catch (error) {
  check('C38-P2-window', false, `抛错：${String(error?.stack ?? error).slice(0, 400)}`);
} finally {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC38 P2 指针 type/status 持久 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
