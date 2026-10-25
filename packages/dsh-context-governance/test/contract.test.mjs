import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTRY_TYPES,
  MemoryContractError,
  assertStatusTransition,
  detectSensitive,
  formatPointer,
  nextEntryId,
  normalizeDraft,
  normalizePatch,
} from '../src/memory/contract.js';
import { fixedClock } from './helpers.mjs';

const now = () => new Date('2026-10-25T08:00:00.000Z');

test('字段齐全的条目通过规范化', () => {
  const entry = normalizeDraft({
    type: 'decision',
    title: '插件名定为 dsh-context-governance',
    detail: '细节',
    project: 'DSH插件开发',
    writer: 'user',
    source: 'session:x#3',
    evidence: 'docs/DECISIONS.md',
    risk: 'low',
  }, { project: 'test-project', now });
  for (const field of ['id', 'title', 'type', 'status', 'project', 'writer', 'confidence', 'createdAt', 'updatedAt', 'supersedes', 'supersededBy', 'source', 'evidence', 'detail', 'risk']) {
    assert.ok(Object.hasOwn(entry, field), `missing field ${field}`);
  }
  assert.equal(entry.status, 'active');
  assert.equal(entry.confidence, 1);
  assert.equal(entry.id, null); // id 由 store 分配
});

test('模型写入默认 proposed，且必须带 confidence', () => {
  assert.throws(
    () => normalizeDraft({ type: 'fact', title: 'x', writer: 'model' }, { project: 'test-project', now }),
    (error) => error instanceof MemoryContractError && error.code === 'CONFIDENCE_REQUIRED',
  );
  const entry = normalizeDraft({ type: 'fact', title: 'x', writer: 'model', confidence: 0.6 }, { project: 'test-project', now });
  assert.equal(entry.status, 'proposed');
});

test('高风险默认 proposed，不能直接 active', () => {
  const proposed = normalizeDraft({ type: 'decision', title: '删库', writer: 'user', risk: 'high' }, { project: 'test-project', now });
  assert.equal(proposed.status, 'proposed');
  assert.throws(
    () => normalizeDraft({ type: 'decision', title: '删库', writer: 'user', risk: 'high', status: 'active' }, { project: 'test-project', now }),
    (error) => error instanceof MemoryContractError && error.code === 'CONFIRMATION_REQUIRED',
  );
});

test('规则提取只有低风险进度/事实可直接生效', () => {
  assert.equal(
    normalizeDraft({ type: 'progress', title: '511/958', writer: 'rule' }, { project: 'test-project', now }).status,
    'active',
  );
  assert.equal(
    normalizeDraft({ type: 'decision', title: '换路线', writer: 'rule' }, { project: 'test-project', now }).status,
    'proposed',
  );
  assert.equal(
    normalizeDraft({ type: 'progress', title: '删旧日志', writer: 'rule', risk: 'high' }, { project: 'test-project', now }).status,
    'proposed',
  );
});

test('枚举、长度、敏感信息都被拒绝', () => {
  assert.throws(() => normalizeDraft({ type: 'nope', title: 'x', writer: 'user' }, { project: 'test-project', now }), /type/);
  assert.throws(() => normalizeDraft({ type: 'fact', title: '', writer: 'user' }, { project: 'test-project', now }), /title/);
  assert.throws(() => normalizeDraft({ type: 'fact', title: 'x\ny', writer: 'user' }, { project: 'test-project', now }), /single line/);
  assert.throws(
    () => normalizeDraft({ type: 'fact', title: 'x', detail: 'api_key = sk-abcdefghijklmnop', writer: 'user' }, { project: 'test-project', now }),
    (error) => error instanceof MemoryContractError && error.code === 'SENSITIVE_CONTENT',
  );
  assert.throws(
    () => normalizeDraft({ type: 'fact', title: 'x', detail: 'password: hunter2hunter2', writer: 'user' }, { project: 'test-project', now }),
    /SENSITIVE_CONTENT/,
  );
  assert.throws(
    () => normalizeDraft({ type: 'fact', title: 'x', writer: 'user', supersedes: 'NOPE-1' }, { project: 'test-project', now }),
    /memory id/,
  );
});

