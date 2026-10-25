/**
 * 压缩保护校验（架构 §4.10 / §6.6）。
 *
 * 治理层**不是执行者**：宿主/后端决定压缩范围，我们只能：
 *   1. 压缩前（`compaction/start`）对当前 surface 做只读快照；
 *   2. 压缩后（`compaction/end`）用 `shadowedRange/Seqs` 核对受保护内容是否被吞；
 *   3. 失败时显式报告（不静默、不改写宿主内容）。
 *
 * 保护清单（M1）：
 *   - latest-user-message  最新人类用户消息
 *   - rule-injection       系统提示 / AGENTS 规则注入 / 技能目录
 *   - tool-pairing         工具调用与结果配对（压缩切口必须 balanced）
 *   - batch-list           含批次/进度数字的消息
 *   - rollback-point       含回滚/备份/还原点的消息
 *   - artifact             摘要 + checkpoint 产物存在
 *
 * 快照只保留 seq/类型/标记数字与路径，不保存消息正文。
 */

export const PROTECTION_CHECKS = Object.freeze([
  'artifact',
  'latest-user-message',
  'rule-injection',
  'tool-pairing',
  'batch-list',
  'rollback-point',
  'summary-readable',
]);

const ROLLBACK_RE = /(回滚点?|rollback|还原点|备份点|恢复点|快照点)/i;
const PATH_RE = /[A-Za-z]:\\[^\s，。；;）)]+/g;

const RULE_SOURCE_KINDS = Object.freeze(['agent-instructions', 'skill-catalog']);
const STATE_FILE_RE = /(?:[A-Za-z]:\\|TASKS[\\/])[^\s，。；;）)]*?-STATE\.md/gi;

/**
 * 进度数字只认“数字/数字”的明确比例（`511/958`、`8000/1500`）。
 * 前后不许再贴数字或斜杠，避免把日期 `2026/10/25`、多级路径当比例。
 * `YYYY/MM`（19xx/20xx + 1–12）单独出现也不算比例。
 */
