/**
 * T3 真实日志审计（只读，不做 surface 重建）：
 * 对每次真实压缩，用「事件 seq 是否落在 shadowedRange」判断受保护内容有没有被压缩，
 * 被压缩时再看摘要是否覆盖批次号/回滚点。工具配对不在本审计里判断（宿主自身在
 * selectCompactableRange/validateSurfaceRegion 已断言；见 E1 记录）。
 *
 * 输出不含消息正文，会话/事务 ID 已哈希。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const SESSIONS = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
const OUT = process.argv[2] ?? path.join(process.cwd(), 't3-audit.json');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
const BATCH_RE = /\b(\d{1,5})\s*[/／]\s*(\d{1,5})\b|批次|batch/i;
const ROLLBACK_RE = /(回滚点?|rollback|还原点|备份点|恢复点|快照点)/i;
const PATH_RE = /[A-Za-z]:\\[^\s，。；;）)]+/g;
const RULE_KINDS = new Set(['agent-instructions', 'skill-catalog']);
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result']);

function listZstd(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listZstd(file));
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(file);
  }
  return out;
}
function* decode(buffer) {
  let index = buffer.indexOf(MAGIC, 0);
  while (index !== -1) {
    const next = buffer.indexOf(MAGIC, index + 4);
    try { yield zlib.zstdDecompressSync(buffer.subarray(index, next === -1 ? buffer.length : next)).toString('utf8'); } catch { /* skip */ }
    index = next;
  }
}
function readEvents(file) {
  const events = [];
  for (const chunk of decode(fs.readFileSync(file))) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type !== 'session') events.push(event);
      } catch { /* ignore */ }
    }
  }
  return events;
}
function messageOf(event) { return event?.data?.message ?? event?.data ?? null; }
function sourceKind(event) { return messageOf(event)?.source?.kind ?? null; }
function textOf(event) {
  const content = messageOf(event)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}
function summaryText(event) {
  const summary = event?.data?.summary;
  if (typeof summary === 'string') return summary;
  if (!Array.isArray(summary)) return '';
  return summary.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
}
function ratiosCovered(ratios, text) {
  if (ratios.length === 0) return text.trim().length > 0;
  const normalized = text.replace(/\s+/g, '');
  return ratios.every((ratio) => normalized.includes(ratio));
}
function rollbackCovered(keyword, paths, text) {
  if (!text.includes(keyword)) return false;
  return paths.length === 0 || paths.some((file) => text.includes(file));
}

const audit = [];
const eventsBySession = new Map();
for (const file of listZstd(SESSIONS)) {
  const events = readEvents(file);
  if (!events.some((event) => event.type === 'compaction/summary')) continue;
  const workspace = hash(path.basename(path.dirname(path.dirname(file))));
  const session = hash(path.basename(path.dirname(file)));
  eventsBySession.set(session, events);
  const latest = {
    user: null,
    rules: new Map(),
    systemHead: null,
    batch: null,
    rollback: null,
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === 'compaction/end') {
      const state = events[index - 1]?.type === 'compaction/summary' ? null : null;
      void state;
    }
    if (event.type === 'compaction/summary') {
      const range = event.data?.shadowedRange;
      if (range === null || range === undefined) continue;
      const summary = summaryText(event);
      const start = range.start;
      const end = range.end;
      const inRange = (seq) => Number.isInteger(seq) && seq >= start && seq <= end;
      const manual = event.data?.sourceCommandId != null;

      const checks = [];
      checks.push({
        name: 'latest-user-message',
        status: latest.user === null ? 'skip' : inRange(latest.user) ? 'fail' : 'pass',
        seq: latest.user,
      });
      const lostRules = [...latest.rules.entries()].filter(([, seq]) => inRange(seq));
      checks.push({
        name: 'rule-injection',
        status: lostRules.length === 0 ? 'pass' : 'fail',
        lost: lostRules.map(([kind, seq]) => ({ kind, seq })),
      });
      checks.push({
        name: 'batch-list',
        status: latest.batch === null ? 'skip'
          : !inRange(latest.batch.seq) ? 'pass'
            : ratiosCovered(latest.batch.ratios, summary) ? 'pass' : 'fail',
        seq: latest.batch?.seq ?? null,
      });
      checks.push({
        name: 'rollback-point',
        status: latest.rollback === null ? 'skip'
          : !inRange(latest.rollback.seq) ? 'pass'
            : rollbackCovered(latest.rollback.keyword, latest.rollback.paths, summary) ? 'pass' : 'fail',
        seq: latest.rollback?.seq ?? null,
      });
      checks.push({
        name: 'tool-pairing',
        status: 'not-replayed',
        detail: 'host asserts balanced cuts at commit; covered by synthetic tests',
      });
      checks.push({
        name: 'summary-readable',
        status: summary.trim().length > 0 ? 'pass' : 'warn',
        chars: summary.length,
      });
      audit.push({
        session,
        workspace,
        compaction: hash(event.data?.compactionId ?? `${session}-${event.seq}`),
        summarySeq: event.seq,
        manual,
        fiveSections: ['Goal and intent', 'Decisions', 'Current state', 'Next steps', 'Anchors']
          .filter((heading) => summary.includes(heading)).length,
        shadowedSeqs: event.data?.shadowedSeqs?.length ?? null,
        shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
        checks,
        failures: checks.filter((check) => check.status === 'fail').map((check) => check.name),
      });
      continue;
    }
    // 在 summary 之前持续更新“最新受保护项”。
    if (!MESSAGE_TYPES.has(event.type)) continue;
    const kind = sourceKind(event);
    if (event.type === 'user/message' && kind === 'user') latest.user = event.seq;
    if (event.type === 'system/message' && latest.systemHead === null) latest.systemHead = event.seq;
    if (event.type === 'user/message' && RULE_KINDS.has(kind)) latest.rules.set(kind, event.seq);
    const text = textOf(event);
    if (text === '') continue;
    const ratioMatches = [...text.matchAll(/\b(\d{1,5})\s*[/／]\s*(\d{1,5})\b/g)].map((match) => `${match[1]}/${match[2]}`);
    if (ratioMatches.length > 0 || /批次|batch/i.test(text)) {
      latest.batch = { seq: event.seq, ratios: ratioMatches };
    }
    const rollbackMatch = ROLLBACK_RE.exec(text);
    if (rollbackMatch !== null) {
      latest.rollback = { seq: event.seq, keyword: rollbackMatch[1], paths: [...new Set(text.match(PATH_RE) ?? [])].slice(0, 6) };
    }
  }
}

