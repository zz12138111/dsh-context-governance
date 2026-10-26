/**
 * T7：S1–S6 验收场景（v0.1.5）。
 *
 * 每个用例一个场景脚本 + 明确通过判据；真实数据用 `test/fixtures/replay-compaction*.json`
 * （两份：自动压缩 18:41、手动压缩 00 会话，均由 `analysis/t7/extract-replay-fixture.mjs` 脱敏），
 * 其余场景用 `test/compress-helpers.mjs` 合成（可重复）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PLUGIN_VERSION } from '../src/diagnostics.js';
import { AUDIT_FIELD_WHITELIST } from '../src/audit.js';
import { apply, resolveConfig } from '../src/index.js';
import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { buildMemoryHeader, registerMemoryHeader } from '../src/memory/header.js';
import {
  FIVE_SECTION_SUMMARY,
  buildCompaction,
  healthyMessages,
} from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx({ withOn = true, onThrows = false, compaction = new BasicCompactionEngine() } = {}) {
  const handlers = [];
  const logs = [];
  const ctx = {
    handlers,
    logs,
    get(name) { return name === 'compaction' ? compaction : undefined; },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
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

function liveSession(built, id = 'session-t7') {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 20_000;
  const appended = [];
  const session = {
    id,
    appended,
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const event = { seq: nextSeq++, type, data, time: Date.now(), ...opts };
      bySeq.set(event.seq, event);
      if (type === 'user/message' && opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      appended.push(event);
      return event;
    },
  };
  return session;
}

function replaySession(fixture) {
  const bySeq = new Map();
  for (const event of fixture.preMessages) bySeq.set(event.seq, event);
  for (const event of fixture.events) bySeq.set(event.seq, event);
  const appended = [];
  let nextSeq = 30_000;
  const session = {
    id: fixture.sessionId,
    appended,
    surface: { nodes: [...fixture.preSurface] },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const event = { seq: nextSeq++, type, data, time: Date.now(), ...opts };
      bySeq.set(event.seq, event);
      if (type === 'user/message' && opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      appended.push(event);
      return event;
    },
  };
  return session;
}

const eventOf = (built, type) => built.events.find((item) => item.type === type);
const checkpointOf = (built) => built.events.find(
  (item) => item.type === 'user/message' && item.data.source.kind === 'compact-checkpoint',
);

function runCycle(ctx, session, built) {
  const handler = ctx.handlers[0].handler;
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointOf(built));
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function readAudit(store) {
  const file = path.join(store.rootDir, 'audit.jsonl');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function injectedOf(session) {
  return session.appended.filter((item) => item.data?.source?.kind === 'plugin:context-governance');
}

async function withStore(fn) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    await fn(store, rootDir);
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

/** 只含 ID/状态/指针、不含详情的回注行判据。 */
function pointerLines(text) {
  return text.split('\n').filter((line) => /^MEM-\d{8}-\d+/.test(line.trim()));
}

function queryAll(store, filter = {}) {
  return store.query(filter).entries;
}

function pointerIds(text) {
  return pointerLines(text)
    .map((line) => (line.trim().match(/^(MEM-\d{8}-\d+)/) ?? [])[1])
    .filter(Boolean);
}

test('S1 压缩后接续不重问：最新用户消息有指针且下一轮可见', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const summary = '本阶段把 T3/T4 做完了，下一步按计划继续。'; // 故意不含最新用户消息标题
    const built = buildCompaction({ before: healthyMessages(), summary, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();

    const [injected] = injectedOf(session);
    assert.ok(injected, 'S1 失败：没有回注消息');
    const text = injected.data.content.map((block) => block.text).join('\n');
    const latest = queryAll(store, { text: '继续', limit: 10 }).find((entry) => entry.title.includes('最新一条用户消息'));
    assert.ok(latest, 'S1 失败：最新用户消息没有进记忆');
    assert.ok(text.includes(latest.id), 'S1 失败：回注没有该指针');
    assert.ok(pointerLines(text).length >= 1, 'S1 失败：回注格式不是指针行');
    // 详情不回注：正文里的换行/长句不应出现
    assert.ok(text.includes('最新一条用户消息'), 'S1 失败：看不出最后一句');
    assert.ok(text.length <= 900, 'S1 失败：回注超预算');
    guard.stop();
  });
});

