/* ARCHIVED-C34（2026-11-15，用户批 0214ae5：C34 作废、C35 新增）\n   本文件保留作历史/回归参考，不再作为验收判据；C35 见 verify-c35-host-heal.mjs。\n   禁止按本文件结果判实现。 */
/**
 * 测试角色独立验收 · D-MGMT-021 v3b pending 对账（唯一验收用例，实现方另写测试不替代）
 *
 * 覆盖判定文件「保护面重建-真伪判定-20261115.md」§RT 矩阵：
 *   RT-A1 逐字节重发 → resolved(accepted, match=kind, hashMatch=true)
 *   RT-A2 同 kind 不同内容（真实形态）→ resolved(accepted, match=kind, hashMatch=false)
 *   RT-B  TTL 到点无重发（turn/end）→ resolved(unacceptable, ttl-expired) + 1 条 compaction-loss
 *   RT-C  重启扫描 pending → resolved(unacceptable, restart) + 1 条 compaction-loss
 *   RT-D  dispose 无下一轮 → resolved(unacceptable, session-ended) + 1 条 compaction-loss
 *   RT-E1 kind=null + 文本不同 → unacceptable（sha256 从严）
 *   RT-E2 kind=null + 文本相同 → accepted(match=sha256)
 *   RT-F  重启扫描遇轮转 → surface-rebuild-recovery-incomplete（文案含"可能存在未结算 pending"）
 *   RT-G  turn/abort → resolved(unacceptable, turn-aborted)
 *   RT-P  pending 期间零 compaction-loss、零 accepted（不计通过）
 *   RT-FIELDS skip 审计字段齐（sessionId/cycle/compactionId/ruleSeq/kind/status=pending）
 *
 * 运行：node tests\probe-1.1.0\verify-021-runtime.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { CompressionGuard } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-context-governance/src/compress/runtime.js')).href);
const { MemoryStore } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-context-governance/src/memory/store.js')).href);
const { FIVE_SECTION_SUMMARY, buildCompaction, healthyMessages } = await import(
  pathToFileURL(path.join(ROOT, 'packages/dsh-context-governance/test/compress-helpers.mjs')).href
);
const { tempDir } = await import(pathToFileURL(path.join(ROOT, 'packages/dsh-context-governance/test/helpers.mjs')).href);

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx() {
  const handlers = [];
  return {
    handlers,
    get() { return undefined; },
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) { handlers.push({ event: name, handler }); return () => {}; },
  };
}

/**
 * 跑一次压缩事务。repost:
 *   null          不重发
 *   { text }      在 end 之后写入同 kind 原生 system/message（真实时序）
 *   { text, before:true } 在 end 之前写入（dev-order，仅供对照）
 */
async function run({ repost = null, kindPatch = undefined, auditFile = '' } = {}) {
  const base = await tempDir('cg-021-runtime-');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/work/dsh-021', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx,
    hostVersion: '0.2.2-rc.3',
    store,
    rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; }, file: auditFile },
    rootId: 'root-dsh-021',
    projectRoot: 'D:/work/dsh-021',
    logger: ctx.logger,
    auditFile,
  });
  guard.start();

  const built = buildCompaction({ before: healthyMessages(), summary: FIVE_SECTION_SUMMARY, start: 0, end: 13, manual: true });
  const head = built.events.find((item) => item.type === 'system/message');
  if (kindPatch !== undefined && head) head.data.message.source.kind = kindPatch;
  const bySeq = new Map(built.events.map((item) => [item.seq, item]));
  let nextSeq = 9000;
  const session = {
    id: 'session-021-runtime',
    surface: { nodes: [...built.session.surface.nodes] },
    eventAt(seq) { return bySeq.get(seq); },
    append(type, data, opts) {
      const item = { seq: nextSeq, type, data, time: Date.now(), ...opts };
      nextSeq += 1;
      bySeq.set(item.seq, item);
      if (opts?.surfaceOp === 'append') this.surface.nodes.push(item.seq);
      return item;
    },
  };
  const emitRepost = (text) => session.append('system/message', {
    turn: 7, step: 1,
    message: { role: 'system', id: 'sys-repost', content: [{ type: 'text', text }], source: { kind: kindPatch === undefined ? 'system-prompt' : kindPatch } },
  }, { surfaceOp: 'append' });

  const handler = ctx.handlers[0].handler;
  const ev = (type) => built.events.find((item) => item.type === type);
  const checkpoint = built.events.find((item) => item.type === 'user/message' && item.data.source?.kind === 'compact-checkpoint');
  handler(session, ev('compaction/start'));
  handler(session, ev('compaction/summary'));
  handler(session, checkpoint);
  session.surface.nodes = [...built.postSurface];
  if (repost?.before === true) emitRepost(repost.text);
  handler(session, ev('compaction/end'));
  await wait(15);
  if (repost !== null && repost.before !== true) {
    emitRepost(repost.text);
    handler(session, { type: 'system/message', data: { turn: 7, step: 1 } });
    await wait(60); // 等轮询/事件通道结算
  }

  const cleanup = async () => {
    await guard.flush().catch(() => {});
    guard.stop();
    await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  };
  return { audits, session, built, guard, handler, emitRepost, cleanup, base };
}

