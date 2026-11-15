#!/usr/bin/env node
// Independent count of message-bearing event types + source.kind distribution for one session.
// Usage: node count-messages.mjs <session.v4.jsonl.zstd>
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const MAGIC = 0xfd2fb528;
function frameEnd(buf, s) {
  if (buf.readUInt32LE(s) !== MAGIC) {
    const m = buf.readUInt32LE(s) & 0xfffffff0;
    if (m === 0x184d2a50) return s + 8 + buf.readUInt32LE(s + 4);
    throw new Error('not zstd at ' + s);
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
    if (bt === 0 || bt === 2) p += bs; else if (bt === 1) p += 1; else throw new Error('reserved block');
    if (last) break;
  }
  if (ck) p += 4;
  return p;
}

const buf = fs.readFileSync(file);
const frames = [];
let p = 0;
while (p < buf.length) { const e = frameEnd(buf, p); frames.push([p, e]); p = e; }
console.log(`frames=${frames.length} bytes=${buf.length} tail=${buf.length - p}`);
let text = '';
let decodeFail = 0;
for (const [s, e] of frames) {
  try { text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { decodeFail++; }
}
console.log(`decode_failures=${decodeFail}`);
const events = [];
let badLines = 0;
for (const ln of text.split('\n')) {
  if (!ln.trim()) continue;
  try { events.push(JSON.parse(ln)); } catch { badLines++; }
}
console.log(`events=${events.length} bad_json_lines=${badLines}`);

// seq continuity
const seqs = events.filter(e => typeof e.seq === 'number').map(e => e.seq);
let gaps = 0;
for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) gaps++;
console.log(`events_with_seq=${seqs.length} seq_gaps=${gaps} first=${seqs[0]} last=${seqs[seqs.length - 1]}`);

// type distribution (all types)
const types = {};
for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
console.log('\n--- type distribution (top 20) ---');
for (const [k, n] of sorted.slice(0, 20)) console.log(`  ${k} x${n}`);

// message-bearing events: type + source.kind + role
const msgTypes = ['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result', 'tool/call'];
console.log('\n--- message-bearing events ---');
for (const t of msgTypes) {
  const list = events.filter(e => e.type === t);
  const kinds = {};
  const roles = {};
  for (const e of list) {
    const d = e.data || {};
    const k = d.message?.source?.kind ?? d.source?.kind ?? '(none)';
    kinds[k] = (kinds[k] || 0) + 1;
    const r = d.message?.role ?? d.role ?? '(none)';
    roles[r] = (roles[r] || 0) + 1;
  }
  if (list.length === 0) continue;
  console.log(`  ${t}: total=${list.length} sourceKind=${JSON.stringify(kinds)} role=${JSON.stringify(roles)}`);
  if (t === 'system/message' || t === 'user/message') {
    console.log(`    seqs=${JSON.stringify(list.map(e => e.seq))}`);
  }
}
