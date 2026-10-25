/**
 * M2 0.2.0 接线测试：/cg policy show 与 /cg status 的策略行。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { CompressionGuard } from '../src/compress/runtime.js';
import { apply, buildPolicyState, resolveConfig } from '../src/index.js';
import { profileLayer, resolvePolicy, validateLayer } from '../src/policy.js';
import { tempDir } from './helpers.mjs';

const NATIVE = 0.6785;

function policyState(profileName = '') {
  const layers = [];
  const profile = profileLayer(profileName);
  if (profile !== null) layers.push({ source: profile.source, values: profile.values });
  const plugin = validateLayer({ 'compact.at': 0.58 }, { source: 'plugin', native: NATIVE });
  layers.push({ source: 'plugin', values: plugin.values });
  return {
    native: NATIVE,
    layers,
    invalid: [],
    resolve: () => resolvePolicy(layers, { native: NATIVE }),
  };
}

function guardWithPressure(pressure = null) {
  return {
    status: {
      started: true,
      mode: 'event-level',
      perception: 'event',
      eventApi: true,
      readOnly: false,
      readOnlyReason: null,
      reasons: [],
      degradedReasons: [],
      conflicts: [],
      fallback: null,
      pressure,
      adapter: {
        kind: 'none',
        label: 'no-compaction-service',
        versions: { host: '0.2.1-rc.3', backend: 'unknown' },
        perception: 'none',
        control: 'unknown',
        hooks: { before: 'best-effort', after: 'event' },
        protectionRole: 'validator',
        summary: { readability: 'readable', style: 'free-form' },
        inference: { kind: 'unknown', label: 'unknown', inferred: false, styles: [] },
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
  };
}

test('0.2.0 /cg policy show：逐层来源 + native + early', async () => {
  const command = createStatusCommand({ policy: policyState('research'), now: () => new Date('2026-10-25T00:00:00Z') });
  const result = await command.handler({ rawInput: 'policy show' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /layers: profile=research -> plugin/);
  assert.match(result.text, /compact\.at=0\.58 \(source=plugin\)/);
  assert.match(result.text, /native=0\.6785 early=off/);
  assert.match(result.text, /invalid: none/);
  if (process.env.CG_SAMPLE === '1') console.log('### policy show ###\n' + result.text);
});

test('0.2.0 /cg status：出现 policy 合成链行', async () => {
  const command = createStatusCommand({ guard: guardWithPressure(), policy: policyState(''), now: () => new Date('2026-10-25T00:00:00Z') });
  const result = await command.handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /policy: compact\.at=0\.58 \(source=plugin\) native=0\.6785 early=on/);
  if (process.env.CG_SAMPLE === '1') console.log('### status tail ###\n' + result.text.split('\n').filter((line) => line.startsWith('compression:') || line.startsWith('policy:') || line.startsWith('degraded:')).join('\n'));
});

test('0.2.0 项目 .cg-policy.json：覆盖插件层，来源=project', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/project', policy: { values: { 'compact.at': 0.58 } } });
  const state = buildPolicyState(config, { readFile: () => JSON.stringify({ 'compact.at': 0.52 }) });
  const resolved = state.resolve();
  assert.equal(resolved.values['compact.at'], 0.52);
  assert.equal(resolved.sources['compact.at'], 'project');
});

test('0.2.0 项目文件非法：只记 invalid，不抛错；越界/未知键都拒绝该层', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/project' });
  const state = buildPolicyState(config, { readFile: () => JSON.stringify({ 'compact.at': 0.9, 'x': 1 }) });
  const resolved = state.resolve();
  assert.equal(resolved.values['compact.at'], 0.60);
  assert.equal(resolved.sources['compact.at'], 'builtin');
  assert.ok(state.invalid.some((item) => item.reason === 'over-native'));
  assert.ok(state.invalid.some((item) => item.reason === 'unknown-key'));
});

const PLUGIN_AT = 0.58;

function applyCtx() {
  const commands = [];
  const logs = [];
  const disposers = [];
  const ctx = {
    tools: { register: () => () => {} },
    get: (name) => (name === 'commands'
      ? { register: (definition) => { commands.push(definition); return () => {}; } }
      : undefined),
    logger: { info: () => {}, warn: (...args) => logs.push(args.join(' ')) },
    effect: (callback) => { disposers.push(callback()); },
  };
  return { ctx, commands, logs, disposers };
}

async function withApplyPolicy(projectFileContent, rawConfig, fn) {
  const rootDir = await tempDir('cg-policy-');
  const { ctx, commands, logs, disposers } = applyCtx();
  try {
    if (projectFileContent !== null) {
      await fs.writeFile(path.join(rootDir, '.cg-policy.json'), JSON.stringify(projectFileContent));
    }
    await apply(ctx, {
      projectRoot: rootDir,
      project: 'policy-project',
      compression: { enabled: false },
      policy: { values: { 'compact.at': PLUGIN_AT } },
      ...rawConfig,
    });
    assert.equal(commands.length, 1, 'apply 应注册 /cg 命令');
    return await fn({ rootDir, commands, logs, definition: commands[0] });
  } finally {
    for (const dispose of disposers) await dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test('① 经 apply 真读项目 .cg-policy.json（不是 apply 内联副本）', async () => {
  await withApplyPolicy({ 'compact.at': 0.52 }, {}, async ({ definition }) => {
    const show = await definition.handler({ rawInput: 'policy show' });
    assert.equal(show.kind, 'success');
    assert.match(show.text, /layers: plugin -> project/);
    assert.match(show.text, /compact\.at=0\.52 \(source=project\)/);
    const status = await definition.handler({ rawInput: 'status' });
    assert.match(status.text, /policy: compact\.at=0\.52 \(source=project\)/);
    assert.doesNotMatch(status.text, /policy-invalid:/);
  });
});

test('①b 项目层被拒：apply 打一行 warn，/cg status 显示 policy-invalid 与被拒层', async () => {
  await withApplyPolicy({ 'compact.at': 0.52, 'compact.lowThresholdAck': true }, {}, async ({ definition, logs }) => {
    assert.ok(
      logs.some((line) => /policy layer rejected \(1\): project\/compact\.lowThresholdAck:project-denied/.test(line)),
      `期望 apply warn，实际: ${logs.join(' | ')}`,
    );
    const status = await definition.handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(`policy: compact\\.at=${PLUGIN_AT} \\(source=plugin\\)`));
    assert.match(status.text, /policy-invalid: 1 \(project\/compact\.lowThresholdAck:project-denied\)/);
  });
});

test('② projectFile 只允许项目内相对路径：绝对路径与 .. 被 resolveConfig 拒绝', () => {
  assert.throws(() => resolveConfig({ policy: { projectFile: '../x.json' } }), /policy\.projectFile/);
  assert.throws(() => resolveConfig({ policy: { projectFile: 'a/../../x.json' } }), /policy\.projectFile/);
  assert.throws(() => resolveConfig({ policy: { projectFile: 'C:\\x.json' } }), /policy\.projectFile/);
  assert.equal(resolveConfig({ policy: { projectFile: ' conf/policy.json ' } }).policy.projectFile, 'conf/policy.json');
});

test('② 项目文件超 64KB：记 too-large，不读取内容', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/project' });
  let reads = 0;
  const state = buildPolicyState(config, {
    readFile: () => { reads += 1; return '{"compact.at":0.5}'; },
    statSize: () => 65 * 1024,
  });
  assert.equal(reads, 0);
  assert.equal(state.resolve().values['compact.at'], 0.60);
  assert.ok(state.invalid.some((item) => item.reason === 'too-large'));
});

test('P-A 项目层禁 lowThresholdAck：整层拒绝，不逐键降级', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/project', policy: { values: { 'compact.at': PLUGIN_AT } } });
  const state = buildPolicyState(config, {
    readFile: () => JSON.stringify({ 'compact.at': 0.5, 'compact.lowThresholdAck': true }),
  });
  const resolved = state.resolve();
  assert.equal(resolved.values['compact.at'], PLUGIN_AT);
  assert.equal(resolved.sources['compact.at'], 'plugin');
  assert.ok(state.invalid.some((item) => item.key === 'compact.lowThresholdAck' && item.reason === 'project-denied'));
});

test('P-A 项目层禁 estimateSafety：整层拒绝', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/project', policy: { values: { 'compact.at': PLUGIN_AT } } });
  const state = buildPolicyState(config, {
    readFile: () => JSON.stringify({ 'compact.at': 0.5, 'compact.estimateSafety': 1.2 }),
  });
  const resolved = state.resolve();
  assert.equal(resolved.values['compact.at'], PLUGIN_AT);
  assert.equal(resolved.sources['compact.at'], 'plugin');
  assert.ok(state.invalid.some((item) => item.key === 'compact.estimateSafety' && item.reason === 'project-denied'));
});

test('P-C 项目层 compact.at<0.45：整层拒绝', () => {
  const config = resolveConfig({ projectRoot: 'D:/tmp/project', policy: { values: { 'compact.at': PLUGIN_AT } } });
  const state = buildPolicyState(config, { readFile: () => JSON.stringify({ 'compact.at': 0.4 }) });
  const resolved = state.resolve();
  assert.equal(resolved.values['compact.at'], PLUGIN_AT);
  assert.equal(resolved.sources['compact.at'], 'plugin');
  assert.ok(state.invalid.some((item) => item.reason === 'below-min' && /0\.45/.test(item.detail)));
});

function policyForSet(values = {}) {
  const config = resolveConfig({ projectRoot: 'D:/tmp/policy-set', policy: { values } });
  return buildPolicyState(config, {
    readFile: () => {
      const error = new Error('missing project policy file');
      error.code = 'ENOENT';
      throw error;
    },
  });
}

const fixedNow = () => new Date('2026-10-25T00:00:00Z');

test('0.2.0 /cg set：会话层覆盖最高优先级，policy show 可见', async () => {
  const command = createStatusCommand({ policy: policyForSet({ 'compact.at': 0.58 }), now: fixedNow });
  const set = await command.handler({ rawInput: 'set compact.at=0.55' });
  assert.equal(set.kind, 'success');
  assert.match(set.text, /applied: compact\.at=0\.55/);
  assert.match(set.text, /source=session/);
  const show = await command.handler({ rawInput: 'policy show' });
  assert.match(show.text, /layers: plugin -> project \(empty\) -> session/);
  assert.match(show.text, /compact\.at=0\.55 \(source=session\)/);
  assert.match(show.text, /session: compact\.at=0\.55/);
});

test('0.2.0 /cg set：config-only 键、越界、<0.30 未确认都拒绝且不留半截覆盖', async () => {
  const command = createStatusCommand({ policy: policyForSet({ 'compact.at': 0.58 }), now: fixedNow });
  const safety = await command.handler({ rawInput: 'set compact.estimateSafety=1.2' });
  assert.equal(safety.kind, 'error');
  assert.match(safety.text, /只能在配置文件改/);
  const ack = await command.handler({ rawInput: 'set compact.lowThresholdAck=true' });
  assert.match(ack.text, /只能在配置文件改/);
  const overNative = await command.handler({ rawInput: 'set compact.at=0.9' });
  assert.match(overNative.text, /over-native/);
  const tooLow = await command.handler({ rawInput: 'set compact.at=0.25' });
  assert.match(tooLow.text, /lowThresholdAck/);
  const unknown = await command.handler({ rawInput: 'set compact.nope=1' });
  assert.match(unknown.text, /未知键/);
  const list = await command.handler({ rawInput: 'set' });
  assert.match(list.text, /session: none/);
});

test('0.2.0 /cg set：布尔与 reset 回落', async () => {
  const command = createStatusCommand({ policy: policyForSet({ 'compact.at': 0.58 }), now: fixedNow });
  const set = await command.handler({ rawInput: 'set compact.early=off' });
  assert.equal(set.kind, 'success');
  const show = await command.handler({ rawInput: 'policy show' });
  assert.match(show.text, /early=off/);
  const reset = await command.handler({ rawInput: 'set reset' });
  assert.match(reset.text, /cleared: 1 session override/);
  const after = await command.handler({ rawInput: 'policy show' });
  assert.match(after.text, /early=on/);
});

test('0.2.0 压力四段：measured/estimated/adjusted/effective + ratio（只展示）', async () => {
  const command = createStatusCommand({
    guard: guardWithPressure({ measuredTokens: 583000, estimatedTokens: 412000 }),
    policy: policyForSet({ 'compact.at': 0.58 }),
    now: fixedNow,
  });
  const result = await command.handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  assert.match(
    result.text,
    /pressure: measured=0\.583 estimated=0\.412 adjusted=0\.556\(×1\.35\) effective=0\.583 ratio=1\.42 at=0\.58 effective>=at/,
  );
});

test('0.2.0 压力四段：无 usage/tokenMeter 时写 -，不伪造数字', async () => {
  const command = createStatusCommand({
    guard: guardWithPressure(null),
    policy: policyForSet({}),
    now: fixedNow,
  });
  const result = await command.handler({ rawInput: 'status' });
  assert.match(result.text, /pressure: measured=- estimated=- adjusted=- effective=- ratio=- \(no usage\/tokenMeter yet\)/);
});

test('0.2.0 guard.pressure：usage 实测与 tokenMeter 估算分开取，不互相顶替', () => {
  const handlers = [];
  const meter = { measure: () => ({ nodes: [{ tokens: 400000 }, { heuristicTokens: 12345 }] }) };
  const ctx = {
    get: (name) => (name === 'tokenMeter' ? meter : undefined),
    on: (event, handler) => { handlers.push(handler); return () => {}; },
    logger: { info: () => {}, warn: () => {} },
  };
  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3' });
  guard.start();
  try {
    const session = { id: 'session-pressure', header: { id: 'session-pressure', cwd: process.cwd() } };
    handlers[0](session, { type: 'assistant/message', seq: 5, data: { usage: { inputTokens: 500000, cacheReadTokens: 83000 } } });
    const pressure = guard.pressure();
    assert.equal(pressure.measuredTokens, 583000);
    assert.equal(pressure.estimatedTokens, 412345);
    assert.equal(pressure.seq, 5);
  } finally {
    guard.stop();
  }
});
