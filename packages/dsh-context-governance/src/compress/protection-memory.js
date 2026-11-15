/**
 * T4：把压缩前快照转成“最小记忆条目”（标题 + 指针），供 `MemoryStore.protectSync` 同步落盘。
 *
 * 硬约束：
 * - 不复制正文；只放首行/摘要（≤200 字符）、路径、callId 与来源指针；
 * - 每条都带 `source = session:<id>#<seq>`，可回原文；
 * - 标题单行、≤200 字符；命中凭据形态时只写“已省略”，绝不落敏感内容；
 * - 顺序固定：① 最新用户 ② 规则 ③ 批次 ④ 回滚点 ⑤ 未闭合调用。
 */

import { ENTRY_TYPES, detectSensitive, detectTitleTruncation } from '../memory/contract.js';

const MAX_TITLE = 200;

/**
 * 1.0.3：标题截断必须落在安全边界——超长时在空白/顿号/逗号前切，并去掉尾部分隔符与
 * 未闭合反引号；绝不在"回滚点：回滚"这种残句上收尾（实测噪声）。
 */
function cutTitle(text) {
  if (text.length <= MAX_TITLE) return text;
  const head = text.slice(0, MAX_TITLE);
  const boundary = Math.max(
    head.lastIndexOf(' '),
    head.lastIndexOf('、'),
    head.lastIndexOf('，'),
    head.lastIndexOf('；'),
    head.lastIndexOf(';'),
    head.lastIndexOf('/'),
  );
  let cut = boundary > MAX_TITLE * 0.6 ? head.slice(0, boundary) : head;
  cut = cut.replace(/[：:，,、;；/\\\-—–（(【\[`]+$/, '').trim();
  if ((cut.match(/`/g) ?? []).length % 2 === 1) cut = cut.replace(/`/g, '').trim();
  return cut === '' ? head.trim() : cut;
}

function sanitizeTitle(value, fallback) {
  let title = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (title === '') title = fallback;
  if (detectSensitive(title) !== null) return fallbackSensitive(title, fallback);
  const cut = cutTitle(title);
  // 1.0.3-5c：切分后仍被判"截断"（未闭合反引号 / 残尾分隔符 / 省略号）就退回指针式标题，
  // 绝不把半句写进库——历史缺陷里出现过"回滚点：<仓库根>"被截半后当成标题的情况（见记忆）。
  if (detectTitleTruncation(cut) !== null) return String(fallback ?? '').trim();
  return cut;
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
    // 1.0.3：正文不允许为空——用覆盖率文本（首行/路径/比例）兜底，否则落到来源指针。
    // 与标题同一脱敏口径：正文命中凭据形态时只用指针，绝不落敏感内容。
    const detailRaw = String(info?.coverageText ?? '').trim();
    const detailText = detailRaw !== '' && detectSensitive(detailRaw) === null ? detailRaw : '';
    const fallbackDetail = `来源：${item.source ?? 'unknown'}${item.evidence ? `；证据：${item.evidence}` : ''}`;
    items.push({
      type: typeOf(item.type),
      title,
      detail: detailText === '' ? fallbackDetail : detailText.slice(0, 2000),
      source: item.source,
      evidence: item.evidence ?? evidence,
    });
    meta.push({ ...info, manual });
  };

  // ① 最新用户消息：首行/摘要 + 原文指针。
  if (snapshot.latestUser !== null) {
    const fullTitle = snapshot.latestUser.title || '最新用户消息（非文本）';
    // 1.1.0 #4③：标题按 80 字收口（拼前缀后 ≈87 字），全文仍走 detail 的 coverageText，信息不丢。
    const title = fullTitle.slice(0, 80);
    const prefix = title.startsWith('最新用户消息') ? '' : '最后用户消息：';
    push({
      type: 'fact',
      title: `${prefix}${title}`,
      fallback: '最新用户消息',
      source: pointer(snapshot.latestUser.seq),
    }, {
      kind: 'latest-user',
      seq: snapshot.latestUser.seq,
      title: fullTitle,
      coverageText: fullTitle,
    });
  }

  // ② 本回合规则注入：每种注入取最新一条，列出在册路径。
  const latestRules = new Map();
  for (const rule of snapshot.rules ?? []) {
    const key = rule.kind ?? rule.source?.kind ?? 'unknown';
    if (!latestRules.has(key) || latestRules.get(key).seq < rule.seq) latestRules.set(key, rule);
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
    // 1.1.0 #4②：statePath 与 ratios 都空 → 不发占位条目（空信息条目只占 TTL 名额与去重窗口）。
    if (snapshot.batch.statePath || ratios.length > 0) {
      const title = snapshot.batch.statePath
        ? `批次 STATE：${snapshot.batch.statePath}`
        : `批次进度：${ratios.join('、')}`;
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
  }

  // ④ 最近回滚点/映射指针。
  if (snapshot.rollback !== null) {
    const paths = snapshot.rollback.paths ?? [];
    const keyword = String(snapshot.rollback.keyword ?? '').trim();
    // 1.0.3：不给"回滚点：回滚"这种残句；无路径又只有泛词时落到指针说明。
    // 1.1.0 #4①：与 5c 截断兜底（`:43`+`:166`）同文案 `回滚点（见 source）`——detail 允许为空（5a），
    // "见正文"可能指向空，能保证可解析的只有 source/evidence。
    const title = paths.length > 0
      ? `回滚点：${paths[0]}`
      : (keyword !== '' && keyword !== '回滚点' && keyword !== '回滚' ? `回滚点：${keyword}` : '回滚点（见 source）');
    push({
      type: 'anchor',
      title,
      fallback: '回滚点（见 source）',
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
