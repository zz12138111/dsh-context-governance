// Align event digests with host-recomputed digests (C35③ feasibility).
// instruction digest = sha1(raw utf8 content); catalog digest = sha256(entries canonical JSON pairs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

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
function loadSession(file) {
  const buf = fs.readFileSync(file);
  let p = 0, text = '';
  while (p < buf.length) { const e = frameEnd(buf, p); text += zlib.zstdDecompressSync(buf.subarray(p, e)).toString('utf8'); p = e; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const catalogDigest = (entries, incomplete = false) =>
  sha256((incomplete ? 'incomplete\n' : '') + entries.map((e) => JSON.stringify([e.name, e.description])).join('\n'));

const sessions = [
  'C:/Users/19091/.dsh/sessions/--D-DS-PROJECT-DSH~63D2~4EF6~5F00~53D1--/session-58a2e845-cec5-4229-afa9-7f09a0fc0207/session.v4.jsonl.zstd',
  'C:/Users/19091/.dsh/sessions/--G-DS-HARNESS--/session-2ebebd78-77b9-401a-b632-6d8ff3574431/session.v4.jsonl.zstd',
];
let same = 0, diff = 0, unreadable = 0, noField = 0;
const rows = [];
for (const file of sessions) {
  let evs;
  try { evs = loadSession(file); } catch (e) { console.log('SKIP', file, e.message); continue; }
  const header = evs[0];
  const cwd = header.cwd || '';
  const base = evs.filter((e) => e.type === 'user/message' && (e.data?.source?.kind === 'agent-instructions'));
  const baseline = base.filter((e) => e.data.source.baseline === true);
  const chosen = baseline.length ? baseline[baseline.length - 1] : base[base.length - 1];
  if (!chosen) { console.log('no agent-instructions in', path.basename(path.dirname(file))); continue; }
  console.log(`\n== ${path.basename(path.dirname(file))} cwd=${cwd} baselineSeq=${chosen.seq} baseline=${chosen.data.source.baseline} changes=${(chosen.data.source.changes || []).length}`);
  for (const ch of chosen.data.source.changes || []) {
    const p = ch.path || '';
    const abs = p.startsWith('~/.dsh/') ? path.join('C:/Users/19091/.dsh', p.slice('~/.dsh/'.length)) : path.join(cwd, p);
    let content = null;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { /* missing */ }
    if (content === null) { unreadable++; rows.push({ abs, ok: 'unreadable', eventDigest: ch.digest }); continue; }
    const remote = sha1(content);
    const trimmed = sha1(content.trim());
    const ok = ch.digest === remote || ch.digest === trimmed;
    if (ok) same++; else diff++;
    rows.push({ abs, ok: ok ? 'same' : 'DIFF', eventDigest: String(ch.digest).slice(0, 12), recomputed: remote.slice(0, 12), trimmed: trimmed.slice(0, 12), mtime: fs.statSync(abs).mtime.toISOString() });
  }
}
for (const r of rows) console.log(JSON.stringify(r));
console.log(`\nINSTRUCTION digest alignment: same=${same} diff=${diff} unreadable=${unreadable}`);

// catalog events: check whether entries carry digest
for (const file of sessions) {
  let evs;
  try { evs = loadSession(file); } catch { continue; }
  const cat = evs.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'skill-catalog');
  if (!cat.length) continue;
  const last = cat[cat.length - 1];
  const s = last.data.source;
  const entries = s.entries || [];
  const withDigest = entries.filter((x) => typeof x.digest === 'string');
  console.log(`\nCATALOG ${path.basename(path.dirname(file))}: seq=${last.seq} entries=${entries.length} entriesWithDigest=${withDigest.length} update=${s.update === true} keys=${JSON.stringify(Object.keys(entries[0] || {}))}`);
  if (withDigest.length) {
    const okCount = entries.filter((x) => x.digest === catalogDigest([x])).length;
    console.log(`  perEntryDigestMatchesSingleEntryHash=${okCount}/${entries.length}`);
  }
  const whole = catalogDigest(entries, false);
  console.log(`  wholeCatalogDigest(recomputed)=${whole.slice(0, 16)} eventHasCatalogDigest=${typeof s.digest === 'string' ? s.digest.slice(0, 16) : 'NO'}`);
}
