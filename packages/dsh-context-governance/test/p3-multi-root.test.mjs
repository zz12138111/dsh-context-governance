/**
 * P3：两真实根经 apply 接线——单订阅、各根 guard、四件套/审计不串。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from './compress-helpers.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeRoot(base, name) {
  const root = path.join(base, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, '.git'), 'gitdir: nowhere\n');
  return root;
}

async function readAudit(root) {
  try {
    const text = await fs.readFile(path.join(root, 'memory', 'governance', 'audit.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeCtx({ home, engine }) {
  const handlers = [];
  const disposers = [];
  const commands = [];
  const ctx = {
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {} },
    effect(callback) { disposers.push(callback()); },
    on(event, handler) {
      handlers.push({ event, handler });
      return () => {
        const index = handlers.findIndex((item) => item.handler === handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    get(name) {
      if (name === 'profileContext') return { name: 'p3-multi', dir: home, home };
      if (name === 'compaction') return engine;
      if (name === 'commands') {
        return {
          register: (definition) => {
            commands.push(definition);
            return () => {};
          },
        };
      }
      if (name === 'agents') return { list: () => [] };
      if (name === 'agentPresets') return null;
      return undefined;
    },
  };
  return { ctx, handlers, disposers, commands };
}

function sessionFor(built, id, cwd) {
  built.session.id = id;
  built.session.header = { id, cwd };
  built.session.append = () => ({ seq: 9000 });
  return built.session;
}

test('P3 两真实根：唯一 session/event 订阅；A/B 各自 protection/materialized/cost 审计', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-p3-multi-'));
  const home = path.join(base, 'home');
  await fs.mkdir(home, { recursive: true });
  const rootA = await makeRoot(base, 'alpha');
  const rootB = await makeRoot(base, 'beta');
  await fs.writeFile(path.join(rootA, '.cg-policy.json'), '{"compact.at":0.55}\n');
  await fs.writeFile(path.join(rootB, '.cg-policy.json'), '{"compact.at":0.64}\n');
  const engine = { compactNow() {}, compactRegion() {} };
  const { ctx, handlers, disposers, commands } = makeCtx({ home, engine });
  try {
    await apply(ctx, {
      projectRoot: rootA,
      project: 'alpha',
      compression: { enabled: true, hostVersion: '0.2.1-rc.3', backendVersion: '' },
      memoryHeader: { enabled: false },
    });
    const sessionHandlers = handlers.filter((item) => item.event === 'session/event');
    assert.equal(sessionHandlers.length, 1, 'P3 生产只能有一份 session/event 订阅（early 不得再订）');
    const route = sessionHandlers[0].handler;

    const builtA = buildCompaction({ compactionId: 'cmp-a', before: healthyMessages(), summary: FIVE_SECTION_SUMMARY });
    const builtB = buildCompaction({ compactionId: 'cmp-b', before: healthyMessages(), summary: FIVE_SECTION_SUMMARY });
    const sessionA = sessionFor(builtA, 'session-p3-a', path.join(rootA, 'src'));
    const sessionB = sessionFor(builtB, 'session-p3-b', rootB);

    const sendCompaction = async (session, built) => {
      for (const type of ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']) {
        const event = built.events.find((item) => item.type === type
          && (type !== 'user/message' || item.data?.source?.kind === 'compact-checkpoint'));
        if (event === undefined) continue;
        if (type === 'compaction/end') session.surface.nodes = built.postSurface;
        route(session, event);
      }
      await wait(20);
      route(session, { type: 'assistant/message', seq: 9000 + (session.id.endsWith('a') ? 1 : 2), data: { usage: { inputTokens: 7 } } });
      await wait(20);
    };

    await sendCompaction(sessionA, builtA);
    await sendCompaction(sessionB, builtB);
    await wait(30);

    const auditA = await readAudit(rootA);
    const auditB = await readAudit(rootB);
    for (const [label, rows] of [['A', auditA], ['B', auditB]]) {
      assert.ok(rows.some((row) => row.event === 'protection-write'), `${label} 缺 protection-write`);
      assert.ok(rows.some((row) => row.event === 'protection-materialized'), `${label} 缺 protection-materialized`);
      assert.ok(rows.some((row) => row.event === 'compaction-cost'), `${label} 缺 compaction-cost`);
      assert.ok(rows.some((row) => row.event === 'reinjection'), `${label} 缺 reinjection`);
    }
    assert.equal(auditA.some((row) => row.sessionId === 'session-p3-b' || row.compactionId === 'cmp-b'), false, 'A 审计不得出现 B');
    assert.equal(auditB.some((row) => row.sessionId === 'session-p3-a' || row.compactionId === 'cmp-a'), false, 'B 审计不得出现 A');
    assert.ok(auditA.some((row) => row.rootId !== undefined) === false, 'per-root audit 不写 rootId 归因噪声');

    // 每根项目层 policy 隔离（/cg policy show 按会话根路由）。
    assert.equal(commands.length, 1);
    const policyA = await commands[0].handler({
      rawInput: 'policy show',
      agent: { session: { id: 'session-p3-a' } },
    });
    const policyB = await commands[0].handler({
      rawInput: 'policy show',
      agent: { session: { id: 'session-p3-b' } },
    });
    assert.match(policyA.text, /compact\.at=0\.55 \(source=project\)/);
    assert.match(policyB.text, /compact\.at=0\.64 \(source=project\)/);
    assert.equal(policyA.text.includes('0.64'), false);
    assert.equal(policyB.text.includes('0.55'), false);
  } finally {
    for (const dispose of disposers) {
      try { await dispose(); } catch { /* ignore */ }
    }
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
