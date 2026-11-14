/**
 * 1.1.0（REQ-20261114-02）§二② #4 生成侧标题收口：C5 三项。
 * 只验证生成侧文案/预算；不碰准入、5b、§12。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProtectionItems } from '../src/compress/protection-memory.js';
import { detectTitleTruncation } from '../src/memory/contract.js';

const base = { latestUser: null, rules: [], batch: null, rollback: null, unpairedCalls: [] };
const context = { sessionId: 'session-1f3', cycleKey: 'c-110' };
const build = (patch) => buildProtectionItems({ ...base, ...patch }, context).items;
const firstOfType = (items, type) => items.find((item) => item.type === type);

test('1.1.0 C5①：回滚点无指针时兜底文案统一为「回滚点（见 source）」', () => {
  // 正常分支：无 paths + 泛词 keyword。
  const plain = build({ rollback: { paths: [], keyword: '回滚点', seq: 1 } });
  const anchor = firstOfType(plain, 'anchor');
  assert.equal(anchor.title, '回滚点（见 source）');
  assert.equal(detectTitleTruncation(anchor.title), null);

  // 5c 截断分支：残句 → 同一 fallback（1009 与 1010 必须同名）。
  const residual = build({ rollback: { paths: [], keyword: '回滚点：G:\\DS-HARNESS`（见记忆', seq: 2 } });
  const residualAnchor = firstOfType(residual, 'anchor');
  assert.equal(residualAnchor.title, '回滚点（见 source）');
  assert.equal(detectTitleTruncation(residualAnchor.title), null);

  // 有 paths 时仍用路径，不被兜底覆盖。
  const withPath = build({ rollback: { paths: ['D:\\backup\\x.zip'], keyword: '回滚点', seq: 3 } });
  assert.equal(firstOfType(withPath, 'anchor').title, '回滚点：D:\\backup\\x.zip');
});

test('1.1.0 C5②：批次 statePath/ratios 都空不发；单有其一照发', () => {
  const none = build({ batch: { ratios: [], statePath: null, seq: 4 } });
  assert.equal(firstOfType(none, 'progress'), undefined, '两者都空不得发条目');

  const ratiosOnly = build({ batch: { ratios: ['511/958'], statePath: null, seq: 5 } });
  assert.equal(firstOfType(ratiosOnly, 'progress').title, '批次进度：511/958');

  const pathOnly = build({ batch: { ratios: [], statePath: 'G:\\DS-HARNESS\\tasks\\x-STATE.md', seq: 6 } });
  assert.match(firstOfType(pathOnly, 'progress').title, /^批次 STATE：/);
  assert.equal(firstOfType(pathOnly, 'progress').title.includes('有批次标记'), false);
});

test('1.1.0 C5③：用户消息标题 ≤87 字、全文仍进 detail（coverageText）', () => {
  const long = '这是一条很长的用户消息'.repeat(30);
  const items = build({ latestUser: { title: long, seq: 7 } });
  const entry = firstOfType(items, 'fact');
  assert.ok(entry.title.length <= 87, `title 长度 ${entry.title.length}`);
  assert.equal(entry.title.startsWith('最后用户消息：'), true);
  assert.ok(entry.detail.includes(long), 'detail 必须保留全文');
});
