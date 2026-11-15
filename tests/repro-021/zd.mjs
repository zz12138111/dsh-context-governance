#!/usr/bin/env node
// Robust zstd concatenated-frame splitter (parses frame headers/blocks, no magic guessing).
// Usage: node zd.mjs <file.zstd> [out.jsonl]
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const out = process.argv[3];
const buf = fs.readFileSync(file);
const MAGIC = 0xfd2fb528;

function frameEnd(buf, start) {
  if (buf.readUInt32LE(start) !== MAGIC) {
    // skippable frame?
    const m = buf.readUInt32LE(start) & 0xfffffff0;
    if (m === 0x184d2a50) return start + 8 + buf.readUInt32LE(start + 4);
    throw new Error('not a zstd frame at ' + start);
  }
  let p = start + 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!singleSegment) p += 1; // window descriptor
  const dictSize = [0, 1, 2, 4][dictFlag];
  p += dictSize;
  let fcsSize = 0;
  if (fcsFlag === 0) fcsSize = singleSegment ? 1 : 0;
  else if (fcsFlag === 1) fcsSize = 2;
  else if (fcsFlag === 2) fcsSize = 4;
  else fcsSize = 8;
  p += fcsSize;
  // blocks
  for (;;) {
    if (p + 3 > buf.length) throw new Error('truncated block header at ' + p);
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const btype = (h >> 1) & 3;
    const bsize = h >> 3;
    if (btype === 0) p += bsize; // raw
    else if (btype === 1) p += 1; // rle
    else if (btype === 2) p += bsize; // compressed
    else throw new Error('reserved block type at ' + p);
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

const frames = [];
let p = 0;
while (p < buf.length) {
  let end;
  try { end = frameEnd(buf, p); } catch (e) { console.error(`frame parse fail at ${p}: ${e.message}`); break; }
  frames.push({ start: p, end });
  p = end;
}
console.error(`frames=${frames.length} bytes=${buf.length} tail_unparsed=${buf.length - p}`);
let text = '';
let fail = 0;
for (const f of frames) {
  try { text += zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'); }
  catch (e) { fail++; console.error(`decompress fail @${f.start}+${f.end - f.start}: ${e.message}`); }
}
console.error(`decompress_failures=${fail}`);
if (out) fs.writeFileSync(out, text, 'utf8');
// continuity check
const seqs = [];
for (const ln of text.split('\n')) {
  if (!ln.trim()) continue;
  try { const ev = JSON.parse(ln); if (typeof ev.seq === 'number') seqs.push(ev.seq); } catch {}
}
let gaps = 0, firstGap = null;
for (let i = 1; i < seqs.length; i++) {
  if (seqs[i] !== seqs[i - 1] + 1) { gaps++; if (!firstGap) firstGap = [seqs[i - 1], seqs[i]]; }
}
console.error(`events_with_seq=${seqs.length} gaps=${gaps} first_gap=${JSON.stringify(firstGap)}`);
