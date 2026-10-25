import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedSurface,
  snapshotProtection,
  stripStructuredPayload,
  summaryTextOf,
  verifyProtection,
} from '../src/compress/protection.js';
import {
  FIVE_SECTION_SUMMARY,
  FREE_FORM_SUMMARY,
  agentInstructions,
  assistantText,
  assistantToolCall,
  buildCompaction,
  checkpoint,
  compactionSummary,
  event,
  fakeSession,
  healthyMessages,
  systemPrompt,
  toolResult,
  userMessage,
} from './compress-helpers.mjs';

function reportFor({ before, summary, start, end, shadowedSeqs, checkpointSeq, postSurfaceNodes } = {}) {
  const built = buildCompaction({
    before,
    summary,
    start,
    end,
    shadowedSeqs,
    ...(checkpointSeq === undefined ? {} : { checkpointSeq }),
  });
  const snapshot = snapshotProtection(built.session);
  const report = verifyProtection({
    snapshot,
    summaryEvent: built.summaryEvent,
    checkpointSeq: checkpointSeq === undefined ? built.checkpointSeq : checkpointSeq,
    ...(postSurfaceNodes === undefined ? {} : { postSurfaceNodes }),
    adapterKind: built.source,
  });
  return { built, snapshot, report };
}

test('健康压缩（宿主自由摘要）：五项保护全部通过', () => {
  const { built, snapshot, report } = reportFor({
    before: healthyMessages(),
    summary: FREE_FORM_SUMMARY,
    start: 2,
    end: 11,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.degraded, false);
  assert.equal(snapshot.latestUser.seq, 13);
  assert.equal(snapshot.rules.length, 2);
  assert.equal(snapshot.batch.ratios[0], '511/958');
  assert.equal(snapshot.rollback.paths[0], 'D:\\backup\\pre-t3.zip');
  for (const name of ['artifact', 'latest-user-message', 'rule-injection', 'tool-pairing', 'batch-list', 'rollback-point']) {
    assert.equal(report.checks.find((check) => check.name === name).status, 'pass', name);
  }
  assert.equal(built.postSurface.includes(built.checkpointSeq), true);
});

test('健康压缩（context-zip 五段摘要）：同样全部通过', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 11,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.summaryChars, FIVE_SECTION_SUMMARY.length);
});

test('最新用户消息被吞：fail，即使摘要写了它', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 13,
  });
  assert.equal(report.ok, false);
  const check = report.checks.find((item) => item.name === 'latest-user-message');
  assert.equal(check.status, 'fail');
  assert.deepEqual(check.seqs, [13]);
});

test('规则注入被吞：fail', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 1,
    end: 11,
  });
  const check = report.checks.find((item) => item.name === 'rule-injection');
  assert.equal(check.status, 'fail');
  assert.deepEqual(check.seqs, [1]);
});

test('旧的规则快照被吞、但有更新的同类副本：通过', () => {
  const before = [...healthyMessages(), agentInstructions(14, 'AGENTS.md v2')];
  const { report } = reportFor({
    before,
    summary: FIVE_SECTION_SUMMARY,
    start: 1,
    end: 11,
  });
  const check = report.checks.find((item) => item.name === 'rule-injection');
  assert.equal(check.status, 'pass');
  assert.match(check.detail, /superseded/);
});

test('工具配对切口不平衡：fail', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 4,
    end: 11,
  });
  const check = report.checks.find((item) => item.name === 'tool-pairing');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /before=1/);
});

test('孤儿 tool/result（无对应调用）：fail', () => {
  const before = healthyMessages().filter((item) => item.seq !== 3); // 删掉 call-1，保留 result-1
  const { report } = reportFor({
    before,
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 11,
  });
  const check = report.checks.find((item) => item.name === 'tool-pairing');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /without a matching call|balanced/);
});

