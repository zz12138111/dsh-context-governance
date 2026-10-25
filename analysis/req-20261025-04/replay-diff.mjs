/**
 * REQ-20261025-04 / 0.1.13 证据：batch-list 改判前后对比（离线夹具，不碰真机）。
 *
 * 旧实现 = `HEAD` 的 `protection.js`（0.1.12，见 ./protection-0.1.12.js）
 * 新实现 = `packages/dsh-context-governance/src/compress/protection.js`（0.1.13）
 *
 * 用法：node analysis/req-20261025-04/replay-diff.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  FREE_FORM_SUMMARY,
  assistantText,
  assistantToolCall,
  buildCompaction,
  event,
  systemPrompt,
  userMessage,
} from '../../packages/dsh-context-governance/test/compress-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function jsonResult(seq, callId, json) {
  return event(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', content: [{ type: 'text', text: json }], source: { kind: 'tool', callId } },
    meta: { callId },
  });
}

const scenarios = [
  {
    name: '① 反例：tool 结果 JSON 含 "batch" + 511/958',
    summary: FREE_FORM_SUMMARY,
    start: 1,
    end: 5,
    before: [
      systemPrompt(0),
      userMessage(1, '继续执行。'),
      assistantToolCall(2, 'call-1'),
      jsonResult(3, 'call-1', '{"batch": "T3", "progress": "511/958", "status": "running"}'),
      userMessage(4, '收到。'),
      assistantText(5, '好。'),
      userMessage(6, '最后一条用户消息：继续。'),
    ],
  },
  {
    name: '② 反例：tool 结果 JSON 只有 "batch"、没有比例',
    summary: FREE_FORM_SUMMARY,
    start: 1,
    end: 5,
    before: [
      systemPrompt(0),
      userMessage(1, '继续执行。'),
      assistantToolCall(2, 'call-1'),
      jsonResult(3, 'call-1', '{"batch": "T3", "status": "running"}'),
      userMessage(4, '收到。'),
      assistantText(5, '好。'),
      userMessage(6, '最后一条用户消息：继续。'),
    ],
  },
  {
    name: '③ 用户消息只有“批次”关键字、没有比例',
    summary: FREE_FORM_SUMMARY,
    start: 1,
    end: 3,
    before: [
      systemPrompt(0),
      userMessage(1, '继续。'),
      userMessage(2, '批次进度：等用户确认。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ],
  },
  {
    name: '④ 正例：用户消息 511/958，摘要覆盖',
    summary: FREE_FORM_SUMMARY,
    start: 1,
    end: 3,
    before: [
      systemPrompt(0),
      userMessage(1, '继续。'),
      userMessage(2, '批次 511/958 已完成。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ],
  },
  {
    name: '⑤ 正例：用户消息 511/958，摘要不覆盖',
    summary: '继续 T3，下一步写 Runbook。',
    start: 1,
    end: 3,
    before: [
      systemPrompt(0),
      userMessage(1, '继续。'),
      userMessage(2, '批次 511/958 已完成。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ],
  },
  {
    name: '⑥ 反例：日期 2026/10/25 被旧实现当比例',
    summary: '继续 T3，下一步写 Runbook。',
    start: 1,
    end: 3,
    before: [
      systemPrompt(0),
      userMessage(1, '继续。'),
      userMessage(2, '2026/10/25 的批次：已完成。'),
      assistantText(3, '好。'),
      userMessage(4, '最后一条用户消息：继续。'),
    ],
  },
];

async function evaluate(modulePath, scenario) {
  const mod = await import(pathToFileURL(modulePath).href);
  const built = buildCompaction({
    before: scenario.before,
    summary: scenario.summary,
    start: scenario.start,
    end: scenario.end,
  });
  const snapshot = mod.snapshotProtection(built.session);
  const report = mod.verifyProtection({
    snapshot,
    summaryEvent: built.summaryEvent,
    checkpointSeq: built.checkpointSeq,
    postSurfaceNodes: built.postSurface,
    adapterKind: built.source,
  });
  const check = report.checks.find((item) => item.name === 'batch-list');
  return {
    ratios: snapshot.batch === null ? null : snapshot.batch.ratios,
    seq: snapshot.batch === null ? null : snapshot.batch.seq,
    status: check.status,
    reason: check.reason ?? '-',
  };
}

const oldPath = path.join(here, 'protection-0.1.12.js');
const newPath = path.resolve(here, '../../packages/dsh-context-governance/src/compress/protection.js');

const rows = [];
for (const scenario of scenarios) {
  const oldResult = await evaluate(oldPath, scenario);
  const newResult = await evaluate(newPath, scenario);
  rows.push({ scenario: scenario.name, oldResult, newResult });
}

const pad = (value, width) => String(value).padEnd(width);
console.log(`${pad('场景', 40)}${pad('0.1.12', 10)}${pad('0.1.13', 10)}${pad('0.1.12 ratios', 18)}${pad('0.1.13 ratios', 18)}reason`);
console.log('-'.repeat(120));
let changed = 0;
for (const row of rows) {
  if (row.oldResult.status !== row.newResult.status) changed += 1;
  console.log(
    pad(row.scenario, 40) +
    pad(row.oldResult.status, 10) +
    pad(row.newResult.status, 10) +
    pad(row.oldResult.ratios === null ? 'null' : JSON.stringify(row.oldResult.ratios), 18) +
    pad(row.newResult.ratios === null ? 'null' : JSON.stringify(row.newResult.ratios), 18) +
    row.newResult.reason,
  );
}
console.log('-'.repeat(120));
console.log(`status changed: ${changed}/${rows.length}`);
