// rc.2 复跑取数：以重启后（apply version=1.1.0 晚于重启时刻）为界，只统计 rc.2 进程的 compactionId。
// 用法：node tests\repro-021\rc2-window.mjs [audit.jsonl...] [--since 2026-11-15T12:00:00Z]
import fs from 'node:fs';

const args = process.argv.slice(2);
let since = '';
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') { since = args[++i]; continue; }
  files.push(args[i]);
}
if (files.length === 0) files.push('G:/DS-HARNESS/memory/governance/audit.jsonl', 'D:/DS-PROJECT/DSH插件开发/memory/governance/audit.jsonl');

const rows = [];
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`MISSING ${f}`); continue; }
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    rows.push({ file: f.includes('DS-HARNESS') ? 'G' : 'D', e });
  }
}
rows.sort((a, b) => String(a.e.ts).localeCompare(String(b.e.ts)));

// 重启界：显式 --since 优先；否则取最后一次 apply version=1.1.0
const applies = rows.filter((r) => r.e.event === 'apply' && r.e.version === '1.1.0');
if (applies.length === 0) { console.log('no apply version=1.1.0 found'); process.exit(1); }
const lastApply = applies[applies.length - 1];
const boundary = since || lastApply.e.ts;
console.log(`boundary=${boundary} (${since ? 'explicit --since' : 'last apply 1.1.0'})`);
for (const a of applies.slice(-4)) console.log(`  apply ${a.e.ts} version=${a.e.version} host=${String(a.e.host || '')}`);

const after = rows.filter((r) => String(r.e.ts) > String(boundary));
const before = rows.filter((r) => String(r.e.ts) <= String(boundary));
const bad = (r) => r.e.event === 'compaction-loss' && ((r.e.failures || []).includes('rule-injection') || r.e.reason === 'baseline-stale');
console.log(`rowsAfterBoundary=${after.length} rowsBefore=${before.length}`);
const lossAfter = after.filter((r) => r.e.event === 'compaction-loss');
const badAfter = lossAfter.filter(bad);
console.log(`post-restart compaction-loss=${lossAfter.length} (rule-injection/baseline-stale=${badAfter.length})`);
const rbAfter = after.filter((r) => String(r.e.event || '').startsWith('surface-rebuild'));
console.log(`post-restart surface-rebuild-*=${rbAfter.length}`);
const lossesBefore = before.filter((r) => bad(r));
console.log(`pre-restart(rc.1) 剔除计数: rule-injection/baseline-stale loss=${lossesBefore.length}`);

const cycles = {};
for (const r of after) {
  const id = r.e.compactionId || r.e.cycle;
  if (!id) continue;
  if (!/compaction-loss|compaction-cost|self-heal|surface-rebuild|protection-write/.test(r.e.event)) continue;
  (cycles[id] = cycles[id] || []).push(r.e);
}
const ids = Object.keys(cycles);
console.log(`post-restart cycles=${ids.length}`);
for (const id of ids) {
  const rs = cycles[id];
  const kinds = {};
  for (const r of rs) kinds[r.event] = (kinds[r.event] || 0) + 1;
  const lossRule = rs.filter((r) => r.event === 'compaction-loss' && (r.failures || []).includes('rule-injection')).length;
  console.log(`  ${id} lastTs=${rs[rs.length - 1].ts} rows=${rs.length} ${JSON.stringify(kinds)} lossRuleInjection=${lossRule}`);
}
