// Decode a DSH v4 session log: a concatenation of independent zstd frames
// (one per append). Node's zstd API stops after the first frame, so walk the
// frame headers ourselves. Read-only helper for analysis/t1.
import fs from 'node:fs';
import zlib from 'node:zlib';

/** Return the byte range of every zstd frame starting at 0 (stops at first non-frame). */
export function frameRanges(buf) {
  const frames = [];
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0xFD2FB528) {
    const start = p;
    p += 4;
    const fhd = buf[p++];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p += 1;
    p += [0, 1, 2, 4][dictFlag];
    p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    for (;;) {
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      p += 3;
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      if (type === 0 || type === 2) p += size;
      else if (type === 1) p += 1;
      else throw new Error('reserved zstd block at ' + p);
      if (last) break;
    }
    if (checksum) p += 4;
    frames.push([start, p]);
  }
  return { frames, end: p };
}

/** Decode a session log file to an array of parsed events. */
export function readSessionEvents(file) {
  const raw = fs.readFileSync(file);
  const { frames, end } = frameRanges(raw);
  if (frames.length === 0) throw new Error('no zstd frame at start of ' + file);
  if (end !== raw.length) console.error(`warning: ${raw.length - end} trailing bytes in ${file}`);
  const text = frames.map(([a, b]) => zlib.zstdDecompressSync(raw.subarray(a, b)).toString('utf8')).join('');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (e) { console.error('bad JSON line:', e.message); }
  }
  return events;
}
