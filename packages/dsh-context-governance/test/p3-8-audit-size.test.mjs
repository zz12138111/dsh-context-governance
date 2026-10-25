/**
 * P3-8（0.2.0 复核）：audit `sizeBytes` 必须是真实文件大小，轮转按真实大小判断。
 * 场景来自审核真机实测：既有文件 42 行 / 14990 字节，构造后曾显示 1379（本进程写入量）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../src/audit.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import { tempDir } from './helpers.mjs';

const TS = '2026-10-25T00:00:00.000Z';
const TARGET_BYTES = 14990;
const LINES = 42;

/** 构造恰好 42 行、14990 字节的既有审计文件（历史进程留下的内容）。 */
function buildHistory() {
  const rows = [];
  let total = 0;
  for (let index = 0; index < LINES - 1; index += 1) {
    const line = `${JSON.stringify({
      ts: TS,
      event: index % 3 === 0 ? 'protection-write' : 'reinjection',
      compactionId: `cmp-${index}`,
      count: 1,
      durationMs: 2,
    })}\n`;
    rows.push(line);
    total += Buffer.byteLength(line, 'utf8');
  }
  // 最后一行用可解析的 JSON + 填充值凑到精确字节数（保证仍是合法 JSONL）。
  const head = JSON.stringify({ ts: TS, event: 'apply', status: 'applied', version: '' });
  const pad = TARGET_BYTES - total - Buffer.byteLength(head, 'utf8') - 1; // -1 = 行尾 \n
  assert.ok(pad > 0, 'history sizing math must leave room for the last line');
  rows.push(`${JSON.stringify({ ts: TS, event: 'apply', status: 'applied', version: 'p'.repeat(pad) })}\n`);
  return rows.join('');
}

test('P3-8 构造已有 42 行/14990 字节文件：sizeBytes 取真实大小，不按本进程写入量', async () => {
  const rootDir = await tempDir('cg-audit-size-');
  const file = path.join(rootDir, 'audit.jsonl');
  try {
    await fs.writeFile(file, buildHistory(), 'utf8');
    assert.equal((await fs.stat(file)).size, TARGET_BYTES);

    const audit = new AuditLog({ file, now: () => new Date(TS), maxBytes: 64 * 1024 });
    assert.equal(audit.sizeBytes, TARGET_BYTES, '构造后必须等于真实文件大小');
    assert.equal(audit.sizeBytes, (await fs.stat(file)).size);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('P3-8 追加一条后 sizeBytes 仍等于文件实际值；页面展示同一数值', async () => {
  const rootDir = await tempDir('cg-audit-size-');
  const file = path.join(rootDir, 'audit.jsonl');
  try {
    await fs.writeFile(file, buildHistory(), 'utf8');
    const audit = new AuditLog({ file, now: () => new Date(TS), maxBytes: 64 * 1024 });
    audit.append('apply', { status: 'applied', version: '0.2.0', mode: 'event-level' });

    const actual = (await fs.stat(file)).size;
    assert.ok(actual > TARGET_BYTES, 'append must grow the real file');
    assert.equal(audit.sizeBytes, actual, '追加后必须等于文件实际值');
    assert.equal(audit.rotations, 0);

    const command = createStatusCommand({ audit, now: () => new Date(TS) });
    const status = await command.handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(`audit: file=.* size=${actual} `));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('P3-8 历史字节计入轮转：真实大小跨 64KB 上限才轮转（不是从 0 起算）', async () => {
  const rootDir = await tempDir('cg-audit-size-');
  const file = path.join(rootDir, 'audit.jsonl');
  const MAX = 64 * 1024; // AuditLog 的 maxBytes 下限就是 64KB
  try {
    await fs.writeFile(file, buildHistory(), 'utf8');
    const audit = new AuditLog({ file, now: () => new Date(TS), maxBytes: MAX });
    assert.equal(audit.sizeBytes, TARGET_BYTES);

    let appended = 0;
    while (audit.rotations === 0 && appended < 2000) {
      audit.append('reinjection', { compactionId: `cmp-${appended}`, count: 1, seq: appended });
      appended += 1;
      if (audit.rotations === 0) assert.equal(audit.sizeBytes, (await fs.stat(file)).size);
    }
    assert.equal(audit.rotations, 1, '真实大小跨 64KB 必须轮转');

    const names = await fs.readdir(rootDir);
    const rotated = names.filter((name) => /^audit-\d{8}(-\d+)?\.jsonl$/.test(name));
    assert.equal(rotated.length, 1, `rotated files: ${names.join(',')}`);
    const rotatedSize = (await fs.stat(path.join(rootDir, rotated[0]))).size;
    // 若按“本进程写入量”计数，轮转文件会是 14990+65536≈80526；按真实大小则 ≤64KB。
    assert.ok(rotatedSize <= MAX, `rotated file must stay within maxBytes, got ${rotatedSize}`);
    assert.ok(rotatedSize > MAX - 500, `rotation must happen at the real limit, got ${rotatedSize}`);

    const rotatedText = await fs.readFile(path.join(rootDir, rotated[0]), 'utf8');
    assert.equal(rotatedText.trim().split('\n').length, (LINES - 1) + appended);
    const current = await fs.readFile(file, 'utf8');
    assert.equal(current.trim().split('\n').length, 1, '当前文件只保留轮转后的新记录');
    assert.equal(audit.sizeBytes, (await fs.stat(file)).size, '轮转后 sizeBytes 仍等于当前文件实际大小');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
