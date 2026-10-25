/**
 * 回放 fixture 的「结构白名单」（第三轮复核 P2）。
 *
 * 只保留结构字段：事件 type/seq/time、枚举、数值、id 引用、source.kind 等；
 * `content` / `stream` / `texts` / `args` / `meta` / `summary` 等正文载体**整段替换为占位**，
 * 不做逐条正则清洗（避免英文正文/工具参数残留）。
 */

const STRUCT_STRING_KEYS = new Set([
  'type', 'kind', 'role', 'form', 'provider', 'model', 'plugin', 'name',
  'status', 'code', 'mode', 'adapter', 'backend', 'host', 'version',
]);
const ID_KEYS = new Set(['compactionId', 'sourceCommandId', 'callId', 'toolCallId', 'id', 'cycle', 'sessionId']);
const NUMBER_KEYS = new Set(['turn', 'shadowedTokenCount', 'maxTokens', 'start', 'end']);
const CONTENT_KEYS = new Set(['content', 'text', 'summary', 'rawOutput', 'stream', 'texts', 'args', 'lines', 'detail', 'title', 'meta', 'messages']);

function structuralString(value) {
  if (typeof value !== 'string') return undefined;
  if (/^[A-Za-z0-9._:/-]{1,96}$/.test(value)) return value;
  return '[redacted:enum]';
}

function placeholder(key) {
  return `[redacted:${key}]`;
}

function numericUsage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function contentPlaceholder(key) {
  return [{ type: 'text', text: placeholder(key) }];
}

function structureSource(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'kind' || key === 'form' || key === 'plugin') out[key] = structuralString(value);
    else if (key === 'compactionId' || key === 'callId' || key === 'id') {
      if (typeof value === 'string') out[key] = '[id]';
    } else if (key === 'provider' || key === 'model') out[key] = structuralString(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function structureMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const out = {};
  if (typeof message.role === 'string') out.role = structuralString(message.role);
  if (message.content !== undefined) out.content = contentPlaceholder('content');
  if (message.source !== undefined) {
    const source = structureSource(message.source);
    if (source !== undefined) out.source = source;
  }
  if (typeof message.id === 'string') out.id = '[id]';
  if (typeof message.toolCallId === 'string') out.toolCallId = '[id]';
  for (const key of CONTENT_KEYS) if (message[key] !== undefined && key !== 'content') out[key] = placeholder(key);
  return out;
}

/** 一个事件 → 纯结构事件。未知键一律丢弃。 */
export function structureEvent(event) {
  const out = {
    type: structuralString(event?.type) ?? 'unknown',
    seq: Number.isInteger(event?.seq) ? event.seq : undefined,
    time: Number.isFinite(event?.time) ? event.time : undefined,
  };
  if (out.seq === undefined) delete out.seq;
  if (out.time === undefined) delete out.time;

  const data = event?.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return out;
  const structured = {};
  for (const [key, value] of Object.entries(data)) {
    if (NUMBER_KEYS.has(key) && Number.isFinite(value)) { structured[key] = value; continue; }
    if (key === 'shadowedSeqs') {
      structured.shadowedSeqs = Array.isArray(value) ? value.filter((item) => Number.isInteger(item)) : [];
      continue;
    }
    if (key === 'shadowedRange' && value !== null && typeof value === 'object') {
      const range = {};
      if (Number.isFinite(value.start)) range.start = value.start;
      if (Number.isFinite(value.end)) range.end = value.end;
      structured.shadowedRange = range;
      continue;
    }
    if (key === 'usage') {
      const usage = numericUsage(value);
      if (usage !== undefined) structured.usage = usage;
      continue;
    }
    if (key === 'compactionId' || key === 'sourceCommandId') {
      if (typeof value === 'string') structured[key] = '[id]';
      continue;
    }
    if (key === 'provider' || key === 'model' || key === 'role' || key === 'name' || key === 'kind' || key === 'form') {
      const text = structuralString(value);
      if (text !== undefined) structured[key] = text;
      continue;
    }
    if (key === 'source') {
      const source = structureSource(value);
      if (source !== undefined) structured.source = source;
      continue;
    }
    if (key === 'message') {
      const message = structureMessage(value);
      if (message !== undefined) structured.message = message;
      continue;
    }
    if (key === 'content') {
      structured.content = contentPlaceholder('content');
      continue;
    }
    if (key === 'error') { structured.error = '[error]'; continue; }
    if (key === 'toolCallId' || key === 'callId' || key === 'id') {
      if (typeof value === 'string') structured[key] = '[id]';
      continue;
    }
    // 其余（stream/texts/args/meta/summary/rawOutput/...）整段占位或丢弃
    if (CONTENT_KEYS.has(key)) structured[key] = placeholder(key);
  }
  out.data = structured;
  return out;
}
