/**
 * P1 / T12–T13：审计双通道（用户级 root audit vs 每根 audit）与白名单字段。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AUDIT_EVENTS, AuditLog, createRootAudit, sanitizeAuditDetails } from '../src/audit.js';
import { apply } from '../src/index.js';

async function tempDir(prefix = 'cg-audit-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeApplyContext({ profile, commands, handlers, cleanups }) {
  const logs = { info: [], warn: [], error: [] };
  const ctx = {
    tools: { register: () => {} },
    commands: { register: (definition) => commands.push(definition) },
    get(name) {
      if (name === 'profileContext') return profile;
      if (name === 'commands') return ctx.commands;
      return undefined;
    },
    effect: (factory) => cleanups.push(factory),
    on: (event, cb) => {
      const entry = { event, cb };
      handlers.push(entry);
      return () => {
        const index = handlers.indexOf(entry);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
      error: (message) => logs.error.push(String(message)),
    },
  };
  return { ctx, logs };
}

function fireSessionEvent(handlers, session) {
  for (const handler of handlers.slice()) {
    if (handler.event === 'session/event') handler.cb(session, { type: 'turn/end' });
  }
}

async function until(check, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function closeContext(cleanups) {
  for (const factory of cleanups.splice(0).reverse()) {
    try {
      const cleanup = factory();
      if (typeof cleanup === 'function') await cleanup();
    } catch {
      /* ignore */
    }
  }
}

