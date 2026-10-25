/**
 * REQ-20261025-05 / 0.1.14 真实快照 A/B 回放（离线，不启动插件、不碰安装态）。
 *
 * 快照来源：会话 session-58a2e845 的真实压缩周期 summarySeq=11509（shadowedRange 8538–11499）。
 * 本文件只抽取 batch 判定相关的候选事件与真实摘要，未改正文（见 ./real/snapshot-11509.json）。
 *
 * 三列对照：
 *   0.1.12 = `git show 2cea1ca^:…/protection.js`
 *   0.1.13 = `git show 2cea1ca:…/protection.js`
 *   0.1.14 = 工作区 `src/compress/protection.js`
 *
 * 用法：node analysis/req-20261025-05/replay-real.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'real', 'snapshot-11509.json'), 'utf8'));

const CANDIDATES = fixture.candidates;
const SUMMARY_SEQ = fixture.cycle.summarySeq;
const CHECKPOINT_SEQ = 11600;

function materialize(rev) {
  const source = execFileSync(
    'git',
    ['-C', repo, 'show', `${rev}:packages/dsh-context-governance/src/compress/protection.js`],
    { encoding: 'utf8' },
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-014-'));
  const file = path.join(dir, `protection-${rev.replace(/[^\w.^-]/g, '_')}.js`);
  fs.writeFileSync(file, source);
  return pathToFileURL(file).href;
}

const VERSIONS = [
  { name: '0.1.12', moduleUrl: materialize('2cea1ca^') },
  { name: '0.1.13', moduleUrl: materialize('2cea1ca') },
  { name: '0.1.14', moduleUrl: pathToFileURL(path.join(repo, 'packages/dsh-context-governance/src/compress/protection.js')).href },
];

function toEvent(candidate) {
  if (candidate.type === 'assistant/message') {
    return {
      seq: candidate.seq,
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: candidate.text }], source: { kind: 'model' } } },
    };
  }
  if (candidate.type === 'tool/result') {
    return {
      seq: candidate.seq,
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: candidate.text }], source: { kind: 'tool', callId: 'call-real' } }, meta: { callId: 'call-real' } },
    };
  }
  return {
    seq: candidate.seq,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: candidate.text }], source: { kind: candidate.source ?? 'user' } },
  };
}

function buildSurface(candidates) {
  const supportUser = {
    seq: 6000,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '继续执行。' }], source: { kind: 'user' } },
  };
  const checkpoint = {
    seq: CHECKPOINT_SEQ,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span.' }], source: { kind: 'compact-checkpoint', compactionId: 'real-11509' } },
  };
  const events = [supportUser, ...candidates.map(toEvent), checkpoint];
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const nodes = events.map((event) => event.seq);
  const summaryEvent = {
    seq: SUMMARY_SEQ,
    type: 'compaction/summary',
    data: {
      compactionId: 'real-11509',
      summary: [{ type: 'text', text: fixture.summaryText }],
      shadowedRange: fixture.cycle.shadowedRange,
      shadowedSeqs: fixture.cycle.shadowedSeqs,
    },
  };
  return {
    session: { surface: { nodes }, eventAt: (seq) => bySeq.get(seq) },
    summaryEvent,
    postSurfaceNodes: nodes.filter((seq) => seq === 6000 || !fixture.cycle.shadowedSeqs.includes(seq)),
  };
}

async function evaluate(moduleUrl, surface) {
  const mod = await import(moduleUrl);
  const snapshot = mod.snapshotProtection(surface.session);
  const report = mod.verifyProtection({
    snapshot,
    summaryEvent: surface.summaryEvent,
    checkpointSeq: CHECKPOINT_SEQ,
    postSurfaceNodes: surface.postSurfaceNodes,
    adapterKind: 'host',
  });
  const check = report.checks.find((item) => item.name === 'batch-list');
  return {
    picked: snapshot.batch === null ? null : { seq: snapshot.batch.seq, ratios: snapshot.batch.ratios, keyword: snapshot.batch.keyword },
    rejected: snapshot.batchRejected == null ? null : { seq: snapshot.batchRejected.seq, ratios: snapshot.batchRejected.ratios },
    status: check.status,
    reason: check.reason ?? '-',
    loss: report.failures.some((item) => item.name === 'batch-list'),
  };
}

const prefixCandidates = CANDIDATES.filter((item) => item.seq <= 11479);
const fullCandidates = CANDIDATES;

const surfaces = [
  { name: 'A：表面截至 seq=11479（评审口径）', candidates: prefixCandidates },
  { name: 'B：完整周期（含 11487 等后续候选）', candidates: fullCandidates },
];

const rows = [];
for (const surface of surfaces) {
  for (const version of VERSIONS) {
    const result = await evaluate(version.moduleUrl, buildSurface(surface.candidates));
    rows.push({ surface: surface.name, version: version.name, ...result });
  }
}

console.log(`真实快照：summarySeq=${SUMMARY_SEQ} range=${fixture.cycle.shadowedRange.start}-${fixture.cycle.shadowedRange.end} shadowedSeqs=${fixture.cycle.shadowedSeqs.length} summaryLen=${fixture.summaryText.length}`);
console.log('关键字口径：0.1.12/0.1.13 = 批次|batch；0.1.14 = 批次|进度|progress|batch（且必须与比例同消息）。');
console.log('');
for (const surface of surfaces) {
  console.log(surface.name);
  for (const row of rows.filter((item) => item.surface === surface.name)) {
    console.log(
      `  ${row.version}  batch-list=${row.status}${row.reason === '-' ? '' : ` reason=${row.reason}`}  picked=` +
      `${row.picked === null ? 'null' : `seq ${row.picked.seq} ratios=${JSON.stringify(row.picked.ratios)}`}` +
      `${row.rejected === null ? '' : `  rejected=seq ${row.rejected.seq} ratios=${JSON.stringify(row.rejected.ratios)}`}` +
      `${row.loss ? '  [进入 failures/manual-compaction-loss]' : ''}`,
    );
  }
  console.log('');
}
const bad = rows.filter((row) => row.version === '0.1.14' && row.loss);
console.log(
  bad.length === 0
    ? '结论：0.1.14 两个表面都判 skip(no-batch-semantics)，均未进入 failures（不会写 manual-compaction-loss）；0.1.12 的 pass 是 ratios=[] 空泛通过；0.1.13 的 fail 正是本单要修的假阳性。'
    : `结论：0.1.14 仍有 ${bad.length} 行进入 failures。`,
);
