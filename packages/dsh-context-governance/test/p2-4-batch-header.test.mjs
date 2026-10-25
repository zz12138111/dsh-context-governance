/**
 * P2-4 回归：批次判定收紧 + header 零注入（噪音不注入）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { batchCandidate } from '../src/compress/protection.js';
import { buildMemoryHeader } from '../src/memory/header.js';

function userEvent(text) {
  return {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  };
}

function assistantEvent(text, source = { kind: 'assistant' }) {
  return {
    type: 'assistant/message',
    data: { role: 'assistant', content: [{ type: 'text', text }], source },
  };
}

test('P2-4 自引用切断：assistant 回引 [CG-MEMORY header 不再被当成新进度；真实 user 进度仍识别', () => {
  assert.equal(batchCandidate(assistantEvent('[CG-MEMORY · state-only · budget 8 lines]\n批次进度 3/8 项完成')), null, 'header 回引必须排除');
  assert.equal(batchCandidate(assistantEvent('[CG-MEMORY] 批次进度 216/216')), null);
  const real = batchCandidate(userEvent('批次 3/8 项完成'));
  assert.ok(real, '真实 user 进度仍入选');
  assert.deepEqual(real.ratios, ['3/8']);
  // 语义收紧（测试数/版本语境、单位要求）与前版验收用例冲突，留待需求裁决，未在本批改。
});

test('P2-4 止血：store 全是 writer=rule / 纯数字标题时 header 零注入', () => {
  const store = {
    allEntries: () => [
      { id: 'MEM-1', type: 'progress', status: 'active', writer: 'rule', title: '批次进度：216/216', updatedAt: new Date().toISOString() },
      { id: 'MEM-2', type: 'progress', status: 'active', writer: 'rule', title: '批次进度：205/205', updatedAt: new Date().toISOString() },
      { id: 'MEM-3', type: 'fact', status: 'active', writer: 'rule', title: '2026/10/25', updatedAt: new Date().toISOString() },
    ],
  };
  assert.equal(buildMemoryHeader(store, { hasRuleFile: true }), null, '全是噪音时必须零注入');
});

test('P2-4 真实状态仍可注入', () => {
  const store = {
    allEntries: () => [
      { id: 'MEM-9', type: 'todo', status: 'active', writer: 'model', title: '补 T0 headless 用例', updatedAt: new Date().toISOString() },
    ],
  };
  const header = buildMemoryHeader(store, { hasRuleFile: true });
  assert.ok(header);
  assert.match(header.text, /补 T0 headless 用例/);
  assert.ok(!header.text.includes('[preference·非硬规则]'));
});

test('P2-4 假阳性（新口径）：205/205 无单位、赶进度+测试数、tool/result 都不成候选', () => {
  const fp1 = batchCandidate(userEvent('进度：205/205 测试通过'));
  assert.equal(fp1 === null || fp1.missingUnit === true, true, '205/205 不得成为候选');
  const fp2 = batchCandidate(userEvent('赶进度 205/205'));
  assert.equal(fp2 === null || fp2.missingUnit === true, true, '赶进度 205/205 不得成为候选');
  const toolMsg = { type: 'tool/result', data: { content: [{ type: 'text', text: '批次 3/8 项完成' }] } };
  assert.equal(batchCandidate(toolMsg), null, 'tool/result 不参与');
  const ok = batchCandidate(userEvent('批次 3/8 项完成'));
  assert.deepEqual(ok?.ratios, ['3/8'], '真实进度入选');
});
