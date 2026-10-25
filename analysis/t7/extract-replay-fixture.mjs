/**
 * T7 回放 fixture 提取器（离线、只读）。
 *
 * 从 DSH 的 `session.v4.jsonl.zstd`（多 zstd frame 追加）里取一个**真实压缩周期**，
 * 保留结构（事件 type/seq/time、compactionId 占位、shadowedRange/shadowedSeqs、usage 数字），
 * 并对**所有字符串**做递归脱敏（不依赖 key 白名单）：
 * - 含 CJK / 绝对路径（Windows 盘符、UNC、/usr|/home|…） / URL / 长 token 的整串 → `[redacted:N]`；
 * - 其余字符串里的 `session-<uuid>` → `[session-id]`，裸 uuid → `[uuid]`；
 * - 数字/布尔/结构不变。
 *
 * 用法：node analysis/t7/extract-replay-fixture.mjs <session.v4.jsonl.zstd> [outFile] [--manual]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { structureEvent } from './structure.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** CJK 及全角标点（含日文假名、韩文、CJK 统一表意、兼容表意、全角块）。 */
const CJK_RE = /[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
/** Windows 盘符绝对路径、UNC。 */
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/])/;
/** POSIX 绝对路径（常见根）。 */
const POSIX_PATH_RE = /\/(?:usr|home|etc|var|tmp|opt|mnt|root|Users)\//;
const URL_RE = /(?:https?|ftp|file):\/\/[^\s"'<>]+/i;
const SESSION_SOURCE = 'session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION_RE = new RegExp(SESSION_SOURCE, 'g');
const UUID_RE = new RegExp(UUID_SOURCE, 'g');
const SESSION_TEST_RE = new RegExp(SESSION_SOURCE);
const UUID_TEST_RE = new RegExp(UUID_SOURCE);
/** 长 token（base64/hex/长 id 片段）。 */
const LONG_TOKEN_RE = /[A-Za-z0-9+/_=-]{64,}/;

/** 一组字符串“按序拼起来”是否会组成敏感内容（token 数组绕过单串检查的根因）。 */
function joinedLooksSensitive(items) {
  const joined = items.join('');
  if (joined === '') return false;
  if (CJK_RE.test(joined) || ABS_PATH_RE.test(joined) || POSIX_PATH_RE.test(joined) || URL_RE.test(joined)) return true;
  if (SESSION_TEST_RE.test(joined) || UUID_TEST_RE.test(joined) || LONG_TOKEN_RE.test(joined)) return true;
  return false;
}

/** 大量短片段（stream/token 数组）：拼起来可能还原路径/正文，整组替换。 */
function isFragmentStream(items) {
  if (items.length < 20) return false;
  const total = items.reduce((sum, item) => sum + item.length, 0);
  return total / items.length <= 6;
}

function sanitizeString(raw) {
  const text = String(raw);
  if (text === '') return text;
  if (CJK_RE.test(text) || ABS_PATH_RE.test(text) || POSIX_PATH_RE.test(text) || URL_RE.test(text) || LONG_TOKEN_RE.test(text)) {
    return `[redacted:${text.length}]`;
  }
  return text.replace(SESSION_RE, '[session-id]').replace(UUID_RE, '[uuid]');
}

/** 递归脱敏：**所有字符串**都过一遍，不依赖 key 白名单。 */
export function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => typeof item === 'string')) {
      // 先看“原数组按序 join”是否敏感；token 数组/短片段流整组替换。
      if (joinedLooksSensitive(value) || isFragmentStream(value)) {
        return [`[redacted:${value.join('').length}]`];
      }
      return value.map((item) => sanitizeString(item));
    }
    return value.map((item) => sanitizeDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizeDeep(child);
    return out;
  }
  return value;
}

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

function redactEvent(event) {
  // P2（三轮复核）：先按结构白名单裁剪，再用 sanitizeDeep 兜底；正文载体整段占位。
  return sanitizeDeep(structureEvent(event));
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

  const fixture = sanitizeDeep({
    meta: {
      source: path.basename(source),
      extractedAt: new Date().toISOString(),
      note: 'real session/event sequence, all strings recursively redacted; structure preserved',
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
  });
  const out = process.argv[3] ?? path.join('test', 'fixtures', 'replay-compaction.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`wrote ${out}: ${cycle.length} events, shadowed=${shadowed.length}, preSurface=${fixture.preSurface.length}, preMessages=${preMessages.length}`);
}

main();
