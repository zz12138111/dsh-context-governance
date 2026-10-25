// F1 evidence: find tool results that were already replaced before the
// `tool/result` event was appended, and verify the spilled full text.
// Read-only: reads session logs and the spill files they point at.
// Usage: node analysis/t1/f1-evidence.mjs <session.v4.jsonl.zstd>...
import fs from 'node:fs';
import { readSessionEvents } from './zstd-frames.mjs';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: f1-evidence.mjs <session...>'); process.exit(1); }

const rows = [];
for (const file of files) {
  const events = readSessionEvents(file);
  const header = events.find((e) => e.type === 'session') ?? {};
  const callById = new Map();
  const callSeqById = new Map();
  for (const e of events) if (e.type === 'tool/call') { callById.set(e.data.callId, e.data.name); callSeqById.set(e.data.callId, e.seq); }
  for (const e of events) {
    if (e.type !== 'tool/result') continue;
    const d = e.data ?? {};
    const content = Array.isArray(d.message?.content) ? d.message.content : [];
    const text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
    const tool = callById.get(d.message?.toolCallId) ?? '(unknown)';
    const isTokenGuard = text.startsWith('[token-guard]');
    const spill = text.match(/\(Omitted (\d+) bytes\. Full formatted result stored at: ([^)\n]+?)(?:\.\s*Use read|\))/);
    if (!isTokenGuard && !spill) continue;
    const locator = isTokenGuard
      ? text.match(/完整输出: ([^\n（(]+)/)?.[1]?.trim()
      : spill[2].trim();
    const exists = locator ? fs.existsSync(locator) : false;
    const rawBytes = exists ? fs.statSync(locator).size : null;
    let rawChars = null;
    let headInRaw = null;
    let tailInRaw = null;
    let arithmetic = null;
    if (exists) {
      const raw = fs.readFileSync(locator, 'utf8');
      rawChars = raw.length;
      // The host-spill notice (and its leading blank line) is not part of the raw text.
      const retained = spill ? text.slice(0, text.indexOf('\n\n(Omitted')) : text;
      headInRaw = raw.includes(retained.slice(0, 120));
      tailInRaw = raw.includes(retained.slice(-120));
      if (spill) arithmetic = rawChars - Number(spill[1]);
    }
    rows.push({
      session: header.id ?? file,
      seq: e.seq,
      callSeq: callSeqById.get(d.message?.toolCallId) ?? null,
      turn: d.turn,
      tool,
      kind: isTokenGuard ? 'token-guard' : 'host-spill',
      foldedChars: text.length,
      locator,
      exists,
      rawBytes,
      rawChars,
      omittedBytes: spill ? Number(spill[1]) : null,
      headInRaw,
      tailInRaw,
      rawMinusOmitted: arithmetic,
    });
  }
}

for (const r of rows) {
  console.log(`session=${r.session} seq=${r.seq} turn=${r.turn} tool=${r.tool} kind=${r.kind} foldedChars=${r.foldedChars} rawChars=${r.rawChars} rawBytes=${r.rawBytes} omitted=${r.omittedBytes} headInRaw=${r.headInRaw} tailInRaw=${r.tailInRaw} rawMinusOmitted=${r.rawMinusOmitted}`);
  console.log(`  locator=${r.locator} exists=${r.exists}`);
}
const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
const byTool = {};
for (const r of rows) byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
console.log(JSON.stringify({ total: rows.length, byKind, byTool, rows }, null, 2));