test('detectSensitive 覆盖常见凭据形态', () => {
  assert.equal(detectSensitive('gHp_'.toLowerCase() + 'x'), null);
  assert.equal(detectSensitive('ghp_' + 'a'.repeat(30)), 'github-token');
  assert.equal(detectSensitive('sk-' + 'a'.repeat(24)), 'openai-key');
  assert.equal(detectSensitive('-----BEGIN RSA PRIVATE KEY-----'), 'private-key');
  assert.equal(detectSensitive('普通文本 511/958'), null);
});

test('状态迁移表', () => {
  assert.doesNotThrow(() => assertStatusTransition('proposed', 'active'));
  assert.doesNotThrow(() => assertStatusTransition('proposed', 'expired'));
  assert.doesNotThrow(() => assertStatusTransition('active', 'expired'));
  assert.throws(() => assertStatusTransition('active', 'proposed'), /cannot move/);
  assert.throws(() => assertStatusTransition('expired', 'active'), /cannot move/);
  assert.throws(() => assertStatusTransition('superseded', 'expired'), /cannot move/);
});

test('update 补丁只允许可编辑字段', () => {
  assert.deepEqual(normalizePatch({ title: '新标题' }), { title: '新标题' });
  assert.throws(() => normalizePatch({ status: 'active' }), /cannot be patched/);
  assert.throws(() => normalizePatch({ supersededBy: 'MEM-20261025-001' }), /cannot be patched/);
});

test('回注行只含 ID/状态/指针，可选用标题，绝不含详情', () => {
  const entry = {
    id: 'MEM-20261025-007',
    status: 'proposed',
    title: '把默认回注形态定为 ID+状态',
    detail: '这段详情绝对不能出现在回注里',
  };
  assert.equal(formatPointer(entry), 'MEM-20261025-007 待确认（见记忆）');
  assert.equal(formatPointer(entry, { includeTitle: true }), 'MEM-20261025-007 待确认：把默认回注形态定为 ID+状态（见记忆）');
  assert.equal(
    formatPointer(entry, { summaryReadable: false, includeTitle: true }),
    'MEM-20261025-007 待确认（详情查记忆）',
  );
  assert.equal(formatPointer({ ...entry, status: 'active' }), 'MEM-20261025-007 仍生效（见记忆）');
  assert.ok(!formatPointer(entry, { includeTitle: true }).includes('绝对不能'));
});

test('nextEntryId 按本地日期递增，且不受其他日期干扰', () => {
  const ids = ['MEM-20261024-009', 'MEM-20261025-002', 'MEM-20261025-001'];
  assert.equal(nextEntryId(ids, new Date('2026-10-25T12:00:00+08:00')), 'MEM-20261025-003');
  assert.equal(nextEntryId([], new Date('2026-10-25T12:00:00+08:00')), 'MEM-20261025-001');
});

test('全部 type 都能规范化', () => {
  for (const type of ENTRY_TYPES) {
    const entry = normalizeDraft({ type, title: `${type} 测试`, writer: 'user' }, { project: 'test-project', now });
    assert.equal(entry.type, type);
  }
});

test('注入时钟可复现', () => {
  const clock = fixedClock('2026-10-25T00:00:00.000Z');
  const a = normalizeDraft({ type: 'fact', title: 'a', writer: 'user' }, { project: 'test-project', now: clock });
  const b = normalizeDraft({ type: 'fact', title: 'b', writer: 'user' }, { project: 'test-project', now: clock });
  assert.equal(a.createdAt, '2026-10-25T00:00:00.000Z');
  assert.equal(b.createdAt, '2026-10-25T00:00:01.000Z');
});

