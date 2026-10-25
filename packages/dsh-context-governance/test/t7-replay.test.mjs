/**
 * T7 回放：用**真实 session/event 序列**（脱敏 fixture）驱动 CompressionGuard。
 *
 * fixture 由 `analysis/t7/extract-replay-fixture.mjs` 从本机真实会话日志
 * （`session.v4.jsonl.zstd`，2026-10-25 18:41 的自动压缩）提取：保留 type/seq/time/
 * compactionId/shadowedRange/source.kind/usage，所有文本替换为 `[redacted:N]`。
 * 结论：不依赖新的真机压缩也能做回放验收。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { tempDir } from './helpers.mjs';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'replay-compaction.json');

async function loadFixture() {
  return JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
}

function makeCtx() {
  const handlers = [];
  const logs = [];
  return {
    handlers,
    logs,
    get: () => undefined,
    on(event, handler) {
      handlers.push({ event, handler });
      return () => {};
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
  };
}

function replaySession(fixture) {
  const bySeq = new Map();
  for (const event of fixture.preMessages) bySeq.set(event.seq, event);
  for (const event of fixture.events) bySeq.set(event.seq, event);
  const appended = [];
  let nextSeq = 10_000;
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

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('T7-R1 真实压缩回放：start/summary/checkpoint/end 全程无抛错，保护与审计落地', async () => {
  const fixture = await loadFixture();
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    const ctx = makeCtx();
    const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
    guard.start();
    const session = replaySession(fixture);
    const handler = ctx.handlers[0].handler;
    const start = fixture.events.find((event) => event.type === 'compaction/start');
    const summary = fixture.events.find((event) => event.type === 'compaction/summary');
    const checkpoint = fixture.events.find(
      (event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint',
    );
    const end = fixture.events.find((event) => event.type === 'compaction/end');
    assert.ok(start && summary && checkpoint && end, 'fixture must contain a full cycle');

    assert.doesNotThrow(() => {
      handler(session, start);
      handler(session, summary);
      handler(session, checkpoint);
      session.surface.nodes = [...fixture.preSurface, checkpoint.seq];
      handler(session, end);
    });
    await flush();

    const status = guard.status;
    assert.equal(status.stats.starts, 1);
    assert.equal(status.stats.summaries, 1);
    assert.equal(status.stats.ends, 1);
    assert.equal(status.stats.protectionWrites, 1);
    assert.ok(status.lastReport !== null, 'replay must produce a report');
    const injected = session.appended.filter((item) => item.data?.source?.kind === 'plugin:context-governance');
    assert.equal(injected.length, 1, 'replay must reinject pointers');
    const audit = (await fs.readFile(path.join(rootDir, 'audit.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(audit.some((entry) => entry.event === 'protection-write'));
    assert.ok(audit.some((entry) => entry.event === 'reinjection'));
    guard.stop();
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test('T7-R2 fixture 已脱敏：文本只剩 [redacted:N]，无原始消息内容', async () => {
  const fixture = await loadFixture();
  const raw = await fs.readFile(FIXTURE, 'utf8');
  assert.ok(raw.length > 0);
  assert.equal(raw.includes('"text": "'), true, 'redacted marker must be present');
  const allowed = /^\[redacted:\d+\]$/;
  const walk = (value, trail) => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${trail}[${index}]`)); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'text' && typeof child === 'string') assert.match(child, allowed, `unredacted text at ${trail}.text`);
      walk(child, `${trail}.${key}`);
    }
  };
  walk(fixture, 'fixture');
  assert.equal(fixture.meta.note.includes('redacted'), true);
  assert.ok(Array.isArray(fixture.preMessages) && fixture.preMessages.length > 0);
  for (const needle of ['DS-PROJECT', 'C:\\\\Users', '19091', 'AGENTS.md']) {
    assert.equal(raw.includes(needle), false, `fixture leaks ${needle}`);
  }
});