test('批次号被吞且摘要没覆盖：fail', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: 'Current state: 继续 T3。回滚点：D:\\backup\\pre-t3.zip',
    start: 2,
    end: 11,
  });
  const check = report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'fail');
  assert.deepEqual(check.seqs, [9]);
});

test('假阳性回归：tool 结果里的 {"batch":…} JSON 不产生批次标记（skip）', () => {
  const json = '{"batch": "T3", "progress": "511/958", "status": "running"}';
  const before = [
    systemPrompt(0),
    userMessage(1, '继续执行。'),
    assistantToolCall(2, 'call-1'),
    event(3, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', content: [{ type: 'text', text: json }], source: { kind: 'tool', callId: 'call-1' } },
      meta: { callId: 'call-1' },
    }),
    userMessage(4, '收到。'),
    assistantText(5, '好。'),
    userMessage(6, '最后一条用户消息：继续。'),
  ];
  const { snapshot, report } = reportFor({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 5 });
  assert.equal(snapshot.batch, null, 'tool/result/JSON 不得生成批次标记');
  const check = report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'skip');
});

test('正例：用户消息里的 8000/1500 能识别并正确比对', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    userMessage(2, '批次进度 8000/1500 项，继续跑。'),
    assistantText(3, '收到。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const covered = reportFor({ before, summary: '当前进度 8000/1500，继续。', start: 1, end: 3 });
  assert.deepEqual(covered.snapshot.batch.ratios, ['8000/1500']);
  assert.equal(covered.report.checks.find((item) => item.name === 'batch-list').status, 'pass');

  const lost = reportFor({ before, summary: '继续跑下一步。', start: 1, end: 3 });
  assert.equal(lost.report.checks.find((item) => item.name === 'batch-list').status, 'fail');
});

test('只有“批次”关键字、没有数字比例：skip 并带原因（不再空泛 pass）', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    userMessage(2, '批次进度：等用户确认。'),
    assistantText(3, '好。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const { snapshot, report } = reportFor({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3 });
  assert.deepEqual(snapshot.batch.ratios, []);
  const check = report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'skip');
  assert.equal(check.reason, 'no-ratio-in-user-messages');
  assert.deepEqual(check.seqs, [2]);
});

test('日期/规则注入不当成进度比例；助手正文里的比例可识别', () => {
  const before = [
    systemPrompt(0),
    agentInstructions(1, '规则：批次编号按 2026/10/25 归档。'),
    userMessage(2, '2026/10/25 的批次：已完成。'),
    assistantText(3, '助手进度 6000/1200 项完成。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const { snapshot } = reportFor({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3 });
  // 日期 2026/10/25 不算比例；规则注入不取数；助手正文的 6000/1200 生效。
  assert.deepEqual(snapshot.batch.ratios, ['6000/1200']);
  assert.equal(snapshot.batch.seq, 3);
});

test('0.1.14 同源约束：助手正文 2/6 无批次语义 → skip(no-batch-semantics)', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    assistantText(2, '已收口：0 阻断 / 0 P2 / 6 P3，未 push。'),
    assistantText(3, '好。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const { snapshot, report } = reportFor({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3 });
  assert.equal(snapshot.batch, null);
  assert.equal(snapshot.batchRejected.seq, 2);
  const check = report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'skip');
  assert.equal(check.reason, 'no-batch-semantics');
  assert.deepEqual(check.seqs, [2]);
});

test('0.1.14 同源约束：183/183 无关键字 → skip(no-batch-semantics)', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    userMessage(2, '测试 183/183 全部通过。'),
    assistantText(3, '好。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const { snapshot, report } = reportFor({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3 });
  assert.equal(snapshot.batch, null);
  const check = report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'skip');
  assert.equal(check.reason, 'no-batch-semantics');
});

test('0.1.14 反例：仅 8000/1500、无关键字 → skip，不得 pass/fail', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    userMessage(2, '8000/1500 已完成。'),
    assistantText(3, '好。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const { snapshot, report } = reportFor({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3 });
  assert.equal(snapshot.batch, null);
  assert.equal(snapshot.batchRejected.ratios[0], '8000/1500');
  const check = report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'skip');
  assert.equal(check.reason, 'no-batch-semantics');
});