const RATIO_RE = /(?<![\d/／])(\d{1,6})\s*[／/]\s*(\d{1,6})(?![\d/／])/g;
const YEAR_PREFIX_RE = /^(?:19|20)\d{2}$/;
const BATCH_KEYWORD_RE = /批次|进度|progress|batch/i;
/** P2-4：需要语义邻近词（比例后紧跟单位）或显式 [batch]；测试/版本语境直接排除。 */
const RATIO_UNIT_AFTER_RE = /^\s*(?:项|条|个|文件|任务|完成)/;
const EXPLICIT_BATCH_RE = /\[batch\]/i;
const TEST_CONTEXT_RE = /测试|通过|passed|tests?|覆盖|coverage|commit|push|版本/i;
/** 排除结构化载荷：围栏代码块、JSON 对象、JSON 数组（只剥“像 JSON”的，正文 `{511/958}` 保留）。 */
const FENCE_RE = /```[\s\S]*?```/g;
const JSON_OBJECT_RE = /\{[^{}]{0,400}\}/g;
const JSON_ARRAY_RE = /\[[^\[\]]{0,400}\]/g;
const STRUCTURED_HINT_RE = /["'：:]/;

/** 取消息对象（user/message 直接放 data；system/assistant/tool 放在 data.message）。 */
export function messageOf(event) {
  if (event === null || typeof event !== 'object') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object') return null;
  if (data.message !== null && typeof data.message === 'object') return data.message;
  return data;
}

export function sourceKindOf(event) {
  return messageOf(event)?.source?.kind ?? null;
}

/** 取消息可见文本（只处理 text 块；工具参数/结果不算“文本”）。 */
export function textOf(event) {
  const content = messageOf(event)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function isAssistantToolCall(event) {
  if (event?.type !== 'assistant/message') return false;
  const content = messageOf(event)?.content;
  return Array.isArray(content) && content.some((block) => block?.type === 'tool-call');
}

function toolCallCount(event) {
  if (event?.type !== 'assistant/message') return 0;
  const content = messageOf(event)?.content;
  return Array.isArray(content) ? content.filter((block) => block?.type === 'tool-call').length : 0;
}

function deltaOf(event) {
  if (event?.type === 'tool/result') return -1;
  return toolCallCount(event);
}

function getEvent(session) {
  return (seq) => {
    const event = session?.eventAt?.(seq);
    return event !== undefined && event !== null ? event : null;
  };
}

function summarizeNode(event) {
  if (event === null) return null;
  return {
    seq: event.seq,
    type: event.type,
    source: sourceKindOf(event),
    textLength: textOf(event).length,
  };
}

/** 首行/摘要，≤200 字符；不保留换行。 */
export function titleOfText(text, max = 200) {
  const firstLine = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return firstLine.replace(/\s+/g, ' ').slice(0, max);
}

function rulePathsOf(event) {
  const source = messageOf(event)?.source;
  const changes = Array.isArray(source?.changes) ? source.changes : [];
  const paths = new Set();
  for (const change of changes) {
    if (typeof change?.path === 'string' && change.path.trim() !== '') paths.add(change.path.trim());
    else if (typeof change?.scope === 'string' && change.scope.trim() !== '') paths.add(change.scope.trim());
  }
  if (paths.size === 0 && typeof source?.kind === 'string') paths.add(source.kind);
  return [...paths].slice(0, 8);
}

function callIdOfResult(event) {
  return messageOf(event)?.source?.callId ??
    event?.data?.source?.callId ??
    event?.data?.toolCallId ??
    messageOf(event)?.toolCallId ?? null;
}

function toolCallsOf(event) {
  if (event?.type !== 'assistant/message') return [];
  const content = messageOf(event)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'tool-call')
    .map((block) => ({ callId: block.id ?? block.callId ?? block.toolCallId ?? null, name: block.name ?? null }));
}

function unpairedCallsOf(events) {
  const open = new Map();
  for (const event of events) {
    for (const call of toolCallsOf(event)) {
      if (typeof call.callId !== 'string' || call.callId === '') continue;
      open.set(call.callId, { callId: call.callId, name: call.name, seq: event.seq });
    }
    if (event?.type === 'tool/result') {
      const callId = callIdOfResult(event);
      if (typeof callId === 'string') open.delete(callId);
    }
  }
  return [...open.values()].slice(0, 20);
}

/**
 * 进度数字只从对话正文取：人类的 `user/message` 与 `assistant/message`。
 * 排除 `tool/call`、`tool/result`、规则注入/检查点等非对话消息。
 */
export function isProgressMessage(event) {
  if (event === null || typeof event !== 'object') return false;
  if (event.type === 'user/message') return sourceKindOf(event) === 'user';
  return event.type === 'assistant/message';
}

/** 去掉围栏代码块与“像 JSON”的对象/数组载荷；正文里的 `{511/958}` 保留。 */
export function stripStructuredPayload(text) {
  return String(text ?? '')
    .replace(FENCE_RE, ' ')
    .replace(JSON_OBJECT_RE, (chunk) => (STRUCTURED_HINT_RE.test(chunk) ? ' ' : chunk))
    .replace(JSON_ARRAY_RE, (chunk) => (STRUCTURED_HINT_RE.test(chunk) ? ' ' : chunk));
}

/**
 * 抽取明确比例并剔除日期形态（`2026/10`）。
 * @returns {{ratios: string[], dateLike: number}}
 */
function extractRatios(text) {
  const ratios = [];
  let dateLike = 0;
  for (const match of text.matchAll(RATIO_RE)) {
    const current = match[1];
    const total = match[2];
    if (YEAR_PREFIX_RE.test(current) && /^\d{1,2}$/.test(total) && Number(total) >= 1 && Number(total) <= 12) {
      dateLike += 1;
      continue;
    }
    const key = `${current}/${total}`;
    if (!ratios.includes(key)) ratios.push(key);
  }
  return { ratios: ratios.slice(0, 8), dateLike };
}

/**
 * 批次进度候选：只从对话正文取，且**必须同一条消息内**出现批次语义
 * （`批次|进度|progress|batch`）；无关键字但有比例的消息记为“被拒候选”，
 * 供 skip 时写 `no-batch-semantics` 原因。
 */
function batchMarkers(event) {
  if (!isProgressMessage(event)) return null;
  const text = stripStructuredPayload(textOf(event));
  if (text.trim() === '') return null;
  // P2-4 第 2 条：模型回引 header 不得再被当成新进度。
  if (event.type === 'assistant/message' && /\[CG-MEMORY/i.test(text)) return null;
  const { ratios, dateLike } = extractRatios(text);
  const explicit = /\[batch\]/i.test(text);
  const keyword = BATCH_KEYWORD_RE.exec(text)?.[0]?.toLowerCase() ?? (explicit ? 'batch' : null);
  if (keyword === null && ratios.length === 0) return null;
  if (keyword === null) return { ratios, keyword: null, dateLike };
  // P2-4 第 1 条（DEC-20261025-73 A）：比例须带语义单位或显式 [batch]；缺单位 → skip(no-unit)，不是 null。
  if (!explicit && ratios.length > 0) {
    const hasUnit = [...text.matchAll(RATIO_RE)].some((match) => (
      /^\s*[}】)\]]*\s*(?:项|条|个|文件|任务|完成)/.test(text.slice(match.index + match[0].length))
    ));
    if (!hasUnit) return { ratios, keyword, dateLike, missingUnit: true };
  }
  return { ratios, keyword, dateLike };
}

