#!/usr/bin/env node
/**
 * 干净包导出 + 合规扫描（T4 发布就绪）。
 *
 * 用法：
 *   node scripts/export-package.mjs [--rev <ref>] [--out <dir>] [--keep]
 *
 * 做什么：
 *   1) git archive <rev> → .tmp/release-<stamp>.zip（只含 tracked 内容）
 *   2) 解压到 .tmp/release-<stamp>/（干净目录，无 .git/未跟踪文件）
 *   3) 在该目录 git init + add -A，让 compliance-scan 的 ls-files/remote 检查可用
 *   4) 跑 scripts/compliance-scan.mjs --root <dir> --strict（仅 blocker 使退出码非 0）
 *   5) 报告写到 logs/compliance-scan-<stamp>.md；默认清理解压目录（--keep 保留）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const rev = opt('--rev', 'HEAD');
const keep = args.includes('--keep');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = process.cwd();
const outDir = path.resolve(opt('--out', path.join('.tmp', `release-${stamp}`)));
const zip = path.join('.tmp', `release-${stamp}.zip`);
const report = path.join('logs', `compliance-scan-${stamp}.md`);

fs.mkdirSync(path.dirname(zip), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
execFileSync('git', ['archive', '--format=zip', `--output=${zip}`, rev], { cwd: root, stdio: 'inherit' });
execFileSync('tar', ['-xf', path.resolve(root, zip), '-C', outDir], { cwd: root, stdio: 'inherit' });

// 让扫描脚本的 git 检查可用（干净导出目录本身不是 git 仓库）
execFileSync('git', ['init', '-q'], { cwd: outDir, stdio: 'inherit' });
execFileSync('git', ['add', '-A'], { cwd: outDir, stdio: 'inherit' });

let failed = false;
try {
  execFileSync(process.execPath, [path.resolve(root, 'scripts', 'compliance-scan.mjs'), '--root', outDir, '--out', path.resolve(root, report), '--strict'], { cwd: root, stdio: 'inherit' });
} catch (error) {
  failed = true;
}

const text = fs.existsSync(path.join(root, report)) ? fs.readFileSync(path.join(root, report), 'utf8') : '';
const summary = text.split('\n').filter((line) => /blocker|review|info|合计|总计/i.test(line)).slice(0, 12).join('\n');
console.log(`\n[export-package] rev=${rev} files=${execFileSync('git', ['-C', outDir, 'ls-files'], { encoding: 'utf8' }).trim().split('\n').length} report=${report} strictFailed=${failed}`);
console.log(summary || '(报告为空)');
if (!keep) fs.rmSync(outDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
