/**
 * C36 ①/⑤：会话作用域——`.git` 不再是闸门；无根/不可用 cwd 仍受治并留审计。
 *
 * - `inferCwdRoot`：无 `.git` 的 cwd realpath 即根；不存在/不可读 → null；
 * - registry：无 git 祖先的 cwd 会话 → managed（cwd 根），空 cwd 仍 no-root；
 * - pool：首个事件 `session-governed`（每会话一条）；无根会话 `root-unresolved`
 *   每会话每 cycle 至少 1 条（同 cycle 去重）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inferCwdRoot } from '../src/roots/identity.js';
import { RootRegistry } from '../src/roots/registry.js';
import { RootGuardPool } from '../src/compress/root-guards.js';

const tempDir = async (prefix = 'cg-c36-') => fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));

function auditSink() {
  const rows = [];
  return { rows, file: 'fake-audit.jsonl', append(event, details) { rows.push({ event, details }); return true; } };
}

function makePool({ resolve, rootAudit }) {
  const guards = [];
  const ctx = {
    handlers: [],
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) {
      this.handlers.push({ event, handler });
      return () => {
        const index = this.handlers.findIndex((item) => item.handler === handler);
        if (index >= 0) this.handlers.splice(index, 1);
      };
    },
  };
  const pool = new RootGuardPool({
    ctx,
    registry: { resolveSessionRoot: resolve },
    storePool: {
      async pin(rootEntry) {
        const audit = auditSink();
        return { entry: rootEntry, store: { rootDir: rootEntry.root }, audit, release() {} };
      },
    },
    createGuard: async (rootEntry, resources) => {
      const guard = { events: [], handleEvent(session, event) { this.events.push({ session, event }); }, stop() {} };
      const early = { checks: [], check() { this.checks.push(true); }, stop() {}, hasPending() { return false; } };
      guards.push({ entry: rootEntry, guard, early, audit: resources.audit });
      return { guard, early, policy: { root: rootEntry.root } };
    },
    rootAudit,
    logger: ctx.logger,
    idleMs: 1000,
    now: () => new Date(),
  });
  return { ctx, pool, guards };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const entry = (rootId, root) => ({ rootId, root, state: 'active', origin: 'inferred' });

test('C36 ①：inferCwdRoot——无 .git 的 cwd realpath 即根；不存在/空 → null', async () => {
  const base = await tempDir();
  try {
    const child = path.join(base, 'nogit-project');
    fs.mkdirSync(child, { recursive: true });
    assert.equal(inferCwdRoot(child), fs.realpathSync.native(child));
    assert.equal(inferCwdRoot(path.join(base, 'missing')), null);
    assert.equal(inferCwdRoot(''), null);
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C36 ①：registry 无 git 祖先 → managed（cwd 根）；空 cwd → no-root', async () => {
  const base = await tempDir();
  try {
    const cwd = path.join(base, 'nogit');
    fs.mkdirSync(cwd, { recursive: true });
    const registry = RootRegistry.load({
      stateFile: path.join(base, 'state.json'),
      profile: 'test',
      now: () => new Date('2026-11-15T00:00:00Z'),
      rootAudit: { append() {} },
    });
    const resolved = registry.resolveSessionRoot({ header: { id: 'session-c36-1', cwd } });
    assert.equal(resolved.status, 'managed');
    assert.equal(resolved.entry.root, fs.realpathSync.native(cwd));
    const missing = registry.resolveSessionRoot({ header: { id: 'session-c36-2' } });
    assert.equal(missing.status, 'no-root');
    assert.equal(missing.reason, 'cwd-missing');
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('C36：pool 首个事件写 session-governed，每会话只一条', async () => {
  const rootAudit = auditSink();
  const root = entry('root-a', 'D:/work/c36-a');
  const { ctx, pool } = makePool({
    resolve: () => ({ status: 'managed', entry: root, source: 'inferred', isSubagent: false, cwd: 'D:/work/c36-a', reason: null }),
    rootAudit,
  });
  pool.start();
  try {
    ctx.handlers[0].handler({ id: 'session-c36-a' }, { type: 'compaction/start', seq: 1, data: { compactionId: 'cmp-1' } });
    ctx.handlers[0].handler({ id: 'session-c36-a' }, { type: 'compaction/end', seq: 2, data: { compactionId: 'cmp-1' } });
    await flush();
    const rows = rootAudit.rows.filter((row) => row.event === 'session-governed');
    assert.equal(rows.length, 1, '每会话只写一条');
    assert.equal(rows[0].details.sessionId, 'session-c36-a');
    assert.equal(rows[0].details.root, 'D:/work/c36-a');
  } finally {
    await pool.closeAll('test');
  }
});

test('C36 ⑤：无根会话 root-unresolved 每会话每 cycle 去重、跨 cycle 再写，不静默', async () => {
  const rootAudit = auditSink();
  const { ctx, pool } = makePool({
    resolve: () => ({ status: 'no-root', entry: null, source: null, isSubagent: false, cwd: '', reason: 'cwd-missing' }),
    rootAudit,
  });
  pool.start();
  try {
    const session = { id: 'session-c36-u' };
    // 同一 cycle 三个事件 → 只 1 条。
    ctx.handlers[0].handler(session, { type: 'turn/start', seq: 1, data: { turn: 7 } });
    ctx.handlers[0].handler(session, { type: 'user/message', seq: 2, data: {} });
    ctx.handlers[0].handler(session, { type: 'turn/end', seq: 3, data: { turn: 7 } });
    await flush();
    const first = rootAudit.rows.filter((row) => row.event === 'root-unresolved');
    assert.equal(first.length, 1, '同 cycle 去重');
    assert.equal(first[0].details.sessionId, 'session-c36-u');
    assert.equal(first[0].details.reason, 'cwd-missing');
    assert.equal(first[0].details.cycle, 'turn:7');
    // 下一轮 → 再 1 条（每 cycle 至少 1 条）。
    ctx.handlers[0].handler(session, { type: 'turn/start', seq: 4, data: { turn: 8 } });
    await flush();
    const second = rootAudit.rows.filter((row) => row.event === 'root-unresolved');
    assert.equal(second.length, 2, '新 cycle 必须再写');
    assert.equal(second[1].details.cycle, 'turn:8');
    // 无根会话不建 guard，不写 compaction-loss。
    assert.equal(rootAudit.rows.some((row) => row.event === 'compaction-loss'), false);
  } finally {
    await pool.closeAll('test');
  }
});
