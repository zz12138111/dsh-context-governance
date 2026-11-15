/**
 * 测试角色 · 在**指定 commit 的干净导出**上跑 C36/C37/C38 隔离探针（不装、不启用、不重启）。
 *
 * 为什么不用工作区：开发可能仍有未提交改动；验收数字必须锚 commit。
 * 做法：`git archive <ref>` 导出到临时目录 → 在导出目录跑探针 → 落盘结果 → 删除临时目录。
 * 注意：不建 git worktree、不碰 .git、不碰用户 profile 与会话。
 *
 * 用法：node tests\probe-c36-38\run-at-commit.mjs [ref]
 *       ref 缺省 = HEAD；输出落 tests\probe-c36-38\out-<short8>.txt
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const ref = process.argv[2] ?? 'HEAD';
const probeName = process.argv[3] ?? 'verify-c36-37-38.mjs';
const sha = execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim();
const short = sha.slice(0, 8);
const outDir = path.join(import.meta.dirname);
const outFile = path.join(outDir, `out-${short}-${probeName.replace(/\.mjs$/, '')}.txt`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-c36-38-'));
process.stdout.write(`ref=${ref} sha=${sha}\nexport=${work}\n`);

try {
  // git archive 导出指定 commit 的源码树（不含 .git/dist/node_modules）
  const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', sha], { maxBuffer: 256 * 1024 * 1024 });
  const tarFile = path.join(work, 'snapshot.tar');
  fs.writeFileSync(tarFile, tar);
  execFileSync('tar', ['-xf', tarFile, '-C', work], { stdio: 'inherit' });

  // 探针本身可能是未提交文件：从工作区拷进导出目录（探针代码与产物解耦；探针哈希一并记录）。
  const probeSrc = path.join(import.meta.dirname);
  const probeDst = path.join(work, 'tests', 'probe-c36-38');
  fs.mkdirSync(probeDst, { recursive: true });
  for (const name of fs.readdirSync(probeSrc)) {
    if (!name.endsWith('.mjs')) continue;
    fs.copyFileSync(path.join(probeSrc, name), path.join(probeDst, name));
  }

  let output = '';
  let code = 0;
  try {
    output = execFileSync(process.execPath, [path.join(work, 'tests', 'probe-c36-38', probeName)], {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    code = typeof error.status === 'number' ? error.status : 1;
  }
  fs.writeFileSync(outFile, `ref=${ref}\nsha=${sha}\n\n${output}`, 'utf8');
  const summary = output.split(/\r?\n/).filter((line) => /TOTAL|FAILED|WARN /.test(line)).join('\n');
  process.stdout.write(`${output}\n`);
  process.stdout.write(`\nwrote ${outFile}\nexit=${code}\n`);
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
