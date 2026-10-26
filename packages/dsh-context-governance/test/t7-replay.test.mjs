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
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger });
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

test('T7-R2 fixture 已脱敏：递归所有字符串 + join 整串 都无 CJK/路径/会话 id/URL', async () => {
  const files = [FIXTURE, path.join(path.dirname(FIXTURE), 'replay-compaction-manual.json')];
  const { scanFixture, collectStrings, FORBIDDEN } = await import('../../../analysis/t7/scan-fixture.mjs');
  for (const file of files) {
    const result = scanFixture(file);
    assert.equal(result.violations.length, 0, `${path.basename(file)} 泄漏：\n${result.violations.join('\n')}`);
    assert.ok(result.strings > 0, `${path.basename(file)} 没有可扫描字符串`);

    const fixture = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(fixture.meta.note.includes('redacted'), true);
    assert.ok(Array.isArray(fixture.preMessages) && fixture.preMessages.length > 0);

    const strings = collectStrings(fixture).map((entry) => entry.value);
    const joined = strings.join('\n');
    const joinedTight = strings.join('');
    for (const [label, pattern] of FORBIDDEN) {
      if (label === 'long-token') continue; // 正常枚举值相连可能触发，单串层面已查
      assert.equal(pattern.test(joined), false, `${path.basename(file)} join 后出现 ${label}`);
      assert.equal(pattern.test(joinedTight), false, `${path.basename(file)} join-tight 后出现 ${label}`);
    }
    // 结构白名单：preMessages/events 里不允许出现带空白的“句子/命令/正文”（meta 说明除外）。
    for (const { trail, value } of collectStrings(fixture)) {
      if (!trail.startsWith('$.preMessages') && !trail.startsWith('$.events')) continue;
      assert.equal(/\s/.test(value), false, `${path.basename(file)} 结构字段里出现正文/命令：${trail} = ${value.slice(0, 60)}`);
    }
    // 审核点名的真实会话 id / 工作区路径不得出现（raw 文本复检）
    const raw = await fs.readFile(file, 'utf8');
    for (const needle of ['session-53ece2c2', '19091', 'DS-PROJECT', 'AGENTS.md']) {
      assert.equal(raw.includes(needle), false, `${path.basename(file)} leaks ${needle}`);
    }
  }
});
