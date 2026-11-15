#!/usr/bin/env node
// Build a temp session that is a truncated copy of a real session, cut right after a compaction.
// Usage: node build-truncated.mjs <src.zstd> <cutSeq> <newCwd> <outId> [workspaceDir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [src, cutSeqArg, newCwd, forcedId] = process.argv.slice(2);
const cutSeq = Number(cutSeqArg);
const SESSIONS = 'C:/Users/19091/.dsh/sessions';

function frameEnd(buf, start) {
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
    const last = h & 1, btype = (h >> 1) & 3, bsize = h >> 3;
    if (btype === 0 || btype === 2) p += bsize; else if (btype === 1) p += 1; else throw new Error('reserved');
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

const events = [];
for (const ln of decodeAll(fs.readFileSync(src)).split('\n')) {
  if (!ln.trim()) continue;
  try { events.push(JSON.parse(ln)); } catch {}
}
const id = forcedId || 'session-' + crypto.randomUUID();
const kept = [];
for (const ev of events) {
  const c = JSON.parse(JSON.stringify(ev));
  if (typeof c.seq === 'number' && c.seq > cutSeq) continue;
  if (c.type === 'session') { c.id = id; c.cwd = newCwd; c.createdAt = Date.now(); delete c.agentPreset; }
  if (c.type === 'session-log-deepseek/delivery-accepted' && c.data) c.data.sessionId = id;
  kept.push(c);
}
const slug = '--' + newCwd.replace(/[^A-Za-z0-9]+/g, '-') + '--';
const dir = path.join(SESSIONS, slug, id);
fs.mkdirSync(newCwd, { recursive: true });
fs.mkdirSync(dir, { recursive: true });
const frames = kept.map(e => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
console.log(JSON.stringify({ id, dir, keptEvents: kept.length, lastType: kept[kept.length - 1].type, lastSeq: kept[kept.length - 1].seq }));
