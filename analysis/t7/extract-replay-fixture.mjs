/**
 * T7 回放 fixture 提取器（离线、只读）。
 *
 * 从 DSH 的 `session.v4.jsonl.zstd`（多 zstd frame 追加）里取一个**真实压缩周期**，
 * 做结构保留、文本脱敏后写成 JSON fixture：
 * - 保留：事件 type/seq/time、compactionId、shadowedRange/shadowedSeqs、summary 分节标题、
 *   source.kind、usage 数字、checkpoint 事件、end 事件；
 * - 脱敏：所有 message 文本替换为 `[redacted:<原长度>]`，标题/路径/正文不落盘。
 *
 * 用法：node analysis/t7/extract-replay-fixture.mjs <session.v4.jsonl.zstd> [outFile]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeZstdFrames(buffer) {
  const offsets = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.compare(MAGIC, 0, 4, index, index + 4) === 0) offsets.push(index);
  }
  const chunks = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
    } catch {
      /* 不是 frame 边界，跳过 */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

const REDACT_KEYS = new Set([
  'text', 'title', 'detail', 'output', 'stdout', 'stderr', 'command', 'summary',
  'prompt', 'description', 'content', 'arguments', 'query', 'message', 'messages',
  'path', 'paths', 'file', 'files', 'cwd', 'root', 'workdir', 'url', 'body', 'input',
  'oldText', 'newText', 'patch', 'diffs', 'diff', 'proposal', 'reason', 'note',
]);

function redactDeep(value, key) {
  if (typeof value === 'string') return REDACT_KEYS.has(key) ? `[redacted:${value.length}]` : value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, key));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = redactDeep(child, childKey);
    return out;
  }
  return value;
}

function redactContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return block;
    if (typeof block.text === 'string') return { ...block, text: `[redacted:${block.text.length}]` };
    return block;
  });
}

function redactEvent(event) {
  return { type: event.type, seq: event.seq, time: event.time, data: redactDeep(event.data ?? {}, 'data') };
}

function main() {
  const source = process.argv[2];
  if (typeof source !== 'string' || !fs.existsSync(source)) {
    console.error('usage: node extract-replay-fixture.mjs <session.v4.jsonl.zstd> [outFile]');
    process.exit(2);
  }
  const events = decodeZstdFrames(fs.readFileSync(source))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((event) => typeof event.type === 'string');

  const startIndexes = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === 'compaction/start') startIndexes.push(index);
  }
  if (startIndexes.length === 0) {
    console.error('no compaction/start in this log');
    process.exit(1);
  }
  const wantManual = process.argv.includes('--manual');
  const cycles = [];
  for (const startIndex of startIndexes) {
    const start = events[startIndex];
    const id = start?.data?.compactionId;
    if (typeof id !== 'string') continue;
    const endIndex = events.findIndex((event, index) => index > startIndex && event.type === 'compaction/end' && event.data?.compactionId === id);
    if (endIndex === -1) continue;
    cycles.push({ startIndex, endIndex, id, manual: start.data?.sourceCommandId != null });
  }
  if (cycles.length === 0) {
    console.error('no complete compaction cycle (start+end) in this log');
    process.exit(1);
  }
  const chosen = cycles.reverse().find((cycle) => cycle.manual === wantManual) ?? cycles[0];
  const chosenMeta = { manual: chosen.manual, requested: wantManual ? 'manual' : 'auto', fallback: chosen.manual !== wantManual };

  const summary = events.slice(chosen.startIndex, chosen.endIndex + 1)
    .find((event) => event.type === 'compaction/summary' && event.data?.compactionId === chosen.id);
  const shadowed = Array.isArray(summary?.data?.shadowedSeqs) ? summary.data.shadowedSeqs : [];
  const range = summary?.data?.shadowedRange ?? null;

  // 压缩前 surface：取该周期之前 message 事件的尾部窗口，并**强制带上最近一条 user/message**
  // （真实 surface 完整时它一定在；截断窗口不能把它丢掉，否则保护快照为空）。
  const preEvents = events.slice(0, chosen.startIndex)
    .filter((event) => ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type));
  const window = preEvents.slice(-60);
  const lastRealUser = [...preEvents].reverse()
    .find((event) => event.type === 'user/message' && event.data?.source?.kind === 'user');
  if (lastRealUser !== undefined && !window.includes(lastRealUser)) window.unshift(lastRealUser);
  const before = window.map((event) => event.seq);
  const keptSeqs = new Set(before);
  const preMessages = preEvents.filter((event) => keptSeqs.has(event.seq)).map(redactEvent);

  const cycle = events.slice(chosen.startIndex, chosen.endIndex + 1).map(redactEvent);
  const checkpoint = cycle.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint');

  const fixture = {
    meta: {
      source: path.basename(source),
      extractedAt: new Date().toISOString(),
      note: 'real session/event sequence, texts redacted; structure preserved',
      compactionId: chosen.id,
      manual: chosen.manual,
      synthetic: false,
      requested: chosenMeta.requested,
      fallbackToOtherKind: chosenMeta.fallback,
      shadowedRange: range,
      shadowedCount: shadowed.length,
      hasCheckpoint: checkpoint !== undefined,
    },
    sessionId: 'session-t7-fixture',
    preSurface: before,
    preMessages,
    events: cycle,
  };
  const out = process.argv[3] ?? path.join('test', 'fixtures', 'replay-compaction.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`wrote ${out}: ${cycle.length} events, shadowed=${shadowed.length}, preSurface=${fixture.preSurface.length}, preMessages=${preMessages.length}, id=${chosen.id}`);
}

main();
