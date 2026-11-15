/**
 * P4（rc.11）：根被删/不可读 → 不假装纳管、不重建目录、显式 root-missing。
 *
 * rc.10 缺陷：根目录被删后，已登记 active 的根仍判 `managed` → 记忆路径经
 * `<root>/memory/governance` 开 store 时把目录静默重建，且不写 `root-unresolved`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RootRegistry } from '../src/roots/registry.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p4-reg-'));
}

function makeRoot(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: nowhere\n');
  return dir;
}

function makeRegistry(stateFile, rootAudit) {
  return RootRegistry.load({
    stateFile,
    profile: 'test',
    now: () => new Date('2026-11-15T00:00:00Z'),
    rootAudit: { append: (event, details) => rootAudit.push({ event, details }) },
  });
}

test('P4 ①：根目录被删 → resolveSessionRoot 降为 no-root(root-missing)，entry 保留可诊断', () => {
  const base = tempDir();
  try {
    const root = makeRoot(base, 'alpha');
    const audit = [];
    const stateFile = path.join(base, 'context-governance', 'root-state-p4.json');
    const reg = makeRegistry(stateFile, audit);
    const entry = reg.claimPrimary(root, { origin: 'inferred' });

    const before = reg.resolveSessionRoot({ header: { id: 's1', cwd: root } });
    assert.equal(before.status, 'managed');
    assert.equal(before.reason, undefined);

    fs.rmSync(root, { recursive: true, force: true });

    const after = reg.resolveSessionRoot({ header: { id: 's1', cwd: root } });
    assert.equal(after.status, 'no-root', '根不在 → 不得再判 managed');
    assert.equal(after.reason, 'root-missing');
    assert.equal(after.entry?.rootId, entry.rootId, 'entry 保留供诊断，但不许被当成可用根');
    assert.equal(fs.existsSync(root), false, '判定过程不得重建根目录');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P4 ②：根目录被换成同名文件（不是目录）→ 同样 no-root，不得当作可用根', () => {
  const base = tempDir();
  try {
    const root = makeRoot(base, 'beta');
    const audit = [];
    const stateFile = path.join(base, 'context-governance', 'root-state-p4b.json');
    const reg = makeRegistry(stateFile, audit);
    const entry = reg.claimPrimary(root, { origin: 'inferred' });
    assert.equal(reg.resolveSessionRoot({ header: { id: 's2', cwd: root } }).status, 'managed');

    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, 'not a dir\n');

    const after = reg.resolveSessionRoot({ header: { id: 's2', cwd: root } });
    assert.equal(after.status, 'no-root');
    assert.equal(after.reason, 'root-missing');
    assert.equal(after.entry?.rootId, entry.rootId);
    assert.equal(fs.readFileSync(root, 'utf8'), 'not a dir\n', '不得改写占位文件');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('P4 ③：根恢复后自动回到 managed（不缓存"缺失"结论）', () => {
  const base = tempDir();
  const root = makeRoot(base, 'gamma');
  try {
    const audit = [];
    const stateFile = path.join(base, 'context-governance', 'root-state-p4c.json');
    const reg = makeRegistry(stateFile, audit);
    reg.claimPrimary(root, { origin: 'inferred' });
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(reg.resolveSessionRoot({ header: { id: 's3', cwd: root } }).status, 'no-root');

    fs.mkdirSync(root, { recursive: true });
    const back = reg.resolveSessionRoot({ header: { id: 's3', cwd: root } });
    assert.equal(back.status, 'managed', '用户把根放回去后必须恢复纳管');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  }
});