async function readEvents(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('P1/T12 双通道：root audit 只收根事件，per-root audit 只收会话事件', async () => {
  const base = await tempDir();
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  const identity = { ok: true, name: 'desk', dir: path.join(base, 'profile'), home, anchor: 'home' };
  identity.stateFile = path.join(home, 'context-governance', 'root-state-desk.json');
  await fs.mkdir(path.join(repo, 'memory', 'governance'), { recursive: true });

  const rootAudit = createRootAudit(identity, { maxBytes: 64 * 1024 });
  assert.ok(rootAudit !== null);
  assert.equal(rootAudit.file, path.join(home, 'context-governance', 'root-audit-desk.jsonl'));
  rootAudit.append('root-registered', { root: repo, rootId: 'a'.repeat(16), rootCount: 1 });
  rootAudit.append('root-migrated', { fromVersion: 1, toVersion: 2, root: repo, backupPath: `${base}/b.bak` });

  const perRoot = new AuditLog({ file: path.join(repo, 'memory', 'governance', 'audit.jsonl') });
  perRoot.append('compaction-cost', { sessionId: 's1', tokensBefore: 10 });

  const rootEvents = (await readEvents(rootAudit.file)).map((record) => record.event);
  const rootEventsRaw = (await readEvents(perRoot.file)).map((record) => record.event);
  assert.deepEqual(rootEvents.slice(-2), ['root-registered', 'root-migrated']);
  assert.deepEqual(rootEventsRaw, ['compaction-cost']);
  // 隔离语义：root audit 不出现会话事件；per-root 不出现根事件。
  assert.equal(rootEvents.includes('compaction-cost'), false);
  assert.equal(rootEventsRaw.includes('root-registered'), false);
});

test('P1/T13 审计白名单：新事件在册、字段可落盘、未知字段丢弃、脱敏不变', async () => {
  for (const event of [
    'root-registered', 'root-migrated', 'root-state-corrupt', 'root-state-write-failed',
    'root-state-unsupported-version', 'root-entry-invalid', 'root-id-collision',
    'root-fail-closed', 'root-limit-warn', 'containment-violation', 'root-unmanaged',
    'root-drift', 'memory-tool-rejected',
  ]) {
    assert.ok(AUDIT_EVENTS.includes(event), `${event} 应在 AUDIT_EVENTS`);
  }
  const sanitized = sanitizeAuditDetails({
    rootId: 'a'.repeat(16),
    rootCount: 3,
    managed: false,
    fromVersion: 1,
    toVersion: 2,
    backupPath: 'C:/tmp/x.bak',
    violation: 'outside-root',
    target: 'C:/repo/memory/governance',
    subagent: true,
    unknownField: 'drop-me',
    root: 'C:/repo',
  });
  assert.equal(sanitized.rootId, 'a'.repeat(16));
  assert.equal(sanitized.rootCount, 3);
  assert.equal(sanitized.managed, false);
  assert.equal(sanitized.fromVersion, 1);
  assert.equal(sanitized.toVersion, 2);
  assert.equal(sanitized.backupPath, 'C:/tmp/x.bak');
  assert.equal(sanitized.violation, 'outside-root');
  assert.equal(sanitized.target, 'C:/repo/memory/governance');
  assert.equal(sanitized.subagent, true);
  assert.equal('unknownField' in sanitized, false);
  const sensitive = sanitizeAuditDetails({ reason: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(sensitive.reason, '[redacted:github-token]');
});

test('P1/T12 apply：persistence-identity / project-root-changed 只进 root audit', async () => {
  const base = await tempDir();
  const home = path.join(base, 'home');
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  const oldRoot = path.join(base, 'old');
  const newRoot = path.join(base, 'new');
  await fs.mkdir(oldRoot, { recursive: true });
  await fs.mkdir(newRoot, { recursive: true });
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({
    version: 1,
    root: oldRoot,
    source: 'inferred',
    inferredAt: '2026-10-25T00:00:00.000Z',
    instance: { profile: 'prof' },
  }, null, 2));

  const commands = [];
  const handlers = [];
  const cleanups = [];
  const { ctx } = makeApplyContext({ profile, commands, handlers, cleanups });
  try {
    await apply(ctx, {
      projectRoot: newRoot,
      compression: { enabled: false },
      project: 'test-project',
    });
    const rootAuditFile = path.join(home, 'context-governance', 'root-audit-prof.jsonl');
    const events = (await readEvents(rootAuditFile)).map((record) => record.event);
    assert.ok(events.includes('persistence-identity'), `root audit 缺身份事件：${events.join(',')}`);
    assert.ok(events.includes('project-root-changed'), `root audit 缺根变化事件：${events.join(',')}`);
    // 没有 guard 时不应创建 per-root audit。
    const perRootAudit = await fs.readFile(path.join(newRoot, 'memory', 'governance', 'audit.jsonl'), 'utf8').catch(() => '');
    assert.equal(perRootAudit.includes('persistence-identity'), false);
    assert.equal(perRootAudit.includes('project-root-changed'), false);
    const status = await commands[0].handler({ rawInput: 'status' });
    assert.match(status.text, /^root-audit: file=.*root-audit-prof\.jsonl/m);
  } finally {
    await closeContext(cleanups);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('P1/T12 apply：首次推断 inferred-fresh 进 root audit（per-root 无）', async () => {
  const base = await tempDir();
  const home = path.join(base, 'home');
  const profile = { name: 'prof', dir: path.join(base, 'profile'), home };
  const repo = path.join(base, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const { ctx } = makeApplyContext({ profile, commands, handlers, cleanups });
  try {
    await apply(ctx, { compression: { enabled: false }, project: 'test-project' });
    fireSessionEvent(handlers, { id: 'sess-1', header: { cwd: repo } });
    const rootAuditFile = path.join(home, 'context-governance', 'root-audit-prof.jsonl');
    const attached = await until(async () => {
      const events = (await readEvents(rootAuditFile)).map((record) => record.event);
      return events.includes('inferred-fresh');
    });
    assert.equal(attached, true, 'root audit 应出现 inferred-fresh');
    const events = (await readEvents(rootAuditFile)).map((record) => record.event);
    assert.ok(events.includes('persistence-identity'));
    const perRootAudit = await fs.readFile(path.join(repo, 'memory', 'governance', 'audit.jsonl'), 'utf8').catch(() => '');
    assert.equal(perRootAudit.includes('persistence-identity'), false);
    assert.equal(perRootAudit.includes('inferred-fresh'), false);
  } finally {
    await closeContext(cleanups);
    await fs.rm(base, { recursive: true, force: true });
  }
});
