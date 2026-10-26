/**
 * v3：实际写入路径 containment（realpath / `..` / 符号链接 / junction / 盘符归一）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../src/audit.js';
import { MemoryStore } from '../src/memory/store.js';
import { checkWriteTarget } from '../src/roots/containment.js';
import { emptyV2State, writeStateV2 } from '../src/root-state.js';

async function tempDir(prefix = 'cg-contain-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('v3 containment：普通路径/.. /盘符大小写/基目录边界', async () => {
  const base = await tempDir();
  try {
    assert.equal(checkWriteTarget(base, path.join(base, 'sub', 'file.txt')).ok, true);
    assert.equal(checkWriteTarget(base, path.join(base, '..', 'outside.txt')).ok, false);
    assert.equal(checkWriteTarget(base, path.join(path.dirname(base), 'outside.txt')).ok, false);
    assert.equal(checkWriteTarget(base, base).ok, false, '目标等于基目录不是文件写入');
    const upper = path.join(base, 'Sub', 'F.TXT');
    const lower = path.join(base, 'sub', 'f.txt');
    const a = checkWriteTarget(base, upper).ok;
    const b = checkWriteTarget(base, lower).ok;
    assert.equal(a, b, 'Windows 大小写归一后判定一致');
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});

test('v3 containment：目标符号链接 / 父 junction 逃逸均拒绝', async (t) => {
  const base = await tempDir();
  const outside = await tempDir();
  try {
    const outsideFile = path.join(outside, 'target.txt');
    await fs.promises.writeFile(outsideFile, 'x');
    const link = path.join(base, 'link.txt');
    try {
      fs.symlinkSync(outsideFile, link, 'file');
    } catch {
      t.diagnostic('当前环境不能创建文件符号链接，跳过目标 symlink 断言');
    }
    if (fs.existsSync(link)) {
      assert.equal(checkWriteTarget(base, link).ok, false, '目标本身是符号链接必须拒绝');
    }

    const outsideDir = path.join(outside, 'dir');
    await fs.promises.mkdir(outsideDir, { recursive: true });
    const junction = path.join(base, 'junction');
    try {
      fs.symlinkSync(outsideDir, junction, 'junction');
    } catch {
      t.diagnostic('当前环境不能创建 junction，跳过父链接断言');
    }
    if (fs.existsSync(junction)) {
      assert.equal(checkWriteTarget(base, path.join(junction, 'file.txt')).ok, false, '父 junction 指向外部必须拒绝');
    }
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

test('v3 containment：state 写入与 AuditLog 构造按实际路径拒绝', async () => {
  const base = await tempDir();
  const outside = await tempDir();
  try {
    const state = emptyV2State('p');
    assert.equal(writeStateV2(path.join(outside, 'state.json'), state, { allowedBase: base }), false);
    assert.equal(writeStateV2(path.join(base, 'state.json'), state, { allowedBase: base }), true);

    assert.throws(() => new AuditLog({ file: path.join(outside, 'audit.jsonl'), allowedBase: base }), /outside allowed base|outside-base/);
    const ok = new AuditLog({ file: path.join(base, 'audit.jsonl'), allowedBase: base });
    assert.equal(ok.append('apply', { status: 'ok' }), true);
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true });
    await fs.promises.rm(outside, { recursive: true, force: true });
  }
});

test('v3 containment：memory topics 是指向外部的 junction → store 只读 fail-closed', async (t) => {
  const rootDir = await tempDir();
  const outsideDir = await tempDir();
  try {
    const topics = path.join(rootDir, 'topics');
    try {
      fs.symlinkSync(outsideDir, topics, 'junction');
    } catch {
      t.skip('当前环境不能创建 junction');
      return;
    }
    const store = await MemoryStore.open({ rootDir, project: 'test-project' });
    try {
      assert.ok((store.status.readOnlyReason ?? '').startsWith('containment:'), `应 containment 只读，实际 ${store.status.readOnlyReason}`);
      assert.equal(fs.readdirSync(outsideDir).length, 0, '不得向外部目录写入');
    } finally {
      await store.close().catch(() => {});
    }
  } finally {
    await fs.promises.rm(rootDir, { recursive: true, force: true });
    await fs.promises.rm(outsideDir, { recursive: true, force: true });
  }
});
