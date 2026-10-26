/**
 * P1 / T9–T11：containment 集成（apply 级 fail-closed + 不建目录/不写记忆）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';
import { tempDir } from './helpers.mjs';

function makeApplyContext({ profile, commands, handlers, cleanups }) {
  const logs = { info: [], warn: [], error: [] };
  const ctx = {
    tools: { register: () => {} },
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
  return { ctx, logs };
}

async function closeContext(cleanups) {
  for (const factory of cleanups.splice(0).reverse()) {
    try {
      const cleanup = factory();
      if (typeof cleanup === 'function') await cleanup();
    } catch {
      /* ignore */
    }
  }
}

async function runFailClosed({ memoryRoot, rootDir, profile, base }) {
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const { ctx } = makeApplyContext({ profile, commands, handlers, cleanups });
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      memoryRoot,
      compression: { enabled: false },
      project: 'test-project',
    });
    const status = await commands.at(-1).handler({ rawInput: 'status' });
    return { status, commands, base };
  } finally {
    await closeContext(cleanups);
  }
}

test('P1/T9 apply：memoryRoot 非固定值 → 该根 fail-closed、不建 store、status 明示', async () => {
  const base = await tempDir('cg-containment-');
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  try {
    const { status } = await runFailClosed({ memoryRoot: 'memory/other', rootDir: repo, profile, base });
    assert.match(status.text, /^project-root: .*\(fail-closed: memory-root-not-fixed\)$/m);
    await assert.rejects(fs.access(path.join(repo, 'memory', 'other')));
    await assert.rejects(fs.access(path.join(repo, 'memory', 'governance')));
    await assert.rejects(fs.access(path.join(repo, '.dsh')), '默认目录不得回退创建');
    const rootAudit = await fs.readFile(path.join(home, 'context-governance', 'root-audit-prof.jsonl'), 'utf8');
    assert.match(rootAudit, /root-fail-closed/);
    const state = JSON.parse(await fs.readFile(path.join(home, 'context-governance', 'root-state-prof.json'), 'utf8'));
    const entry = Object.values(state.roots).find((item) => item.root === path.resolve(repo));
    assert.equal(entry.state, 'fail-closed');
    assert.equal(entry.failClosedReason, 'memory-root-not-fixed');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('P1/T10 apply：memoryRoot 绝对路径 / 逃出根 → fail-closed（不清洗、不回退）', async () => {
  const base = await tempDir('cg-containment-abs-');
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  try {
    for (const [memoryRoot, reason] of [
      [path.join(base, 'absolute-memory'), 'memory-root-absolute'],
      ['..\\escape', 'memory-root-escape'],
    ]) {
      const { status } = await runFailClosed({ memoryRoot, rootDir: repo, profile, base });
      assert.match(status.text, new RegExp(`\\(fail-closed: ${reason}\\)`));
      await assert.rejects(fs.access(path.join(repo, 'memory')));
      await assert.rejects(fs.access(path.join(base, 'escape')));
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