/** 供 P2-4 回归用例直接验证写入侧判定（不是对外 API）。 */
export function batchCandidate(event) {
  return batchMarkers(event);
}

function rollbackMarkers(event) {
  const text = textOf(event);
  if (text === '') return null;
  const match = ROLLBACK_RE.exec(text);
  if (match === null) return null;
  return {
    keyword: match[1],
    paths: [...new Set(text.match(PATH_RE) ?? [])].slice(0, 6),
  };
}

/**
 * 压缩前快照；只读取 surface 与事件，不改任何东西。
 *
 * @param {object} session 宿主 Session（提供 surface.nodes / eventAt）。
 * @returns {object}
 */
export function snapshotProtection(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : [];
  const at = getEvent(session);
  const events = nodes.map(at);
  const balances = [];
  const deltas = [];
  let balance = 0;
  for (const event of events) {
    const delta = deltaOf(event);
    deltas.push(delta);
    balance += delta;
    balances.push(balance);
  }
  let latestUser = null;
  const rules = [];
  let batch = null;
  let batchRejected = null;
  let rollback = null;
  for (let index = 0; index < nodes.length; index += 1) {
    const event = events[index];
    if (event === null) continue;
    const text = textOf(event);
    if (event.type === 'user/message' && sourceKindOf(event) === 'user') {
      latestUser = { ...summarizeNode(event), title: titleOfText(text) };
    }
    if (event.type === 'system/message' || (event.type === 'user/message' && RULE_SOURCE_KINDS.includes(sourceKindOf(event)))) {
      rules.push({ ...summarizeNode(event), kind: sourceKindOf(event), paths: rulePathsOf(event) });
    }
    const batchInfo = batchMarkers(event);
    if (batchInfo !== null) {
      const statePath = (text.match(STATE_FILE_RE) ?? [])[0] ?? null;
      const candidate = { ...summarizeNode(event), ...batchInfo, statePath };
      if (candidate.missingUnit === true) {
        // P2-4：有比例+批次语义但缺语义单位 → 不算候选，skip(no-unit)。
        batchRejected = candidate;
      } else if (candidate.keyword === null) {
        // 有比例但没有批次语义：不算批次进度，只留最后一次做 skip 原因（no-batch-semantics）。
        batchRejected = candidate;
      } else if (batch === null || batch.ratios.length === 0 || candidate.ratios.length > 0) {
        // 取最近一条；但“带比例”的进度优先于仅有关键字的消息，避免后文把 511/958 覆盖掉。
        batch = candidate;
      }
    }
    const rollbackInfo = rollbackMarkers(event);
    if (rollbackInfo !== null) rollback = { ...summarizeNode(event), ...rollbackInfo };
  }
  return {
    capturedAt: new Date().toISOString(),
    nodes,
    nodeCount: nodes.length,
    latestUser,
    rules,
    batch,
    batchRejected,
    rollback,
    unpairedCalls: unpairedCallsOf(events),
    balances,
    deltas,
    toolCalls: events.reduce((total, event) => total + toolCallCount(event), 0),
    toolResults: events.filter((event) => event?.type === 'tool/result').length,
  };
}

