/**
 * 审核 · 包内逐文件对照 commit 树（发布前最后一道）。
 *
 * 做什么：
 *   1. 解开 zip → 列全部条目（文件）；
 *   2. 每条目取 `git show <ref>:<pkgSubdir>/<rel>` 的内容，**CRLF→LF 归一后**逐字节比对；
 *   3. 反向核对：commit 树里应进包的文件（= `files` 白名单展开后的文件集）是否都在包里；
 *   4. 报告 zip 大小与 SHA256。
 *
 * 为什么：zip 是用户实际拿到的东西，`npm pack` 的清单/CRLF 转换都可能与树不一致；
 *   只报"打包成功"不算证据。归一 CRLF 是因为 npm pack 在 Windows 上统一转 LF。
 *
 * 用法：node analysis\dsh-021-turn-cursor\tools\verify-package.mjs --ref 87794f2 \
 *         --zip dist\dsh-context-governance-1.1.0-rc.12.zip
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const ref = arg('ref');
const zipRel = arg('zip');
const PKG = 'packages/dsh-context-governance';
const ROOT_NAME = 'dsh-context-governance';

if (ref === undefined || zipRel === undefined) {
  console.error('usage: node verify-package.mjs --ref <commit> --zip <zip>');
  process.exit(2);
}

const zip = path.resolve(repo, zipRel);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const norm = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 256 * 1024 * 1024 });

const sha = git('rev-parse', ref).toString().trim();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pkgverify-'));

// 1. 解包（Windows tar = bsdtar，可解 zip）
execFileSync('tar', ['-xf', zip, '-C', work], { stdio: 'inherit' });
const rootDir = path.join(work, ROOT_NAME);

// 2. 包内条目
const packed = [];
const walk = (dir, rel = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
    else packed.push(childRel);
  }
};
walk(rootDir);
packed.sort();

// 3. 逐文件比对
const missing = [];
const mismatch = [];
const identical = [];
for (const rel of packed) {
  let tree;
  try {
    tree = git('show', `${sha}:${PKG}/${rel}`);
  } catch {
    mismatch.push({ rel, why: 'not-in-commit-tree' });
    continue;
  }
  const local = fs.readFileSync(path.join(rootDir, rel));
  const a = norm(tree);
  const b = norm(local);
  if (a.equals(b)) identical.push(rel);
  else mismatch.push({ rel, why: `bytes differ: tree=${sha256(a).slice(0, 12)} zip=${sha256(b).slice(0, 12)}` });
}
// 4. 反向：包内清单必须 = 声明的 files 白名单（目录展开）∪ npm 自动项（package.json/LICENSE）
const manifest = JSON.parse(git('show', `${sha}:${PKG}/package.json`).toString('utf8'));
const treeFiles = git('ls-tree', '-r', '--name-only', `${sha}:${PKG}`).toString().split('\n').filter(Boolean);
const expected = new Set(['package.json', 'LICENSE']);
for (const entry of manifest.files ?? []) {
  const clean = String(entry).replace(/^\.\//, '').replace(/\/$/, '');
  if (treeFiles.includes(clean)) { expected.add(clean); continue; }
  for (const rel of treeFiles) if (rel.startsWith(`${clean}/`)) expected.add(rel);
}
const notPacked = [...expected].filter((rel) => !packed.includes(rel)).sort();
const outsideWhitelist = packed.filter((rel) => !expected.has(rel));

const zipBuf = fs.readFileSync(zip);
console.log(`ref=${ref} sha=${sha}`);
console.log(`zip=${zip}`);
console.log(`zip bytes=${zipBuf.length} sha256=${sha256(zipBuf)}`);
console.log(`packed files=${packed.length} expected=${expected.size}`);
console.log(`identical=${identical.length} mismatch=${mismatch.length} notPacked=${notPacked.length} outsideWhitelist=${outsideWhitelist.length}`);
if (mismatch.length > 0) {
  for (const item of mismatch.slice(0, 20)) console.log(`  MISMATCH ${item.rel} :: ${item.why}`);
}
if (notPacked.length > 0) {
  for (const rel of notPacked.slice(0, 20)) console.log(`  NOT-PACKED ${rel}`);
}
if (outsideWhitelist.length > 0) {
  for (const rel of outsideWhitelist.slice(0, 20)) console.log(`  OUTSIDE-WHITELIST ${rel}`);
}
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
const ok = mismatch.length === 0 && notPacked.length === 0 && outsideWhitelist.length === 0;
console.log(ok ? 'PACKAGE-VERIFY PASS（逐文件与 commit 树一致）' : 'PACKAGE-VERIFY FAIL');
process.exitCode = ok ? 0 : 1;
