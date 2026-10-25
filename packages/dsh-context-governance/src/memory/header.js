/**
 * 新会话记忆 header（S3 / M3 T2 0.3.1，默认开）。
 *
 * 目标：新会话开头带“可执行状态”（待办/进度/决定/锚点），让模型不必重问；
 * 有规则文件时不重复偏好，只放动态状态；无规则文件才补 1 行偏好并标“非硬规则”。
 *
 * 安全边界：
 * - 默认开（M3 T2）；`/cg header off`、项目/插件配置可关；
 * - 只读 active 条目；子会话默认不注入；空记忆/无项目 → 零注入；
 * - 只注入一次/会话（source.form = memory-header）；失败只 warn，不抛宿主；
 * - 不改 surface，仅在 `agent/pre-step` 决策消息前插入一条 user 消息。
 */

import { randomUUID } from 'node:crypto';

export const MEMORY_HEADER_SOURCE_KIND = 'plugin:context-governance';
export const MEMORY_HEADER_FORM = 'memory-header';

export const HEADER_DEFAULTS = Object.freeze({
  maxLines: 8,
  maxChars: 800,
  oldAgeDays: 14,
  oldLimit: 30,
  quota: Object.freeze({ todo: 2, progress: 2, decision: 2, anchor: 1, preference: 1 }),
});

const DYNAMIC_TYPES = ['todo', 'progress', 'decision', 'anchor'];

function ageDays(entry, now) {
  const stamp = Date.parse(entry?.updatedAt ?? entry?.createdAt ?? '');
  if (!Number.isFinite(stamp)) return 0;
  return (now - stamp) / (24 * 60 * 60 * 1000);
}

function lineOf(entry, old) {
  const title = String(entry.title ?? '').trim().slice(0, 120);
  return `- ${old ? '[Old] ' : ''}${entry.id} ${entry.type} ${title}`;
}

/**
 * 从记忆库构造 header 文本；没有可用条目时返回 null。
 *
 * @param {object} store MemoryStore
 * @param {{
 *   hasRuleFile?: boolean, maxLines?: number, maxChars?: number,
 *   oldAgeDays?: number, oldLimit?: number, now?: number,
 * }} [options]
 */
export function buildMemoryHeader(store, options = {}) {
  if (store === null || typeof store?.allEntries !== 'function') return null;
  const maxLines = Math.min(Math.max(Number(options.maxLines) || HEADER_DEFAULTS.maxLines, 1), 20);
  const maxChars = Math.min(Math.max(Number(options.maxChars) || HEADER_DEFAULTS.maxChars, 120), 2000);
  const oldAgeDays = Number.isFinite(Number(options.oldAgeDays))
    ? Math.max(Number(options.oldAgeDays), 0)
    : HEADER_DEFAULTS.oldAgeDays;
  const oldLimit = Number.isFinite(Number(options.oldLimit))
    ? Math.min(Math.max(Number(options.oldLimit), 0), 100)
    : HEADER_DEFAULTS.oldLimit;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const hasRuleFile = options.hasRuleFile === true;
  const quota = { ...HEADER_DEFAULTS.quota };

  let entries = [];
  try {
    entries = store.allEntries().filter((entry) => (
      entry !== null && typeof entry === 'object' &&
      entry.status === 'active' &&
      typeof entry.title === 'string' && entry.title.trim() !== ''
    ));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? 0) - Date.parse(left.updatedAt ?? left.createdAt ?? 0));

  const allowedTypes = hasRuleFile ? DYNAMIC_TYPES : [...DYNAMIC_TYPES, 'preference'];
  const candidates = entries.filter((entry) => allowedTypes.includes(entry.type));
  if (candidates.length === 0) return null;
  const picked = [];
  const used = {};
  let oldUsed = 0;
  for (const entry of candidates) {
    const limit = entry.type === 'preference' ? (hasRuleFile ? 0 : quota.preference) : quota[entry.type] ?? 0;
    if ((used[entry.type] ?? 0) >= limit) continue;
    const old = ageDays(entry, now) > oldAgeDays;
    if (old && oldUsed >= oldLimit) continue;
    if (old) oldUsed += 1;
    used[entry.type] = (used[entry.type] ?? 0) + 1;
    picked.push({ entry, old });
  }
  if (picked.length === 0) return null;
  // 新条目在前，[Old] 统一排末尾
  picked.sort((left, right) => Number(left.old) - Number(right.old));
  const dropped = Math.max(0, candidates.length - picked.length);

  const mode = hasRuleFile ? 'state-only' : 'state-only+preference';
  const lines = [
    `[CG-MEMORY · state-only · budget ${maxLines} lines]`,
    ...picked.slice(0, maxLines).map(({ entry, old }) => lineOf(entry, old)),
  ];
  if (dropped > 0) lines.push(`conflicts: ${dropped} 条被配额截断`);
  const text = lines.join('\n').slice(0, maxChars);
  return {
    text,
    ids: picked.map(({ entry }) => entry.id),
    mode,
    count: picked.length,
    dropped,
  };
}

