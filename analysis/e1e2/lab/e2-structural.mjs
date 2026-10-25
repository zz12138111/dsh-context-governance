/**
 * E2 结构实验：用真实压缩日志回答"回注会不会被下一次压缩吞掉/重复"。
 *
 * 对每次压缩，检查"在本次 checkpoint 之后立刻注入的一条短消息"（seq = checkpoint + k）
 * 是否落在下一次压缩的 shadowedRange 内。落在范围内 = 下一次压缩会把它换成摘要
 * （结构上必然"被吞"）；不在范围内 = 它会留在保留尾部（有重复注入的风险）。
 *
 * 用法：node e2-structural.mjs <compaction-inventory.json> [输出 json]
 */
import fs from 'node:fs';
import path from 'node:path';

const INPUT = process.argv[2];
const OUT = process.argv[3] ?? path.join(path.dirname(INPUT), 'e2-structural.json');
if (INPUT === undefined) {
  console.error('usage: node e2-structural.mjs <compaction-inventory.json> [out.json]');
  process.exit(2);
}

const inventory = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const pairs = [];
const singleCompactions = [];
for (const row of inventory) {
  const list = [...row.compactions].sort((a, b) => a.summarySeq - b.summarySeq);
  for (let index = 0; index < list.length; index += 1) {
    const current = list[index];
    const next = list[index + 1];
    const checkpoint = current.checkpointSeq ?? current.endSeq - 1;
    if (next === undefined) {
      singleCompactions.push({
        session: row.session,
        workspace: row.workspace,
        compactionId: current.compactionId,
        manual: current.manual,
        shadowedRange: current.shadowedRange,
        checkpointSeq: checkpoint,
      });
      continue;
    }
    const nextStart = next.shadowedRange?.start ?? null;
    const nextEnd = next.shadowedRange?.end ?? null;
    const injectionSeq = checkpoint + 1;
    const insideNextShadow = nextStart !== null && nextEnd !== null &&
      injectionSeq >= nextStart && injectionSeq <= nextEnd;
    pairs.push({
      session: row.session,
      workspace: row.workspace,
      previous: {
        compactionId: current.compactionId,
        manual: current.manual,
        shadowedRange: current.shadowedRange,
        checkpointSeq: checkpoint,
        summarySeq: current.summarySeq,
        endSeq: current.endSeq,
      },
      next: {
        compactionId: next.compactionId,
        manual: next.manual,
        shadowedRange: next.shadowedRange,
        startEventSeq: next.startEventSeq,
      },
      injectionSeq,
      insideNextShadow,
      nextStartsAtPreviousCheckpoint: nextStart === checkpoint,
      gapEvents: next.startEventSeq === null ? null : next.startEventSeq - current.endSeq,
    });
  }
}

const report = {
  experiment: 'E2 结构实验：回注是否被下一次压缩吞掉',
  method: [
    '读取本机会话日志中的 compaction/summary.shadowedRange 与 checkpoint user/message seq',
    '假设治理层在 checkpoint 后立刻注入一条短消息（seq = checkpoint + 1）',
    '判断该 seq 是否落在下一次压缩的 shadowedRange 内',
  ],
  sessionsWithPair: new Set(pairs.map((pair) => pair.session)).size,
  pairs: pairs.length,
  insideNextShadow: pairs.filter((pair) => pair.insideNextShadow).length,
  nextStartsAtPreviousCheckpoint: pairs.filter((pair) => pair.nextStartsAtPreviousCheckpoint).length,
  singletonCompactions: singleCompactions.length,
  details: pairs,
  singletons: singleCompactions,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

for (const pair of pairs) {
  console.log(
    `${pair.session.slice(0, 18)} checkpoint=${pair.previous.checkpointSeq} ` +
    `inject=${pair.injectionSeq} nextShadow=[${pair.next.shadowedRange?.start}..${pair.next.shadowedRange?.end}] ` +
    `swallowed=${pair.insideNextShadow} nextStart==checkpoint=${pair.nextStartsAtPreviousCheckpoint}`,
  );
}
console.log(`pairs=${report.pairs} swallowed=${report.insideNextShadow} nextStartsAtCheckpoint=${report.nextStartsAtPreviousCheckpoint} singletons=${report.singletonCompactions}`);
console.log(`out=${OUT}`);
