// N6 取数：rc.3 重启后窗口（--since）
// 口径：ids 全可解析（protection-write.ids 对 memory 层 MEMORY.md）；
//       moved=requested 或差额必有 protection-entry-missing；
//       同日 ID 严格递增；pending→verified 成对。
// 用法：node tests\repro-021\n6-check.mjs --since 2026-11-15T01:25:21Z
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let since = '';
let files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') { since = args[++i]; continue; }
  files.push(args[i]);
}
if (!since) { console.error('usage: n6-check.mjs --since <ISO> [audit...]'); process.exit(2); }
if (files.length === 0) files = ['G:/DS-HARNESS/memory/governance/audit.jsonl', 'D:/DS-PROJECT/DSH插件开发/memory/governance/audit.jsonl'];
const memFor = (f) => (f.includes('DS-HARNESS') ? 'G:/DS-HARNESS/memory/governance/MEMORY.md' : 'D:/DS-PROJECT/DSH插件开发/memory/governance/MEMORY.md');

const rows = [];
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`MISSING ${f}`); continue; }
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    rows.push({ file: f, e });
  }
}
rows.sort((a, b) => String(a.e.ts).localeCompare(String(b.e.ts)));
const post = rows.filter((r) => String(r.e.ts) > since);
console.log(`since=${since} postRows=${post.length} (files: ${files.length})`);

const writes = post.filter((r) => r.e.event === 'protection-write' && Array.isArray(r.e.ids));
const typed = post.filter((r) => r.e.event === 'protection-materialized');
const missingEvents = post.filter((r) => r.e.event === 'protection-entry-missing');
console.log(`protection-write=${writes.length} protection-materialized=${typed.length} protection-entry-missing=${missingEvents.length}`);
if (writes.length === 0) { console.log('NO protection-write after boundary — 等待用户 /compact'); process.exit(0); }

// 1) ids 解析
for (const w of writes) {
  const mem = memFor(w.file);
  const doc = fs.existsSync(mem) ? fs.readFileSync(mem, 'utf8') : '';
  const unresolved = w.e.ids.filter((id) => !doc.includes(id));
  console.log(`  compaction=${String(w.e.compactionId || '').slice(0, 8)} ids=${JSON.stringify(w.e.ids)} unresolved=${JSON.stringify(unresolved)}`);
}

// 2) moved vs requested
for (const w of writes) {
  const cid = w.e.compactionId;
  const mv = typed.find((t) => t.e.compactionId === cid);
  const requested = Number.isFinite(w.e.count) ? w.e.count : w.e.ids.length;
  const moved = mv ? (Number.isFinite(mv.e.moved) ? mv.e.moved : null) : null;
  const miss = missingEvents.filter((m) => m.e.compactionId === cid).length;
  const ok = moved === requested || (moved !== null && moved < requested && miss > 0);
  console.log(`  moved-check compaction=${String(cid || '').slice(0, 8)} requested=${requested} moved=${moved} missingEvents=${miss} => ${ok ? 'PASS' : 'FAIL'}`);
}

// 3) 同日 ID 严格递增
const byDate = {};
for (const w of writes) for (const id of w.e.ids) {
  const m = /^MEM-(\d{8})-(\d+)$/.exec(String(id));
  if (!m) continue;
  (byDate[m[1]] = byDate[m[1]] || []).push(Number(m[2]));
}
for (const [date, nums] of Object.entries(byDate)) {
  let ok = true;
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) ok = false;
  console.log(`  id-monotonic ${date}: ${JSON.stringify(nums)} => ${ok ? 'PASS' : 'FAIL'}`);
}

// 4) pending → verified 成对
const pending = post.filter((r) => r.e.event === 'self-heal-pending');
const verified = post.filter((r) => r.e.event === 'self-heal-verified');
const missingHeal = post.filter((r) => r.e.event === 'self-heal-missing');
const key = (r) => `${r.e.compactionId || r.e.cycle || ''}|${r.e.ruleSeq ?? ''}|${r.e.kind ?? ''}`;
const vkeys = new Set([...verified, ...missingHeal].map(key));
const unpaired = pending.filter((r) => !vkeys.has(key(r)));
console.log(`self-heal-pending=${pending.length} verified=${verified.length} missing=${missingHeal.length} unpaired=${unpaired.length}`);

