/**
 * v0.1.3：能力探测 + 感知层级不再"假报"。
 *
 * 背景：0.1.2 在 provider 不可见时日志写 `perception=none`，但 `mode=event-level`；
 * 00 需要确认事件面（`ctx.on('session/event')`）到底可不可订。这里固化三条契约：
 * 1. 能力探测只记类型、不记值；
 * 2. 只有订阅真的挂上才允许声称 `perception=event`；
 * 3. 审计文件在 apply 时就建出来并留 `apply` 记录。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';
import { probeCapability, formatCapability, describeValue } from '../src/capabilities.js';
import { CompressionGuard } from '../src/compress/runtime.js';
import { capabilityLine, startupLine } from '../src/diagnostics.js';
import { tempDir } from './helpers.mjs';

function fakeCtx({ withOn = true, onThrows = false, extra = {} } = {}) {
  const handlers = [];
  const warnings = [];
  const ctx = {
    tools: { register: () => {} },
    logger: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: () => {} },
    effect: (callback) => { callback(); },
    get: (name) => (name === 'tools' ? { register: () => {} } : undefined),
    handlers,
    warnings,
    ...extra,
  };
  if (withOn) {
    ctx.on = (event, handler) => {
      if (onThrows) throw new Error('events service unavailable');
      handlers.push({ event, handler });
      return () => {};
    };
  }
  return ctx;
}

test('能力探测：只记类型，不泄漏任何值/内容', () => {
  const secretId = 'SECRET-session-4f2a';
  const secretPath = 'C:\\Users\\SECRET-PATH\\workspace';
  const capability = probeCapability({
    on: () => {},
    events: { dispatch: () => {} },
    session: secretId,
    workspace: { root: secretPath },
    get: (name) => (name === 'sessions' ? { list: () => [] } : undefined),
    root: undefined,
  });
  const text = formatCapability(capability.entries);
  assert.equal(text.includes(secretId), false, 'session id leaked into capability dump');
  assert.equal(text.includes('SECRET-PATH'), false, 'path leaked into capability dump');
  assert.match(text, /on=fn/);
  assert.match(text, /events=obj\(dispatch=fn\)/);
  assert.match(text, /session=string/);
  assert.match(text, /workspace=obj/);
  assert.match(text, /get\.sessions=obj/);
  assert.equal(capability.eventApi, true);
});

test('能力探测：单个探测点抛错只记 throws，不影响其它探测', () => {
  const ctx = {
    get on() { throw new Error('boom'); },
    events: {},
    get: () => ({ ok: true }),
  };
  const capability = probeCapability(ctx);
  const text = formatCapability(capability.entries);
  assert.match(text, /on=throws/);
  assert.match(text, /events=obj/);
  assert.equal(capability.eventApi, false);
});

test('describeValue：不加内容、不深挖对象', () => {
  assert.equal(describeValue(undefined), 'absent');
  assert.equal(describeValue(null), 'absent');
  assert.equal(describeValue('abc'), 'string');
  assert.equal(describeValue(5), 'number');
  assert.equal(describeValue(() => {}), 'fn');
  assert.equal(describeValue({ secret: 'x' }), 'obj');
});

test('能力探测行：单行、含版本与 probe 字段', () => {
  const line = capabilityLine([['on', 'fn'], ['get.sessions', 'absent']]);
  assert.equal(line.includes('\n'), false);
  assert.match(line, / governance capability version=0\.1\.3 /);
  assert.match(line, /probe=on=fn,get\.sessions=absent$/);
});

test('无事件订阅能力：perception=none，不得声称 event-level', async () => {
  const rootDir = await tempDir();
  const logFile = path.join(rootDir, 'logs', 'governance.log');
  const ctx = fakeCtx({ withOn: false });
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.3', backendVersion: '' },
      diagnostics: { logFile },
    });
    const text = await fs.readFile(logFile, 'utf8');
    assert.match(text, /mode=observe-only/);
    assert.match(text, /perception=none/);
    assert.match(text, /event-api=off/);
    assert.equal(/mode=event-level/.test(text), false, 'event-level must not be claimed without a subscription');
    assert.ok(ctx.warnings.some((warning) => warning.includes('perception=none')));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('订阅抛错：guard 不崩，perception 退回契约值', () => {
  const ctx = fakeCtx({ onThrows: true });
  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  assert.equal(guard.status.started, false);
  assert.equal(guard.perception, 'none');
  assert.ok(ctx.warnings.some((warning) => warning.includes('registration failed')));
});

test('订阅成功：perception=event，session/event 计数可见', () => {
  const ctx = fakeCtx();
  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  assert.equal(guard.perception, 'event');
  assert.equal(guard.status.perception, 'event');
  const handler = ctx.handlers[0].handler;
  handler({ id: 's1' }, { type: 'user/message', data: {} });
  handler({ id: 's1' }, { type: 'assistant/message', data: {} });
  assert.equal(guard.status.stats.events, 2);
  guard.stop();
  assert.equal(guard.perception, 'none');
});

test('apply：审计文件在装载时就存在，并留 apply 记录（不含正文）', async () => {
  const rootDir = await tempDir();
  const ctx = fakeCtx();
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.3', backendVersion: '' },
    });
    const auditFile = path.join(rootDir, '.dsh', 'memory', 'audit.jsonl');
    const text = await fs.readFile(auditFile, 'utf8');
    const first = JSON.parse(text.trim().split('\n')[0]);
    assert.equal(first.event, 'apply');
    assert.equal(first.version, '0.1.3');
    assert.equal(first.mode, 'event-level');
    assert.equal(first.perception, 'event');
    assert.equal(first.eventApi, true);
    assert.equal(text.includes('mem_write'), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('startupLine：稳定字段顺序，event-api 与 audit 只在需要时出现', () => {
  const line = startupLine({
    adapterKind: 'none',
    mode: 'event-level',
    hostVersion: '0.2.1-rc.3',
    backendVersion: 'unknown',
    memoryRoot: 'D:\\x',
    compactionService: 'absent',
    perception: 'event',
    eventApi: 'on',
    auditFile: 'D:\\x\\audit.jsonl',
    warning: 'provider-unavailable',
  });
  assert.match(
    line,
    /adapter=none mode=event-level host=0\.2\.1-rc\.3 backend=unknown compaction-service=absent\(token=compaction\) perception=event event-api=on audit=D:\\x\\audit\.jsonl memory=D:\\x warning=provider-unavailable$/,
  );
  const bare = startupLine({ perception: 'none', eventApi: 'off' });
  assert.equal(bare.includes('audit='), false);
});
