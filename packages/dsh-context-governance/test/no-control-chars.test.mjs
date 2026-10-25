/**
 * 0.1.16 P3-1：控制字符闸（防复发）。
 *
 * 背景：README 曾被写入 0x08/0x07（某写入路径把 `\b`/`\a` 当转义），
 * 渲染成 `ackendInferred`/`uditVersion`。此测试扫包里所有文本文件，
 * 命中 C0 控制字符（除 \t \n \r）或 DEL 即失败，并打印文件+偏移。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

function isForbidden(byte) {
  if (byte <= 0x08) return true;
  if (byte === 0x0b || byte === 0x0c) return true;
  if (byte >= 0x0e && byte <= 0x1f) return true;
  if (byte === 0x7f) return true;
  return false;
}

function collectTextFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectTextFiles(full));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

test('0.1.16 P3-1：包内所有文本文件不得含 C0 控制字符/DEL', () => {
  const files = collectTextFiles(PACKAGE_ROOT);
  const violations = [];
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    for (let offset = 0; offset < buffer.length; offset += 1) {
      if (isForbidden(buffer[offset])) {
        violations.push(`${path.relative(PACKAGE_ROOT, file)} @${offset} byte=0x${buffer[offset].toString(16).padStart(2, '0')}`);
      }
    }
  }
  console.log(`scanned files=${files.length} violations=${violations.length}`);
  assert.deepEqual(violations, [], `控制字符命中（文件 @偏移）：\n${violations.join('\n')}`);
});
