/**
 * P1 / T1–T3：state v2 读写、v1 迁移、损坏/未来版本、首推独占。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  emptyV2State,
  loadStateV2,
  makeV2Entry,
  persistPrimaryV2,
  validateV2Document,
  writeStateV2,
} from '../src/root-state.js';
import { rootIdOf } from '../src/roots/identity.js';

async function tempDir(prefix = 'cg-state-') {
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

function stateFileIn(dir, profile = 'desktop') {
  return path.join(dir, 'context-governance', `root-state-${profile}.json`);
}

test('P1/T1 state v2：roundtrip、未知字段容忍、坏条目丢弃且其余保留', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const file = stateFileIn(base);
  const state = emptyV2State('desktop');
  const a = makeV2Entry({ root: rootA, origin: 'inferred', inferredFromCwd: rootA });
  const b = makeV2Entry({ root: rootB, origin: 'config' });
  state.roots[a.rootId] = a;
  state.roots[b.rootId] = b;
  state.primaryRootId = a.rootId;
  state.primaryRoot = a.root;
  state.futureField = 'tolerated';
  assert.equal(writeStateV2(file, state), true);

  const loaded = loadStateV2(file, { profile: 'desktop' });
  assert.equal(loaded.migrated, undefined);
  assert.equal(Object.keys(loaded.state.roots).length, 2);
  assert.equal(loaded.state.primaryRootId, a.rootId);
  assert.equal(loaded.state.roots[a.rootId].root, a.root);
  assert.equal(loaded.state.roots[b.rootId].origin, 'config');

  // 手工塞坏条目：rootId 不匹配 / 相对 root / 坏 state → 只丢坏条目，其余保留。
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.roots['deadbeefdeadbeef'] = { ...raw.roots[a.rootId], rootId: 'deadbeefdeadbeef' };
  raw.roots['relroot'] = { ...raw.roots[a.rootId], root: 'relative/root' };
  raw.roots[b.rootId].state = 'weird';
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const repaired = loadStateV2(file, { profile: 'desktop' });
  assert.equal(Object.keys(repaired.state.roots).length, 1, '坏条目应被丢弃，仅保留合法条目');
  assert.ok(repaired.invalidEntries.length >= 3);
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.v2-bad-')));

  // primaryRootId 不在 roots → null + 记录。
  const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw2.primaryRootId = 'ffffffffffffffff';
  raw2.primaryRoot = rootA;
  fs.writeFileSync(file, JSON.stringify(raw2, null, 2));
  const orphan = loadStateV2(file, { profile: 'desktop' });
  assert.equal(orphan.state.primaryRootId, null);
  assert.ok(orphan.invalidEntries.some((item) => item.key === 'primaryRootId'));
});

test('P1/T2 v1→v2 迁移：rootId/primaryRootId/.v1.bak/幂等', async () => {
  const base = await tempDir();
  const root = makeRoot(base, 'workspace');
  const file = stateFileIn(base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    root,
    source: 'inferred',
    inferredAt: '2026-10-26T03:37:54.715Z',
    inferredFromCwd: root,
    instance: { profile: 'desktop' },
  }, null, 2));

  const migrated = loadStateV2(file, { profile: 'desktop' });
  assert.equal(migrated.migrated, true);
  const id = rootIdOf(root);
  assert.equal(migrated.state.primaryRootId, id);
  assert.equal(migrated.state.roots[id].root, root);
  assert.equal(migrated.state.roots[id].name, 'workspace');
  assert.equal(migrated.state.migratedFrom, 1);
  assert.ok(fs.existsSync(migrated.backupPath));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.primaryRootId, id);

  const backupsBefore = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.v1.bak')).length;
  const again = loadStateV2(file, { profile: 'desktop' });
  assert.equal(again.migrated, undefined);
  assert.equal(again.state.primaryRootId, id);
  const backupsAfter = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.v1.bak')).length;
  assert.equal(backupsAfter, backupsBefore, '二次加载不得重复备份');
});

test('P1/T3 损坏隔离 + 未来版本只读 + 首推独占', async () => {
  const base = await tempDir();
  const file = stateFileIn(base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');

  const corrupt = loadStateV2(file, { profile: 'desktop', now: new Date('2026-10-26T13:00:00Z') });
  assert.equal(corrupt.corrupt, true);
  assert.ok(corrupt.corruptPath !== null && fs.existsSync(corrupt.corruptPath), '损坏文件应改名留证');
  assert.equal(fs.existsSync(file), false);
  assert.equal(Object.keys(corrupt.state.roots).length, 0);

  fs.writeFileSync(file, JSON.stringify({ version: 99, roots: { x: {} } }, null, 2));
  const future = loadStateV2(file, { profile: 'desktop' });
  assert.equal(future.unsupported, true);
  assert.equal(future.writable, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 99, '未来版本不得被覆盖');

  const root = makeRoot(base, 'first');
  const first = persistPrimaryV2(file, { root, profile: 'desktop', now: new Date('2026-10-26T13:01:00Z') });
  // 文件仍是 version 99：首推走 link EEXIST → 读回既有（unsupported 返回空 state）。
  assert.equal(first.ok, true);
  assert.equal(first.existed, true);

  const fresh = stateFileIn(base, 'fresh');
  const rootB = makeRoot(base, 'second');
  const one = persistPrimaryV2(fresh, { root: rootB, profile: 'fresh', now: new Date('2026-10-26T13:02:00Z') });
  const two = persistPrimaryV2(fresh, { root: rootB, profile: 'fresh', now: new Date('2026-10-26T13:02:01Z') });
  assert.equal(one.ok, true);
  assert.equal(one.existed, false);
  assert.equal(two.ok, true);
  assert.equal(two.existed, true);
  assert.equal(two.state.primaryRootId, rootIdOf(rootB));
});

test('P1/T1 validateV2Document：rootId 必须由 root 重算', async () => {
  const base = await tempDir();
  const root = makeRoot(base, 'check');
  const id = rootIdOf(root);
  const entry = makeV2Entry({ root, origin: 'inferred' });
  const ok = validateV2Document({ version: 2, roots: { [id]: entry }, primaryRootId: id, primaryRoot: root });
  assert.equal(ok.invalid.length, 0);
  assert.equal(ok.state.roots[id].rootId, id);

  const bad = validateV2Document({
    version: 2,
    roots: { deadbeef: { ...entry, rootId: 'deadbeef' } },
  });
  assert.equal(Object.keys(bad.state.roots).length, 0);
  assert.equal(bad.invalid[0].reason, 'root-id-mismatch');
});
