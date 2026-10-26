import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { AUDIT_FIELD_WHITELIST, AuditLog, sanitizeAuditDetails } from '../src/audit.js';
import { CompressionGuard } from '../src/compress/runtime.js';
import {
  CG_COMMAND_NAME,
  createStatusCommand,
  registerStatusCommand,
} from '../src/commands/cg-status.js';
import { calculateLatencyStats, percentile } from '../src/metrics.js';
import { MemoryStore } from '../src/memory/store.js';
import {
  FIVE_SECTION_SUMMARY,
  buildCompaction,
  healthyMessages,
  userMessage,
} from './compress-helpers.mjs';
import { tempDir } from './helpers.mjs';

class BasicCompactionEngine {
  compactNow() {}
  compactRegion() {}
}

function makeCtx(compaction) {
  const handlers = [];
  const commands = [];
  return {
    handlers,
    commands,
    get(name) {
      if (name === 'compaction') return compaction;
      if (name === 'commands') return { register: (definition) => commands.push(definition) };
      return undefined;
    },
    on(event, handler) {
      handlers.push({ event, handler });
      return () => {};
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function liveSession(built) {
  const bySeq = new Map(built.events.map((event) => [event.seq, event]));
  let nextSeq = 1000;
  const session = {
    id: 'session-t5',
    appended: [],
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt(seq) { return bySeq.get(seq); },
    append(type, data, opts) {
      const event = { seq: nextSeq++, type, data, time: Date.now(), ...opts };
      bySeq.set(event.seq, event);
      if (type === 'user/message' && opts?.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      this.appended.push(event);
      return event;
    },
  };
  return session;
}

function emitThroughEnd(ctx, session, built) {
  const handler = ctx.handlers[0].handler;
  handler(session, built.events.find((event) => event.type === 'compaction/start'));
  handler(session, built.events.find((event) => event.type === 'compaction/summary'));
  handler(session, built.events.find((event) => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint'));
  session.surface.nodes = [...built.postSurface];
  handler(session, built.events.find((event) => event.type === 'compaction/end'));
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('/cg status：输出后端/模式/降级/记忆/上次压缩与回注/写盘 p50p95/审计', () => {
  const guard = {
    status: {
      mode: 'full',
      perception: 'event',
      eventApi: true,
      readOnly: false,
      readOnlyReason: null,
      degradedReasons: [],
      conflicts: [{ code: 'host-version-unverified', severity: 'warning' }],
      adapter: {
        kind: 'context-zip',
        perception: 'event',
        protectionRole: 'validator',
        hooks: { before: 'best-effort', after: 'event' },
        summary: { readability: 'readable', style: 'five-section' },
        versions: { host: '0.2.1-rc.2', backend: 'unknown' },
      },
      writeLatency: { count: 3, p50Ms: 1, p95Ms: 4, maxMs: 5, minMs: 1 },
      lastReport: {
        compactionId: '12345678-abcd',
        manual: false,
        ok: true,
        shadowedSeqs: [1, 2],
        checkpointSeq: 102,
        failures: [],
        reinjection: { status: 'injected', seq: 200, lines: 3 },
      },
      protection: { pendingJournals: 0, reinjectionDisabled: false, readOnly: false, readOnlyReason: null },
      stats: {
        protectionWrites: 3,
        protectionWriteFailures: 0,
        reinjections: 3,
        reinjectionFailures: 0,
        auditWriteFailures: 0,
        auditSkippedReadOnly: 0,
      },
    },
  };
  const store = {
    status: {
      counts: { active: 2, proposed: 1 },
      project: 'demo',
      rootDir: 'D:/demo/memory',
      readOnlyReason: null,
      warnings: [],
    },
    allEntries: () => [{}, {}, {}],
    protectionPending: 0,
  };
  const audit = {
    file: 'D:/demo/memory/audit.jsonl',
    maxBytes: 8388608,
    sizeBytes: 1234,
    rotations: 2,
    entries: () => [{ event: 'protection-write' }, { event: 'reinjection-failed' }],
  };
  const command = createStatusCommand({ store, guard, audit, now: () => new Date('2026-10-25T00:00:00Z') });
  assert.equal(command.name, CG_COMMAND_NAME);
  return command.handler({ rawInput: 'status' }).then((result) => {
    assert.equal(result.kind, 'success');
    assert.match(result.text, /context-governance status/);
    assert.match(result.text, /mode=full adapter=context-zip/);
    assert.match(result.text, /p50=1ms p95=4ms max=5ms/);
    assert.match(result.text, /last-compaction: id=12345678 manual=false compaction=committed protection=ok/);
    assert.match(result.text, /last-reinjection: status=injected seq=200 lines=3/);
    assert.match(result.text, /memory: project=demo/);
    assert.match(result.text, /audit: file=D:\/demo\/memory\/audit\.jsonl max=8388608 size=1234 rotations=2 recentFailures=reinjection-failed/);
    assert.match(result.text, /conflicts: host-version-unverified\(warning\)/);
  });
});

test('/cg status：参数错误返回 error；未注册命令面只返回失败不抛错', async () => {
  const command = createStatusCommand({});
  const bad = await command.handler({ rawInput: 'other' });
  assert.equal(bad.kind, 'error');
  assert.match(bad.text, /Usage: \/cg status/);

  const noCommands = registerStatusCommand({}, {});
  assert.equal(noCommands.registered, false);
  assert.match(noCommands.reason, /unavailable/);

  const registered = [];
  const result = registerStatusCommand({ get: () => ({ register: (definition) => registered.push(definition) }) });
  assert.equal(result.registered, true);
  assert.equal(registered[0].name, 'cg');
});

test('p50/p95：偶数/奇数样本与空样本', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.deepEqual(calculateLatencyStats([3, 1, 2]), {
    count: 3, p50Ms: 2, p95Ms: 3, maxMs: 3, minMs: 1,
  });
  assert.deepEqual(calculateLatencyStats([]), { count: 0, p50Ms: null, p95Ms: null, maxMs: null, minMs: null });
});

test('审计字段白名单：未知字段/正文/标题被丢弃，敏感字符串被替换', () => {
  assert.ok(AUDIT_FIELD_WHITELIST.sessionId);
  assert.equal(AUDIT_FIELD_WHITELIST.title, undefined);
  assert.equal(AUDIT_FIELD_WHITELIST.injected, 'number');
  assert.equal(AUDIT_FIELD_WHITELIST.messagesBefore, 'number');
  assert.equal(AUDIT_FIELD_WHITELIST.messagesAfter, 'number');
  assert.equal(AUDIT_FIELD_WHITELIST.messagesLength, undefined, '不得记裸 messages.length');
  assert.equal(AUDIT_FIELD_WHITELIST.textHash, undefined, '审核定论：不做 header hash');
  const sanitized = sanitizeAuditDetails({
    sessionId: 'session-1',
    compactionId: 'cmp-1',
    durationMs: 3,
    ids: ['MEM-20261025-1000'],
    kinds: ['latest-user'],
    reason: 'password = hunter2hunter2',
    secret: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    title: '用户消息正文',
    text: '正文',
  });
  assert.equal(sanitized.sessionId, 'session-1');
  assert.equal(sanitized.durationMs, 3);
  assert.deepEqual(sanitized.ids, ['MEM-20261025-1000']);
  assert.equal(sanitized.reason, '[redacted:credential-assignment]');
  assert.equal(Object.hasOwn(sanitized, 'secret'), false);
  assert.equal(Object.hasOwn(sanitized, 'title'), false);
  assert.equal(Object.hasOwn(sanitized, 'text'), false);
});

test('审计 JSONL：同步追加；正文/令牌不落盘', async () => {
  const root = await tempDir();
  try {
    const file = path.join(root, 'audit.jsonl');
    const audit = new AuditLog({ file, now: () => new Date('2026-10-25T00:00:00Z') });
    assert.equal(audit.append('protection-write', {
      sessionId: 's', compactionId: 'c', durationMs: 2, count: 1,
      reason: 'password=hunter2', text: '用户消息：我的密码是 hunter2',
    }), true);
    const text = await fs.readFile(file, 'utf8');
    assert.equal(text.includes('hunter2'), false);
    assert.equal(text.includes('用户消息'), false);
    assert.ok(audit.entries().length === 1);
    assert.equal(audit.writeLatencyStats().p50Ms, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('T5：压缩周期中的敏感用户消息不进 audit/记忆标题', async () => {
  const root = await tempDir();
  const store = await MemoryStore.open({ rootDir: root, project: 'test-project' });
  try {
    const secret = 'password = hunter2hunter2';
    const before = [...healthyMessages(), userMessage(14, `最后一条：${secret}，token=ghp_${'a'.repeat(30)}`)];
    const built = buildCompaction({ before, summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
    const session = liveSession(built);
    const ctx = makeCtx(new BasicCompactionEngine());
    const guard = new CompressionGuard({ resolveScope: () => ({ mode: 'single-root', root: 'test-root', cwd: '', governed: true, skipReason: null, unattributed: false }), ctx, store, hostVersion: '0.2.1-rc.2' });
    guard.start();
    try {
      emitThroughEnd(ctx, session, built);
      await flush();
      await guard.flush();
      const auditText = await fs.readFile(path.join(root, 'audit.jsonl'), 'utf8');
      assert.equal(auditText.includes('hunter2'), false);
      assert.equal(auditText.includes('ghp_'), false);
      const latest = store.allEntries().find((entry) => entry.title.includes('用户消息'));
      assert.ok(latest);
      assert.match(latest.title, /敏感内容已省略/);
      assert.equal(latest.title.includes('hunter2'), false);
      const status = guard.status;
      assert.equal(status.writeLatency.count, 1);
      assert.ok(Number.isFinite(status.writeLatency.p50Ms));
      assert.ok(Number.isFinite(status.writeLatency.p95Ms));
    } finally {
      guard.stop();
    }
  } finally {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('apply 注册 /cg status（宿主命令面）', async () => {
  const root = await tempDir();
  const commands = [];
  const ctx = {
    tools: { register: () => {} },
    commands: { register: (definition) => commands.push(definition) },
    get(name) {
      if (name === 'compaction') return new BasicCompactionEngine();
      if (name === 'commands') return ctx.commands;
      return undefined;
    },
    effect: () => {},
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  try {
    const { apply } = await import('../src/index.js');
    await apply(ctx, {
      projectRoot: root,
      project: 'test-project',
      compression: { enabled: true, hostVersion: '0.2.1-rc.2', backendVersion: '' },
    });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, 'cg');
    const result = await commands[0].handler({ rawInput: 'status' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /context-governance status/);
    assert.match(result.text, /memory: project=test-project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
