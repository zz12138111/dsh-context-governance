// Produce one synthetic cost-v1.1 audit line for the T1/M1.2 report.
// Uses the plugin's test fixtures; no real session data, no host changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CompressionGuard } from '../../packages/dsh-context-governance/src/compress/runtime.js';
import { MemoryStore } from '../../packages/dsh-context-governance/src/memory/store.js';
import { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } from '../../packages/dsh-context-governance/test/compress-helpers.mjs';
import { tempDir } from '../../packages/dsh-context-governance/test/helpers.mjs';

const rootDir = await tempDir();
const store = await MemoryStore.open({ rootDir, project: 'sample-project' });
const handlers = [];
const meter = { measure: (session) => ({ nodes: (session?.surface?.nodes ?? []).map((seq) => ({ seq, tokens: 100 })) }) };
const ctx = {
  get(name) {
    if (name === 'compaction') return { compactNow() {}, compactRegion() {} };
    if (name === 'tokenMeter') return meter;
    if (name === 'commands') return { register: () => () => {} };
    return undefined;
  },
  on(event, handler) { handlers.push({ event, handler }); return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};
const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.3', store, logger: ctx.logger, project: 'sample-project' });
guard.start();
const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 2, end: 11 });
const bySeq = new Map(built.events.map((event) => [event.seq, event]));
const session = {
  id: 'session-sample',
  surface: { nodes: [...built.session.surface.nodes] },
  eventAt: (seq) => bySeq.get(seq),
  append() { throw new Error('not used'); },
};
const handler = handlers[0].handler;
handler(session, bySeq.get(built.startSeq));
handler(session, bySeq.get(built.summarySeq));
handler(session, bySeq.get(built.checkpointSeq));
session.surface.nodes = [...built.postSurface];
handler(session, bySeq.get(built.endSeq));
for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
guard.stop();
const audit = (await fs.readFile(path.join(store.rootDir, 'audit.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const cost = audit.find((entry) => entry.event === 'compaction-cost');
await fs.mkdir('analysis/t1/data', { recursive: true });
await fs.writeFile('analysis/t1/data/m1.2-cost-sample.jsonl', `${JSON.stringify(cost)}\n`, 'utf8');
console.log(JSON.stringify(cost, null, 2));
await store.close();
await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
