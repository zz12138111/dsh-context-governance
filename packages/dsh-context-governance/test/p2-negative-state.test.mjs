/**
 * P2 / 块D：删状态重推（有/无 configRoot）、同根并发、双 store 只读、跨根并发。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';
import { MemoryStore } from '../src/memory/store.js';
import { rootIdOf } from '../src/roots/identity.js';
import { MEM_QUERY_NAME, MEM_WRITE_NAME, createMemoryTools } from '../src/tools/mem-tools.js';

async function tempDir(prefix = 'cg-p2-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRoot(parent, name) {
  const dir = path.join(parent, name);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, '.git'), 'gitdir: x\n');
  return dir;
}

function makeCtx(profile) {
  const registered = [];
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    commands: { register: (definition) => commands.push(definition) },
    get(name) {
      if (name === 'profileContext') return profile;
      if (name === 'commands') return ctx.commands;
      return undefined;
    },
    effect: (factory) => cleanups.push(factory),
    on: (event, cb) => {
      const entry = { event, cb };
      handlers.push(entry);
      return () => {
        const index = handlers.indexOf(entry);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
      error: (message) => logs.error.push(String(message)),
    },
  };
  return { ctx, registered, commands, handlers, cleanups, logs };
}

function fire(handlers, session) {
  for (const handler of handlers.slice()) {
    if (handler.event === 'session/event') handler.cb(session, { type: 'turn/end' });
  }
}

async function until(check, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function close(cleanups) {
  for (const factory of cleanups.splice(0).reverse()) {
    try {
      const cleanup = factory();
      if (typeof cleanup === 'function') await cleanup();
    } catch {
      /* ignore */
    }
  }
}

const execFor = (id, cwd) => ({ agent: { session: { id, header: { id, cwd }, cwd } } });
const tool = (registered, name) => registered.find((definition) => definition.name === name);