test('0.1.14 正例作废（DEC-73）：批次 8000/1500 无单位 → skip(no-unit)', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    userMessage(2, '批次 8000/1500 进行中。'),
    assistantText(3, '收到。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const result = reportFor({ before, summary: '继续跑下一步。', start: 1, end: 3 });
  const check = result.report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'skip');
  assert.equal(check.reason, 'no-unit');
  assert.deepEqual(result.snapshot.batch?.ratios ?? [], [], '无单位不得成为 batch 候选');
});

test('0.1.14 正例（新口径）：批次 8000/1500 项完成 → 覆盖 pass / 不覆盖 fail', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    userMessage(2, '批次 8000/1500 项完成，进行中。'),
    assistantText(3, '收到。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const covered = reportFor({ before, summary: '当前批次 8000/1500 已完成。', start: 1, end: 3 });
  assert.deepEqual(covered.snapshot.batch.ratios, ['8000/1500']);
  assert.equal(covered.report.checks.find((item) => item.name === 'batch-list').status, 'pass');
  const lost = reportFor({ before, summary: '继续跑下一步。', start: 1, end: 3 });
  assert.equal(lost.report.checks.find((item) => item.name === 'batch-list').status, 'fail');
});

test('0.1.14 日期：2026/10 有批次语义 → skip(date-like-ratio)', () => {
  const before = [
    systemPrompt(0),
    userMessage(1, '继续。'),
    userMessage(2, '批次归档：2026/10。'),
    assistantText(3, '好。'),
    userMessage(4, '最后一条用户消息：继续。'),
  ];
  const { snapshot, report } = reportFor({ before, summary: FREE_FORM_SUMMARY, start: 1, end: 3 });
  assert.deepEqual(snapshot.batch.ratios, []);
  assert.equal(snapshot.batch.dateLike, 1);
  const check = report.checks.find((item) => item.name === 'batch-list');
  assert.equal(check.status, 'skip');
  assert.equal(check.reason, 'date-like-ratio');
});

test('0.1.14 正文保留：{511/958} 可识别；JSON 载荷不参选', () => {
  const keep = reportFor({
    before: [
      systemPrompt(0),
      userMessage(1, '继续。'),
      userMessage(2, '批次进度 {511/958} 项完成，继续。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ],
    summary: '批次 511/958 项完成。',
    start: 1,
    end: 3,
  });
  assert.deepEqual(keep.snapshot.batch.ratios, ['511/958']);
  assert.equal(keep.report.checks.find((item) => item.name === 'batch-list').status, 'pass');

  const json = reportFor({
    before: [
      systemPrompt(0),
      userMessage(1, '继续。'),
      userMessage(2, '批次 {"n": "511/958"} 已归档。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ],
    summary: '批次 511/958 项完成。',
    start: 1,
    end: 3,
  });
  assert.deepEqual(json.snapshot.batch.ratios, []);
  assert.equal(json.report.checks.find((item) => item.name === 'batch-list').reason, 'no-ratio-in-user-messages');

  assert.equal(stripStructuredPayload('批次 {511/958}').includes('511/958'), true);
  assert.equal(stripStructuredPayload('{"batch": "511/958"}').includes('511/958'), false);
});

test('回滚点被吞且摘要没覆盖：fail', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: 'Current state: 批次 511/958 项完成。',
    start: 2,
    end: 11,
  });
  const check = report.checks.find((item) => item.name === 'rollback-point');
  assert.equal(check.status, 'fail');
  assert.deepEqual(check.seqs, [10]);
});

test('摘要不可读：批量/回滚检查降级为 skip，报告 degraded 但不误报 fail', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: '',
    start: 2,
    end: 11,
  });
  assert.equal(report.summaryReadable, false);
  assert.equal(report.degraded, true);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((item) => item.name === 'batch-list').status, 'skip');
  assert.equal(report.checks.find((item) => item.name === 'summary-readable').status, 'warn');
});

