#!/usr/bin/env node
// Quantitative control: after every compaction/end, what turn did the next system/message get?
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.argv[2];
const MAGIC = 0xfd2fb528;
function frameEnd(buf, start) {
  let p = start + 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  if (!single) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1, btype = (h >> 1) & 3, bsize = h >> 3;
    if (btype === 0 || btype === 2) p += bsize; else if (btype === 1) p += 1; else throw new Error('reserved');
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}
function decodeAll(buf) {
  let text = '', p = 0;
  while (p < buf.length) { const e = frameEnd(buf, p); text += zlib.zstdDecompressSync(buf.subarray(p, e)).toString('utf8'); p = e; }
  return text;
}

const files = [];
(function walk(dir, depth) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (depth < 3) walk(p, depth + 1); } else if (ent.name.endsWith('.zstd')) files.push(p);
  }
})(root, 0);
files.sort();

const rows = [];
for (const f of files) {
  let evs = [];
  try { for (const ln of decodeAll(fs.readFileSync(f)).split('\n')) { if (ln.trim()) try { evs.push(JSON.parse(ln)); } catch {} } } catch { continue; }
  const sid = path.basename(path.dirname(f));
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.type !== 'compaction/end') continue;
    const src = ev.data && ev.data.sourceCommandId;
    // find the next system/message and the next turn/start after this compaction/end
    let sys = null, turnStart = null, turnEnd = null;
    for (let j = i + 1; j < evs.length; j++) {
      const n = evs[j];
      if (!sys && n.type === 'system/message') sys = { seq: n.seq, turn: n.data && n.data.turn };
      if (!turnStart && n.type === 'turn/start') turnStart = { seq: n.seq, turn: n.data && n.data.turn };
      if (!turnEnd && n.type === 'turn/end') { turnEnd = { seq: n.seq, reason: n.data && n.data.reason && n.data.reason.kind }; break; }
    }
    rows.push({ sid, compSeq: ev.seq, compTime: ev.time, src, sys, turnStart, turnEnd });
  }
}

const total = rows.length;
const withSys = rows.filter(r => r.sys);
const validSys = withSys.filter(r => typeof r.sys.turn === 'number' && Number.isSafeInteger(r.sys.turn) && r.sys.turn >= 0);
console.log(`compactions=${total} with_next_system_message=${withSys.length} valid_turn=${validSys.length} invalid=${withSys.length - validSys.length}`);
const bySrc = {};
for (const r of rows) bySrc[r.src] = (bySrc[r.src] || 0) + 1;
console.log(`by_source=${JSON.stringify(bySrc)}`);
for (const r of rows) {
  console.log(`${r.sid} comp@${r.compSeq} src=${r.src} nextSys=${JSON.stringify(r.sys)} nextTurnStart=${JSON.stringify(r.turnStart)} nextTurnEnd=${JSON.stringify(r.turnEnd)}`);
}
