/**
 * 1.0 #8 安装契约：包内 0 绝对路径、logFile 只允许空/绝对、
 * projectRoot 空（D9=A）与 project 由根 basename 推导。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { appendDiagnosticLine } from '../src/diagnostics.js';
import { apply, resolveConfig } from '../src/index.js';
import { tempDir } from './helpers.mjs';

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('#8 logFile：空/相对路径不写文件（绝不 path.resolve 到进程 cwd）', async () => {
  const relative = 'cg-relative-diagnostics-test.log';
  const cwdFile = path.resolve(relative);
  await fs.rm(cwdFile, { force: true });
  assert.equal(appendDiagnosticLine('', 'line'), false);
  assert.equal(appendDiagnosticLine(relative, 'line'), false);
  assert.equal(appendDiagnosticLine('relative.log', 'line'), false);
  await assert.rejects(fs.access(cwdFile), '相对路径不得写到进程 cwd');

  const dir = await tempDir('cg-install-diag-');
  const absolute = path.join(dir, 'diag.log');
  try {
    assert.equal(appendDiagnosticLine(absolute, 'hello'), true);
    assert.match(await fs.readFile(absolute, 'utf8'), /hello/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('#8 resolveConfig：logFile 非空必须是绝对路径，相对直接 CONFIG 拒绝', async () => {
  assert.throws(
    () => resolveConfig({ diagnostics: { logFile: 'logs/governance.log' } }),
    (error) => error?.code === 'CONFIG' && /absolute/i.test(error.message),
  );
  assert.throws(
    () => resolveConfig({ diagnostics: { logFile: '..\\logs\\governance.log' } }),
    /absolute/i,
  );
  assert.equal(resolveConfig({ diagnostics: { logFile: '' } }).diagnostics.logFile, '');
  const absolute = path.resolve('C:/tmp/cg-diag.log');
  assert.equal(resolveConfig({ diagnostics: { logFile: `  ${absolute}  ` } }).diagnostics.logFile, absolute);
});

test('#8 包内 0 绝对路径；projectRoot/logFile/project 默认空、memoryRoot 相对', async () => {
  const patch = await fs.readFile(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8');
  const readme = await fs.readFile(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
  for (const [name, text] of [['cordis.patch.yml', patch], ['README.md', readme]]) {
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, `${name} 不得含盘符绝对路径`);
    assert.doesNotMatch(text, /DS-PROJECT/i, `${name} 不得含本机工作区路径`);
    assert.doesNotMatch(text, /Users[\\/]/, `${name} 不得含用户目录`);
  }
  assert.match(patch, /projectRoot:\s*""/);
  assert.match(patch, /project:\s*""/);
  assert.match(patch, /logFile:\s*""/);
  assert.match(patch, /memoryRoot:\s*"memory\/governance"/);
});

test('#8 D9=A：project 空 → 由显式根 basename 补；status memory 显示补出的 project', async () => {
  const root = await tempDir('cg-install-project-');
  const expected = path.basename(root);
  const config = resolveConfig({ projectRoot: root, project: '' });
  assert.equal(config.project, expected);
  try {
    const commands = [];
    const cleanups = [];
    const ctx = {
      tools: { register: () => {} },
      commands: { register: (definition) => commands.push(definition) },
      get: (name) => (name === 'commands' ? ctx.commands : undefined),
      effect: (factory) => cleanups.push(factory),
      on: () => () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    try {
      await apply(ctx, { projectRoot: root, compression: { enabled: false }, project: '' });
      assert.equal(commands.length, 1);
      const status = await commands[0].handler({ rawInput: 'status' });
      assert.match(status.text, new RegExp(`memory: project=${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      for (const factory of cleanups.reverse()) {
        try {
          const cleanup = factory();
          if (typeof cleanup === 'function') await cleanup();
        } catch { /* ignore */ }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