test('S2 批次进度接上：511/958 有指针、可按 ID 找回', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: '本阶段完成。', start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const batch = queryAll(store, { text: '511/958', limit: 10 });
    assert.ok(batch.length >= 1, 'S2 失败：批次条目没进记忆');
    const [injected] = injectedOf(session);
    const text = injected?.data.content.map((block) => block.text).join('\n') ?? '';
    assert.ok(text.includes(batch[0].id), 'S2 失败：回注没有批次指针');
    const found = queryAll(store, { ids: [batch[0].id] })[0];
    assert.match(found.title, /511\/958/);
    guard.stop();
  });
});

test('S3 新会话 header 带偏好（opt-in，仅第一步一次）', async () => {
  await withStore(async (store) => {
    await store.create({
      type: 'preference',
      title: '命名规则：插件包统一 dsh- 前缀',
      detail: '用户 2026-10-25 定的命名规则',
      writer: 'user',
      source: 'session:test#1',
    });
    const header = buildMemoryHeader(store);
    assert.ok(header, 'S3 失败：偏好没被读成 header');
    assert.match(header.text, /dsh- 前缀/);
    assert.ok(header.ids.length >= 1);

    const ctx = makeCtx();
    const registration = registerMemoryHeader(ctx, store, { enabled: true });
    assert.equal(registration.registered, true);
    const handler = ctx.handlers.find((item) => item.event === 'agent/pre-step').handler;
    const payload = { agent: { session: { id: 'session-new' } }, step: 1 };
    const base = { kind: 'accept', messages: [{ role: 'system', content: [] }] };
    const first = await handler(payload, async () => base);
    assert.equal(first.messages.length, 2, 'S3 失败：header 没插入');
    assert.match(first.messages[0].content[0].text, /dsh- 前缀/);
    assert.equal(first.messages[0].source.form, 'memory-header');
    const second = await handler(payload, async () => base);
    assert.equal(second.messages.length, 1, 'S3 失败：同一会话重复注入');
  });
});

test('S3b 默认开（M3 T2）：显式 enabled=false 时不留行为', async () => {
  assert.equal(resolveConfig({}).memoryHeader.enabled, true);
  await withStore(async (store) => {
    const ctx = makeCtx();
    const registration = registerMemoryHeader(ctx, store, { enabled: false });
    assert.equal(registration.registered, false);
    assert.equal(ctx.handlers.filter((item) => item.event === 'agent/pre-step').length, 0);
  });
});

test('S3c next() 返回 undefined：header 必须原样返回，不得 fabricate decision（M3 T0 实测）', async () => {
  await withStore(async (store) => {
    await store.create({
      type: 'preference',
      title: '命名规则：插件包统一 dsh- 前缀',
      detail: 'M3 T0 回归',
      writer: 'user',
      source: 'session:test#2',
    });
    const ctx = makeCtx();
    const registration = registerMemoryHeader(ctx, store, { enabled: true });
    assert.equal(registration.registered, true);
    const handler = ctx.handlers.find((item) => item.event === 'agent/pre-step').handler;
    const payload = { agent: { session: { id: 'session-undefined-decision' } }, step: 1 };
    // 宿主 next() 可能没有其它监听者→undefined；把它当对象展开会让宿主读 decision.kind 崩溃。
    const none = await handler(payload, async () => undefined);
    assert.equal(none, undefined, 'next() 返回 undefined 时必须原样返回');
    // 下一次拿到合法 decision 时仍能正常注入一次。
    const base = { kind: 'accept', messages: [] };
    const injected = await handler(payload, async () => base);
    assert.equal(injected.kind, 'accept');
    assert.equal(injected.messages.length, 1);
    assert.equal(injected.messages[0].source.form, 'memory-header');
  });
});

test('S4-A 自动压缩 5 类零丢失（可恢复、回注全 ID）', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    assert.equal(guard.status.lastReport.protection, 'ok', 'S4-A 失败：自动压缩保护有失败项');
    assert.equal(guard.status.lastReport.reinjected, true, 'S4-A 失败：回注字段应为 true');
    const [injected] = injectedOf(session);
    assert.ok(injected, 'S4-A 失败：没有回注');
    const text = injected.data.content.map((block) => block.text).join('\n');
    const ids = pointerIds(text);
    assert.ok(ids.length >= 3, `S4-A 失败：回注 ID 太少 (${ids.length})`);
    for (const id of ids) assert.ok(queryAll(store, { ids: [id] }).length === 1, `S4-A 失败：${id} 找回失败`);
    guard.stop();
  });
});

