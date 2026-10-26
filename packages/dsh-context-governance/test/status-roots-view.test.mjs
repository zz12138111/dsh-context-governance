/**
 * P1 / T17：/cg status「全部纳管根」段 + registry.view 只读（不 mkdir/不开 store）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { RootRegistry } from '../src/roots/registry.js';

async function tempDir(prefix = 'cg-roots-view-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoot(parent, name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: x\n');
  return dir;
}

test('P1/T17 status：roots 计数 + 全部根列表（active/idle/fail-closed、memory、audit 末行）', async () => {
  const command = createStatusCommand({
    getRootsView: () => [
      {
        rootId: 'a'.repeat(16), root: 'D:\\work\\demo', name: 'demo', project: 'demo',
        state: 'active', active: true, memoryCount: 3,
        auditLast: { ts: '2026-10-26T10:00:00.000Z', event: 'apply' }, failClosedReason: null,
      },
      {
        rootId: 'b'.repeat(16), root: 'D:\\work\\idle', name: 'idle', project: 'idle',
        state: 'idle', active: false, memoryCount: null, auditLast: null, failClosedReason: null,
      },
      {
        rootId: 'c'.repeat(16), root: 'D:\\work\\bad', name: 'bad', project: 'bad',
        state: 'fail-closed', active: false, memoryCount: null, auditLast: null,
        failClosedReason: 'memory-root-escape',
      },
    ],
    getRootCounts: () => ({ roots: 3, active: 1, idle: 1, failClosed: 1, warn: false }),
  });
  const result = await command.handler({ rawInput: 'status' });
  assert.match(result.text, /^roots: 3 \(active=1, idle=1, fail-closed=1\)$/m);
  assert.match(result.text, /^ {2}root: id=aaaaaaaaaaaaaaaa name=demo project=demo state=active memory=3 audit=2026-10-26T10:00:00\.000Z\(apply\)$/m);
  assert.match(result.text, /^ {2}root: id=bbbbbbbbbbbbbbbb name=idle project=idle state=idle memory=- audit=-$/m);
  assert.match(result.text, /^ {2}root: id=cccccccccccccccc name=bad project=bad state=fail-closed reason=memory-root-escape memory=- audit=-$/m);
});

test('P1/T17 registry.view：记忆条数/审计末行只读；无数不建目录；idle 来自 state', async () => {
  const base = await tempDir();
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const stateFile = path.join(base, 'context-governance', 'root-state-view.json');
  const clock = { value: new Date('2026-10-26T10:00:00Z') };
  const reg = RootRegistry.load({ stateFile, profile: 'view', now: () => clock.value });
  reg.claimPrimary(rootA, { origin: 'inferred' });
  reg.resolveSessionRoot({ header: { id: 'b1', cwd: rootB } });

  const memoryDir = path.join(rootA, 'memory', 'governance');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), [
    '# Memory index',
    '',
    '- MEM-20261026-1001 · active · fact · one',
    '- MEM-20261026-1002 · proposed · decision · two',
  ].join('\n'));
  fs.writeFileSync(path.join(memoryDir, 'audit.jsonl'), `${JSON.stringify({ ts: '2026-10-26T09:00:00.000Z', event: 'apply' })}\n`);

  const view = reg.view();
  const byRoot = new Map(view.map((item) => [item.root, item]));
  assert.equal(byRoot.get(rootA).state, 'active');
  assert.equal(byRoot.get(rootA).memoryCount, 2);
  assert.deepEqual(byRoot.get(rootA).auditLast, { ts: '2026-10-26T09:00:00.000Z', event: 'apply' });
  assert.equal(byRoot.get(rootB).state, 'active');
  assert.equal(byRoot.get(rootB).memoryCount, null);
  assert.equal(byRoot.get(rootB).auditLast, null);
  assert.equal(fs.existsSync(path.join(rootB, 'memory')), false, 'view 不得替其他根建目录');

  const idle = RootRegistry.load({ stateFile, profile: 'view', now: () => clock.value });
  const idleView = idle.view();
  assert.equal(idleView.find((item) => item.root === rootA).state, 'idle');
  assert.equal(idle.counts().active, 0);
  assert.equal(idle.counts().idle, 2);
});