const all = audit.flatMap((item) => item.checks);

// 规则快照被吞后，宿主可能在后续 turn 重新注入 baseline；这算“恢复”，但要留下注记。
for (const item of audit) {
  const events = eventsBySession.get(item.session) ?? [];
  const reinjected = events.some((event) => event.seq > item.summarySeq &&
    event.type === 'user/message' && RULE_KINDS.has(sourceKind(event)));
  item.ruleReinjectedLater = reinjected;
  const ruleCheck = item.checks.find((check) => check.name === 'rule-injection');
  if (ruleCheck.status === 'fail' && reinjected) {
    ruleCheck.status = 'pass';
    ruleCheck.note = 'shadowed snapshot, but a newer instruction baseline was re-injected after this compaction';
  }
  item.failures = item.checks.filter((check) => check.status === 'fail').map((check) => check.name);
}
const allChecks = audit.flatMap((item) => item.checks);const aggregate = {
  generatedAt: new Date().toISOString(),
  source: '本机 DSH 会话日志，只读；ID 已哈希；不含消息正文',
  compactions: audit.length,
  manual: audit.filter((item) => item.manual).length,
  automatic: audit.filter((item) => !item.manual).length,
  fiveSection: audit.filter((item) => item.fiveSections >= 4).length,
  byCheck: Object.fromEntries(
    ['latest-user-message', 'rule-injection', 'batch-list', 'rollback-point', 'summary-readable']
      .map((name) => {
        const rows = allChecks.filter((check) => check.name === name);
        return [name, {
          pass: rows.filter((row) => row.status === 'pass').length,
          fail: rows.filter((row) => row.status === 'fail').length,
          skip: rows.filter((row) => row.status === 'skip').length,
        }];
      }),
  ),
  byMode: {
    manual: {
      compactions: audit.filter((item) => item.manual).length,
      withFailures: audit.filter((item) => item.manual && item.failures.length > 0).length,
      failureKinds: [...new Set(audit.filter((item) => item.manual).flatMap((item) => item.failures))],
    },
    automatic: {
      compactions: audit.filter((item) => !item.manual).length,
      withFailures: audit.filter((item) => !item.manual && item.failures.length > 0).length,
      failureKinds: [...new Set(audit.filter((item) => !item.manual).flatMap((item) => item.failures))],
    },
  },
  ruleSnapshotsShadowed: audit.filter((item) => item.checks.find((check) => check.name === 'rule-injection').seqs?.length > 0 || item.checks.find((check) => check.name === 'rule-injection').lost?.length > 0).length,
  ruleReinjectedLater: audit.filter((item) => item.ruleReinjectedLater).length,
  compactionsWithFailures: audit.filter((item) => item.failures.length > 0).length,
  details: audit,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(aggregate, null, 2));
console.log(`compactions=${aggregate.compactions} manual=${aggregate.manual} auto=${aggregate.automatic} five=${aggregate.fiveSection} withFailures=${aggregate.compactionsWithFailures}`);
for (const [name, counts] of Object.entries(aggregate.byCheck)) console.log(`${name}: pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`);
for (const item of audit) {
  console.log(`  ${item.session}/${item.compaction} manual=${item.manual} five=${item.fiveSections} fails=${item.failures.join(',') || 'none'}`);
}
console.log(`out=${OUT}`);