test('S4-M 手动压缩（真实样本）：latest/rule 重建后不再写 loss，指针可回', async () => {
  const fixture = JSON.parse(await fs.readFile(path.join(FIXTURES, 'replay-compaction-manual.json'), 'utf8'));
  assert.equal(fixture.meta.manual, true);
  assert.equal(fixture.meta.synthetic, false);
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const session = replaySession(fixture);
    const start = fixture.events.find((item) => item.type === 'compaction/start');
    const summary = fixture.events.find((item) => item.type === 'compaction/summary');
    const checkpoint = fixture.events.find((item) => item.type === 'user/message' && item.data?.source?.kind === 'compact-checkpoint');
    const end = fixture.events.find((item) => item.type === 'compaction/end');
    ctx.handlers[0].handler(session, start);
    ctx.handlers[0].handler(session, summary);
    ctx.handlers[0].handler(session, checkpoint);
    session.surface.nodes = [...fixture.preSurface, checkpoint.seq];
    ctx.handlers[0].handler(session, end);
    await flush();

    const audit = await readAudit(store);
    assert.ok(guard.status.lastReport !== null, 'S4-M 失败：报告缺失');
    assert.equal(audit.some((entry) => entry.event === 'compaction-loss'), false, 'latest/rule 重建后不得再写 loss');
    assert.equal(audit.some((entry) => entry.event === 'manual-compaction-loss'), false, '旧事件名不得新写');
    const [injected] = injectedOf(session);
    assert.ok(injected, 'S4-M 失败：没有回注');
    const text = injected.data.content.map((block) => block.text).join('\n');
    assert.match(text, /manual=true/, 'S4-M 失败：回注没标明手动');
    assert.ok(pointerLines(text).length >= 1, 'S4-M 失败：没有指针行');
    const ids = pointerIds(text);
    for (const id of ids) assert.ok(queryAll(store, { ids: [id] }).length === 1, `S4-M 失败：${id} 找不回`);
    guard.stop();
  });
});

test('S4-I 幂等：重复 start/end 不重复写/注', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const handler = ctx.handlers[0].handler;
    handler(session, eventOf(built, 'compaction/start'));
    handler(session, eventOf(built, 'compaction/summary'));
    handler(session, eventOf(built, 'compaction/end'));
    await flush();
    const audit = await readAudit(store);
    assert.ok(audit.some((entry) => entry.event === 'duplicate-cycle-start'), 'S4-I 失败：重复周期没有审计');
    assert.equal(injectedOf(session).length, 1, 'S4-I 失败：重复回注');
    guard.stop();
  });
});

test('S4-F 写不进/注不进：按阈值降级，下一周期暂停写入并尝试回注', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }),
      ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger, reinjection: { maxFailures: 1 },
    });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    session.append = () => { throw new Error('append rejected'); };
    runCycle(ctx, session, built);
    await flush();
    const audit = await readAudit(store);
    assert.ok(audit.some((entry) => entry.event === 'reinjection-failed'), 'S4-F 失败：缺 reinjection-failed');
    assert.ok(audit.some((entry) => entry.event === 'reinjection-degraded'), 'S4-F 失败：缺 reinjection-degraded');
    assert.equal(guard.mode, 'degraded-protection');
    const built2 = buildCompaction({ compactionId: 'cmp-2', startSeq: 200, summarySeq: 201, checkpointSeq: 202, endSeq: 203, before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session2 = liveSession(built2);
    runCycle(ctx, session2, built2);
    await flush();
    const audit2 = await readAudit(store);
    assert.ok(audit2.some((entry) => entry.event === 'protection-write-skipped' && entry.compactionId === 'cmp-2' && entry.reason === 'reinjection-suspended'), 'S4-F 失败：降级周期仍写新保护');
    assert.equal(session2.appended.length, 1, 'S4-F 失败：降级周期没有尝试回注');
    assert.ok(audit2.some((entry) => entry.event === 'reinjection-recovered'), 'S4-F 失败：未自愈');
    guard.stop();
  });
});

test('S4-AUD 审计只含白名单字段，不落正文/路径/数字标题', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.2', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const raw = await fs.readFile(path.join(store.rootDir, 'audit.jsonl'), 'utf8');
    for (const needle of ['最新一条用户消息', '继续。', '511/958', 'D:\\\\backup', 'pre-t3.zip']) {
      assert.equal(raw.includes(needle), false, `S4-AUD 失败：audit 含 ${needle}`);
    }
    for (const entry of await readAudit(store)) {
      for (const key of Object.keys(entry)) {
        const allowed = key === 'ts' || key === 'event' || Object.hasOwn(AUDIT_FIELD_WHITELIST, key);
        assert.ok(allowed, `S4-AUD 失败：未知字段 ${key}`);
      }
    }
    guard.stop();
  });
});

