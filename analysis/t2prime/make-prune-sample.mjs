// T2′ offline evidence: synthetic host prune events -> prune-observed + cost-v1.2.
// Uses the plugin's own guard and public test fixtures; no host changes, no content.
import fs from 'node:fs/promises';
import path from 'node:path';

import { CompressionGuard } from '../../packages/dsh-context-governance/src/compress/runtime.js';
import { MemoryStore } from '../../packages/dsh-context-governance/src/memory/store.js';
import { createStatusCommand } from '../../packages/dsh-context-governance/src/commands/cg-status.js';
import {
  FIVE_SECTION_SUMMARY,
  checkpoint,
  compactionEnd,
  compactionStart,
  compactionSummary,
  event,
} from '../../packages/dsh-context-governance/test/compress-helpers.mjs';
import { tempDir } from '../../packages/dsh-context-governance/test/helpers.mjs';

const rootDir = await tempDir();
const store = await MemoryStore.open({ rootDir, project: 'sample-project' });
const meter = { measure: (session) => ({ nodes: (session?.surface?.nodes ?? []).map((seq) => ({ seq, tokens: 10 })) }) };
const handlers = [];
const ctx = {
  get(name) {
    if (name === 'compaction') return { compactNow() {}, compactRegion() {} };
    if (name === 'tokenMeter') return meter;
    if (name === 'commands') return { register: () => () => {} };
    return undefined;
  },
  on(name, handler) { handlers.push({ name, handler }); return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};
const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger, project: 'sample-project' });
guard.start();

const toolCall = event(1, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' });
const prune = event(2, 'compaction/prune', {
  shadowedRange: { start: 10, end: 10 },
  shadowedSeqs: [10],
  shadowedTokenCount: 4797,
});
const replacement = event(3, 'tool/result', {
  turn: 1, step: 1,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: 'call-1' },
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'replacement content (not audited)' }],
  },
}, { sourceEventSeqs: [10], surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 } });
const start = compactionStart(100, 'cmp-sample');
const summary = compactionSummary(101, 'cmp-sample', { summary: FIVE_SECTION_SUMMARY, start: 1, end: 9 });
const checkpointEvent = checkpoint(102, 'cmp-sample');
const end = compactionEnd(103, 'cmp-sample');
const events = [toolCall, prune, replacement, start, summary, checkpointEvent, end];
const bySeq = new Map(events.map((item) => [item.seq, item]));
const session = {
  id: 'session-prune-sample',
  surface: { nodes: [1, 2, 3] },
  eventAt: (seq) => bySeq.get(seq),
  append() { throw new Error('not used by prune observation'); },
};

const handler = handlers[0].handler;
handler(session, toolCall);
handler(session, prune);
handler(session, replacement);
handler(session, start);
handler(session, summary);
handler(session, checkpointEvent);
session.surface.nodes = [101, 102];
handler(session, end);
for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

const audit = (await fs.readFile(path.join(store.rootDir, 'audit.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const picked = audit.filter((entry) => entry.event === 'prune-observed' || entry.event === 'compaction-cost');
await fs.mkdir('analysis/t2prime/data', { recursive: true });
await fs.writeFile('analysis/t2prime/data/prune-observed-cost-v1.2.jsonl', `${picked.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

const command = createStatusCommand({ store, getGuard: () => guard, audit: guard.auditLog });
const status = await command.handler({ rawInput: 'status' });
const lastCost = await command.handler({ rawInput: 'last-cost' });
await fs.writeFile('analysis/t2prime/data/status.txt', `${status.text}\n\n--- /cg status last-cost ---\n${lastCost.text}\n`, 'utf8');
console.log(JSON.stringify({ prunes: picked.filter((entry) => entry.event === 'prune-observed').length, cost: picked.find((entry) => entry.event === 'compaction-cost'), status: status.text.split('\n').filter((line) => line.startsWith('last-cost:'))[0] }, null, 2));

guard.stop();
await store.close();
await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
