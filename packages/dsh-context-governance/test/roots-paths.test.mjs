/**
 * P1：两类固定位置守卫（memoryRoot 目录固定 + 用户级路径白名单）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MEMORY_ROOT_REL,
  isUserLevelPath,
  memoryRootFor,
  rootAuditFile,
  userLevelDir,
} from '../src/roots/paths.js';

async function tempDir(prefix = 'cg-paths-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoot(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: x\n');
  return dir;
}

test('P1 containment：根内只认固定 memory/governance', async () => {
  const base = await tempDir();
  const root = makeRoot(base, 'repo');
  const ok = memoryRootFor(root);
  assert.equal(ok.ok, true);
  assert.equal(ok.memoryRoot, path.join(root, MEMORY_ROOT_REL));
  assert.equal(memoryRootFor(root, 'memory/governance').ok, true);
  assert.equal(memoryRootFor(root, 'memory\\governance').ok, true);

  assert.equal(memoryRootFor(root, path.join(base, 'elsewhere')).reason, 'memory-root-absolute');
  assert.equal(memoryRootFor(root, '..\\outside').reason, 'memory-root-escape');
  assert.equal(memoryRootFor(root, 'memory/other').reason, 'memory-root-not-fixed');
  assert.equal(memoryRootFor(root, '').reason, 'memory-root-invalid');
});

test('P1 containment：用户级路径只认 context-governance 目录 + 白名单文件', async () => {
  const base = await tempDir();
  const dir = path.join(base, 'context-governance');
  const identity = { ok: true, name: 'desktop', stateFile: path.join(dir, 'root-state-desktop.json') };
  assert.equal(userLevelDir(identity), dir);
  assert.equal(rootAuditFile(identity), path.join(dir, 'root-audit-desktop.jsonl'));
  assert.equal(rootAuditFile({ ...identity, stateFile: path.join(dir, 'root-state.json') }),
    path.join(dir, 'root-audit.jsonl'));

  assert.equal(isUserLevelPath(identity, path.join(dir, 'root-state-desktop.json')), true);
  assert.equal(isUserLevelPath(identity, path.join(dir, 'root-audit-desktop.jsonl')), true);
  assert.equal(isUserLevelPath(identity, path.join(dir, 'root-state-desktop.v1.bak')), true);
  assert.equal(isUserLevelPath(identity, path.join(dir, 'root-state-desktop.corrupt-20261026T130000Z.json')), true);
  assert.equal(isUserLevelPath(identity, path.join(dir, 'audit-20261026.jsonl')), true);
  assert.equal(isUserLevelPath(identity, path.join(dir, 'other.json')), false);
  assert.equal(isUserLevelPath(identity, path.join(base, 'root-state-desktop.json')), false);
  assert.equal(isUserLevelPath({ ...identity, stateFile: path.join(base, 'root-state-desktop.json') }, null), false);
});
