#!/usr/bin/env node
// Classify every shadowed system/message rule as a (regenerable) / b (not) / skip-empty.
// Rules (executable discriminant, C34③):
//  - skip-empty : rule text is empty -> protection.js skips it anyway, nothing lost
//  - a-superseded: another system/message shadowed by the SAME compaction with a larger seq
//                  (the older revision is obsolete; the newer one carries the content)
//  - a-reemitted : the first system/message written AFTER compaction/end has identical text
//                  (sha256 equal) or contains the rule text
//  - b           : none of the above (default strict; sub-tag b-no-next when no later system/message)
// Usage: node classify-a-b.mjs <sessionsRoot>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const root = process.argv[2];
const MAGIC = 0xfd2fb528;
function frameEnd(buf, s) {
  if (buf.readUInt32LE(s) !== MAGIC) {
    const m = buf.readUInt32LE(s) & 0xfffffff0;
    if (m === 0x184d2a50) return s + 8 + buf.readUInt32LE(s + 4);
    throw new Error('not zstd');
  }
  let p = s + 4;
  const f = buf[p++];
  const fcs = f >> 6, single = (f >> 5) & 1, ck = (f >> 2) & 1, dict = f & 3;
  if (!single) p += 1;
  p += [0, 1, 2, 4][dict];
  p += fcs === 0 ? (single ? 1 : 0) : fcs === 1 ? 2 : fcs === 2 ? 4 : 8;
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1, bt = (h >> 1) & 3, bs = h >> 3;
    if (bt === 0 || bt === 2) p += bs; else if (bt === 1) p += 1; else throw new Error('reserved');
    if (last) break;
  }
  if (ck) p += 4;
  return p;
}
function load(f) {
  const buf = fs.readFileSync(f);
  let p = 0, t = '';
  while (p < buf.length) { const e = frameEnd(buf, p); t += zlib.zstdDecompressSync(buf.subarray(p, e)).toString('utf8'); p = e; }
  return t.split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const textOf = (e) => {
  const d = e.data || {};
  const m = d.message || d;
  const c = m.content || [];
  return Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('') : '';
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const files = [];
(function walk(dir, depth) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (depth < 2) walk(p, depth + 1); } else if (ent.name.endsWith('.zstd')) files.push(p);
  }
})(root, 0);

const rows = [];
for (const f of files) {
  const dirName = path.basename(path.dirname(path.dirname(f)));
  if (/dsh-repro/i.test(dirName)) continue; // skip this session's synthetic temp sessions
  let evs;
  try { evs = load(f); } catch { continue; }
  const sid = path.basename(path.dirname(f));
  const sys = evs.filter(e => e.type === 'system/message');
  if (!sys.length) continue;
  for (let i = 0; i < evs.length; i++) {
    const c = evs[i];
    if (c.type !== 'compaction/summary') continue;
    const shadowed = new Set(c.data?.shadowedSeqs || []);
    const rules = sys.filter(e => shadowed.has(e.seq));
    if (!rules.length) continue;
    // first system/message after this compaction/end
    let nextSys = null;
    for (let j = i + 1; j < evs.length; j++) {
      if (evs[j].type === 'system/message') { nextSys = evs[j]; break; }
    }
    const nextText = nextSys ? textOf(nextSys) : null;
    for (const rule of rules) {
      const text = textOf(rule);
      let klass, evidence;
      if (text === '') { klass = 'skip-empty'; evidence = 'text=""'; }
      else if (rules.some(o => o.seq > rule.seq)) {
        klass = 'a-superseded';
        const newer = rules.filter(o => o.seq > rule.seq).map(o => o.seq).join(',');
        evidence = `newer same-compaction system/message seq=${newer}`;
      } else if (nextSys === null) { klass = 'b-no-next'; evidence = 'no system/message after compaction/end'; }
      else if (nextText !== null && sha(nextText) === sha(text)) { klass = 'a-reemitted'; evidence = `next system/message seq=${nextSys.seq} identical (sha ${sha(text).slice(0, 12)})`; }
      else if (nextText !== null && nextText.includes(text)) { klass = 'a-reemitted'; evidence = `next system/message seq=${nextSys.seq} contains rule text`; }
      else { klass = 'b'; evidence = `next seq=${nextSys ? nextSys.seq : '-'} differs (sha ${sha(text).slice(0, 12)} vs ${nextText ? sha(nextText).slice(0, 12) : '-'})`; }
      rows.push({ sid, compSeq: c.seq, src: c.data?.sourceCommandId ?? 'auto', ruleSeq: rule.seq, len: text.length, klass, evidence });
    }
  }
}

console.log(`total_shadowed_system_rules=${rows.length}`);
const counts = {};
for (const r of rows) counts[r.klass] = (counts[r.klass] || 0) + 1;
console.log('counts=' + JSON.stringify(counts));
for (const r of rows) {
  console.log(`${r.sid} comp@${r.compSeq}(${r.src}) rule@${r.ruleSeq} len=${r.len} -> ${r.klass} :: ${r.evidence}`);
}
