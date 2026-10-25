/**
 * T4：把压缩前快照转成“最小记忆条目”（标题 + 指针），供 `MemoryStore.protectSync` 同步落盘。
 *
 * 硬约束：
 * - 不复制正文；只放首行/摘要（≤200 字符）、路径、callId 与来源指针；
 * - 每条都带 `source = session:<id>#<seq>`，可回原文；
 * - 标题单行、≤200 字符；命中凭据形态时只写“已省略”，绝不落敏感内容；
 * - 顺序固定：① 最新用户 ② 规则 ③ 批次 ④ 回滚点 ⑤ 未闭合调用。
 */

import { ENTRY_TYPES, detectSensitive } from '../memory/contract.js';

const MAX_TITLE = 200;

function sanitizeTitle(value, fallback) {
  let title = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (title === '') title = fallback;
  if (detectSensitive(title) !== null) return fallbackSensitive(title, fallback);
  return title.slice(0, MAX_TITLE);
}

function fallbackSensitive(_value, fallback) {
  return `${fallback.replace(/：.*$/, '')}（敏感内容已省略）`.slice(0, MAX_TITLE);
}

function typeOf(raw) {
  return ENTRY_TYPES.includes(raw) ? raw : 'fact';
}

/**
 * @param {object} snapshot `snapshotProtection` 的结果。
 * @param {{sessionId?:string, compactionId?:string, cycleKey?:string, manual?:boolean, captureTitle?:boolean}} context
 *   `captureTitle=false`（P2-2）时只写通用标签（如“最新用户消息”），不存任何首行/路径内容。
 * @returns {{items:object[], meta:object[]}}
 */
export function buildProtectionItems(snapshot, {
  sessionId = 'unknown',
  compactionId = null,
  cycleKey = null,
  manual = false,
  captureTitle = true,
} = {}) {
  const items = [];
  const meta = [];
  const pointer = (seq) => `session:${sessionId}#${seq ?? '?'}`;
  const evidence = cycleKey === null ? undefined : `compaction:${cycleKey}`;
  const push = (item, info) => {
    const title = captureTitle
      ? sanitizeTitle(item.title, item.fallback ?? '压缩保护项')
      : sanitizeTitle(item.fallback ?? '压缩保护项', '压缩保护项');
    items.push({
      type: typeOf(item.type),
      title,
      source: item.source,
      evidence: item.evidence ?? evidence,
    });
    meta.push({ ...info, manual });
  };

  // ① 最新用户消息：首行/摘要 + 原文指针。
  if (snapshot.latestUser !== null) {
    const title = snapshot.latestUser.title || '最新用户消息（非文本）';
    const prefix = title.startsWith('最新用户消息') ? '' : '最后用户消息：';
    push({
      type: 'fact',
      title: `${prefix}${title}`,
      fallback: '最新用户消息',
      source: pointer(snapshot.latestUser.seq),
    }, {
      kind: 'latest-user',
      seq: snapshot.latestUser.seq,
      title,
      coverageText: title,
    });
  }

  // ② 本回合规则注入：每种注入取最新一条，列出在册路径。
  const latestRules = new Map();
  for (const rule of snapshot.rules ?? []) {
    if (!latestRules.has(rule.source) || latestRules.get(rule.source).seq < rule.seq) latestRules.set(rule.source, rule);
  }
  if (latestRules.size > 0) {
    const rules = [...latestRules.values()];
    const paths = [...new Set(rules.flatMap((rule) => rule.paths ?? []))].slice(0, 6);
    const title = paths.length > 0
      ? `规则在场：${paths.join('、')}`
      : `规则在场：${[...latestRules.keys()].join('、')}`;
    const latest = rules.reduce((best, rule) => (best === null || rule.seq > best.seq ? rule : best), null);
    push({
      type: 'criterion',
      title,
      fallback: '规则注入在场',
      source: pointer(latest?.seq),
    }, {
      kind: 'rules',
      seq: latest?.seq ?? null,
      paths,
      coverageText: paths.join(' '),
    });
  }

  // ③ 未完成批次：优先 STATE 文件指针，其次批次数字。
  if (snapshot.batch !== null) {
    const ratios = snapshot.batch.ratios ?? [];
    const title = snapshot.batch.statePath
      ? `批次 STATE：${snapshot.batch.statePath}`
      : `批次进度：${ratios.join('、') || '有批次标记'}`;
    push({
      type: 'progress',
      title,
      fallback: '批次进度',
      source: pointer(snapshot.batch.seq),
    }, {
      kind: 'batch',
      seq: snapshot.batch.seq,
      ratios,
      paths: snapshot.batch.statePath === null ? [] : [snapshot.batch.statePath],
      keyword: snapshot.batch.keyword ?? null,
      coverageText: [ratios.join(' '), snapshot.batch.statePath ?? ''].filter(Boolean).join(' '),
    });
  }

  // ④ 最近回滚点/映射指针。
  if (snapshot.rollback !== null) {
    const paths = snapshot.rollback.paths ?? [];
    const title = paths.length > 0
      ? `回滚点：${paths[0]}`
      : `回滚点：${snapshot.rollback.keyword}`;
    push({
      type: 'anchor',
      title,
      fallback: '回滚点',
      source: pointer(snapshot.rollback.seq),
    }, {
      kind: 'rollback',
      seq: snapshot.rollback.seq,
      paths,
      keyword: snapshot.rollback.keyword,
      coverageText: [snapshot.rollback.keyword, ...paths].join(' '),
    });
  }

  // ⑤ 工具配对未闭合的 callId（若有）。
  if (Array.isArray(snapshot.unpairedCalls) && snapshot.unpairedCalls.length > 0) {
    const calls = snapshot.unpairedCalls;
    const ids = calls.map((call) => call.callId).filter(Boolean).slice(0, 10);
    push({
      type: 'fact',
      title: `未闭合工具调用：${ids.join(', ')}`,
      fallback: '未闭合工具调用',
      source: pointer(calls[0].seq),
    }, {
      kind: 'unpaired-calls',
      seq: calls[0].seq,
      callIds: ids,
      coverageText: ids.join(' '),
    });
  }

  return { items, meta };
}
