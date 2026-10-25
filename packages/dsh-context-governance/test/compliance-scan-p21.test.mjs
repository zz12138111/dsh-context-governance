/**
 * compliance-scan 的 P2-1 回归：白名单按**匹配串**判定，不能把同行真 key 一起降级。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SCAN = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'compliance-scan.mjs');
const REAL_TOKEN = `ghp_${'A'.repeat(26)}`;

function scanWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const out = path.join(dir, 'report.md');
  let failed = false;
  try {
    execFileSync(process.execPath, [SCAN, '--root', dir, '--out', out, '--no-untracked'], { encoding: 'utf8' });
  } catch {
    failed = true;
  }
  const report = fs.readFileSync(out, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { report, failed };
}

test('scan P2-1：示例行后贴真 token → 仍 blocker（按匹配串，不按整行）', () => {
  const { report } = scanWith({
    'docs/review-x.md': `raw 凭据形态（ghp_/sk-/Bearer/PRIVATE KEY/password=/api_key=） | 0 | 0\n格式示例 ghp_/sk-，实际 token ${REAL_TOKEN}\n`,
  });
  assert.match(report, /blocker \| [1-9]/, '真 token 必须仍计入 blocker');
  assert.match(report, /github-token/);
});

test('scan P2-1：纯样例行 → info（白名单只降命中的那段）', () => {
  const { report } = scanWith({
    'docs/review-x.md': 'raw 凭据形态（ghp_/sk-/Bearer/PRIVATE KEY/password=/api_key=） | 0 | 0\n',
  });
  assert.match(report, /blocker \| 0/);
  assert.doesNotMatch(report, /github-token/);
});
