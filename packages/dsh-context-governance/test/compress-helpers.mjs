/**
 * T3 测试夹具：合成 DSH 会话事件，形状对齐 0.2.1-rc.2 的真实日志。
 * 只用于测试；不含真实会话内容。
 */
import { expectedSurface } from '../src/compress/protection.js';

export function event(seq, type, data = {}, extra = {}) {
  return { seq, type, time: 1790000000000 + seq, data, ...extra };
}

const text = (value) => [{ type: 'text', text: value }];

export function systemPrompt(seq, content = 'SYSTEM PROMPT') {
  return event(seq, 'system/message', {
    turn: 1,
    step: 1,
    message: { role: 'system', content: text(content), source: { kind: 'system-prompt' } },
  });
}

export function agentInstructions(seq, content = 'AGENTS.md rules') {
  return event(seq, 'user/message', {
    role: 'user',
    content: text(content),
    source: { kind: 'agent-instructions', form: 'instructions' },
  });
}

export function skillCatalog(seq, content = 'skill catalog') {
  return event(seq, 'user/message', {
    role: 'user',
    content: text(content),
    source: { kind: 'skill-catalog', form: 'catalog' },
  });
}

export function userMessage(seq, content, sourceKind = 'user') {
  return event(seq, 'user/message', {
    role: 'user',
    content: text(content),
    source: { kind: sourceKind },
  });
}

export function assistantText(seq, content = 'ok') {
  return event(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: text(content), source: { provider: 'test', model: 'test' } },
  });
}

export function assistantToolCall(seq, callId, name = 'pwsh') {
  return event(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: `call ${name}` },
        { type: 'tool-call', id: callId, name, arguments: { command: 'echo ok' } },
      ],
      source: { provider: 'test', model: 'test' },
    },
  });
}

export function toolResult(seq, callId) {
  return event(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: text('ok'), source: { kind: 'tool', callId } },
    meta: { callId },
  });
}

export function compactionStart(seq, compactionId, { manual = false } = {}) {
  return event(seq, 'compaction/start', {
    compactionId,
    turn: null,
    ...(manual ? { sourceCommandId: 'cmd-test' } : {}),
  });
}

export function compactionSummary(seq, compactionId, {
  summary,
  start,
  end,
  shadowedSeqs,
  shadowedTokenCount = 1000,
} = {}) {
  return event(seq, 'compaction/summary', {
    compactionId,
    summary: typeof summary === 'string' ? text(summary) : summary,
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount,
    provider: 'test',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20 },
  });
}

export function checkpoint(seq, compactionId) {
  return event(seq, 'user/message', {
    role: 'user',
    content: text('This is an automatically generated checkpoint condensing an earlier span.'),
    source: { kind: 'compact-checkpoint', compactionId },
  });
}

export function compactionEnd(seq, compactionId, error = undefined) {
  return event(seq, 'compaction/end', {
    compactionId,
    ...(error === undefined ? {} : { error }),
  });
}

/**
 * @param {object[]} events 全部日志事件。
 * @param {number[]} surfaceNodes 压缩前 surface 的 seq 顺序。
 */
export function fakeSession(events, surfaceNodes) {
  const bySeq = new Map(events.map((item) => [item.seq, item]));
  const session = {
    id: 'session-t3-fixture',
    surface: {
      nodes: [...surfaceNodes],
      contentGeneration: 1,
      replaceGeneration: 0,
    },
    eventAt(seq) {
      return bySeq.get(seq);
    },
  };
  return session;
}

/**
 * 一次完整压缩：返回 {session, events, snapshot, summaryEvent, checkpointSeq, postSurface}。
 */
export function buildCompaction({
  compactionId = 'cmp-1',
  startSeq = 100,
  summarySeq = 101,
  checkpointSeq = 102,
  endSeq = 103,
  summary = '',
  start = 2,
  end = 11,
  shadowedSeqs,
  before = [],
  source = 'host',
  manual = false,
}) {
  const events = [...before];
  const nodes = before.map((item) => item.seq);
  const summaryEvent = compactionSummary(summarySeq, compactionId, {
    summary,
    start,
    end,
    shadowedSeqs: shadowedSeqs ?? nodes.filter((seq) => seq >= start && seq <= end),
  });
  events.push(compactionStart(startSeq, compactionId, { manual }), summaryEvent, checkpoint(checkpointSeq, compactionId), compactionEnd(endSeq, compactionId));
  const session = fakeSession(events, nodes);
  const postSurface = expectedSurface(
    { nodes: [...nodes] },
    summaryEvent.data.shadowedSeqs,
    checkpointSeq,
  );
  return {
    compactionId,
    source,
    events,
    session,
    summaryEvent,
    checkpointSeq,
    postSurface,
    summarySeq,
    startSeq,
    endSeq,
  };
}

export function healthyMessages() {
  return [
    systemPrompt(0),
    agentInstructions(1),
    userMessage(2, '把 E1/E2 前置门禁跑完。'),
    assistantToolCall(3, 'call-1'),
    toolResult(4, 'call-1'),
    assistantText(5, 'E1 结论已出。'),
    userMessage(6, '继续 T3。'),
    assistantToolCall(7, 'call-2'),
    toolResult(8, 'call-2'),
    userMessage(9, '批次 511/958 已完成。'),
    userMessage(10, '回滚点：D:\\backup\\pre-t3.zip'),
    assistantText(11, '收到。'),
    assistantText(12, '准备下一步。'),
    userMessage(13, '最新一条用户消息：继续。'),
  ];
}

export const FIVE_SECTION_SUMMARY = [
  '## Goal and intent',
  '完成 T3 压缩适配与保护。',
  '',
  '## Decisions',
  '- 事件级感知；不替换 provider。',
  '',
  '## Current state',
  '批次 511/958 已完成；回滚点 D:\\backup\\pre-t3.zip；最新用户要求继续。',
  '',
  '## Next steps',
  '- 写 Runbook。',
  '',
  '## Anchors',
  '- D:\\backup\\pre-t3.zip',
].join('\n');

export const FREE_FORM_SUMMARY = [
  'Current state: 批次 511/958 已完成。',
  '回滚点：D:\\backup\\pre-t3.zip。',
  '最新用户要求继续 T3。',
].join('\n');
