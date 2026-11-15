/**
 * D：项目模板 `.cg-policy.json`（显式、可选、带 schema 版本；默认没有）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildPolicyState, resolveConfig } from '../src/index.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import { parseProjectTemplate, serializeProjectTemplate } from '../src/project-template.js';
import { tempDir } from './helpers.mjs';

test('D：项目模板格式——新格式带 version=1，旧扁平格式兼容，未知版本/坏 JSON 拒绝', () => {
  const versioned = parseProjectTemplate(JSON.stringify({ version: 1, values: { 'compact.at': 0.5 } }));
  assert.equal(versioned.ok, true);
  assert.equal(versioned.values['compact.at'], 0.5);
  const legacy = parseProjectTemplate(JSON.stringify({ 'compact.at': 0.5 }));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.version, 0);
  assert.equal(parseProjectTemplate(JSON.stringify({ version: 2, values: {} })).reason, 'unknown-version');
  assert.equal(parseProjectTemplate('{bad').reason, 'invalid-json');
  assert.equal(parseProjectTemplate('[]').reason, 'invalid-shape');
  const roundtrip = parseProjectTemplate(serializeProjectTemplate({ 'compact.at': 0.55 }));
  assert.equal(roundtrip.ok, true);
  assert.equal(roundtrip.values['compact.at'], 0.55);
});

test('D：项目层只在文件存在且显式写字段时生效；未知版本整层不生效', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/d-project' });
  const good = buildPolicyState(config, {
    readFile: () => JSON.stringify({ version: 1, values: { 'compact.at': 0.5 } }),
  });
  const resolved = good.resolve();
  assert.equal(resolved.values['compact.at'], 0.5);
  assert.equal(resolved.sources['compact.at'], 'project');
  const bad = buildPolicyState(config, {
    readFile: () => JSON.stringify({ version: 9, values: { 'compact.at': 0.5 } }),
  });
  const rejected = bad.resolve();
  assert.notEqual(rejected.sources['compact.at'], 'project', '未知版本不得生效');
  assert.equal(rejected.values['compact.at'], 0.6);
  assert.equal(bad.invalid.some((item) => item.reason === 'unknown-version'), true);
});

test('D：显式创建/清除项目模板——写 version=1、可读回、清除后回到无模板', async () => {
  const dir = await tempDir('cg-d-template-');
  try {
    const config = resolveConfig({ projectRoot: dir });
    const state = buildPolicyState(config);
    assert.equal(state.projectTemplate.exists(), false, '默认没有项目模板');
    const written = state.projectTemplate.write({ 'compact.at': 0.5 });
    assert.equal(written.ok, true);
    const file = path.join(dir, config.policy.projectFile);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.values['compact.at'], 0.5);
    // 新实例（重启）读回 → source=project。
    const reopened = buildPolicyState(resolveConfig({ projectRoot: dir }));
    const resolved = reopened.resolve();
    assert.equal(resolved.sources['compact.at'], 'project');
    assert.equal(resolved.values['compact.at'], 0.5);
    // 清除 → 文件消失、回落 plugin/builtin。
    assert.equal(reopened.projectTemplate.clear().ok, true);
    assert.equal(reopened.projectTemplate.exists(), false);
    const after = buildPolicyState(resolveConfig({ projectRoot: dir }));
    assert.notEqual(after.resolve().sources['compact.at'], 'project');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C37⑥：/cg 帮助可见项目模板创建/清除入口（不强制 client UI）', async () => {
  const expected = 'project-template [show|create compact.at=0.5|clear]';
  const command = createStatusCommand({});
  assert.ok(
    String(command.input?.hint ?? '').includes(expected),
    `input.hint 必须列出 ${expected}（用户可见的 help）`,
  );
  const unknown = await command.handler({ rawInput: 'no-such-subcommand' });
  assert.equal(unknown.kind, 'error');
  assert.ok(String(unknown.text).includes(expected), 'fallback usage 与 hint 同字面');
});