const events = (audits, name) => audits.filter((item) => item.event === name);
const headRuleText = () => healthyMessages().find((item) => item.type === 'system/message')?.data?.message?.content?.map((b) => b.text).join('') ?? '';

// ── RT-A1：真实时序 + 逐字节重发 → accepted(kind, hashMatch=true)
{
  const text = headRuleText();
  const r = await run({ repost: { text } });
  try {
    const res = events(r.audits, 'surface-rebuild-resolved');
    const loss = events(r.audits, 'compaction-loss');
    const okRes = res.length === 1 && res[0].details.disposition === 'accepted'
      && res[0].details.match === 'kind' && res[0].details.hashMatch === true;
    check('RT-A1-byte-identical-repost-accepted', okRes && loss.length === 0,
      `resolved=${JSON.stringify(res.map((x) => x.details))} loss=${loss.length}`);
  } finally { await r.cleanup(); }
}

// ── RT-A2：真实形态（同 kind、内容不同）→ accepted(kind, hashMatch=false)
{
  const r = await run({ repost: { text: `${headRuleText()}\n\n[memory header updated 2026-11-15]` } });
  try {
    const res = events(r.audits, 'surface-rebuild-resolved');
    const loss = events(r.audits, 'compaction-loss');
    check('RT-A2-different-content-same-kind-accepted',
      res.length === 1 && res[0].details.disposition === 'accepted'
      && res[0].details.match === 'kind' && res[0].details.hashMatch === false && loss.length === 0,
      `resolved=${JSON.stringify(res.map((x) => x.details))} loss=${loss.length}`);
  } finally { await r.cleanup(); }
}

// ── RT-P/FIELDS：pending 期间零 loss、零 accepted；skip 字段齐
{
  const r = await run({});
  try {
    const skipped = events(r.audits, 'surface-rebuild-skipped');
    const loss = events(r.audits, 'compaction-loss');
    const acc = events(r.audits, 'compaction-loss-accepted');
    const d = skipped[0]?.details ?? {};
    const required = ['sessionId', 'cycle', 'compactionId', 'ruleSeq', 'kind', 'status'];
    const missing = required.filter((k) => !(k in d));
    check('RT-P-pending-no-loss-no-accepted', skipped.length === 1 && d.status === 'pending' && loss.length === 0 && acc.length === 0,
      `skip=${JSON.stringify(d)} loss=${loss.length} accepted=${acc.length}`);
    check('RT-FIELDS-skip-audit-fields', missing.length === 0 && typeof d.ruleSeq === 'number',
      `missing=${JSON.stringify(missing)} detail=${JSON.stringify(d)}`);

    // RT-B：TTL 到点（turn/end）→ ttl-expired + 恰 1 条 loss
    r.handler(r.session, { type: 'turn/start', data: { turn: 7 } });
    r.handler(r.session, { type: 'turn/end', data: { turn: 7 } });
    await wait(20);
    const res = events(r.audits, 'surface-rebuild-resolved');
    const loss2 = events(r.audits, 'compaction-loss');
    check('RT-B-ttl-expired-settles-unacceptable',
      res.length === 1 && res[0].details.disposition === 'unacceptable' && res[0].details.reason === 'ttl-expired'
      && loss2.length === 1 && loss2[0].details.disposition === 'unacceptable',
      `resolved=${JSON.stringify(res.map((x) => x.details))} loss=${loss2.length}`);
  } finally { await r.cleanup(); }
}

// ── RT-D：dispose 无下一轮 → session-ended
{
  const r = await run({});
  try {
    r.guard.stop();
    const res = events(r.audits, 'surface-rebuild-resolved');
    const loss = events(r.audits, 'compaction-loss');
    check('RT-D-dispose-session-ended',
      res.length === 1 && res[0].details.disposition === 'unacceptable' && res[0].details.reason === 'session-ended'
      && loss.length === 1,
      `resolved=${JSON.stringify(res.map((x) => x.details))} loss=${loss.length}`);
  } finally { await r.cleanup(); }
}

// ── RT-G：turn/abort → turn-aborted
{
  const r = await run({});
  try {
    r.handler(r.session, { type: 'turn/start', data: { turn: 8 } });
    r.handler(r.session, { type: 'turn/abort', data: { turn: 8 } });
    await wait(20);
    const res = events(r.audits, 'surface-rebuild-resolved');
    check('RT-G-turn-aborted-settles',
      res.length === 1 && res[0].details.reason === 'turn-aborted' && res[0].details.disposition === 'unacceptable',
      `resolved=${JSON.stringify(res.map((x) => x.details))}`);
  } finally { await r.cleanup(); }
}

