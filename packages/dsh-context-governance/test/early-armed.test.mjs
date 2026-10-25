/**
 * 0.2.4 T1：`armed` 三通道（default/config/session）+ 项目层不生效。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createStatusCommand } from '../src/commands/cg-status.js';
import { resolvePolicy, summarizePolicy, validateLayer } from '../src/policy.js';

test('0.2.4 T1：默认 armed=true（来源 default），early=on (default)', () => {
  const resolved = resolvePolicy([], { native: 0.6934 });
  assert.equal(resolved.values['compact.early.armed'], true);
  assert.equal(resolved.earlyArmed, true);
  assert.equal(resolved.armedSource, 'builtin');
  assert.match(summarizePolicy(resolved), /early=on \(default\)/);
});

test('0.2.4 T1：配置层可关 armed（plugin → config）', () => {
  const plugin = validateLayer({ 'compact.early.armed': false }, { source: 'plugin', native: 0.6934 });
  assert.deepEqual(plugin.invalid, []);
  assert.equal(plugin.values['compact.early.armed'], false);
  const resolved = resolvePolicy([{ source: 'plugin', values: plugin.values }], { native: 0.6934 });
  assert.equal(resolved.earlyArmed, false);
  assert.equal(resolved.armedSource, 'plugin');
  assert.match(summarizePolicy(resolved), /early=off \(config\)/);
});

test('0.2.4 T1：项目层 armed 被忽略（project-excluded），同层其它键仍生效', () => {
  const project = validateLayer(
    { 'compact.early.armed': false, 'compact.at': 0.5 },
    { source: 'project', native: 0.6934, projectLayer: true },
  );
  assert.equal(project.values['compact.early.armed'], undefined, '项目层不得生效');
  assert.equal(project.values['compact.at'], 0.5, '同层其它合法键仍生效');
  assert.deepEqual(project.invalid.map((item) => item.reason), ['project-excluded']);
  assert.equal(project.invalid[0].key, 'compact.early.armed');

  const resolved = resolvePolicy([{ source: 'project', values: project.values }], { native: 0.6934 });
  assert.equal(resolved.earlyArmed, true, '默认开不能被项目层关掉');
  assert.match(summarizePolicy(resolved), /early=on \(default\)/);
});

test('0.2.4 T1：会话层命令可开可关，优先级高于配置；policy.early 关闭时仍优先于 armed', () => {
  const session = { source: 'session', values: { 'compact.early.armed': false } };
  const withConfigOff = resolvePolicy([{ source: 'plugin', values: { 'compact.early.armed': false } }, session], { native: 0.6934 });
  assert.equal(withConfigOff.earlyArmed, false);
  assert.equal(withConfigOff.armedSource, 'session');
  assert.match(summarizePolicy(withConfigOff), /early=off \(session\)/);

  const sessionOn = { source: 'session', values: { 'compact.early.armed': true } };
  const withConfigOffAndSessionOn = resolvePolicy([{ source: 'plugin', values: { 'compact.early.armed': false } }, sessionOn], { native: 0.6934 });
  assert.equal(withConfigOffAndSessionOn.earlyArmed, true);
  assert.match(summarizePolicy(withConfigOffAndSessionOn), /early=on \(session\)/);

  const research = resolvePolicy([{ source: 'profile=research', values: { 'compact.early': false } }, sessionOn], { native: 0.6934 });
  assert.equal(research.early, false, 'compact.early=false 始终优先于 armed');
  assert.match(summarizePolicy(research), /early=off \(policy:research\)/);
});

test('0.2.4 T1：/cg compact arm|disarm 只改会话层，写 early-armed/disarmed 审计', async () => {
  const sessionLayer = { source: 'session', values: {} };
  const audit = { entries: [], append(event, details) { this.entries.push({ event, ...details }); } };
  const policy = {
    sessionLayer,
    native: 0.6934,
    validationNative: () => 0.6934,
    resolve: () => resolvePolicy([sessionLayer], { native: 0.6934 }),
  };
  const command = createStatusCommand({ policy, audit, now: () => new Date('2026-10-26T00:00:00Z') });

  const off = await command.handler({ rawInput: 'compact disarm', sessionId: 'session-abcdef0123456789' });
  assert.equal(off.kind, 'success');
  assert.equal(sessionLayer.values['compact.early.armed'], false);
  assert.equal(audit.entries[0].event, 'early-disarmed');
  assert.equal(audit.entries[0].source, 'session');
  assert.equal(audit.entries[0].sessionId, 'session-abcdef0123456789');

  const on = await command.handler({ rawInput: 'compact arm', sessionId: 'session-abcdef0123456789' });
  assert.equal(on.kind, 'success');
  assert.equal(sessionLayer.values['compact.early.armed'], true);
  assert.equal(audit.entries[1].event, 'early-armed');

  const denied = await command.handler({ rawInput: 'set compact.early.armed=true' });
  assert.equal(denied.kind, 'error');
  assert.match(denied.text, /\/cg set 修改|只能在配置文件改/);
});