function isSubagentPayload(payload) {
  const agent = payload?.agent ?? null;
  if (agent === null) return false;
  if (agent.parent !== undefined && agent.parent !== null) return true;
  if (agent.isSubagent === true || agent.subagent === true) return true;
  const header = agent.session?.header ?? null;
  return header?.parentSessionId !== undefined && header?.parentSessionId !== null;
}

/**
 * 挂 `agent/pre-step`：新会话第一步注入一次 header。
 *
 * @param {object} ctx 插件上下文（需要 `on`；`logger` 可选）
 * @param {object} store MemoryStore
 * @param {{
 *   enabled?: boolean, isEnabled?: () => boolean, hasRuleFile?: boolean,
 *   maxLines?: number, maxChars?: number, oldAgeDays?: number, oldLimit?: number,
 *   onInjected?: (header: object) => void,
 * }} [options]
 */
export function registerMemoryHeader(ctx, store, options = {}) {
  if (options.enabled !== true) return { registered: false, reason: 'disabled-by-config' };
  if (typeof ctx?.on !== 'function') return { registered: false, reason: 'ctx.on is unavailable' };
  const seen = new Set();
  const enabledNow = () => (typeof options.isEnabled === 'function' ? options.isEnabled() !== false : true);
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      // 实测（M3 T0 探针）：next() 可能返回 undefined——必须原样返回；
      // `{...undefined, messages}` 会造出没有 kind 的 decision，宿主读 decision.kind 直接崩。
      if (decision === null || typeof decision !== 'object' || !('kind' in decision)) return decision;
      try {
        if (!enabledNow()) return decision;
        const session = payload?.agent?.session ?? null;
        const sessionId = typeof session?.id === 'string' ? session.id : null;
        if (sessionId === null || payload?.step !== 1 || seen.has(sessionId)) return decision;
        if (decision.kind === 'reject') return decision;
        if (isSubagentPayload(payload)) return decision; // 子会话默认不注入
        const header = buildMemoryHeader(store, options);
        if (header === null) return decision;
        const messages = Array.isArray(decision?.messages) ? decision.messages : [];
        if (messages.some((message) => message?.source?.kind === MEMORY_HEADER_SOURCE_KIND && message?.source?.form === MEMORY_HEADER_FORM)) {
          seen.add(sessionId);
          return decision;
        }
        const message = {
          role: 'user',
          id: randomUUID(),
          content: [{ type: 'text', text: header.text }],
          source: { kind: MEMORY_HEADER_SOURCE_KIND, form: MEMORY_HEADER_FORM, ids: header.ids },
        };
        seen.add(sessionId);
        try {
          options.onInjected?.(header);
        } catch {
          /* 审计回调失败不影响注入 */
        }
        return { ...decision, messages: [message, ...messages] };
      } catch (error) {
        ctx.logger?.warn?.(`[context-governance] memory header skipped: ${String(error?.message ?? error)}`);
        return decision;
      }
    });
    return { registered: true };
  } catch (error) {
    return { registered: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}