/**
 * 宿主替换压缩区间后的预期 surface（只用于校验，不写回宿主）：
 * 保留未被 shadow 的节点，并在原区间起点插入 checkpoint。
 */
export function expectedSurface(snapshot, shadowedSeqs, checkpointSeq) {
  const shadowed = new Set(shadowedSeqs ?? []);
  const nodes = snapshot.nodes.filter((seq) => !shadowed.has(seq));
  if (Number.isInteger(checkpointSeq)) {
    const firstShadowedIndex = snapshot.nodes.findIndex((seq) => shadowed.has(seq));
    const position = firstShadowedIndex === -1 ? nodes.length : Math.min(firstShadowedIndex, nodes.length);
    nodes.splice(position, 0, checkpointSeq);
  }
  return nodes;
}

function shadowedNodesFrom(summaryData, snapshot) {
  if (Array.isArray(summaryData?.shadowedSeqs) && summaryData.shadowedSeqs.length > 0) {
    return [...summaryData.shadowedSeqs];
  }
  const range = summaryData?.shadowedRange;
  if (range === null || typeof range !== 'object') return [];
  const start = range.start;
  const end = range.end;
  return snapshot.nodes.filter((seq) => seq >= start && seq <= end);
}

export function summaryTextOf(summaryEvent) {
  const summary = summaryEvent?.data?.summary;
  if (typeof summary === 'string') return summary;
  if (!Array.isArray(summary)) return '';
  return summary
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function ratiosCovered(ratios, summaryText) {
  // 没有比例就没有“覆盖”可谈：调用方应判 skip，不得因为摘要非空而空泛通过。
  if (ratios.length === 0) return false;
  const normalized = summaryText.replace(/\s+/g, '');
  return ratios.every((ratio) => normalized.includes(ratio.replace(/\s+/g, '')));
}

function rollbackCovered(markers, summaryText) {
  if (!summaryText.includes(markers.keyword)) return false;
  if (markers.paths.length === 0) return true;
  return markers.paths.some((path) => summaryText.includes(path));
}

function check(name, status, detail, extra = {}) {
  return { name, status, detail, ...extra };
}

function balanceAtCut(balances, index) {
  if (index < 0) return 0;
  return balances[index] ?? 0;
}

/**
 * 压缩后核对。
 *
 * @param {object} options
 * @param {object} options.snapshot snapshotProtection 的结果。
 * @param {object} options.summaryEvent `compaction/summary` 事件。
 * @param {number} [options.checkpointSeq] checkpoint `user/message` 的 seq。
 * @param {number[]} [options.postSurfaceNodes] 若调用方已读到压缩后的 surface。
 * @param {string} [options.adapterKind]
 * @returns {object} 保护报告（不含消息正文）。
 */
export function verifyProtection({
  snapshot,
  summaryEvent,
  checkpointSeq = null,
  postSurfaceNodes = null,
  adapterKind = 'unknown',
  manual = null,
}) {
  const summaryText = summaryTextOf(summaryEvent);
  const summaryReadable = summaryText.trim().length > 0;
  const shadowedSeqs = shadowedNodesFrom(summaryEvent?.data, snapshot);
  const shadowedSet = new Set(shadowedSeqs);
  const indices = shadowedSeqs.map((seq) => snapshot.nodes.indexOf(seq)).filter((index) => index >= 0);
  const firstIndex = indices.length > 0 ? Math.min(...indices) : -1;
  const lastIndex = indices.length > 0 ? Math.max(...indices) : -1;
  const expectedNodes = expectedSurface(snapshot, shadowedSeqs, checkpointSeq);
  const nodesAfter = Array.isArray(postSurfaceNodes) ? postSurfaceNodes : expectedNodes;
  const afterSet = new Set(nodesAfter);
  const checks = [];

  // artifact：摘要 + checkpoint 必须存在，且 shadow 区间能从当前 surface 解释。
  if (summaryEvent === undefined || summaryEvent === null || typeof summaryEvent.data !== 'object') {
    checks.push(check('artifact', 'fail', 'missing compaction/summary event'));
  } else if (shadowedSeqs.length === 0) {
    checks.push(check('artifact', 'fail', 'summary carries no shadowed range/seqs; cannot verify protection'));
  } else if (indices.length === 0) {
    checks.push(check('artifact', 'fail', 'shadowed seqs are not on the captured surface'));
  } else if (!Number.isInteger(checkpointSeq)) {
    checks.push(check('artifact', 'fail', 'missing compact-checkpoint user/message'));
  } else if (!afterSet.has(checkpointSeq)) {
    checks.push(check('artifact', 'fail', 'checkpoint is absent from the post-compaction surface'));
  } else {
    checks.push(check('artifact', 'pass', `${shadowedSeqs.length} seq(s) shadowed; checkpoint ${checkpointSeq} present`));
  }

  checks.push(check(
    'summary-readable',
    summaryReadable ? 'pass' : 'warn',
    summaryReadable ? `${summaryText.length} chars readable` : 'summary is empty/unreadable; coverage checks degrade',
  ));

  // latest-user-message：必须完全不被 shadow（摘要替代不算“未压缩”）。
  if (snapshot.latestUser === null) {
    checks.push(check('latest-user-message', 'skip', 'no human user/message on the captured surface'));
  } else if (shadowedSet.has(snapshot.latestUser.seq)) {
    checks.push(check('latest-user-message', 'fail', `latest user message seq ${snapshot.latestUser.seq} was shadowed`, {
      seqs: [snapshot.latestUser.seq],
    }));
  } else if (!afterSet.has(snapshot.latestUser.seq)) {
    checks.push(check('latest-user-message', 'fail', 'latest user message disappeared from the surface without being shadowed', {
      seqs: [snapshot.latestUser.seq],
    }));
  } else {
    checks.push(check('latest-user-message', 'pass', `latest user message seq ${snapshot.latestUser.seq} retained`));
  }

  // rule-injection：旧的规则快照可以被更新的"同类规则"取代；只有"没有更新副本"才算丢失。
  const shadowedRules = snapshot.rules.filter((rule) => shadowedSet.has(rule.seq));
  const lostRules = shadowedRules.filter((rule) => {
    const hasNewer = snapshot.rules.some((candidate) => candidate.seq > rule.seq &&
      candidate.source === rule.source &&
      !shadowedSet.has(candidate.seq) &&
      afterSet.has(candidate.seq));
    return !hasNewer;
  });
  if (lostRules.length > 0) {
    checks.push(check('rule-injection', 'fail', `${lostRules.length} rule injection(s) shadowed with no newer copy`, {
      seqs: lostRules.map((rule) => rule.seq),
    }));
  } else if (shadowedRules.length > 0) {
    checks.push(check('rule-injection', 'pass', `${shadowedRules.length} superseded rule copy/copies shadowed; newer copies retained`));
  } else {
    checks.push(check('rule-injection', 'pass', `${snapshot.rules.length} rule injection(s) retained`));
  }

  // tool-pairing：切口两侧必须 balanced，且替换后不能有孤儿结果。
  if (shadowedSeqs.length === 0) {
    checks.push(check('tool-pairing', 'skip', 'no shadowed range'));
  } else {
    const before = balanceAtCut(snapshot.balances, firstIndex - 1);
    const after = balanceAtCut(snapshot.balances, lastIndex);
    const negative = snapshot.balances.some((value) => value < 0);
    const deltaBySeq = new Map(snapshot.nodes.map((seq, index) => [seq, snapshot.deltas[index]]));
    let postBalance = 0;
    for (const seq of nodesAfter) {
      if (seq === checkpointSeq) continue;
      postBalance += deltaBySeq.get(seq) ?? 0;
    }
    if (before !== 0 || after !== 0) {
      checks.push(check('tool-pairing', 'fail', `cut is not tool-pairing balanced (before=${before}, after=${after})`));
    } else if (negative) {
      checks.push(check('tool-pairing', 'fail', 'surface contains tool/result without a matching call'));
    } else if (postBalance !== 0) {
      checks.push(check('tool-pairing', 'fail', `post-compaction surface is not tool-pairing balanced (balance=${postBalance})`));
    } else {
      checks.push(check('tool-pairing', 'pass', `balanced cuts (before=0, after=0); ${snapshot.toolCalls} calls / ${snapshot.toolResults} results`));
    }
  }

  // batch-list：同消息含批次语义才算候选；宁 skip 不 fail。
  if (snapshot.batch === null) {
    if (snapshot.batchRejected !== null) {
      checks.push(check('batch-list', 'skip', 'progress ratio without batch semantics (批次/进度/progress/batch) in the same message; not treated as batch progress', {
        seqs: [snapshot.batchRejected.seq],
        reason: snapshot.batchRejected.missingUnit === true ? 'no-unit' : 'no-batch-semantics',
      }));
    } else {
      checks.push(check('batch-list', 'skip', 'no batch/progress marker on the captured surface'));
    }
  } else if (!shadowedSet.has(snapshot.batch.seq)) {
    checks.push(check('batch-list', 'pass', `batch message seq ${snapshot.batch.seq} retained outside the shadow range`));
  } else if (!summaryReadable) {
    checks.push(check('batch-list', 'skip', 'batch message shadowed but summary unreadable; cannot verify coverage', {
      seqs: [snapshot.batch.seq],
    }));
  } else if (snapshot.batch.ratios.length === 0) {
    // 有批次语义但没有可用比例：无法核对覆盖，判 skip 并留原因（不再空泛 pass）。
    checks.push(check('batch-list', 'skip', 'batch/progress message has no usable numeric ratio; coverage cannot be verified', {
      seqs: [snapshot.batch.seq],
      reason: snapshot.batch.dateLike > 0 ? 'date-like-ratio' : 'no-ratio-in-user-messages',
    }));
  } else if (ratiosCovered(snapshot.batch.ratios, summaryText)) {
    checks.push(check('batch-list', 'pass', `batch message seq ${snapshot.batch.seq} covered by summary`, {
      seqs: [snapshot.batch.seq],
    }));
  } else {
    checks.push(check('batch-list', 'fail', `batch message seq ${snapshot.batch.seq} shadowed and not covered by summary`, {
      seqs: [snapshot.batch.seq],
    }));
  }

  // rollback-point：被 shadow 时要求摘要至少保留回滚关键词与路径之一。
  if (snapshot.rollback === null) {
    checks.push(check('rollback-point', 'skip', 'no rollback marker on the captured surface'));
  } else if (!shadowedSet.has(snapshot.rollback.seq)) {
    checks.push(check('rollback-point', 'pass', `rollback message seq ${snapshot.rollback.seq} retained outside the shadow range`));
  } else if (!summaryReadable) {
    checks.push(check('rollback-point', 'skip', 'rollback message shadowed but summary unreadable; cannot verify coverage', {
      seqs: [snapshot.rollback.seq],
    }));
  } else if (rollbackCovered(snapshot.rollback, summaryText)) {
    checks.push(check('rollback-point', 'pass', `rollback message seq ${snapshot.rollback.seq} covered by summary`, {
      seqs: [snapshot.rollback.seq],
    }));
  } else {
    checks.push(check('rollback-point', 'fail', `rollback message seq ${snapshot.rollback.seq} shadowed and not covered by summary`, {
      seqs: [snapshot.rollback.seq],
    }));
  }

  const failures = checks.filter((item) => item.status === 'fail');
  return {
    adapterKind,
    compactionId: summaryEvent?.data?.compactionId ?? null,
    manual,
    finishedAt: new Date().toISOString(),
    shadowedRange: summaryEvent?.data?.shadowedRange ?? null,
    shadowedSeqs,
    checkpointSeq,
    summaryReadable,
    summaryChars: summaryText.length,
    checks,
    failures,
    ok: failures.length === 0,
    degraded: !summaryReadable,
  };
}
