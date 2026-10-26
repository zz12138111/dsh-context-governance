/**
 * S1.3：迟到回填审计落盘（需求 2026-10-27 一致性审 A-2）。
 * 用**真 AuditLog**（走白名单 + sanitize），堵 `makeAudit()` 裸 mock 的盲区：
 * 之前 `compactionShortId` / `reconcileDelayMs` 不在白名单，会被静默丢弃。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AUDIT_EVENTS, AuditLog } from '../src/audit.js';

test('S1.3 落盘：early-forced-reconciled 的 reconcileDelayMs/compactionShortId 不被丢弃', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-s13-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const audit = new AuditLog({ file, allowedBase: dir });
  const ok = audit.append('early-forced-reconciled', {
    sessionId: 'session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6',
    cycle: 'early-bc196744-d505-46eb-96cf-be073c3b3ebe',
    compactionId: 'ccd8bdcd-9f66-42a1-8e19-147b529792f9',
    compactionShortId: 'ccd8bdcd',
    compaction: 'committed',
    protection: 'failed',
    failures: ['rollback-point'],
    reinjected: true,
    reconcileDelayMs: 87573,
    source: 'late-report',
    // 白名单外键必须仍被丢弃（不能因为新增两条就把 sanitize 放开）。
    notInWhitelist: 'should-be-dropped',
  });
  assert.equal(ok, true);
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const row = rows.at(-1);
  assert.equal(row.event, 'early-forced-reconciled');
  assert.equal(row.compactionId, 'ccd8bdcd-9f66-42a1-8e19-147b529792f9');
  assert.equal(row.compactionShortId, 'ccd8bdcd');
  assert.equal(row.reconcileDelayMs, 87573);
  assert.equal(row.compaction, 'committed');
  assert.equal(row.protection, 'failed');
  assert.deepEqual(row.failures, ['rollback-point']);
  assert.equal(row.reinjected, true);
  assert.equal(row.source, 'late-report');
  assert.equal(row.notInWhitelist, undefined, '白名单外字段仍要丢弃');
  await fs.rm(dir, { recursive: true, force: true });
});

test('S1.3 契约：early-forced-reconciled 已在 AUDIT_EVENTS 正式清单里', () => {
  assert.ok(AUDIT_EVENTS.includes('early-forced-reconciled'));
});
