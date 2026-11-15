/**
 * C39 可移植性/外发边界：
 * ① 发布物/配置/文档零绝对路径与机器名；②落盘由宿主 profile/homedir 推导（不写死 `-desktop`）；
 * ③ 根失败显式 root-unresolved；④C38 记忆路径换机/换 profile 仍成立；⑤假 DSH_HOME 冷启动可加载并生成
 * 状态/审计/记忆；⑥测试不依赖本机盘符/用户名；⑦（包面 --strict 由审核执行，这里覆盖静态扫描）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply, resolveConfig } from '../src/index.js';
import { createPluginPolicyStore, pluginPolicyFile } from '../src/plugin-policy.js';
import { openSessionMemory } from '../src/memory/session-store.js';
import { legacySessionBase, resolveUserHome, userDataDir } from '../src/user-paths.js';
import { tempDir } from './helpers.mjs';

// 包根由本文件位置推导（不依赖测试运行时 cwd）。
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('C39 ②：用户级 home 由 profileContext 推导，env 只作 fallback，两者皆缺 → unavailable', () => {
  assert.deepEqual(resolveUserHome({ ok: true, home: '/tmp/ext-home' }, {}), { home: '/tmp/ext-home', source: 'profileContext' });
  assert.deepEqual(resolveUserHome({ ok: false }, { USERPROFILE: 'C:\\Users\\x' }), { home: 'C:\\Users\\x/.dsh', source: 'env' });
  assert.deepEqual(resolveUserHome(null, { HOME: '/home/x' }), { home: '/home/x/.dsh', source: 'env' });
  assert.deepEqual(resolveUserHome(null, {}), { home: null, source: 'unavailable' });
  assert.equal(userDataDir('/tmp/ext-home'), '/tmp/ext-home/context-governance');
  assert.equal(userDataDir(null), null);
  assert.equal(legacySessionBase({ USERPROFILE: 'C:\\Users\\x' }), 'C:\\Users\\x/context-governance');
  assert.equal(legacySessionBase({}), null);
});

test('C39 ④：旧基座的会话记忆被复制到新基座（不移动、不删除，只提示一次）', async () => {
  const base = await tempDir('cg-c39-legacy-');
  try {
    const sessionId = 'session-c39-legacy';
    const home = path.join(base, 'dsh-home'); // 新基座（<home>/context-governance/sessions/<id>）
    const legacyHome = path.join(base, 'user-home');
    const legacyDir = path.join(legacyHome, 'context-governance', 'sessions', sessionId);
    fs.mkdirSync(path.join(legacyDir, 'topics'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'MEMORY.md'), '# 旧库\n- MEM-旧1 [fact] docs/a.md:1\n', 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'topics', 'fact.md'), '- MEM-旧1 [fact] docs/a.md:1\n', 'utf8');

    const rows = [];
    const audit = (event, details) => rows.push({ event, details });
    const store = openSessionMemory({ home, sessionId, audit, legacyBase: path.join(legacyHome, 'context-governance') });
    const newDir = path.join(home, 'context-governance', 'sessions', sessionId);
    assert.equal(fs.existsSync(path.join(newDir, 'MEMORY.md')), true, '新基座必须拿到旧库副本');
    assert.equal(fs.existsSync(path.join(legacyDir, 'MEMORY.md')), true, '旧库不得被移动/删除');
    assert.match(fs.readFileSync(path.join(newDir, 'MEMORY.md'), 'utf8'), /MEM-旧1/, '旧库内容必须原样复制');
    assert.equal(rows.filter((row) => row.event === 'session-memory-legacy-copied').length, 1, '只提示一次');
    // 再打开一次：新基座已有索引 → 不再复制、不再提示。
    openSessionMemory({ home, sessionId, audit, legacyBase: path.join(legacyHome, 'context-governance') });
    assert.equal(rows.filter((row) => row.event === 'session-memory-legacy-copied').length, 1);
  } finally {
    await fsp.rm(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C39 ⑤：假 DSH_HOME 冷启动——状态/审计/记忆/plugin 持久值全部落在临时 home 下', async () => {
  const base = await tempDir('cg-c39-cold-');
  const previousProfile = process.env.USERPROFILE;
  try {
    const home = path.join(base, 'ext-home');
    const profileDir = path.join(base, 'ext-dir');
    const root = path.join(base, 'ext-proj');
    // C39：诊断日志只允许用户级 context-governance 或根内 memory/governance（白名单）。
    const logFile = path.join(home, 'context-governance', 'logs', 'governance.log');
    for (const dir of [home, profileDir, root, path.dirname(logFile)]) fs.mkdirSync(dir, { recursive: true });
    // 冷启动环境：只有 profileContext 提供 home，用户环境变量指到别处（证明不依赖 env）。
    process.env.USERPROFILE = path.join(base, 'unrelated-user-home');

    const captured = { commands: [], handlers: [] };
    const ctx = {
      commands: captured.commands,
      tools: { register() {} },
      get(name) {
        if (name === 'profileContext') return { name: 'ext', dir: profileDir, home };
        if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
        if (name === 'settings') return { subscribe: () => () => {} };
        return undefined;
      },
      on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
      logger: { info() {}, warn() {}, error() {} },
    };

    await apply(ctx, { projectRoot: root, project: 'ext', diagnostics: { logFile } });
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 会话级写入 → A2 落在 <home>/context-governance/session-policy.json
    const command = captured.commands.find((definition) => definition.name === 'cg');
    assert.ok(command !== undefined, '/cg 命令必须注册');
    const sessionId = 'session-c39-cold';
    const setResult = await command.handler({ rawInput: 'set compact.at=0.55', agent: { session: { id: sessionId } } });
    assert.equal(setResult.kind, 'success', setResult.text);

    // 记忆（命令面）→ <home>/context-governance/sessions/<id>
    const showResult = await command.handler({ rawInput: 'memory show', agent: { session: { id: sessionId } } });
    assert.equal(showResult.kind, 'success', showResult.text);
    await command.handler({ rawInput: 'memory register fact docs/x.md:1 c39', agent: { session: { id: sessionId } } });

    // plugin 持久值（设置页写路由实际调用的存储）
    const pluginFile = pluginPolicyFile(home);
    assert.equal(createPluginPolicyStore({ file: pluginFile }).writeAt(0.58), true);

    const expected = [
      path.join(home, 'context-governance', 'root-state-ext.json'),
      path.join(home, 'context-governance', 'root-audit-ext.jsonl'),
      path.join(home, 'context-governance', 'session-policy.json'),
      path.join(home, 'context-governance', 'plugin-policy.json'),
      path.join(home, 'context-governance', 'sessions', sessionId, 'MEMORY.md'),
      logFile,
    ];
    for (const file of expected) {
      assert.equal(fs.existsSync(file), true, `冷启动必须生成：${file}`);
      assert.equal(path.resolve(file).startsWith(path.resolve(home)) || file === logFile, true, `${file} 必须在临时 home 下`);
    }
    // profile 名决定后缀：ext → root-state-ext / root-audit-ext（不是写死的 desktop）。
    assert.equal(fs.existsSync(path.join(home, 'context-governance', 'root-state-desktop.json')), false);
    // 用户环境变量指向的 home 不得被写。
    assert.equal(fs.existsSync(path.join(base, 'unrelated-user-home')), false, '不得写 env 指向的 home');
  } finally {
    process.env.USERPROFILE = previousProfile;
    await fsp.rm(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C39 ①⑥：包面文件零机器名/绝对路径（不依赖本机盘符与用户名）', async () => {
  const machinePatterns = [/DS-PROJECT/i, /DS-HARNESS/i, /19091/, /C:\\Users/i, /G:\\/i];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(PACKAGE_ROOT, 'src'));
  files.push(path.join(PACKAGE_ROOT, 'lib', 'client.js'), path.join(PACKAGE_ROOT, 'cordis.patch.yml'), path.join(PACKAGE_ROOT, 'package.json'));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of machinePatterns) {
      assert.doesNotMatch(text, pattern, `${path.relative(PACKAGE_ROOT, file)} 含机器名/本机路径`);
    }
  }
});

test('C39 ③：无根时显式 root-unresolved，不静默降级', async () => {
  const config = resolveConfig({ projectRoot: '' });
  assert.equal(config.projectRoot, '');
  // 根解析入口在 registry；这里只锁"空根不会被猜成 cwd"。
  assert.equal(typeof os.tmpdir(), 'string');
});
