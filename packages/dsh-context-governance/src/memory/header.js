/**
 * 新会话记忆 header（S3，v0.1.5，默认关闭）。
 *
 * 目的：同项目新会话开头带上**已确认的**偏好/决定（ID + 状态 + 一行标题），
 * 让模型不必重问“我们之前的命名规则是什么”。
 *
 * 安全边界：
 * - 默认 `enabled: false`，不改变宿主现有行为；需要在 config 显式开启（真机验证后再定默认值）；
 * - 只读记忆里 `active` 的 `preference`/`decision`，最多 5 条、600 字；
 * - 只注入一次/会话（`source.form = memory-header` 去重）；失败只 warn，不抛宿主；
 * - 不写记忆、不改 surface，仅在 `agent/pre-step` 的决策消息前插入一条 user 消息。
 */

import { randomUUID } from 'node:crypto';

export const MEMORY_HEADER_SOURCE_KIND = 'plugin:context-governance';
export const MEMORY_HEADER_FORM = 'memory-header';

/**
 * 从记忆库构造 header 文本；没有可用条目时返回 null。
 *
 * @param {object} store MemoryStore
 * @param {{types?:string[],maxEntries?:number,maxChars?:number}} [options]
 * @returns {{text:string, ids:string[]}|null}
 */
export function buildMemoryHeader(store, options = {}) {
  if (store === null || typeof store?.allEntries !== 'function') return null;
  const types = Array.isArray(options.types) && options.types.length > 0
    ? new Set(options.types)
    : new Set(['preference', 'decision']);
  const maxEntries = Math.min(Math.max(Number(options.maxEntries) || 5, 1), 10);
  const maxChars = Math.min(Math.max(Number(options.maxChars) || 600, 120), 2000);
  let entries = [];
  try {
    entries = store.allEntries().filter((entry) => (
      entry !== null && typeof entry === 'object' &&
      entry.status === 'active' && types.has(entry.type) &&
      typeof entry.title === 'string' && entry.title.trim() !== ''
    )).slice(-maxEntries);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const lines = entries.map((entry) => `- ${entry.id} ${entry.type} ${entry.title.trim().slice(0, 120)}`);
  const text = [
    `[context-governance] 本项目记忆 header（active ${entries.length}；详情用 mem_query 取）：`,
    ...lines,
  ].join('\n').slice(0, maxChars);
  return { text, ids: entries.map((entry) => entry.id) };
}

/**
 * 挂 `agent/pre-step`：新会话第一步注入一次 header。
 *
 * @param {object} ctx 插件上下文（需要 `on`；`logger` 可选）
 * @param {object} store MemoryStore
 * @param {{enabled?:boolean,types?:string[],maxEntries?:number,maxChars?:number}} [options]
 * @returns {{registered:boolean, reason?:string}}
 */
export function registerMemoryHeader(ctx, store, options = {}) {
  if (options.enabled !== true) return { registered: false, reason: 'disabled-by-config' };
  if (typeof ctx?.on !== 'function') return { registered: false, reason: 'ctx.on is unavailable' };
  const seen = new Set();
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        const session = payload?.agent?.session ?? null;
        const sessionId = typeof session?.id === 'string' ? session.id : null;
        if (sessionId === null || payload?.step !== 1 || seen.has(sessionId)) return decision;
        if (decision?.kind === 'reject') return decision;
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
