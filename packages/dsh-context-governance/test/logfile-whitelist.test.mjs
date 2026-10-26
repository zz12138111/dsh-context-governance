/**
 * v3：logFile 两处白名单（用户级 / 该根 memory/governance）与旧路径拒载。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';

async function tempDir(prefix = 'cg-logfile-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeCtx(profile) {
  const registered = [];
  const commands = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  const ctx = {
    tools: { register: (definition) => registered.push(definition.name) },
    commands: { register: (definition) => commands.push(definition) },
    get(name) {
      if (name === 'profileContext') return profile;
      if (name === 'commands') return ctx.commands;
      return undefined;
    },
    effect: (factory) => cleanups.push(factory),
    on: () => () => {},
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
      error: (message) => logs.error.push(String(message)),
    },
  };
  return { ctx, registered, commands, cleanups, logs };
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

async function fixture() {
  const base = await tempDir();
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  return { base, home, repo, profile };
}

test('v3 logFile：根内 logs/ 旧路径 CONFIG 拒绝、插件不加载、旧文件不动', async () => {
  const { base, home, repo, profile } = await fixture();
  const oldLog = path.join(repo, 'logs', 'governance.log');
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, 'OLD-CONTENT\n');
  const before = fs.statSync(oldLog);
  const beforeText = fs.readFileSync(oldLog, 'utf8');
  const { ctx, registered, commands, cleanups, logs } = makeCtx(profile);
  try {
    await apply(ctx, {
      projectRoot: repo,
      project: 'test',
      compression: { enabled: false },
      diagnostics: { logFile: oldLog },
    });
    assert.deepEqual(registered, [], '白名单外 logFile → 插件不加载该 profile');
    assert.equal(commands.length, 0);
    assert.equal(fs.readFileSync(oldLog, 'utf8'), beforeText, '旧文件内容不得变化');
    assert.equal(fs.statSync(oldLog).mtimeMs, before.mtimeMs, '旧文件 mtime 不得变化');
    await assert.rejects(fs.promises.access(path.join(repo, 'memory')), '不得创建记忆目录');
    await assert.rejects(fs.promises.access(path.join(home, 'context-governance', 'root-audit-prof.jsonl')));
    assert.ok(logs.error.some((line) => line.includes('log-file-outside-whitelist')));
  } finally {
    await closeContext(cleanups);
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});

test('v3 logFile：迁移到用户级后成功装载、文件创建、status 路径正确', async () => {
  const { base, home, repo, profile } = await fixture();
  const logFile = path.join(home, 'context-governance', 'logs', 'governance.log');
  const { ctx, registered, commands, cleanups } = makeCtx(profile);
  try {
    await apply(ctx, {
      projectRoot: repo,
      project: 'test',
      compression: { enabled: false },
      diagnostics: { logFile },
    });
    assert.deepEqual(registered, ['mem_write', 'mem_query']);
    const text = fs.readFileSync(logFile, 'utf8');
    assert.match(text, /governance apply/);
    const status = await commands.at(-1).handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(`^diagnostics: file=${logFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  } finally {
    await closeContext(cleanups);
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});

test('v3 logFile：该根 memory/governance 内允许；根外绝对路径拒绝；未配置默认用户级', async () => {
  const { base, home, repo, profile } = await fixture();
  try {
    const inside = makeCtx(profile);
    await apply(inside.ctx, {
      projectRoot: repo,
      project: 'test',
      compression: { enabled: false },
      diagnostics: { logFile: path.join(repo, 'memory', 'governance', 'diag.log') },
    });
    assert.deepEqual(inside.registered, ['mem_write', 'mem_query']);
    assert.ok(fs.existsSync(path.join(repo, 'memory', 'governance', 'diag.log')));
    await closeContext(inside.cleanups);

    const outside = makeCtx(profile);
    await apply(outside.ctx, {
      projectRoot: repo,
      project: 'test',
      compression: { enabled: false },
      diagnostics: { logFile: path.join(base, 'outside.log') },
    });
    assert.deepEqual(outside.registered, []);
    assert.equal(fs.existsSync(path.join(base, 'outside.log')), false);
    await closeContext(outside.cleanups);

    const defaulted = makeCtx(profile);
    await apply(defaulted.ctx, { projectRoot: repo, project: 'test', compression: { enabled: false } });
    const defaultLog = path.join(home, 'context-governance', 'logs', 'governance.log');
    assert.ok(fs.existsSync(defaultLog), '未配置时应默认用户级 logs/governance.log');
    const status = await defaulted.commands.at(-1).handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(`^diagnostics: file=${defaultLog.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    await closeContext(defaulted.cleanups);
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true });
  }
});
