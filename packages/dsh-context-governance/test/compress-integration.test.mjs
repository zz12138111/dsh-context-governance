import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { apply, resolveConfig } from '../src/index.js';
import { PLUGIN_VERSION } from '../src/diagnostics.js';
import { FIVE_SECTION_SUMMARY, FREE_FORM_SUMMARY, assistantText, buildCompaction, healthyMessages, systemPrompt, userMessage } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

const versionText = PLUGIN_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx(compaction, { withOn = true } = {}) {
  const handlers = [];
  const disposers = [];
  const registered = [];
  const warnings = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition.name) },
    logger: {
      info: () => {},
      warn: (...args) => warnings.push(args.join(' ')),
      error: () => {},
    },
    effect: (callback, _label) => { disposers.push(callback()); },
    handlers,
    registered,
    disposers,
    warnings,
  };
  if (withOn) {
    ctx.on = (event, handler) => {
      handlers.push({ event, handler });
      return () => {};
    };
  }
  ctx.get = (name) => (name === 'compaction' ? compaction : undefined);
  return ctx;
}

test('apply：注册工具 + 挂上压缩观察器 + dispose 释放记忆锁', async () => {
  const rootDir = await tempDir();
  const ctx = makeCtx(new BasicCompactionEngine());
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.2', backendVersion: '' },
    });
    assert.deepEqual(ctx.registered, ['mem_write', 'mem_query']);
    assert.equal(ctx.handlers.filter((item) => item.event === 'session/event').length, 2, 'guard + early wiring 各一个');

    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    ctx.handlers[0].handler(built.session, built.events.find((item) => item.type === 'compaction/start'));
    ctx.handlers[0].handler(built.session, built.events.find((item) => item.type === 'compaction/summary'));
    ctx.handlers[0].handler(built.session, built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'));
    built.session.surface.nodes = built.postSurface;
    ctx.handlers[0].handler(built.session, built.events.find((item) => item.type === 'compaction/end'));
    assert.equal(ctx.warnings.some((warning) => warning.includes('protection failed')), false);

    for (const dispose of ctx.disposers) await dispose();
    assert.equal(
      await fs.stat(path.join(rootDir, '.dsh', 'memory', '.writer.json')).then(() => true, () => false),
      false,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('0.1.13：batch 只有关键字、没有数字比例 → skip 且写 protection-skip 审计', async () => {
  const rootDir = await tempDir();
  const ctx = makeCtx(new BasicCompactionEngine());
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.2', backendVersion: '' },
    });
    const before = [
      systemPrompt(0),
      userMessage(1, '继续。'),
      userMessage(2, '批次进度：等用户确认。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ];
    const built = buildCompaction({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3 });
    const handler = ctx.handlers[0].handler;
    handler(built.session, built.events.find((item) => item.type === 'compaction/start'));
    handler(built.session, built.events.find((item) => item.type === 'compaction/summary'));
    handler(built.session, built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'));
    built.session.surface.nodes = built.postSurface;
    handler(built.session, built.events.find((item) => item.type === 'compaction/end'));

    const auditFile = path.join(rootDir, '.dsh', 'memory', 'audit.jsonl');
    const lines = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const skip = lines.find((entry) => entry.event === 'protection-skip');
    assert.ok(skip, 'protection-skip 审计缺失');
    assert.equal(skip.reason, 'no-ratio-in-user-messages');
    assert.ok(skip.names.includes('batch-list'));
    assert.equal(ctx.warnings.some((warning) => warning.includes('protection failed')), false);
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    // 回注 microtask 可能在 dispose 之后才落审计，重试删除以免 ENOTEMPTY 干扰断言。
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('0.1.14：无批次语义的比例 → protection-skip(no-batch-semantics)，不写 manual-compaction-loss', async () => {
  const rootDir = await tempDir();
  const ctx = makeCtx(new BasicCompactionEngine());
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.2', backendVersion: '' },
    });
    const before = [
      systemPrompt(0),
      userMessage(1, '继续。'),
      assistantText(2, '已收口：0 阻断 / 0 P2 / 6 P3，未 push。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ];
    const built = buildCompaction({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3, manual: true });
    const handler = ctx.handlers[0].handler;
    handler(built.session, built.events.find((item) => item.type === 'compaction/start'));
    handler(built.session, built.events.find((item) => item.type === 'compaction/summary'));
    handler(built.session, built.events.find((item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint'));
    built.session.surface.nodes = built.postSurface;
    handler(built.session, built.events.find((item) => item.type === 'compaction/end'));

    const auditFile = path.join(rootDir, '.dsh', 'memory', 'audit.jsonl');
    const lines = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.some((entry) => entry.event === 'manual-compaction-loss'), false, 'skip 不得升级为 manual-compaction-loss');
    const skip = lines.find((entry) => entry.event === 'protection-skip');
    assert.ok(skip, 'protection-skip 审计缺失');
    assert.equal(skip.reason, 'no-batch-semantics');
    assert.equal(skip.manual, true);
    assert.ok(skip.names.includes('batch-list'));
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('apply：compression.enabled=false 时不挂观察器', async () => {
  const rootDir = await tempDir();
  const ctx = makeCtx(new BasicCompactionEngine());
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: false, hostVersion: '', backendVersion: '' },
    });
    assert.equal(ctx.handlers.filter((item) => item.event === 'session/event').length, 0);
    assert.deepEqual(ctx.registered, ['mem_write', 'mem_query']);
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('apply：没有 ctx.on 时只告警，不影响工具与记忆库', async () => {
  const rootDir = await tempDir();
  const ctx = makeCtx(null, { withOn: false });
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.2', backendVersion: '' },
    });
    assert.deepEqual(ctx.registered, ['mem_write', 'mem_query']);
    assert.ok(ctx.warnings.some((warning) => warning.includes('ctx.on is unavailable')));
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('配置：compression 字段非法直接拒绝', () => {
  assert.throws(() => resolveConfig({ compression: 'yes' }), /compression must be an object/);
  assert.throws(() => resolveConfig({ compression: { enabled: 'yes' } }), /compression.enabled/);
  assert.throws(() => resolveConfig({ compression: { hostVersion: 1 } }), /hostVersion/);
  assert.throws(() => resolveConfig({ diagnostics: { logFile: 1 } }), /diagnostics.logFile/);
  const config = resolveConfig({ compression: { enabled: true, hostVersion: ' 0.2.1-rc.2 ', backendVersion: '' } });
  assert.equal(config.compression.hostVersion, '0.2.1-rc.2');
  assert.equal(config.compression.backendVersion, '');
});

test('配置：bundle patch 的本机 config 能解析到工作区路径', () => {
  const config = resolveConfig({
    projectRoot: 'D:/DS-PROJECT/DSH插件开发',
    memoryRoot: 'memory/governance',
    project: 'DSH插件开发',
    compression: { enabled: true, hostVersion: '', backendVersion: '' },
    diagnostics: { logFile: 'D:/DS-PROJECT/DSH插件开发/logs/governance.log' },
  });
  assert.equal(config.project, 'DSH插件开发');
  assert.equal(config.memoryRoot, path.resolve('D:/DS-PROJECT/DSH插件开发', 'memory', 'governance'));
  assert.equal(config.diagnostics.logFile, 'D:/DS-PROJECT/DSH插件开发/logs/governance.log');
});

test('apply：provider 不可见也一定执行，并写 warn + 诊断行（不静默）', async () => {
  const rootDir = await tempDir();
  const logFile = path.join(rootDir, 'logs', 'governance.log');
  const ctx = makeCtx(null);
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.3', backendVersion: '' },
      diagnostics: { logFile },
    });
    assert.deepEqual(ctx.registered, ['mem_write', 'mem_query']);
    assert.equal(ctx.handlers.filter((item) => item.event === 'session/event').length, 2, 'guard + early wiring 各一个');
    assert.ok(ctx.warnings.some((warning) => warning.includes('compaction service') && warning.includes('token="compaction"')));
    const text = await fs.readFile(logFile, 'utf8');
    assert.match(text, new RegExp(`governance capability@apply version=${versionText}`));
    assert.match(text, /probe=on=fn/);
    assert.match(text, new RegExp(`governance apply version=${versionText}`));
    assert.match(text, /adapter=none/);
    assert.match(text, /mode=event-level/);
    assert.match(text, /perception=event/);
    assert.match(text, /event-api=on/);
    assert.match(text, /audit=.*audit\.jsonl/);
    assert.match(text, /compaction-service=absent\(token=compaction\)/);
    assert.match(text, /warning=provider-unavailable/);
    assert.equal(text.includes('mem_write'), false);
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('diagnostics.logFile：写一行启动记录，含版本/adapter/mode，不含消息正文', async () => {
  const rootDir = await tempDir();
  const logFile = path.join(rootDir, 'logs', 'governance.log');
  const ctx = makeCtx(new BasicCompactionEngine());
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.2', backendVersion: '' },
      diagnostics: { logFile },
    });
    const text = await fs.readFile(logFile, 'utf8');
    assert.match(text, new RegExp(`governance apply version=${versionText}`));
    assert.match(text, /adapter=host-basic/);
    assert.match(text, /mode=full/);
    assert.match(text, /perception=event/);
    assert.match(text, /compaction-service=present\(token=compaction\)/);
    assert.equal(text.includes('mem_write'), false);
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('diagnostics.logFile 不可写：只告警，不阻断装载', async () => {
  const rootDir = await tempDir();
  const ctx = makeCtx(new BasicCompactionEngine());
  try {
    const blocker = path.join(rootDir, 'not-a-dir');
    await fs.writeFile(blocker, 'x', 'utf8');
    const logFile = path.join(blocker, 'governance.log');
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.2', backendVersion: '' },
      diagnostics: { logFile },
    });
    assert.deepEqual(ctx.registered, ['mem_write', 'mem_query']);
    assert.ok(ctx.warnings.some((warning) => warning.includes('diagnostics log is not writable')));
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

