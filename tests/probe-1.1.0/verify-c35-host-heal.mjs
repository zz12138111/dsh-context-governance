/**
 * 测试角色 · C35「指令/目录宿主自愈」日志级验收
 * 口径：需求 dfaf053（C35③ 回退）——
 *   事件级主判：窗口内出现非治理写的新规则节点（agent-instructions / skill-catalog）→ pass；无 → fail + 期望 loss
 *   digest 仅观察：不一致 → `self-heal-suspect` warn（不判 fail）；读盘失败/字段缺失 → `self-heal-unverified` warn
 *   skill-catalog：事件级，不做 digest 必过
 *   compaction-loss 不得含 rule-injection；surface-rebuild-* 必须 0
 *
 * 用法：node tests\probe-1.1.0\verify-c35-host-heal.mjs <session.zstd> [audit.jsonl] [compactionId]
 * 不带 compactionId 时取会话最后一次 compaction。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const results = [];
const warns = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }
function warn(id, detail) { warns.push({ id, detail }); console.log(`WARN ${id} :: ${detail}`); }

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
const srcOf = (e) => (e?.data?.message?.source) ?? (e?.data?.source) ?? {};
const textOf = (e) => {
  const d = e?.data || {};
  const m = d.message || d;
  const c = m.content || [];
  return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
};
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const RULE_KINDS = new Set(['agent-instructions', 'skill-catalog']);

const file = process.argv[2];
const auditFile = process.argv[3] || '';
const wantCompaction = process.argv[4] || '';
if (!file) { console.error('usage: verify-c35-host-heal.mjs <session.zstd> [audit.jsonl] [compactionId]'); process.exit(2); }

const events = loadSession(file);
console.log(`session=${path.basename(path.dirname(file))} events=${events.length} audit=${auditFile || '(none)'} compaction=${wantCompaction || '(last)'}`);

let endEv = null;
if (wantCompaction) endEv = events.filter((e) => e.type === 'compaction/end' && e.data?.compactionId === wantCompaction).pop() || null;
if (endEv === null) endEv = events.filter((e) => e.type === 'compaction/end').pop() || null;
if (endEv === null) { check('C35-all', false, '该会话无 compaction/end'); process.exit(1); }
const compId = endEv.data?.compactionId ?? null;
const startEv = events.filter((e) => e.type === 'compaction/start' && e.data?.compactionId === compId).pop() || null;
console.log(`compactionId=${compId} start=${startEv?.seq} end=${endEv.seq}`);

// 窗口
const windowEvents = startEv === null ? [endEv] : events.filter((e) => e.seq >= startEv.seq && e.seq <= endEv.seq);

// C35a：窗口内插件写的规则副本 = 0（latestUser 允许 1）
const pluginRuleCopies = windowEvents.filter((e) => {
  if (e.type !== 'user/message') return false;
  const s = srcOf(e);
  const byPlugin = s.plugin === 'context-governance' || s.form === 'surface-rebuild';
  const kind = s.kind ?? null;
  return byPlugin && (kind === null || RULE_KINDS.has(kind) || kind === 'system-prompt');
});
const latestUserCopies = windowEvents.filter((e) => {
  if (e.type !== 'user/message') return false;
  const s = srcOf(e);
  return (s.plugin === 'context-governance' || s.form === 'surface-rebuild') && (s.kind ?? null) === 'user';
});
check('C35a-window-zero-rule-copies', pluginRuleCopies.length === 0,
  `ruleCopies=${JSON.stringify(pluginRuleCopies.map((e) => ({ seq: e.seq, kind: srcOf(e).kind ?? null, form: srcOf(e).form })))}`);
check('C35e-latestUser-at-most-one-copy', latestUserCopies.length <= 1, `latestUserCopies=${latestUserCopies.map((e) => e.seq).join(',') || '0'}`);

// C35b/C35c：事件级——压缩后是否出现非治理写的新规则节点
const after = events.filter((e) => e.seq > endEv.seq && e.type === 'user/message');
const hostRuleNodes = after.filter((e) => {
  const s = srcOf(e);
  if (!RULE_KINDS.has(s.kind ?? null)) return false;
  return s.plugin !== 'context-governance' && s.form !== 'surface-rebuild';
});
const replayedCopies = after.filter((e) => {
  const s = srcOf(e);
  return (s.plugin === 'context-governance' || s.form === 'surface-rebuild') && RULE_KINDS.has(s.kind ?? null) && e.data?.source?.cycle === compId;
});
check('C35b-next-pre-step-host-rule-node', hostRuleNodes.length > 0 && replayedCopies.length === 0,
  `hostNodes=${JSON.stringify(hostRuleNodes.slice(0, 4).map((e) => ({ seq: e.seq, kind: srcOf(e).kind, form: srcOf(e).form, sha1: sha1(textOf(e)).slice(0, 12) })))} replayedThisCycle=${replayedCopies.length}`);

// digest 仅观察：suspect / unverified（warn，不判 fail）
let suspects = 0, unverified = 0;
for (const e of hostRuleNodes.slice(0, 20)) {
  const s = srcOf(e);
  if (s.kind !== 'agent-instructions') continue;
  for (const ch of s.changes || []) {
    if (typeof ch.digest !== 'string' || typeof ch.path !== 'string') { unverified++; continue; }
    const p = ch.path.startsWith('~/.dsh/') ? path.join('C:/Users/19091/.dsh', ch.path.slice('~/.dsh/'.length)) : path.join(events[0]?.cwd ?? '', ch.path);
    let content = null;
    try { content = fs.readFileSync(p, 'utf8'); } catch { unverified++; continue; }
    if (ch.digest !== sha1(content)) suspects++; // v4：raw 复算，不 trim
  }
}
if (suspects > 0) warn('C35-self-heal-suspect', `digest 与盘上重算不一致 ${suspects} 处（仅观察，不判 fail）`);
if (unverified > 0) warn('C35-self-heal-unverified', `读盘失败/字段缺失 ${unverified} 处（仅观察，不判 fail）`);

// 审计断言
if (auditFile && fs.existsSync(auditFile)) {
  const audits = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rows = audits.filter((r) => r.compactionId === compId || r.cycle === compId);
  const lostRule = rows.filter((r) => r.event === 'compaction-loss' && (r.failures || []).includes('rule-injection'));
  const rebuild = rows.filter((r) => String(r.event || '').startsWith('surface-rebuild'));
  const verified = rows.filter((r) => r.event === 'self-heal-verified');
  const missing = rows.filter((r) => r.event === 'self-heal-missing');
  const pending = rows.filter((r) => r.event === 'self-heal-pending');
  console.log(`audit rows(cycle)=${rows.length} verified=${verified.length} missing=${missing.length} pending=${pending.length} lossRuleInjection=${lostRule.length} surface-rebuild=${rebuild.length}`);
  check('C35-loss-no-rule-injection', lostRule.length === 0,
    `compaction-loss(rule-injection)=${lostRule.length} reasons=${JSON.stringify([...new Set(lostRule.map((r) => r.reason || ''))])}`);
  check('C35d-no-surface-rebuild-events', rebuild.length === 0, `surface-rebuild=${rebuild.length}`);
  // 清单 §3 补充断言（重启后复验清单.md）
  const allowedLoss = new Set(['rollback-point', 'batch-list', 'latest-user-message']);
  const badLoss = rows.filter((r) => r.event === 'compaction-loss' && (r.failures || []).some((f) => !allowedLoss.has(f)));
  check('C35-loss-only-allowed-failures', badLoss.length === 0,
    `badLoss=${JSON.stringify(badLoss.map((r) => r.failures))}`);
  const acceptedRows = rows.filter((r) => r.event === 'compaction-loss-accepted');
  check('C35-no-compaction-loss-accepted', acceptedRows.length === 0, `accepted=${acceptedRows.length}`);
  const rbSkipped = rows.filter((r) => r.event === 'surface-rebuild-skipped');
  const rbResolved = rows.filter((r) => r.event === 'surface-rebuild-resolved');
  check('C35-no-pending-events', rbSkipped.length === 0 && rbResolved.length === 0,
    `skipped=${rbSkipped.length} resolved=${rbResolved.length}`);
  const presence = ['protection-write', 'protection-materialized', 'reinjection', 'compaction-cost']
    .filter((e) => rows.some((r) => r.event === e));
  check('C35-pointer-pipeline-present', presence.length >= 3,
    `present=${JSON.stringify(presence)}`);
} else {
  warn('C35-audit-skipped', '未提供 audit 文件：loss/surface-rebuild 不可判');
}

// latestUser：压缩前最后一条用户消息 vs 窗口内 latestUser 副本
const preUser = events.filter((e) => e.seq < (startEv?.seq ?? endEv.seq) && e.type === 'user/message' && (srcOf(e).kind ?? null) === 'user').pop();
const latestCopy = windowEvents.filter((e) => {
  if (e.type !== 'user/message') return false;
  const s = srcOf(e);
  return (s.plugin === 'context-governance' || s.form === 'surface-rebuild') && (s.kind ?? null) === 'user';
}).pop();
if (latestCopy !== undefined) {
  const same = preUser !== undefined && sha1(textOf(preUser)) === sha1(textOf(latestCopy));
  check('C35-latestUser-copy-matches-pre-compaction', same,
    `preSeq=${preUser?.seq} copySeq=${latestCopy.seq} same=${same}`);
} else {
  check('C35-latestUser-copy-matches-pre-compaction', false, '窗口内无 latestUser 副本（清单要求存在）');
}

const failed = results.filter((r) => !r.ok);
console.log(`\nC35 TOTAL ${results.length - failed.length}/${results.length} PASS  WARN=${warns.length}`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((r) => r.id).join(', ')}`); process.exitCode = 1; }

