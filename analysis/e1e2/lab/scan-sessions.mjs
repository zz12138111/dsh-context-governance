/**
 * E1/E2 只读实验：扫描本机 DSH 会话日志里的压缩事件。
 *
 * 不修改任何文件；只读取 `%USERPROFILE%\.dsh\sessions\**\*.jsonl.zstd`。
 * 输出不含对话/摘要正文，只有事件计数、seq 区间、token 数与结构化标记。
 *
 * DSH 的会话日志是"追加式 zstd 帧串"（每次 append 一个独立帧），Node 的
 * `zstdDecompressSync` 一次只解一帧，所以按帧魔数切分后逐帧解压。
 *
 * 用法：node scan-sessions.mjs [输出 json 路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const SESSIONS = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
const OUT = process.argv[2] ?? path.join(process.cwd(), 'compaction-inventory.json');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FIVE_HEADINGS = ['Goal and intent', 'Decisions', 'Current state', 'Next steps', 'Anchors'];

function listZstd(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listZstd(file));
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(file);
  }
  return out;
}

function* frames(buffer) {
  let index = buffer.indexOf(MAGIC, 0);
  while (index !== -1) {
    const next = buffer.indexOf(MAGIC, index + 4);
    try {
      yield zlib.zstdDecompressSync(buffer.subarray(index, next === -1 ? buffer.length : next));
    } catch {
      /* 末尾写了一半的帧：跳过，不影响已落盘的帧 */
    }
    index = next;
  }
}

function visibleText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}

const inventory = [];
const redact = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
for (const file of listZstd(SESSIONS)) {
  const buffer = fs.readFileSync(file);
  const row = {
    session: redact(path.basename(path.dirname(file))),
    workspace: redact(path.basename(path.dirname(path.dirname(file)))),
    bytes: buffer.length,
    events: 0,
    turns: 0,
    types: {},
    compactions: [],
  };
  const openStarts = new Map();
  for (const chunk of frames(buffer)) {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        row.badLines = (row.badLines ?? 0) + 1;
        continue;
      }
      if (event.type === 'session') continue;
      row.events += 1;
      row.types[event.type] = (row.types[event.type] ?? 0) + 1;
      if (event.type === 'turn/start') row.turns += 1;
      if (event.type === 'compaction/start') {
        openStarts.set(event.data?.compactionId, {
          eventSeq: event.seq,
          time: event.time,
          turn: event.data?.turn ?? null,
          manual: event.data?.sourceCommandId != null,
        });
      } else if (event.type === 'compaction/summary') {
        const started = openStarts.get(event.data?.compactionId) ?? {};
        const summary = visibleText(event.data?.summary);
        row.compactions.push({
          compactionId: event.data?.compactionId,
          startEventSeq: started.eventSeq ?? null,
          summarySeq: event.seq,
          time: event.time,
          manual: started.manual ?? false,
          turn: started.turn ?? null,
          shadowedRange: event.data?.shadowedRange ?? null,
          shadowedEvents: event.data?.shadowedSeqs?.length ?? null,
          shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
          provider: event.data?.provider ?? null,
          model: event.data?.model ?? null,
          usage: event.data?.usage ?? null,
          summaryChars: summary.length,
          fiveSectionHits: FIVE_HEADINGS.filter((heading) => summary.includes(heading)),
          checkpointSeq: null,
          endSeq: null,
          endError: null,
        });
      } else if (event.type === 'user/message') {
        const checkpoint = row.compactions[row.compactions.length - 1];
        if (checkpoint !== undefined && checkpoint.checkpointSeq === null &&
            event.data?.source?.kind === 'compact-checkpoint' &&
            event.data?.source?.compactionId === checkpoint.compactionId) {
          checkpoint.checkpointSeq = event.seq;
          checkpoint.surfaceOp = event.surfaceOp ?? null;
        }
      } else if (event.type === 'compaction/end') {
        const checkpoint = row.compactions.find((item) => item.compactionId === event.data?.compactionId);
        if (checkpoint !== undefined) {
          checkpoint.endSeq = event.seq;
          checkpoint.endError = event.data?.error ?? null;
        }
      }
    }
  }
  inventory.push(row);
}

inventory.sort((a, b) => b.compactions.length - a.compactions.length);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(inventory, null, 2));

const withCompaction = inventory.filter((row) => row.compactions.length > 0);
const all = withCompaction.flatMap((row) => row.compactions);
console.log(`sessions=${inventory.length} withCompaction=${withCompaction.length} compactions=${all.length}`);
console.log(`manual=${all.filter((c) => c.manual).length} automatic=${all.filter((c) => !c.manual).length}`);
console.log(`fiveSection=${all.filter((c) => c.fiveSectionHits.length === 5).length} freeForm=${all.filter((c) => c.fiveSectionHits.length === 0).length}`);
console.log(`withErrors=${all.filter((c) => c.endError !== null).length} withUsage=${all.filter((c) => c.usage != null).length}`);
for (const row of withCompaction) {
  console.log(`${row.workspace}/${row.session} events=${row.events} compactions=${row.compactions.length}`);
  for (const c of row.compactions) {
    console.log(`  start=${c.startEventSeq} shadow=[${c.shadowedRange?.start}..${c.shadowedRange?.end}] checkpoint=${c.checkpointSeq} end=${c.endSeq} tokens=${c.shadowedTokenCount} chars=${c.summaryChars} five=${c.fiveSectionHits.length}/5 manual=${c.manual}`);
  }
}
console.log(`out=${OUT}`);
