/**
 * P1 / T4–T7、T18–T19：RootRegistry 发现/登记/主根/会话 pin/不扫盘/节流/限额/碰撞。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RootRegistry, ROOT_WARN_THRESHOLD } from '../src/roots/registry.js';

async function tempDir(prefix = 'cg-roots-') {
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

function stateFileIn(dir) {
  return path.join(dir, 'context-governance', 'root-state-test.json');
}

function session(id, cwd, extra = {}) {
  return { header: { id, cwd, ...extra } };
}

function makeRegistry({ stateFile, clock, rootAudit = [], hashFn, pinLimit }) {
  return RootRegistry.load({
    stateFile,
    profile: 'test',
    now: () => clock.value,
    rootAudit: { append: (event, details) => rootAudit.push({ event, details }) },
    hashFn,
    pinLimit,
  });
}

test('P1/T4 registry：首推登记 + 主根；重启 source=persisted、不重推', async () => {
  const base = await tempDir();
  const root = makeRoot(base, 'alpha');
  const file = stateFileIn(base);
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const audit = [];
  const reg = makeRegistry({ stateFile: file, clock, rootAudit: audit });
  const entry = reg.claimPrimary(root, { origin: 'inferred' });
  assert.ok(entry !== null);
  assert.equal(entry.root, root);
  assert.equal(reg.primary.rootId, entry.rootId);
  assert.ok(fs.existsSync(file), '首推应落盘');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.primaryRootId, entry.rootId);

  const first = reg.resolveSessionRoot(session('s1', root));
  assert.equal(first.status, 'managed');
  assert.equal(first.source, 'inferred');
  assert.equal(first.entry.rootId, entry.rootId);
  assert.ok(audit.some((item) => item.event === 'root-registered'));

  const reg2 = makeRegistry({ stateFile: file, clock, rootAudit: audit });
  const second = reg2.resolveSessionRoot(session('s2', root));
  assert.equal(second.status, 'managed');
  assert.equal(second.source, 'persisted');
  assert.equal(reg2.primary.rootId, entry.rootId);
});

test('P1/T5 registry：第二根只登记不夺主根；>16 只告警不拒绝', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const file = stateFileIn(base);
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const audit = [];
  const reg = makeRegistry({ stateFile: file, clock, rootAudit: audit });
  const primary = reg.claimPrimary(rootA, { origin: 'inferred' });
  const other = reg.resolveSessionRoot(session('s2', rootB));
  assert.equal(other.status, 'unmanaged');
  assert.equal(other.entry.root, rootB);
  assert.equal(reg.counts().roots, 2);
  assert.equal(reg.primary.rootId, primary.rootId);

  // 补齐到阈值 +1：全部登记成功，只有一次 root-limit-warn。
  const total = ROOT_WARN_THRESHOLD + 1;
  for (let index = reg.counts().roots; index < total; index += 1) {
    const dir = makeRoot(base, `many-${index}`);
    const resolved = reg.resolveSessionRoot(session(`many-${index}`, dir));
    assert.equal(resolved.entry.root, dir, `第 ${index + 1} 个根仍须登记（不设硬上限）`);
  }
  assert.equal(reg.counts().roots, total);
  const warns = audit.filter((item) => item.event === 'root-limit-warn');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].details.rootCount, total);
  assert.equal(reg.counts().warn, true);
});

test('P1/T6 registry：首个可判定事件 pin；后续 cwd 在别的根只记 drift 不换根', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const file = stateFileIn(base);
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const reg = makeRegistry({ stateFile: file, clock });
  reg.claimPrimary(rootA, { origin: 'inferred' });
  const first = reg.resolveSessionRoot(session('s1', rootA));
  assert.equal(first.status, 'managed');
  const before = reg.counts().roots;
  const drifted = reg.resolveSessionRoot(session('s1', path.join(rootB, 'sub')));
  assert.equal(drifted.entry.root, rootA, '根不得随中途 cd 切换');
  assert.ok(drifted.drift !== null && drifted.drift.from === rootA);
  assert.equal(reg.counts().roots, before, 'drift 不得登记新根');
});

test('P1/T7 registry：cwd 空/无 .git 祖先 → no-root，不登记、不写 state、不写 audit', async () => {
  const base = await tempDir();
  const noRoot = await tempDir('cg-no-root-');
  const file = stateFileIn(base);
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const audit = [];
  const reg = makeRegistry({ stateFile: file, clock, rootAudit: audit });
  const byCwd = reg.resolveSessionRoot(session('x', noRoot));
  assert.equal(byCwd.status, 'no-root');
  assert.equal(byCwd.reason, 'no-git-ancestor');
  const byEmpty = reg.resolveSessionRoot({ header: { id: 'y' } });
  assert.equal(byEmpty.status, 'no-root');
  assert.equal(byEmpty.reason, 'cwd-missing');
  assert.equal(fs.existsSync(file), false);
  assert.equal(audit.length, 0);
});

test('P1/T18 registry：不扫盘——只登记 state 里/会话出现的根', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  makeRoot(base, 'beta'); // 存在于磁盘，但没有会话 → 不得被发现
  const file = stateFileIn(base);
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const reg = makeRegistry({ stateFile: file, clock });
  assert.equal(reg.list().length, 0);
  reg.claimPrimary(rootA, { origin: 'inferred' });
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0].root, rootA);
  assert.equal(reg.view().length, 1);
});

test('P1/T15 registry：子会话继承父根、不新增根；父根未知/无 cwd → no-root', async () => {
  const base = await tempDir();
  const root = makeRoot(base, 'alpha');
  const file = stateFileIn(base);
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const reg = makeRegistry({ stateFile: file, clock });
  reg.claimPrimary(root, { origin: 'inferred' });
  const parent = reg.resolveSessionRoot(session('p1', root));
  assert.equal(parent.status, 'managed');
  const child = reg.resolveSessionRoot({ header: { id: 'c1', parentSession: 'p1', origin: 'subagent' } });
  assert.equal(child.status, 'managed');
  assert.equal(child.source, 'parent');
  assert.equal(child.isSubagent, true);
  assert.equal(child.entry.root, root);
  assert.equal(reg.counts().roots, 1, '子会话不得新增根');
  const orphan = reg.resolveSessionRoot({ header: { id: 'c2', parentSession: 'missing', origin: 'subagent' } });
  assert.equal(orphan.status, 'no-root');
  assert.equal(orphan.isSubagent, true);
});

test('P1/T19 registry：lastSeenAt 节流、pin 上限、hash 碰撞延长', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const file = stateFileIn(base);
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const reg = makeRegistry({ stateFile: file, clock });
  reg.claimPrimary(rootA, { origin: 'inferred' });
  const firstText = fs.readFileSync(file, 'utf8');
  clock.value = new Date('2026-10-26T10:10:00Z');
  reg.resolveSessionRoot(session('s1', rootA));
  assert.equal(fs.readFileSync(file, 'utf8'), firstText, '1h 内 lastSeenAt 不落盘');
  clock.value = new Date('2026-10-26T12:10:00Z');
  reg.resolveSessionRoot(session('s2', rootA));
  assert.notEqual(fs.readFileSync(file, 'utf8'), firstText, '超过 1h 应刷新 lastSeenAt');

  const pinReg = makeRegistry({ stateFile: stateFileIn(path.join(base, 'pin')), clock, pinLimit: 2 });
  pinReg.claimPrimary(rootA, { origin: 'inferred' });
  for (const id of ['p1', 'p2', 'p3']) pinReg.resolveSessionRoot(session(id, rootA));
  assert.equal(pinReg.pinCount, 2);

  const rootB = makeRoot(base, 'beta');
  const rootC = makeRoot(base, 'gamma');
  const collide = makeRegistry({
    stateFile: stateFileIn(path.join(base, 'collision')),
    clock,
    hashFn: (text) => (text.endsWith('gamma') ? `${'f'.repeat(16)}${'e'.repeat(48)}` : 'f'.repeat(64)),
  });
  const a = collide.claimPrimary(rootB, { origin: 'inferred' });
  const c = collide.resolveSessionRoot(session('c1', rootC));
  assert.equal(collide.counts().roots, 2);
  assert.equal(a.rootId.length, 16);
  assert.equal(c.entry.rootId.length, 20, '碰撞时根标识长度应延长');
  assert.notEqual(a.rootId, c.entry.rootId);
});
