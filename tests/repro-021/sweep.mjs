#!/usr/bin/env node
// Read-only sweep: per-session turn outcomes, compaction events, system/message turn values.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.argv[2];
const MAGIC = 0xfd2fb528;

function frameEnd(buf, start) {
  if (buf.readUInt32LE(start) !== MAGIC) {
    const m = buf.readUInt32LE(start) & 0xfffffff0;
    if (m === 0x184d2a50) return start + 8 + buf.readUInt32LE(start + 4);
    throw new Error('not zstd');
  }
  let p = start + 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!single) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const btype = (h >> 1) & 3;
    const bsize = h >> 3;
    if (btype === 0 || btype === 2) p += bsize;
    else if (btype === 1) p += 1;
    else throw new Error('reserved');
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

function decodeAll(buf) {
  const frames = [];
  let p = 0;
  while (p < buf.length) { const e = frameEnd(buf, p); frames.push([p, e]); p = e; }
  let text = '';
  for (const [s, e] of frames) text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
  return text;
}

const files = [];
(function walk(dir, depth) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
    else if (ent.name.endsWith('.zstd')) files.push(p);
  }
})(root, 0);
files.sort();

for (const f of files) {
  let text;
  try { text = decodeAll(fs.readFileSync(f)); } catch (e) { console.log(`SKIP ${f} (${e.message})`); continue; }
  const sid = path.basename(path.dirname(f));
  const evs = [];
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue;
    try { evs.push(JSON.parse(ln)); } catch {}
  }
  if (!evs.length) continue;
  const reasons = {};
  const systems = [];
  const compactions = [];
  let badSystemTurn = 0;
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if (ev.type === 'turn/end') {
      const k = JSON.stringify(ev.data && ev.data.reason || {}).slice(0, 80);
      reasons[k] = (reasons[k] || 0) + 1;
    } else if (ev.type === 'system/message') {
      const t = ev.data && ev.data.turn;
      const okTurn = typeof t === 'number' && Number.isSafeInteger(t) && t >= 0;
      if (!okTurn) badSystemTurn++;
      const next = evs.slice(i + 1, i + 4).map(x => x.type).join(',');
      systems.push({ seq: ev.seq, turn: t, okTurn, next });
    } else if (ev.type === 'compaction/start') {
      compactions.push({ i, seq: ev.seq, sid: ev.data && ev.data.sourceCommandId, turn: ev.data && ev.data.turn, next: evs.slice(i + 1, i + 6).map(x => x.type + (x.type === 'compaction/end' && x.data && 'turn' in x.data ? `(turn=${JSON.stringify(x.data.turn)})` : '')).join(',') });
    }
  }
  const nonCompleted = Object.entries(reasons).filter(([k]) => !k.includes('completed'));
  console.log(`\n=== ${sid} events=${evs.length} systems=${systems.length} badSystemTurn=${badSystemTurn} compactions=${compactions.length}`);
  console.log(`  turnEnd: ${JSON.stringify(reasons)}`);
  for (const c of compactions) console.log(`  compaction seq=${c.seq} src=${c.sid} turn=${JSON.stringify(c.turn)} | ${c.next}`);
  for (const s of systems.slice(0, 20)) console.log(`  system seq=${s.seq} turn=${JSON.stringify(s.turn)} ok=${s.okTurn} next=${s.next}`);
}
