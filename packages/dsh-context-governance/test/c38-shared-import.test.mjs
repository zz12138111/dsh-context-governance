/**
 * C38 ③：promote / shared / legacy 导入 / --from-role。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { openSessionMemory } from '../src/memory/session-store.js';
import { importFromRole, importLegacy, openSharedMemory, promotePointers } from '../src/memory/import.js';
import { tempDir } from './helpers.mjs';

async function makeBody(dir) {
  const file = path.join(dir, 'BODY.md');
  await fs.writeFile(file, '第一条正文\n第二条正文\n第三条正文\n', 'utf8');
  return file;
}

test('C38 ⑤：promote 只把显式指定指针写入 shared/<rootId>，带来源与审计；默认不共享', async () => {
  const home = await tempDir('cg-c38-promote-');
  const work = await tempDir('cg-c38-promote-body-');
  try {
    const file = await makeBody(work);
    const audits = [];
    const store = openSessionMemory({ home, sessionId: 'session-dddd4444' });
    const first = store.append({ type: 'fact', title: '共享事实', target: `${file}:1`, summary: '共享事实' });
    const second = store.append({ type: 'fact', title: '未指定', target: `${file}:2`, summary: '未指定' });
    const other = openSessionMemory({ home, sessionId: 'session-eeee5555' });
    const before = openSharedMemory({ home, rootId: 'root-x' }).count();
    assert.equal(before, 0, '默认 shared 为空（不共享）');
    const result = promotePointers({
      home, rootId: 'root-x', sessionId: 'session-dddd4444', fromStore: store,
      ids: [first.id], audit: (event, details) => audits.push({ event, details }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.promoted.length, 1);
    assert.ok(audits.some((row) => row.event === 'memory-promoted' && row.details.count === 1));
    const shared = openSharedMemory({ home, rootId: 'root-x' });
    assert.equal(shared.count(), 1, '只有显式 promote 的指针进 shared');
    assert.equal(shared.all()[0].title, '共享事实');
    assert.notEqual(shared.all()[0].id, first.id, 'shared 生成新 id');
    assert.equal(other.count(), 0, '另一个会话仍看不到（默认不共享）');
    void second;
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C38 ⑩：legacy 导入生成新 id 并审计 memory-imported；原 legacy 文件不被修改', async () => {
  const home = await tempDir('cg-c38-legacy-');
  const legacy = await tempDir('cg-c38-legacy-root-');
  try {
    const topics = path.join(legacy, 'topics');
    await fs.mkdir(topics, { recursive: true });
    const legacyFile = path.join(topics, 'fact.md');
    const legacyText = '# legacy\n\n<!-- entry:MEM-20261114-1005 -->\n### MEM-20261114-1005\n最后用户消息：继续\n';
    await fs.writeFile(legacyFile, legacyText, 'utf8');
    const before = await fs.readFile(legacyFile, 'utf8');
    const audits = [];
    const store = openSessionMemory({ home, sessionId: 'session-ffff6666' });
    const result = importLegacy({
      legacyDir: legacy, toStore: store, sessionId: 'session-ffff6666',
      audit: (event, details) => audits.push({ event, details }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.imported.length, 1);
    assert.match(result.imported[0], /^MEM-ffff6666-/);
    assert.ok(audits.some((row) => row.event === 'memory-imported' && row.details.from === 'legacy'));
    assert.equal(await fs.readFile(legacyFile, 'utf8'), before, 'legacy 正文不被修改');
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    await fs.rm(legacy, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C38 ⑪⑬：--from-role 找同 role+同 root 最近会话并复制；无源 → 报错 + memory-import-no-source', async () => {
  const home = await tempDir('cg-c38-role-');
  const work = await tempDir('cg-c38-role-body-');
  try {
    const file = await makeBody(work);
    const audits = [];
    const audit = (event, details) => audits.push({ event, details });
    // 源会话：role=dev、root=r1，登记一条指针。
    const source = openSessionMemory({ home, sessionId: 'session-1111aaaa', audit });
    source.append({ type: 'fact', title: 'dev 事实', target: `${file}:1`, summary: 'dev 事实' });
    source.setRole('dev');
    source.touchMeta({ rootId: 'root-r1' });
    // 目标会话（同 role+root）。
    const target = openSessionMemory({ home, sessionId: 'session-2222bbbb', audit });
    const result = importFromRole({
      home, role: 'dev', rootId: 'root-r1', sessionId: 'session-2222bbbb', toStore: target, audit,
    });
    assert.equal(result.ok, true);
    assert.equal(result.from, 'session-1111aaaa');
    assert.equal(target.count(), 1);
    const imported = target.all()[0];
    assert.match(imported.id, /^MEM-2222bbbb-/);
    assert.equal(imported.originSessionId, 'session-1111aaaa');
    assert.equal(imported.originRole, 'dev');
    assert.ok(audits.some((row) => row.event === 'memory-imported-role' && row.details.fromSessionId === 'session-1111aaaa'));
    // 原会话记忆不变。
    assert.equal(source.count(), 1);
    // 负向：无源会话 → 报错 + 审计。
    const lonely = openSessionMemory({ home, sessionId: 'session-3333cccc', audit });
    const missing = importFromRole({
      home, role: 'qa', rootId: 'root-r1', sessionId: 'session-3333cccc', toStore: lonely, audit,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'no-source-session');
    assert.ok(audits.some((row) => row.event === 'memory-import-no-source' && row.details.role === 'qa'));
    assert.equal(lonely.count(), 0, '默认不继承');
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
  }
});
