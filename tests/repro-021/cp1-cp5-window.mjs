/**
 * 测试角色 · CP1/CP5 真机窗口取数（按 compactionId 分组 + root-unresolved 去重/不参与 loss）。
 *
 * 用法：node tests\repro-021\cp1-cp5-window.mjs --since <ISO> [audit.jsonl...]
 *   缺省审计：$USERPROFILE\.dsh\context-governance\root-audit-desktop.jsonl
 *            + <cwd>\memory\governance\audit.jsonl（当前根）
 *   （不给文件就自动拼这两份；其它根审计用显式参数追加）
 *
 * CP1 口径：两个无 `.git` 会话各 `/compact` 后，须能看到
 *   `protection-write`（保护层写入）/ `reinjection`（回注）/ `compaction-cost`（成本），
 *   且同一 `compactionId` 下三行齐全；`compaction-loss` 的 loss 为空或只含允许项。
 * CP5 口径：删掉 cwd 后 → `root-unresolved{sessionId,cwd,reason}` 每会话每 cycle ≥1、
 *   同 cycle 去重；该会话不得出现在 `compaction-loss` 的统计里（不参与 loss）。
 *
 * 只读：不写、不装、不改任何配置、不碰用户态文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};
const since = opt('--since');
if (since === '') {
  console.error('usage: cp1-cp5-window.mjs --since <ISO> [audit.jsonl...]');
  process.exit(2);
}
const explicit = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--since');
const files = explicit.length > 0 ? explicit : [
  path.join(os.homedir(), '.dsh', 'context-governance', 'root-audit-desktop.jsonl'),
  path.join(process.cwd(), 'memory', 'governance', 'audit.jsonl'),
];
const sinceMs = Date.parse(since);

const rows = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.includes('"event":"') !== true) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(String(row.ts ?? ''));
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    rows.push({ row, file: path.basename(file), line: i + 1 });
  }
}

const CP1_EVENTS = /^(protection-write|reinjection|compaction-cost|compaction-loss|early-decision|early-forced|early-forced-reconciled|compaction-skip|compaction)$/;
const groups = new Map();
const looseRows = [];
for (const item of rows) {
  if (!CP1_EVENTS.test(String(item.row.event ?? ''))) continue;
  const key = item.row.compactionId ?? item.row.cycle;
  if (key === undefined || key === null || key === '') { looseRows.push(item); continue; }
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(item);
}

console.log(`since=${since} files=${files.length} rows=${rows.length} compactionGroups=${groups.size} 无id事件=${looseRows.length}`);
if (groups.size === 0) console.log('CP1: 本窗口无"带 compactionId/cycle"的压缩类事件（未 /compact 或事件未落本根审计）');
for (const item of looseRows) {
  const r = item.row;
  console.log(`  [无id] ${r.ts} ${item.file}:${item.line} event=${r.event} sid=${r.sessionId ?? '-'} reason=${r.reason ?? '-'}`);
}

for (const [key, items] of groups) {
  const present = new Set(items.map((item) => String(item.row.event)));
  const missing = ['protection-write', 'reinjection', 'compaction-cost'].filter((event) => !present.has(event));
  console.log(`\n[compaction ${key}] rows=${items.length} 三件套缺=${missing.length === 0 ? '无' : missing.join(',')}`);
  for (const item of items) {
    const r = item.row;
    const fields = ['event', 'compactionId', 'cycle', 'sessionId', 'rootId', 'count', 'loss', 'tokens', 'reusedTokens', 'written', 'reason']
      .filter((name) => r[name] !== undefined)
      .map((name) => `${name}=${typeof r[name] === 'object' ? JSON.stringify(r[name]).slice(0, 120) : r[name]}`)
      .join(' ');
    console.log(`  ${r.ts} ${item.file}:${item.line} ${fields}`);
  }
}

// CP5：root-unresolved 每会话每 cycle ≥1、同 cycle 去重
const unresolved = rows.filter((item) => item.row.event === 'root-unresolved');
const perCycle = new Map();
for (const item of unresolved) {
  const key = `${item.row.sessionId ?? '-'}|${item.row.cycle ?? item.row.compactionId ?? '-'}`;
  perCycle.set(key, (perCycle.get(key) ?? 0) + 1);
}
console.log(`\nCP5: root-unresolved=${unresolved.length} 会话×cycle=${[...perCycle.keys()].length} 重复(>1)=${[...perCycle.values()].filter((count) => count > 1).length}`);
for (const item of unresolved) {
  const r = item.row;
  console.log(`  ${r.ts} ${item.file}:${item.line} sid=${r.sessionId ?? '-'} cycle=${r.cycle ?? '-'} reason=${r.reason ?? '-'} cwd=${r.cwd ?? '-'}`);
}
const lossRows = rows.filter((item) => item.row.event === 'compaction-loss');
const unresolvedSessions = new Set(unresolved.map((item) => item.row.sessionId).filter(Boolean));
const leaked = lossRows.filter((item) => unresolvedSessions.has(item.row.sessionId));
console.log(`CP5: compaction-loss=${lossRows.length} 其中来自 root-unresolved 会话=${leaked.length}（期望 0）`);
for (const item of leaked) {
  console.log(`  LEAK ${item.row.ts} ${item.file}:${item.line} ${JSON.stringify(item.row).slice(0, 160)}`);
}

const badLoss = lossRows.filter((item) => {
  const loss = item.row.loss ?? item.row.details?.loss;
  if (loss === undefined || loss === null) return false;
  if (typeof loss === 'string') return loss !== '' && loss !== 'none';
  if (Array.isArray(loss)) return loss.length > 0;
  return Object.keys(loss).length > 0;
});
console.log(`CP1: compaction-loss 非空=${badLoss.length}（若 >0 逐条贴给审核判定是否允许项）`);
