/**
 * P2：真实双进程同根 writer-lock（child_process）。
 *
 * 父进程持锁 → 子进程只读、mem_write [READ_ONLY]、mem_query 可读；
 * 父进程关闭 → 子进程可写；父进程重新打开可读到子进程写入。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';

const execFileAsync = promisify(execFile);

const STORE_URL = new URL('../src/memory/store.js', import.meta.url).href;
const TOOLS_URL = new URL('../src/tools/mem-tools.js', import.meta.url).href;

const CHILD_SCRIPT = `
const { MemoryStore } = await import(process.env.MEM_STORE_URL);
const toolsMod = await import(process.env.MEM_TOOLS_URL);
const store = await MemoryStore.open({ rootDir: process.env.MEM_DIR, project: process.env.MEM_PROJECT });
const tools = toolsMod.createMemoryTools(store);
const out = {
  readOnlyReason: store.status.readOnlyReason,
  writable: store.status.writable,
};
try {
  if (process.env.MEM_MODE === 'write') {
    const written = await tools[toolsMod.MEM_WRITE_NAME].definition.execute({
      op: 'create', type: 'fact', title: process.env.MEM_TITLE, writer: 'rule',
    });
    out.id = written.id;
  } else {
    await tools[toolsMod.MEM_WRITE_NAME].definition.execute({
      op: 'create', type: 'fact', title: 'must-fail', writer: 'rule',
    });
  }
} catch (error) {
  out.writeError = String(error?.message ?? error);
}
const queried = await tools[toolsMod.MEM_QUERY_NAME].definition.execute({});
out.queryCount = queried.count;
out.titles = queried.entries.map((entry) => entry.title);
await store.close();
console.log(JSON.stringify(out));
`;

async function runChild({ memoryDir, project, mode, title }) {
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
    env: {
      ...process.env,
      MEM_STORE_URL: STORE_URL,
      MEM_TOOLS_URL: TOOLS_URL,
      MEM_DIR: memoryDir,
      MEM_PROJECT: project,
      MEM_MODE: mode,
      MEM_TITLE: title ?? '',
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
  const result = JSON.parse(lines.at(-1));
  return { ...result, stderr: String(stderr) };
}

test('P2 双进程：父持锁 → 子只读 [READ_ONLY]、查询可见；父释放后子可写，父重开可见', { timeout: 60_000 }, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-proc-lock-'));
  const memoryDir = path.join(base, 'memory', 'governance');
  const project = 'proc-test';
  const parent = await MemoryStore.open({ rootDir: memoryDir, project });
  try {
    await parent.create({ type: 'fact', title: 'parent-1', writer: 'rule', project });
    const childRead = await runChild({ memoryDir, project, mode: 'readonly' });
    assert.match(childRead.readOnlyReason ?? '', /^writer-lock:/, '子进程必须看到 writer-lock');
    assert.equal(childRead.writable, false);
    assert.match(childRead.writeError ?? '', /\[READ_ONLY\]/, '子进程写必须被拒绝');
    assert.equal(childRead.queryCount, 1, '只读子进程仍可查询父进程条目');
    assert.deepEqual(childRead.titles, ['parent-1']);

    await parent.close();
    const childWrite = await runChild({ memoryDir, project, mode: 'write', title: 'child-2' });
    assert.equal(childWrite.readOnlyReason, null, '父释放后子进程可写');
    assert.equal(childWrite.writable, true);
    assert.match(childWrite.id ?? '', /^MEM-/);
    assert.equal(childWrite.writeError, undefined);

    const reopened = await MemoryStore.open({ rootDir: memoryDir, project });
    try {
      const result = reopened.query({});
      assert.ok(result.count >= 2, '父重开应看到 parent-1 + child-2');
      assert.ok(result.entries.some((entry) => entry.title === 'parent-1'));
      assert.ok(result.entries.some((entry) => entry.title === 'child-2'));
    } finally {
      await reopened.close();
    }
  } finally {
    await parent.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true });
  }
});
