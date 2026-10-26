/**
 * P1 / T20：多 profile 状态隔离、删状态重新推断、根审计按 registry 实例隔离。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RootRegistry } from '../src/roots/registry.js';
import { loadStateV2 } from '../src/root-state.js';

async function tempDir(prefix = 'cg-iso-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoot(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: x\n');
  return dir;
}

function stateFileIn(home, profile) {
  return path.join(home, 'context-governance', `root-state-${profile}.json`);
}

function makeRegistry(stateFile, clock, audit) {
  return RootRegistry.load({
    stateFile,
    profile: path.basename(stateFile).replace(/^root-state-|\.json$/g, ''),
    now: () => clock.value,
    rootAudit: { append: (event, details) => audit.push({ event, details }) },
  });
}

test('P1/T20 多 profile：状态与根审计互不影响；删状态 → 重新推断', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const auditA = [];
  const auditB = [];
  const fileA = stateFileIn(base, 'desktop');
  const fileB = stateFileIn(base, 'other');

  const regA = makeRegistry(fileA, clock, auditA);
  const regB = makeRegistry(fileB, clock, auditB);
  regA.claimPrimary(rootA, { origin: 'inferred' });
  regB.claimPrimary(rootB, { origin: 'inferred' });
  assert.equal(regA.list().length, 1);
  assert.equal(regB.list().length, 1);
  assert.equal(regA.list()[0].root, rootA);
  assert.equal(regB.list()[0].root, rootB);
  assert.ok(auditA.some((item) => item.event === 'root-registered'));
  assert.ok(auditB.some((item) => item.event === 'root-registered'));
  assert.equal(auditA.some((item) => item.details.root === rootB), false);
  assert.equal(auditB.some((item) => item.details.root === rootA), false);

  // 删 A 的状态 → load 返回 missing，registry 空；重新登记生成新状态，B 不受影响。
  fs.rmSync(fileA);
  const missing = loadStateV2(fileA, { profile: 'desktop' });
  assert.equal(missing.missing, true);
  const regA2 = makeRegistry(fileA, clock, auditA);
  assert.equal(regA2.list().length, 0);
  const re = regA2.resolveSessionRoot({ header: { id: 'a1', cwd: rootA } });
  assert.equal(re.status, 'unmanaged', '未 claim 主根时新推断根不应自动 managed');
  assert.equal(regA2.list().length, 1);
  assert.ok(fs.existsSync(fileA));
  const regB2 = makeRegistry(fileB, clock, auditB);
  assert.equal(regB2.list()[0].root, rootB);
});
