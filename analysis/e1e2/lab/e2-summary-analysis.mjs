/**
 * E2 辅助：真实压缩摘要的"可读性/结构化保留"统计。
 *
 * 输入是临时目录里导出的摘要索引（含每篇摘要的文件路径），
 * 输出只保留聚合数字与"是否出现某类结构化标记"，不复制摘要正文。
 *
 * 用法：node e2-summary-analysis.mjs <summaries-index.json> [out.json]
 */
import fs from 'node:fs';
import path from 'node:path';

const INPUT = process.argv[2];
const OUT = process.argv[3] ?? path.join(path.dirname(INPUT), '..', 'e2-summary-analysis.json');
if (INPUT === undefined) {
  console.error('usage: node e2-summary-analysis.mjs <summaries-index.json> [out.json]');
  process.exit(2);
}
const index = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

const rows = index.map((item) => {
  const summary = fs.readFileSync(item.savePath, 'utf8');
  return {
    sections: item.sections.length,
    chars: summary.length,
    decIds: (summary.match(/\bDEC-[A-Za-z0-9-]+/g) ?? []).length,
    artIds: (summary.match(/\bART-[A-Za-z0-9-]+/g) ?? []).length,
    memIds: (summary.match(/\bMEM-\d{8}-\d{3,}\b/g) ?? []).length,
    batchRatios: (summary.match(/\b\d{2,5}\s*\/\s*\d{2,5}\b/g) ?? []).length,
    pathHits: (summary.match(/[A-Za-z]:\\[^\s，。)]+/g) ?? []).length,
    headings: item.sections,
  };
});

function aggregate(list) {
  const n = list.length;
  const sum = list.reduce((acc, row) => {
    acc.chars += row.chars;
    acc.decIds += row.decIds;
    acc.batchRatios += row.batchRatios;
    acc.pathHits += row.pathHits;
    return acc;
  }, { chars: 0, decIds: 0, batchRatios: 0, pathHits: 0 });
  return {
    n,
    charsMin: Math.min(...list.map((row) => row.chars)),
    charsMax: Math.max(...list.map((row) => row.chars)),
    charsAvg: Math.round(sum.chars / n),
    withDecisionIds: list.filter((row) => row.decIds > 0).length,
    totalDecisionIds: sum.decIds,
    withBatchRatios: list.filter((row) => row.batchRatios > 0).length,
    totalBatchRatios: sum.batchRatios,
    withWindowsPaths: list.filter((row) => row.pathHits > 0).length,
    totalWindowsPaths: sum.pathHits,
    withMemoryIds: list.filter((row) => row.memIds > 0).length,
  };
}

const five = rows.filter((row) => row.sections === 5);
const freeForm = rows.filter((row) => row.sections === 0);
const report = {
  experiment: 'E2 辅助：真实压缩摘要的可读性与结构化保留',
  source: '本机会话日志中全部 compaction/summary（16 次）',
  caveat: 'MEM-* 记忆 ID 尚未投产，本机摘要里没有该形态的样本；DEC-/ART-/批次号/路径是代理指标。',
  total: aggregate(rows),
  fiveSection: aggregate(five),
  freeForm: aggregate(freeForm),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`out=${OUT}`);
