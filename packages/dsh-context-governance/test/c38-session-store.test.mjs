/**
 * C38 ①：会话级记忆指针库（指针在插件、正文在文件；miss 不静默）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { openSessionMemory, renderMemoryHeader } from '../src/memory/session-store.js';
import { tempDir } from './helpers.mjs';

async function bodyFile(dir, lines) {
  const file = path.join(dir, 'BODY.md');
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

test('C38 ①：登记指针 → 可解析；重启保留；正文删除/行漂移标 miss 并审计', async () => {
  const home = await tempDir('cg-c38-home-');
  const work = await tempDir('cg-c38-body-');
  const audits = [];
  try {
    const file = await bodyFile(work, ['# 正文', '回滚点：D:\\backup\\a.zip', '结论：继续']);
    const store = openSessionMemory({ home, sessionId: 'session-aaaa1111', audit: (event, details) => audits.push({ event, details }) });
    const appended = store.append({ type: 'anchor', title: '回滚点', target: `${file}:2`, summary: 'pre-a' });
    assert.equal(appended.ok, true);
    assert.match(appended.id, /^MEM-aaaa1111-\d{8}-0001$/);
    const queried = store.query();
    assert.equal(queried.length, 1);
    assert.equal(queried[0].miss, false);

    // 重启：新实例读回同一指针。
    const reopened = openSessionMemory({ home, sessionId: 'session-aaaa1111', audit: (event, details) => audits.push({ event, details }) });
    assert.equal(reopened.count(), 1);
    assert.equal(reopened.query()[0].id, appended.id);

    // 行漂移：同一行内容变了 → miss(line-drift)+审计。
    await fs.writeFile(file, '# 正文\n回滚点：D:\\backup\\b.zip\n结论：继续\n', 'utf8');
    const drifted = reopened.query();
    assert.equal(drifted[0].miss, true);
    assert.equal(drifted[0].missReason, 'line-drift');
    assert.ok(audits.some((row) => row.event === 'memory-pointer-miss' && row.details.id === appended.id));

    // 正文删除 → miss(body-missing)。
    await fs.rm(file);
    const missing = reopened.query();
    assert.equal(missing[0].miss, true);
    assert.equal(missing[0].missReason, 'body-missing');
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C38 ①：id 会话隔离前缀 + 单调 + 子会话只读；登记不可解析正文只告警不阻塞', async () => {
  const home = await tempDir('cg-c38-id-');
  const work = await tempDir('cg-c38-body2-');
  try {
    const file = await bodyFile(work, ['line1', 'line2']);
    const store = openSessionMemory({ home, sessionId: 'session-bbbb2222' });
    const first = store.append({ title: 'a', target: `${file}:1`, summary: 'a' });
    const second = store.append({ title: 'b', target: `${file}:2`, summary: 'b' });
    assert.match(first.id, /^MEM-bbbb2222-/);
    assert.notEqual(first.id, second.id);
    assert.ok(Number(second.id.split('-').at(-1)) > Number(first.id.split('-').at(-1)));
    // 正文行不存在：登记成功但带 warning。
    const bad = store.append({ title: 'c', target: `${file}:99`, summary: 'c' });
    assert.equal(bad.ok, true);
    assert.equal(bad.warning, 'body-missing');
    // 子会话只读。
    const child = openSessionMemory({ home, sessionId: 'session-bbbb2222-child', subagent: true });
    assert.equal(child.append({ title: 'x', target: `${file}:1` }).reason, 'subagent-readonly');
    // 角色写死并可读回。
    assert.equal(store.setRole('dev').ok, true);
    assert.equal(store.meta().role, 'dev');
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C38 ④：header 只出短行、有上限、超限截断并审计，不复制正文', async () => {
  const home = await tempDir('cg-c38-header-');
  const work = await tempDir('cg-c38-header-body-');
  try {
    const file = path.join(work, 'BODY.md');
    await fs.writeFile(file, '第一行正文\n第二行正文\n第三行正文\n', 'utf8');
    const audits = [];
    const store = openSessionMemory({ home, sessionId: 'session-cccc3333' });
    store.append({ title: '第一条摘要', target: `${file}:1`, summary: '第一条摘要' });
    store.append({ title: '第二条摘要', target: `${file}:2`, summary: '第二条摘要' });
    store.append({ title: '第三条摘要', target: `${file}:3`, summary: '第三条摘要' });
    const header = renderMemoryHeader(store, { maxLines: 2, maxBytes: 4096, audit: (event, details) => audits.push({ event, details }) });
    assert.ok(header.text.includes('MEM-cccc3333-'));
    assert.ok(header.text.includes('已截断'));
    assert.equal(header.truncated, 1);
    assert.ok(audits.some((row) => row.event === 'header-truncated' && row.details.count === 1));
    assert.equal(header.text.includes('第一行正文'), false, 'header 不得复制正文');
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 });
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
  }
});
