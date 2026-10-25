/**
 * REQ-20261025-06 / 0.1.15：事件形态推断（inferred）与"功能不读推断"证明。
 *
 * 四类：free-form → host-basic(inferred)；five-section → context-zip(inferred)；
 * 都不像 → unknown；同组出现两种 → mixed(unverified)。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CompressionGuard } from '../src/compress/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import {
  detectAdapter,
  inferBackendFromStyles,
  withInference,
} from '../src/compress/adapters.js';
import { selectMode } from '../src/compress/selection.js';
import { FIVE_SECTION_SUMMARY, FREE_FORM_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

const noneAdapter = () => detectAdapter({ compaction: null, hostVersion: '0.2.1-rc.3' });

function makeCtx() {
  const handlers = [];
  const ctx = {
    handlers,
    get(name) {
      if (name !== 'tokenMeter') return undefined;
      return {
        measure(session) {
          const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
          return { nodes: nodes.map((seq) => ({ seq, tokens: 5 })) };
        },
      };
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (event, handler) => {
      handlers.push(handler);
      return () => {};
    },
  };
  return ctx;
}

function liveSession(built) {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 40_000;
  const session = {
    id: 'session-m13',
    appended: [],
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt: (seq) => bySeq.get(seq),
    append(type, data, opts) {
      const event = { seq: nextSeq += 1, type, data, time: Date.now(), ...opts };
      bySeq.set(event.seq, event);
      if (type === 'user/message' && opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      session.appended.push(event);
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
  const handler = ctx.handlers[0];
  handler(session, eventOf(built, 'compaction/start'));
  handler(session, eventOf(built, 'compaction/summary'));
  handler(session, checkpointOf(built));
  session.surface.nodes = [...built.postSurface];
  handler(session, eventOf(built, 'compaction/end'));
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function withStore(fn) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    return await fn(store, rootDir);
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}

async function readAudit(rootDir) {
  const text = await fs.readFile(path.join(rootDir, 'audit.jsonl'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function guardWith(store, adapter) {
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    ctx,
    hostVersion: '0.2.1-rc.3',
    store,
    logger: ctx.logger,
    project: 'native-test',
    adapter,
  });
  guard.start();
  return { ctx, guard };
}

test('0.1.15 推断：free-form / five-section / unknown / mixed 四类', () => {
  assert.deepEqual(inferBackendFromStyles([]), { kind: 'unknown', label: 'unknown', inferred: false, styles: [] });
  assert.deepEqual(inferBackendFromStyles(['free-form']), {
    kind: 'host-basic', label: 'host-basic (inferred)', inferred: true, styles: ['free-form'],
  });
  assert.deepEqual(inferBackendFromStyles(['unknown', 'five-section']), {
    kind: 'context-zip', label: 'context-zip (inferred)', inferred: true, styles: ['five-section'],
  });
  assert.deepEqual(inferBackendFromStyles(['free-form', 'five-section']), {
    kind: 'mixed', label: 'mixed (unverified)', inferred: false, styles: ['free-form', 'five-section'],
  });
  // 推断不改实测 kind
  assert.equal(withInference(noneAdapter(), ['free-form']).kind, 'none');
});

test('0.1.15 功能不读推断：相反推断下选择器输出不变', () => {
  const base = noneAdapter();
  const freeForm = withInference(base, ['free-form']);
  const fiveSection = withInference(base, ['five-section']);
  const mixed = withInference(base, ['free-form', 'five-section']);
  const run = (adapter) => selectMode({ adapter, eventApi: true, conflicts: [], degradedReasons: [] });
  const a = run(freeForm);
  const b = run(fiveSection);
  const c = run(mixed);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test('0.1.15 原生形态：free-form → host-basic (inferred)，成本/审计标 inferred', async () => {
  await withStore(async (store, rootDir) => {
    const { ctx, guard } = guardWith(store, withInference(noneAdapter(), []));
    const built = buildCompaction({ before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();

    assert.equal(guard.status.adapter.kind, 'none', '实测 kind 仍是 none（推断不改 kind）');
    assert.equal(guard.status.adapter.inference.label, 'host-basic (inferred)');
    const audit = await readAudit(rootDir);
    const inferred = audit.filter((entry) => entry.event === 'adapter-inferred');
    assert.ok(inferred.length >= 1);
    assert.equal(inferred[0].adapter, 'host-basic (inferred)');
    assert.equal(inferred[0].inferred, true);
    assert.deepEqual(inferred[0].kinds, ['free-form']);
    const cost = audit.find((entry) => entry.event === 'compaction-cost');
    assert.equal(cost.backend, 'host-basic');
    assert.equal(cost.backendKind, 'host-basic');
    assert.equal(cost.backendLabel, 'host-basic (inferred)');
    assert.equal(cost.backendInferred, true);
    assert.equal(/[\s(]/.test(String(cost.backend)), false, 'backend 必须是枚举（不含空格/括号）');
    assert.equal(cost.auditVersion, 'cost-v1.4');
  });
});

test('0.1.15 五段式：five-section → context-zip (inferred)，功能统计与原生一致', async () => {
  await withStore(async (store, rootDir) => {
    const { ctx, guard } = guardWith(store, withInference(noneAdapter(), []));
    const built = buildCompaction({
      compactionId: 'cmp-five',
      startSeq: 200,
      summarySeq: 201,
      checkpointSeq: 202,
      endSeq: 203,
      before: healthyMessages(),
      summary: FIVE_SECTION_SUMMARY,
      start: 2,
      end: 11,
    });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();

    assert.equal(guard.status.adapter.inference.label, 'context-zip (inferred)');
    const audit = await readAudit(rootDir);
    const cost = audit.find((entry) => entry.event === 'compaction-cost');
    assert.equal(cost.backend, 'context-zip');
    assert.equal(cost.backendKind, 'context-zip');
    assert.equal(cost.backendLabel, 'context-zip (inferred)');
    assert.equal(cost.backendInferred, true);
    // 功能面（保护/回注条数、mode）与形态无关
    assert.equal(guard.status.mode, 'event-level');
    assert.ok(audit.some((entry) => entry.event === 'protection-write'));
    assert.ok(audit.some((entry) => entry.event === 'reinjection'));
  });
});

test('0.1.15 混合：同组两种形态 → mixed (unverified)，不得标 inferred', async () => {
  await withStore(async (store, rootDir) => {
    const { ctx, guard } = guardWith(store, withInference(noneAdapter(), []));
    const first = buildCompaction({ before: healthyMessages(), summary: FREE_FORM_SUMMARY, start: 2, end: 11 });
    const session = liveSession(first);
    runCycle(ctx, session, first);
    await flush();

    const second = buildCompaction({
      compactionId: 'cmp-two',
      startSeq: 300,
      summarySeq: 301,
      checkpointSeq: 302,
      endSeq: 303,
      before: healthyMessages(),
      summary: FIVE_SECTION_SUMMARY,
      start: 2,
      end: 11,
    });
    session.surface.nodes = [...second.session.surface.nodes];
    runCycle(ctx, session, second);
    await flush();

    assert.equal(guard.status.adapter.inference.kind, 'mixed');
    assert.equal(guard.status.adapter.inference.label, 'mixed (unverified)');
    assert.equal(guard.status.adapter.inference.inferred, false);
    const audit = await readAudit(rootDir);
    const cost = audit.find((entry) => entry.event === 'compaction-cost' && entry.compactionId === 'cmp-two');
    assert.equal(cost.backend, 'unknown');
    assert.equal(cost.backendKind, 'unknown');
    assert.equal(cost.backendLabel, 'mixed (unverified)');
    assert.equal(cost.backendInferred, true);
  });
});

test('0.1.15 /cg status 标注 inferred（不冒充实测）', async () => {
  const command = createStatusCommand({
    store: null,
    audit: null,
    guard: {
      status: {
        started: true,
        mode: 'event-level',
        perception: 'event',
        eventApi: true,
        readOnly: false,
        readOnlyReason: null,
        reasons: ['no-compaction-service', 'event-perception-only'],
        degradedReasons: [],
        conflicts: [],
        fallback: null,
        adapter: {
          kind: 'none',
          label: 'no-compaction-service',
          versions: { host: '0.2.1-rc.3', backend: 'unknown' },
          perception: 'none',
          control: 'unknown',
          hooks: { before: 'best-effort', after: 'event' },
          protectionRole: 'validator',
          summary: { readability: 'readable', style: 'free-form' },
          inference: { kind: 'host-basic', label: 'host-basic (inferred)', inferred: true, styles: ['free-form'] },
          matrix: { host: 'in', backend: 'unknown' },
          selfCheck: { state: 'pending', checks: [] },
          notes: [],
        },
        protection: { enabled: false, storeRoot: null, auditFile: null, auditMaxBytes: null, auditSizeBytes: 0, auditRotations: 0, pendingJournals: 0, reinjectionFailureStreak: 0, reinjectionSuspended: false, maxReinjectionFailures: 3 },
        memory: { enabled: false, counts: {} },
        stats: { events: 0, protectionWrites: 0, protectionWriteFailures: 0, reinjections: 0, reinjectionFailures: 0, auditWriteFailures: 0, auditSkippedReadOnly: 0 },
        writeLatency: { count: 0, p50Ms: null, p95Ms: null, maxMs: null, minMs: null },
        lastReport: null,
        lastCost: null,
      },
    },
    now: () => new Date('2026-10-25T00:00:00Z'),
  });
  const result = await command.handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /adapter=none backend-label=host-basic \(inferred\)/);
});

test('0.1.16 无观察：backend/backendKind/backendLabel=unknown、inferred=false', async () => {
  await withStore(async (store, rootDir) => {
    const { ctx, guard } = guardWith(store, withInference(noneAdapter(), []));
    const built = buildCompaction({ before: healthyMessages(), summary: '', start: 2, end: 11 });
    const session = liveSession(built);
    runCycle(ctx, session, built);
    await flush();
    assert.equal(guard.status.adapter.inference.kind, 'unknown');
    const audit = await readAudit(rootDir);
    const cost = audit.find((entry) => entry.event === 'compaction-cost');
    assert.equal(cost.backend, 'unknown');
    assert.equal(cost.backendKind, 'unknown');
    assert.equal(cost.backendLabel, 'unknown');
    assert.equal(cost.backendInferred, false);
  });
});
