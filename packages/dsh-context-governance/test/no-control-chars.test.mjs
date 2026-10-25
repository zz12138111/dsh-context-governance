/**
 * 0.1.16 P3-1 / 0.1.17 / 0.1.18：控制字符闸（防复发）。
 *
 * 背景：README 曾被写入 0x08/0x07（某写入路径把 `\b`/`\a` 当转义），
 * 渲染成 `ackendInferred`/`uditVersion`；AGENTS.md 也被 0x0C 吃掉过字母。
 * 0.1.17 起扫描范围扩到仓库根；0.1.18 起改用 `git ls-files`，只扫 tracked 文件
 * （不再把本机未跟踪/忽略文件算进来），允许 `\n\t\r`，命中列 文件+偏移。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt']);

function isForbidden(byte) {
  if (byte <= 0x08) return true;
  if (byte === 0x0b || byte === 0x0c) return true;
  if (byte >= 0x0e && byte <= 0x1f) return true;
  if (byte === 0x7f) return true;
  return false;
}

function trackedTextFiles() {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return listed
    .split('\0')
    .filter((rel) => rel !== '')
    .filter((rel) => TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase()))
    .map((rel) => path.join(REPO_ROOT, rel));
}

test('0.1.18：仓库 tracked 文本文件不得含 C0 控制字符/DEL（git ls-files）', () => {
  const files = trackedTextFiles();
  const violations = [];
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    for (let offset = 0; offset < buffer.length; offset += 1) {
      if (isForbidden(buffer[offset])) {
        violations.push(`${path.relative(REPO_ROOT, file)} @${offset} byte=0x${buffer[offset].toString(16).padStart(2, '0')}`);
      }
    }
  }
  console.log(`scanned tracked files=${files.length} violations=${violations.length}`);
  assert.deepEqual(violations, [], `控制字符命中（文件 @偏移）：\n${violations.join('\n')}`);
});
