#!/usr/bin/env node
// Decode a DSH session.v4.jsonl.zstd (concatenated zstd frames) into JSONL events.
// Usage: node decode-session.mjs <file.zstd> [out.jsonl]
import fs from 'node:fs';
import zlib from 'node:zlib';

const SOURCE = '28b52ffd'; // zstd frame magic, little endian
const file = process.argv[2];
const outPath = process.argv[3];
if (!file) {
  console.error('usage: node decode-session.mjs <file.zstd> [out.jsonl]');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const magic = Buffer.from(SOURCE, 'hex');
const offsets = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
    offsets.push(i);
  }
}
if (offsets[0] !== 0) offsets.unshift(0); // tolerate leading junk
const frames = [];
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k];
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  try {
    const out = zlib.zstdDecompressSync(buf.subarray(start, end));
    frames.push({ start, end, bytes: end - start, out });
  } catch (e) {
    frames.push({ start, end, bytes: end - start, err: String(e && e.message || e) });
  }
}
const lines = [];
for (const f of frames) {
  if (f.err) {
    console.error(`[frame @${f.start}+${f.bytes}] FAILED: ${f.err}`);
    continue;
  }
  const text = f.out.toString('utf8');
  for (const ln of text.split('\n')) {
    if (ln.trim()) lines.push(ln);
  }
}
console.log(`frames=${frames.length} ok=${frames.filter(f => !f.err).length} lines=${lines.length}`);
const events = [];
for (const ln of lines) {
  try { events.push(JSON.parse(ln)); } catch (e) { console.error('bad json line: ' + ln.slice(0, 120)); }
}
if (outPath) fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
// summarize
const kinds = new Map();
for (const ev of events) {
  const k = ev.type || ev.kind || Object.keys(ev).join(',');
  kinds.set(k, (kinds.get(k) || 0) + 1);
}
for (const [k, n] of kinds) console.log(`  ${k} x${n}`);
if (events.length) console.log('first:', JSON.stringify(events[0]).slice(0, 300));