async function snapshot(root) {
  const dir = path.join(root, 'memory', 'governance');
  const files = [path.join(dir, 'MEMORY.md'), path.join(dir, 'audit.jsonl')];
  try {
    for (const name of await fs.readdir(path.join(dir, 'topics'))) {
      if (name.endsWith('.md')) files.push(path.join(dir, 'topics', name));
    }
  } catch {
    /* ignore */
  }
  const result = {};
  for (const file of [...new Set(files)].sort()) {
    const rel = path.relative(dir, file);
    try {
      const [data, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      result[rel] = { hash: createHash('sha256').update(data).digest('hex'), mtimeMs: stat.mtimeMs };
    } catch {
      result[rel] = null;
    }
  }
  return result;
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('P2/删状态（默认空根）：A 重推 inferred-fresh；A 旧记忆可读；B 文件 hash/mtime 不变', async () => {
  const base = await tempDir();
  const home = path.join(base, 'home');
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  const ctx1 = makeCtx(profile);
  try {
    await apply(ctx1.ctx, { compression: { enabled: false }, project: 'test' });
    fire(ctx1.handlers, { id: 'sA', header: { cwd: rootA } });
    assert.equal(await until(() => fs.stat(stateFile).then(() => true, () => false)
      && ctx1.registered.some((definition) => definition.name === MEM_WRITE_NAME)), true);
    const write = tool(ctx1.registered, MEM_WRITE_NAME);
    await write.execute({ op: 'create', type: 'fact', title: 'A-entry', writer: 'rule' }, execFor('sA', rootA));
    await write.execute({ op: 'create', type: 'fact', title: 'B-entry', writer: 'rule' }, execFor('sB', rootB));
    const aSnapshot = await snapshot(rootA);
    const bSnapshot = await snapshot(rootB);
    await close(ctx1.cleanups);
    await fs.rm(stateFile, { force: true });

    const ctx2 = makeCtx(profile);
    try {
      await apply(ctx2.ctx, { compression: { enabled: false }, project: 'test' });
      fire(ctx2.handlers, { id: 'sA2', header: { cwd: rootA } });
      assert.equal(await until(() => fs.stat(stateFile).then(() => true, () => false)), true, '应重新推断并落盘');
      const rootAudit = await readJsonl(path.join(home, 'context-governance', 'root-audit-prof.jsonl'));
      const fresh = [...rootAudit].reverse().find((entry) => entry.event === 'inferred-fresh');
      assert.ok(fresh, 'root audit 应有 inferred-fresh');
      assert.equal(fresh.inferredFromCwd, path.resolve(rootA));
      assert.equal(fresh.root, rootA);
      const status = await ctx2.commands.at(-1).handler({ rawInput: 'status' });
      assert.match(status.text, /^project-root: .*\(source=inferred, inferred-fresh\)$/m);
      assert.match(status.text, new RegExp(`id=${rootIdOf(rootA)}`, 'm'));
      const aText = await fs.readFile(path.join(rootA, 'memory', 'governance', 'MEMORY.md'), 'utf8');
      assert.match(aText, /A-entry/, 'A 旧记忆必须可读');
      assert.deepEqual(await snapshot(rootB), bSnapshot, 'B memory 的 hash/mtime 不得变');
    } finally {
      await close(ctx2.cleanups);
    }
  } finally {
    await close(ctx1.cleanups);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('P2/删状态（configRoot）：回落 configRoot、不重推', async () => {
  const base = await tempDir();
  const home = path.join(base, 'home');
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  const root = makeRoot(base, 'alpha');
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  const ctx1 = makeCtx(profile);
  try {
    await apply(ctx1.ctx, { projectRoot: root, compression: { enabled: false }, project: 'test' });
    await fs.writeFile(path.join(root, 'marker.txt'), 'x', 'utf8');
    await close(ctx1.cleanups);
    await fs.rm(stateFile, { force: true });

    const ctx2 = makeCtx(profile);
    try {
      await apply(ctx2.ctx, { projectRoot: root, compression: { enabled: false }, project: 'test' });
      const status = await ctx2.commands.at(-1).handler({ rawInput: 'status' });
      assert.match(status.text, /\(source=config\)/);
      const rootAudit = await readJsonl(path.join(home, 'context-governance', 'root-audit-prof.jsonl'));
      assert.equal(rootAudit.some((entry) => entry.event === 'inferred-fresh'), false, 'configRoot 下不得重推');
      assert.equal(fsSync.existsSync(path.join(root, 'marker.txt')), true);
    } finally {
      await close(ctx2.cleanups);
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('P2/并发：同根两会话串行不丢写；不同根并发；第二 store 只读/释放后可写', async () => {
  const base = await tempDir();
  const home = path.join(base, 'home');
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  const rootA = makeRoot(base, 'alpha');
  const rootB = makeRoot(base, 'beta');
  const ctx = makeCtx(profile);
  try {
    await apply(ctx.ctx, { projectRoot: rootA, compression: { enabled: false }, project: 'test' });
    const write = tool(ctx.registered, MEM_WRITE_NAME);
    const query = tool(ctx.registered, MEM_QUERY_NAME);
    await Promise.all([
      write.execute({ op: 'create', type: 'fact', title: 'A-1', writer: 'rule' }, execFor('sA1', rootA)),
      write.execute({ op: 'create', type: 'fact', title: 'A-2', writer: 'rule' }, execFor('sA2', rootA)),
      write.execute({ op: 'create', type: 'fact', title: 'B-1', writer: 'rule' }, execFor('sB', rootB)),
    ]);
    const textA = await fs.readFile(path.join(rootA, 'memory', 'governance', 'MEMORY.md'), 'utf8');
    assert.match(textA, /A-1/);
    assert.match(textA, /A-2/);
    const textB = await fs.readFile(path.join(rootB, 'memory', 'governance', 'MEMORY.md'), 'utf8');
    assert.match(textB, /B-1/);
    assert.equal(textA.includes('B-1'), false);

    const second = await MemoryStore.open({ rootDir: path.join(rootA, 'memory', 'governance'), project: 'test' });
    let secondTools = createMemoryTools(second);
    try {
      assert.match(second.status.readOnlyReason ?? '', /^writer-lock:/);
      await assert.rejects(
        secondTools[MEM_WRITE_NAME].definition.execute({ op: 'create', type: 'fact', title: 'blocked', writer: 'rule' }),
        /\[READ_ONLY\]/,
      );
      const readable = await secondTools[MEM_QUERY_NAME].definition.execute({});
      assert.ok(readable.count >= 1, '只读 store 仍可查询');
      await close(ctx.cleanups);
      await second.reload();
      secondTools = createMemoryTools(second);
      const written = await secondTools[MEM_WRITE_NAME].definition.execute({
        op: 'create', type: 'fact', title: 'after-lock-release', writer: 'rule',
      });
      assert.match(written.id, /^MEM-/);
    } finally {
      await second.close().catch(() => {});
    }
  } finally {
    await close(ctx.cleanups);
    await fs.rm(base, { recursive: true, force: true });
  }
});