test('S4-R 崩溃恢复：journal 残留时重开 store 自动物化', async () => {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    store.protectSync({
      cycleKey: 'cycle-crash',
      sessionId: 'session-crash',
      items: [{
        type: 'progress', title: '崩溃前保护条目', detail: 'T7 S4-R', writer: 'system',
        source: 'session:session-crash#7', confidence: 1, evidence: '',
      }],
    });
    assert.equal(store.protectionPending, 1);
    await store.close();
    const reopened = await MemoryStore.open({ rootDir, project: 'test-project' });
    assert.equal(reopened.protectionPending, 0, 'S4-R 失败：journal 没有物化');
    assert.ok(queryAll(reopened, { text: '崩溃前保护条目' }).length === 1);
    await reopened.close();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test('S5 摘要不可读：只回注 ID+状态，不带标题', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const [injected] = injectedOf(session);
    assert.ok(injected, 'S5 失败：没有回注');
    const text = injected.data.content.map((block) => block.text).join('\n');
    assert.equal(pointerLines(text).length >= 1, true);
    assert.equal(text.includes('最新一条用户消息'), false, 'S5 失败：摘要不可读却带了标题');
    assert.equal(text.includes('批次'), false, 'S5 失败：摘要不可读却带了标题');
    const ids = pointerIds(text);
    for (const id of ids) assert.match(id, /^MEM-/);
    assert.equal(guard.status.lastReport.degraded, true);
    guard.stop();
  });
});

test('S6 后端不可用/配置非法：回退或插件不加载，DSH 正常', async () => {
  // (a) 配置非法：apply 直接拒绝，不注册任何东西
  const badCtx = makeCtx();
  await assert.rejects(() => apply(badCtx, { compression: 'yes' }), /compression must be an object/);
  assert.equal(badCtx.handlers.length, 0);
  // (b) provider 不可见：插件仍装载，走事件级
  const rootDir = await tempDir();
  const ctx = makeCtx({ compaction: null });
  try {
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.3', backendVersion: '' },
    });
    assert.equal(ctx.handlers.filter((item) => item.event === 'session/event').length, 1, 'P3：guard/early 共用 RootGuardPool 的唯一订阅');
    assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && message.includes('compaction service')));
  } finally {
    for (const entry of ctx.handlers) entry.handler = entry.handler; // no-op to keep refs
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test('S7 版本单一来源：PLUGIN_VERSION 等于 package.json，且源码不再手写版本', async () => {
  const pkg = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.equal(PLUGIN_VERSION, pkg.version);
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', 'src', 'diagnostics.js'), 'utf8');
  assert.equal(/PLUGIN_VERSION\s*=\s*['"]\d/.test(source), false, 'PLUGIN_VERSION 仍有手写字面量');
});

test('REQ-02 回注被吞：下一次压缩 shadow 掉回注 seq → reinjection-shadowed 审计', async () => {
  await withStore(async (store) => {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    const [injected] = injectedOf(session);
    assert.ok(injected, 'REQ-02 前置：本次没有回注');

    // 第二次压缩把上一次回注 seq 包含进 shadowedSeqs
    const built2 = buildCompaction({
      compactionId: 'cmp-shadow',
      startSeq: 300,
      summarySeq: 301,
      checkpointSeq: 302,
      endSeq: 303,
      before: healthyMessages(),
      summary: FIVE_SECTION_SUMMARY,
      start: 2,
      end: 11,
      shadowedSeqs: [injected.seq],
    });
    const session2 = liveSession(built2);
    const handler = ctx.handlers[0].handler;
    handler(session2, eventOf(built2, 'compaction/start'));
    handler(session2, eventOf(built2, 'compaction/summary'));
    await flush();
    const audit = await readAudit(store);
    const shadowed = audit.find((entry) => entry.event === 'reinjection-shadowed');
    assert.ok(shadowed, 'REQ-02 失败：缺 reinjection-shadowed 审计');
    assert.equal(shadowed.seq, injected.seq);
    assert.equal(shadowed.compactionId, 'cmp-shadow');
    assert.equal(guard.status.stats.reinjectionShadowed, 1);
    guard.stop();
  });
});
