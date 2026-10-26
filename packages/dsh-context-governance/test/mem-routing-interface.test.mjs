/**
 * P1 / T14：mem_* 根路由接口（resolver 拒绝 unmanaged/no-root；子会话只读）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';
import { MEM_QUERY_NAME, MEM_WRITE_NAME, createMemoryTools } from '../src/tools/mem-tools.js';

function makeStore() {
  return {
    calls: [],
    query(filter) {
      this.calls.push(['query', filter]);
      return { count: 0, entries: [] };
    },
    async create(args) {
      this.calls.push(['create', args]);
      return { id: 'MEM-20261026-1001', status: 'proposed', type: 'fact', title: String(args.title ?? '') };
    },
  };
}

function makeAudit() {
  return { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
}

const execFor = (id, header = {}) => ({ agent: { session: { id, header } } });

test('P1/T14 resolver 收到 exec；NO_ROOT 拒绝 mem_query 并写 memory-tool-rejected', async () => {
  const store = makeStore();
  const audit = makeAudit();
  const seen = [];
  const tools = createMemoryTools(store, {
    resolveStore: (exec) => {
      seen.push(exec);
      return { ok: false, code: 'NO_ROOT', message: 'no project root for this session' };
    },
    audit,
  });
  const exec = execFor('session-no-root');
  await assert.rejects(tools[MEM_QUERY_NAME].definition.execute({}, exec), /\[NO_ROOT\]/);
  assert.equal(seen[0], exec, 'resolver 必须收到原始 exec');
  assert.equal(store.calls.length, 0, '拒绝时不得查询 store');
  const rejected = audit.entries.at(-1);
  assert.equal(rejected.event, 'memory-tool-rejected');
  assert.equal(rejected.tool, MEM_QUERY_NAME);
  assert.equal(rejected.code, 'NO_ROOT');
});

test('P1/T14 unmanaged 根拒绝 mem_write（ROOT_UNMANAGED）', async () => {
  const store = makeStore();
  const audit = makeAudit();
  const tools = createMemoryTools(store, {
    resolveStore: () => ({ ok: false, code: 'ROOT_UNMANAGED', message: 'registered but not managed in P1', reason: 'unmanaged-root' }),
    audit,
  });
  await assert.rejects(
    tools[MEM_WRITE_NAME].definition.execute({ op: 'create', type: 'fact', title: 't', writer: 'model', confidence: 0.5 }, execFor('s1')),
    /\[ROOT_UNMANAGED\]/,
  );
  assert.equal(store.calls.length, 0);
  assert.equal(audit.entries.at(-1).code, 'ROOT_UNMANAGED');
});

test('P1/T14 子会话：mem_write 拒绝且不调 resolver；mem_query 允许只读', async () => {
  const store = makeStore();
  const audit = makeAudit();
  let resolveCalls = 0;
  const tools = createMemoryTools(store, {
    resolveStore: () => { resolveCalls += 1; return { ok: true, store, entry: null }; },
    audit,
  });
  const subagent = execFor('session-sub', { origin: 'subagent', parentSession: 'session-parent' });
  await assert.rejects(
    tools[MEM_WRITE_NAME].definition.execute({ op: 'create', type: 'fact', title: 't' }, subagent),
    /\[SUBAGENT_NO_MEMORY_WRITE\]/,
  );
  assert.equal(resolveCalls, 0, '子会话写拒绝应早于根路由');
  const rejected = audit.entries.at(-1);
  assert.equal(rejected.event, 'memory-tool-rejected');
  assert.equal(rejected.subagent, true);
  assert.equal(rejected.reason, 'subagent');

  const result = await tools[MEM_QUERY_NAME].definition.execute({}, subagent);
  assert.equal(result.count, 0);
  assert.equal(resolveCalls, 1, '子会话读允许进入 resolver');
});

test('P1/T14 默认单 store 行为不变（无 resolver 时）', async () => {
  const store = makeStore();
  const tools = createMemoryTools(store);
  const result = await tools[MEM_QUERY_NAME].definition.execute({ text: 'x' });
  assert.equal(result.count, 0);
  const created = await tools[MEM_WRITE_NAME].definition.execute({ op: 'create', type: 'fact', title: 't' });
  assert.equal(created.id, 'MEM-20261026-1001');
  assert.equal(store.calls.length, 2);
});

test('P1/T14 apply 接线：非主根/无根会话 mem_* 拒绝，主根会话放行', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-mem-apply-'));
  const home = path.join(base, 'home');
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  const primary = path.join(base, 'primary');
  const other = path.join(base, 'other');
  await fs.mkdir(path.join(primary, '.git'), { recursive: true });
  await fs.mkdir(path.join(other, '.git'), { recursive: true });
  const registered = [];
  const cleanups = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    commands: { register: () => {} },
    get(name) {
      if (name === 'profileContext') return profile;
      if (name === 'commands') return ctx.commands;
      return undefined;
    },
    effect: (factory) => cleanups.push(factory),
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  try {
    await apply(ctx, { projectRoot: primary, compression: { enabled: false }, project: 'test' });
    const query = registered.find((definition) => definition.name === MEM_QUERY_NAME);
    assert.ok(query, 'mem_query 应注册');
    const write = registered.find((definition) => definition.name === MEM_WRITE_NAME);
    const exec = (header) => ({ agent: { session: { id: header.id ?? 's', header } } });

    await assert.rejects(query.execute({}, exec({ id: 's-other', cwd: other })), /\[ROOT_UNMANAGED\]/);
    const noRoot = path.join(base, 'nogit');
    await fs.mkdir(noRoot, { recursive: true });
    await assert.rejects(query.execute({}, exec({ id: 's-noroot', cwd: noRoot })), /\[NO_ROOT\]/);
    const own = await query.execute({}, exec({ id: 's-own', cwd: primary }));
    assert.equal(own.count, 0);
    await assert.rejects(
      write.execute({ op: 'create', type: 'fact', title: 't' }, exec({ id: 's-sub', origin: 'subagent', parentSession: 's-own' })),
      /\[SUBAGENT_NO_MEMORY_WRITE\]/,
    );
  } finally {
    for (const factory of cleanups.splice(0).reverse()) {
      try {
        const cleanup = factory();
        if (typeof cleanup === 'function') await cleanup();
      } catch {
        /* ignore */
      }
    }
    await fs.rm(base, { recursive: true, force: true });
  }
});