test('缺 checkpoint：artifact fail', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 11,
    checkpointSeq: null,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'artifact').status, 'fail');
});

test('保护项在压缩后表面消失但不在 shadow 内：latest-user fail', () => {
  const { built, snapshot } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 11,
  });
  const post = built.postSurface.filter((seq) => seq !== 13);
  const report = verifyProtection({
    snapshot,
    summaryEvent: built.summaryEvent,
    checkpointSeq: built.checkpointSeq,
    postSurfaceNodes: post,
    adapterKind: 'host-basic',
  });
  assert.equal(report.checks.find((item) => item.name === 'latest-user-message').status, 'fail');
  assert.match(report.checks.find((item) => item.name === 'latest-user-message').detail, /disappeared/);
});

test('summary 事件缺失：artifact fail，仍不抛错', () => {
  const { built, snapshot } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 11,
  });
  const report = verifyProtection({
    snapshot,
    summaryEvent: undefined,
    checkpointSeq: built.checkpointSeq,
    postSurfaceNodes: built.postSurface,
    adapterKind: 'host-basic',
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'artifact').status, 'fail');
  assert.equal(report.checks.find((item) => item.name === 'summary-readable').status, 'warn');
});

test('报告不含消息正文或路径', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 11,
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('继续 T3'), false);
  assert.equal(serialized.includes('D:\\\\backup'), false);
  assert.equal(serialized.includes('511/958'), false);
});

test('expectedSurface：去掉 shadow 区间并在原位置插入 checkpoint', () => {
  const nodes = [0, 1, 2, 3, 4, 5, 6];
  assert.deepEqual(expectedSurface({ nodes }, [2, 3, 4], 99), [0, 1, 99, 5, 6]);
  assert.deepEqual(expectedSurface({ nodes }, [], null), nodes);
});

test('summaryTextOf 支持字符串与文本块', () => {
  assert.equal(summaryTextOf({ data: { summary: 'abc' } }), 'abc');
  assert.equal(summaryTextOf({ data: { summary: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb');
  assert.equal(summaryTextOf({}), '');
});

test('手动压缩吞掉最新用户（真实日志模式）：latest-user fail，其余不受影响', () => {
  const { report } = reportFor({
    before: healthyMessages(),
    summary: FIVE_SECTION_SUMMARY,
    start: 13,
    end: 13,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((failure) => failure.name), ['latest-user-message']);
  assert.equal(report.checks.find((check) => check.name === 'tool-pairing').status, 'pass');
});

test('工具配对：保留尾部仍 balanced 时通过', () => {
  // 尾部的调用与结果都在 shadow 之外；压缩只覆盖前半段。
  const before = [
    ...healthyMessages(),
    assistantToolCall(14, 'call-9'),
    toolResult(15, 'call-9'),
    assistantText(16, 'done'),
  ];
  const { report } = reportFor({
    before,
    summary: FIVE_SECTION_SUMMARY,
    start: 2,
    end: 11,
  });
  assert.equal(report.checks.find((item) => item.name === 'tool-pairing').status, 'pass');
});

test('空表面/无消息也能返回报告而不抛错', () => {
  const session = fakeSession([], []);
  const snapshot = snapshotProtection(session);
  const summaryEvent = compactionSummary(101, 'cmp-empty', {
    summary: FIVE_SECTION_SUMMARY,
    start: 1,
    end: 2,
    shadowedSeqs: [],
  });
  const report = verifyProtection({
    snapshot,
    summaryEvent,
    checkpointSeq: checkpoint(102, 'cmp-empty').seq,
    postSurfaceNodes: [102],
    adapterKind: 'host-basic',
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.name === 'artifact').status, 'fail');
  assert.equal(report.checks.find((item) => item.name === 'latest-user-message').status, 'skip');
});
