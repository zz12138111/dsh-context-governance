#!/usr/bin/env node
// Find sessions whose turn/start lacks a matching turn/end (crash / truncation evidence).
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
  let text = '';
  let p = 0;
  while (p < buf.length) { const e = frameEnd(buf, p); text += zlib.zstdDecompressSync(buf.subarray(p, e)).toString('utf8'); p = e; }
  return text;
}

const files = [];
(function walk(dir, depth) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
    else if (ent.name.endsWith('.zstd')) files.push(p);
  }
})(root, 0);
files.sort();

for (const f of files) {
  let evs = [];
  try {
    const text = decodeAll(fs.readFileSync(f));
    for (const ln of text.split('\n')) { if (!ln.trim()) continue; try { evs.push(JSON.parse(ln)); } catch {} }
  } catch (e) { console.log(`SKIP ${f} ${e.message}`); continue; }
  const sid = path.basename(path.dirname(f));
  const open = [];
  let mismatches = 0;
  const tail = evs.slice(-3).map(e => `${e.seq}:${e.type}`).join(' ');
  for (const ev of evs) {
    if (ev.type === 'turn/start') open.push(ev.seq);
    else if (ev.type === 'turn/end') { if (open.length) open.shift(); else mismatches++; }
  }
  if (open.length || mismatches) {
    console.log(`\n### ${sid} events=${evs.length} unclosed_turns=${open.length} end_without_start=${mismatches}`);
    console.log(`  unclosed_start_seqs=${open.slice(0, 10).join(',')}`);
    console.log(`  tail: ${tail}`);
    for (const s of open.slice(0, 5)) {
      const after = evs.filter(e => e.seq > s).slice(0, 6).map(e => `${e.seq}:${e.type}`).join(' ');
      console.log(`  after turn/start@${s}: ${after}`);
    }
  }
}
