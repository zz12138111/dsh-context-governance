// Read-only probe of a DSH v4 session log (zstd JSONL). No writes outside analysis/.
// Usage: node analysis/t1/session-probe.mjs <session-dir-or-file> [mode]
//   mode=shape   print event type counts and a sample envelope (default)
//   mode=tools   print tool/call + tool/result summary, flagging folded results
//   mode=baseline  per-turn/step/tool-call stats + prompt token usage
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const arg = process.argv[2];
const mode = process.argv[3] ?? 'shape';
if (!arg) { console.error('usage: session-probe.mjs <session-dir-or-file> [shape|tools|baseline]'); process.exit(1); }
let file = arg;
if (fs.statSync(file).isDirectory()) file = path.join(file, 'session.v4.jsonl.zstd');
const raw = fs.readFileSync(file);
let text;
if (file.endsWith('.zstd')) {
  // Session logs are a concatenation of independent zstd frames (one per append).
  // Node's zstd API decodes only the first frame, so walk frame headers ourselves.
  const frames = [];
  let p = 0;
  while (p + 4 <= raw.length && raw.readUInt32LE(p) === 0xFD2FB528) {
    const start = p;
    p += 4;
    const fhd = raw[p++];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p += 1;
    p += [0, 1, 2, 4][dictFlag];
    p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    for (;;) {
      const bh = raw[p] | (raw[p + 1] << 8) | (raw[p + 2] << 16);
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
    frames.push(raw.subarray(start, p));
  }
  if (frames.length === 0) throw new Error('no zstd frame at start');
  if (p !== raw.length) console.error('warning: trailing bytes after frames:', raw.length - p);
  text = frames.map((frame) => zlib.zstdDecompressSync(frame).toString('utf8')).join('');
} else {
  text = raw.toString('utf8');
}
const lines = text.split('\n').filter(Boolean);
const events = [];
for (const line of lines) {
  try { events.push(JSON.parse(line)); } catch (e) { console.error('bad line', e.message); }
}
console.log('file', file);
console.log('events', events.length);

if (mode === 'shape') {
  const counts = new Map();
  for (const e of events) {
    const t = e.type ?? e.event ?? '?';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('\n'));
  console.log('first envelope:', JSON.stringify(events[0]).slice(0, 800));
  console.log('second envelope:', JSON.stringify(events[1]).slice(0, 800));
}

if (mode === 'tools') {
  let callN = 0, resultN = 0, folded = 0;
  const perTool = new Map();
  for (const e of events) {
    const t = e.type ?? e.event;
    const d = e.data ?? e;
    if (t === 'tool/call') {
      callN++;
      perTool.set(d.name, (perTool.get(d.name) ?? 0) + 1);
    } else if (t === 'tool/result') {
      resultN++;
      const msg = d.message;
      const content = Array.isArray(msg?.content) ? msg.content : [];
      const text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
      const mark = /\[token-guard\]|\[cg-fold\]|Full formatted result stored at/.test(text) ? 'FOLDED' : 'raw';
      if (mark === 'FOLDED') folded++;
      if (mark === 'FOLDED' || text.length > 6000) {
        console.log(`--- ${t} call=${d.message?.toolCallId ?? d.callId ?? '?'} chars=${text.length} ${mark}`);
        console.log(text.slice(0, 260).replace(/\n/g, '\\n'));
        if (mark === 'FOLDED') {
          const m = text.match(/完整输出[:：]\s*([^\s（(]+)/u);
          console.log('locator:', m?.[1] ?? '(none)');
        }
      }
    }
  }
  console.log(`calls=${callN} results=${resultN} folded=${folded}`);
  console.log('per-tool:', [...perTool.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
}

if (mode === 'baseline') {
  let turns = 0, steps = 0, calls = 0;
  const callNames = new Map();
  const promptTokens = [];
  for (const e of events) {
    const t = e.type ?? e.event;
    const d = e.data ?? e;
    if (t === 'turn/start') turns++;
    else if (t === 'step/start') steps++;
    else if (t === 'tool/call') { calls++; callNames.set(d.name, (callNames.get(d.name) ?? 0) + 1); }
    else if (t === 'request/header') {
      // request/header carries config, not usage; prompt water level is on assistant/message.
    }
    else if (t === 'assistant/message') {
      const u = d.usage ?? d.message?.usage;
      if (u && Number.isFinite(u.inputTokens)) {
        promptTokens.push((u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0));
      }
    }
  }
  console.log(JSON.stringify({ turns, steps, calls, stepsPerTurn: turns ? +(steps / turns).toFixed(2) : null, callsPerStep: steps ? +(calls / steps).toFixed(2) : null, promptTokensN: promptTokens.length, promptTokensMedian: promptTokens.length ? promptTokens.sort((a, b) => a - b)[Math.floor(promptTokens.length / 2)] : null, tools: Object.fromEntries(callNames) }, null, 2));
}
