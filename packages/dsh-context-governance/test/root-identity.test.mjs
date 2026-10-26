/**
 * P1 / T16：根标识（路径 hash）、worktree/.git 文件、realpath、UNC、盘符大小写。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inferRootFromCwd,
  normalizeRootPath,
  platformFold,
  rootIdOf,
  rootNameOf,
  samePath,
  stripLongPathPrefix,
} from '../src/roots/identity.js';

async function tempDir(prefix = 'cg-ident-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoot(parent, name, { gitFile = true } = {}) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = path.join(dir, '.git');
  if (gitFile) fs.writeFileSync(git, 'gitdir: nowhere\n');
  else fs.mkdirSync(git, { recursive: true });
  return dir;
}

test('P1/T16 根标识：路径 hash 稳定、同名不同根不撞、name 只展示', async () => {
  const base = await tempDir();
  const left = makeRoot(base, path.join('left', 'tools'));
  const right = makeRoot(base, path.join('right', 'tools'));
  const leftId = rootIdOf(normalizeRootPath(left));
  const rightId = rootIdOf(normalizeRootPath(right));
  assert.equal(leftId.length, 16);
  assert.match(leftId, /^[0-9a-f]{16}$/);
  assert.notEqual(leftId, rightId, '同名 tools 必须靠路径 hash 区分');
  assert.equal(rootNameOf(left), 'tools');
  assert.equal(rootNameOf(right), 'tools');

  // 大小写/重复分隔符/相对写法归一后同一 id（Windows 大小写不敏感）。
  const variant = path.join(base, 'left', 'tools').toUpperCase();
  assert.equal(rootIdOf(normalizeRootPath(variant)), leftId);
  assert.equal(rootIdOf(normalizeRootPath(`${left}${path.sep}`)), leftId);
});

test('P1/T16 根判定：.git 文件或目录都算、取最近祖先、worktree 兼容', async () => {
  const base = await tempDir();
  const outer = makeRoot(base, 'outer', { gitFile: false });
  const inner = makeRoot(path.join(outer, 'packages'), 'inner', { gitFile: true });
  const deep = path.join(inner, 'src', 'lib');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(inferRootFromCwd(deep), inner, '应取最近的 .git（文件形态）');
  assert.equal(inferRootFromCwd(path.join(outer, 'docs')), outer, '应取 .git 目录形态');
  assert.equal(inferRootFromCwd(await tempDir('cg-nogit-')), null);
});

test('P1/T16 符号链接/junction：按 realpath 判根', async (t) => {
  const base = await tempDir();
  const real = makeRoot(base, 'real');
  const link = path.join(base, 'link');
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch {
    t.skip('当前环境不能创建 junction/symlink');
    return;
  }
  const sub = path.join(link, 'src');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(inferRootFromCwd(sub), real, '链接路径应解析到真实根');
  assert.ok(samePath(normalizeRootPath(link), real));
});

test('P1/T16 UNC/长路径前缀归一 + 盘符根展示名', () => {
  assert.equal(stripLongPathPrefix('\\\\?\\C:\\work'), 'C:\\work');
  assert.equal(stripLongPathPrefix('\\\\?\\UNC\\srv\\share\\x'), '\\\\srv\\share\\x');
  assert.equal(stripLongPathPrefix('C:\\work'), 'C:\\work');
  assert.equal(rootNameOf('C:\\'), 'C:');
  assert.equal(platformFold('AbC'), process.platform === 'win32' ? 'abc' : 'AbC');
  assert.equal(normalizeRootPath(''), null);
  assert.equal(normalizeRootPath(null), null);
  assert.equal(normalizeRootPath('relative/path'), path.resolve('relative/path'));
});