// ── RT-E1：kind=null + 不同文本 → 不 accepted（T 结算 unacceptable）
{
  const r = await run({ kindPatch: null, repost: { text: 'totally different prompt' } });
  try {
    r.guard.stop();
    const res = events(r.audits, 'surface-rebuild-resolved');
    const accepted = res.filter((x) => x.details.disposition === 'accepted');
    check('RT-E1-null-kind-mismatch-not-accepted', accepted.length === 0,
      `resolved=${JSON.stringify(res.map((x) => ({ d: x.details.disposition, r: x.details.reason, m: x.details.match })))}`);
  } finally { await r.cleanup(); }
}

// ── RT-E2：kind=null + 文本相同 → accepted(sha256)
{
  const text = headRuleText();
  const r = await run({ kindPatch: null, repost: { text } });
  try {
    const res = events(r.audits, 'surface-rebuild-resolved');
    check('RT-E2-null-kind-sha-match-accepted',
      res.length === 1 && res[0].details.disposition === 'accepted' && res[0].details.match === 'sha256',
      `resolved=${JSON.stringify(res.map((x) => x.details))}`);
  } finally { await r.cleanup(); }
}

// ── RT-C：重启扫描 pending → restart
{
  const base = await tempDir('cg-021-restart-');
  const auditFile = path.join(base, 'audit.jsonl');
  const pendingRow = {
    ts: new Date(Date.now() - 60_000).toISOString(), event: 'surface-rebuild-skipped',
    sessionId: 'session-restart', cycle: 'cmp-r', compactionId: 'cmp-r', ruleSeq: 0,
    kind: 'system-prompt', status: 'pending',
  };
  await fs.writeFile(auditFile, JSON.stringify(pendingRow) + '\n', 'utf8');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/work/dsh-021', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx, hostVersion: '0.2.2-rc.3', store, rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; }, file: auditFile },
    rootId: 'root-dsh-021', projectRoot: 'D:/work/dsh-021', logger: ctx.logger, auditFile,
  });
  guard.start();
  await wait(20);
  try {
    const res = events(audits, 'surface-rebuild-resolved');
    const loss = events(audits, 'compaction-loss');
    check('RT-C-restart-settles-unacceptable',
      res.length === 1 && res[0].details.disposition === 'unacceptable' && res[0].details.reason === 'restart' && loss.length === 1,
      `resolved=${JSON.stringify(res.map((x) => x.details))} loss=${loss.length}`);
  } finally {
    await guard.flush().catch(() => {}); guard.stop(); await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ── RT-F：审计轮转 → recovery-incomplete（文案含"可能存在未结算 pending"）
{
  const base = await tempDir('cg-021-rotate-');
  const auditFile = path.join(base, 'audit.jsonl');
  await fs.writeFile(auditFile, JSON.stringify({ ts: new Date().toISOString(), event: 'x' }) + '\n', 'utf8');
  await fs.writeFile(`${auditFile}.1`, '', 'utf8');
  const store = await MemoryStore.open({ rootDir: path.join(base, 'memory'), project: 'test-project' });
  const audits = [];
  const ctx = makeCtx();
  const guard = new CompressionGuard({
    resolveScope: () => ({ mode: 'single-root', root: 'D:/work/dsh-021', cwd: '', governed: true, skipReason: null, unattributed: false }),
    ctx, hostVersion: '0.2.2-rc.3', store, rootAudit: { append() {} },
    audit: { append(eventName, details) { audits.push({ event: eventName, details }); return true; }, file: auditFile },
    rootId: 'root-dsh-021', projectRoot: 'D:/work/dsh-021', logger: ctx.logger, auditFile,
  });
  guard.start();
  await wait(20);
  try {
    const inc = events(audits, 'surface-rebuild-recovery-incomplete');
    check('RT-F-rotation-reports-recovery-incomplete',
      inc.length === 1 && /未结算 pending/.test(String(inc[0].details.reason ?? '')),
      `incomplete=${JSON.stringify(inc.map((x) => x.details))}`);
  } finally {
    await guard.flush().catch(() => {}); guard.stop(); await store.close().catch(() => {});
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ── RT-E3：kind=null + 无重发 + TTL 到点 → acceptable 不成立且 ttl-expired
{
  const r = await run({ kindPatch: null });
  try {
    r.handler(r.session, { type: 'turn/start', data: { turn: 9 } });
    r.handler(r.session, { type: 'turn/end', data: { turn: 9 } });
    await wait(20);
    const res = events(r.audits, 'surface-rebuild-resolved');
    const accepted = res.filter((x) => x.details.disposition === 'accepted');
    check('RT-E3-null-kind-no-repost-ttl-expired',
      accepted.length === 0 && res.length === 1 && res[0].details.reason === 'ttl-expired',
      `resolved=${JSON.stringify(res.map((x) => x.details))}`);
  } finally { await r.cleanup(); }
}

const failed = results.filter((item) => !item.ok);
console.log(`\n021-runtime TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }

