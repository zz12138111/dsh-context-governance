import fs from 'node:fs';
const SYNTH = new Set(['77479b72', 'b66e56e5', 'e728a6c7', '8c33bbae', '92e4bc49', 'fd638b4b', 'c75bd463', '09062c2f', '6d54098c']);
const lines = fs.readFileSync('post-compaction-turns.txt', 'utf8').split('\n');
const rows = lines.filter(l => /comp@/.test(l)).filter(l => {
  const sid = l.split(' ')[0];
  const uuidPart = sid.replace('session-', '').split('-')[0];
  return !SYNTH.has(uuidPart);
});
console.log('real_compaction_ends =', rows.length);
const early = rows.filter(r => r.includes('src=early-auto'));
console.log('real_early_auto_ends =', early.length);
const withSys = rows.filter(r => !r.includes('nextSys=null'));
console.log('followed_by_next_turn_system_message =', withSys.length);
let bad = 0;
for (const r of withSys) {
  const m = r.match(/nextSys=\{"seq":(\d+),"turn":([^}]*)\}/);
  if (!m) { bad++; console.log('  unparsed:', r.slice(0, 160)); continue; }
  if (!/^\d+$/.test(m[2])) { bad++; console.log('  BAD:', r.slice(0, 200)); }
}
console.log('invalid_turn =', bad);
const srcCounts = {};
for (const r of rows) {
  const m = r.match(/src=([^ ]+)/);
  const k = m ? m[1] : '?';
  srcCounts[k] = (srcCounts[k] || 0) + 1;
}
const early18 = Object.entries(srcCounts).filter(([k]) => k === 'early-auto');
console.log('early_auto =', JSON.stringify(early18));
const manual = rows.length - (srcCounts['early-auto'] || 0) - (srcCounts['undefined'] || 0);
console.log('manual_or_command_sourced =', manual);
