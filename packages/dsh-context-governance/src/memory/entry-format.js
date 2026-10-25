/**
 * 主题文件格式（v1）：Markdown + 显式条目块，人可读、可 git、可手工编辑。
 *
 * 一个主题文件 = 一种 type；每个条目是一个 `<!-- entry:ID -->` 块：
 *
 *   <!-- entry:MEM-20261025-001 -->
 *   ### MEM-20261025-001
 *   - title: 插件名定为 dsh-context-governance
 *   - type: decision
 *   ...
 *
 *   <detail 正文，可多段>
 *   <!-- /entry -->
 *
 * 解析按块进行；块外文字被忽略（允许人在文件头写备注）。重复 ID、未知字段、
 * 缺字段、marker 未闭合都按"文件损坏"处理，由 store 转只读并告警。
 */

export const META_KEYS = Object.freeze([
  'title',
  'type',
  'status',
  'project',
  'writer',
  'confidence',
  'risk',
  'createdAt',
  'updatedAt',
  'supersedes',
  'supersededBy',
  'source',
  'evidence',
]);

export const FILE_HEADER_PREFIX = '# topics';
export class MemoryFormatError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MemoryFormatError';
    this.code = 'FORMAT';
    if (details !== undefined) this.details = details;
  }
}

const OPEN_MARKER = /<!-- entry:(MEM-\d{8}-\d{3,}) -->/g;
const OPEN_ANY = /<!-- entry:/;
const CLOSE_MARKER = '<!-- /entry -->';

function escapeValue(value) {
  if (value === null || value === undefined) return '';
  // 值必须是单行；换行由契约层拦住，这里做最后一道防线。
  return String(value).replace(/[\r\n]+/g, ' ');
}

/** 序列化一个条目块；`detail` 保持原样（可为空）。 */
export function serializeEntryBlock(entry) {
  const lines = [];
  lines.push(`<!-- entry:${entry.id} -->`);
  lines.push(`### ${entry.id}`);
  lines.push(`- title: ${escapeValue(entry.title)}`);
  lines.push(`- type: ${escapeValue(entry.type)}`);
  lines.push(`- status: ${escapeValue(entry.status)}`);
  lines.push(`- project: ${escapeValue(entry.project)}`);
  lines.push(`- writer: ${escapeValue(entry.writer)}`);
  lines.push(`- confidence: ${escapeValue(entry.confidence)}`);
  lines.push(`- risk: ${escapeValue(entry.risk)}`);
  lines.push(`- createdAt: ${escapeValue(entry.createdAt)}`);
  lines.push(`- updatedAt: ${escapeValue(entry.updatedAt)}`);
  lines.push(`- supersedes: ${escapeValue(entry.supersedes)}`);
  lines.push(`- supersededBy: ${escapeValue(entry.supersededBy)}`);
  lines.push(`- source: ${escapeValue(entry.source)}`);
  lines.push(`- evidence: ${escapeValue(entry.evidence)}`);
  const detail = typeof entry.detail === 'string' ? entry.detail.replace(/\r\n/g, '\n') : '';
  if (detail.trim().length > 0) {
    lines.push('');
    lines.push(detail.trimEnd());
  }
  lines.push(CLOSE_MARKER);
  return lines.join('\n');
}

/**
 * 序列化一个主题文件。
 *
 * @param {string} type 主题类型。
 * @param {string} project 项目命名空间。
 * @param {object[]} entries 文件的全部条目。
 * @returns {string}
 */
export function serializeTopicFile(type, project, entries) {
  const header = `# topics/${type}.md — project ${escapeValue(project)}\n\n` +
    '> Managed by dsh-context-governance. Each entry is one marker-delimited block\n' +
    '> (format documented in docs/记忆契约-v1.md at the repository root); text outside blocks is ignored.\n';
  const sorted = [...entries].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const blocks = sorted.map(serializeEntryBlock);
  return `${header}${blocks.length === 0 ? '' : '\n' + blocks.join('\n\n')}\n`;
}

/** 定位全部条目；未闭合/嵌套 marker 一律报损坏。 */
export function splitBlocks(content, file) {
  const text = String(content).replace(/\r\n/g, '\n');
  const blocks = [];
  let match;
  OPEN_MARKER.lastIndex = 0;
  while ((match = OPEN_MARKER.exec(text)) !== null) {
    const openEnd = match.index + match[0].length;
    const closeIdx = text.indexOf(CLOSE_MARKER, openEnd);
    if (closeIdx === -1) {
      throw new MemoryFormatError(`entry ${match[1]} has no closing marker`, { file, id: match[1] });
    }
    const body = text.slice(openEnd, closeIdx);
    if (OPEN_ANY.test(body)) {
      throw new MemoryFormatError(`entry ${match[1]} contains a nested opening marker`, { file, id: match[1] });
    }
    OPEN_MARKER.lastIndex = closeIdx + CLOSE_MARKER.length;
    blocks.push({ id: match[1], body });
  }
  const openAnyCount = (text.match(/<!-- entry:/g) ?? []).length;
  if (openAnyCount !== blocks.length) {
    throw new MemoryFormatError(
      `found ${openAnyCount} opening marker(s) but only ${blocks.length} are well-formed`,
      { file, blocks: blocks.length, openings: openAnyCount },
    );
  }
  const closeCount = text.split(CLOSE_MARKER).length - 1;
  if (closeCount !== blocks.length) {
    throw new MemoryFormatError(`found ${blocks.length} entry marker(s) but ${closeCount} closing marker(s)`, { file });
  }
  return blocks;
}

/** 解析一个条目的元数据与正文。 */
function parseBlock(block, { file, project, expectedType }) {
  const lines = block.body.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i >= lines.length || lines[i].trim() !== `### ${block.id}`) {
    throw new MemoryFormatError(`entry ${block.id} is missing its "### ${block.id}" heading`, { file, id: block.id });
  }
  i += 1;
  const meta = {};
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; break; }
    const m = /^- ([A-Za-z]+):(?: (.*))?$/.exec(line);
    if (m === null) {
      throw new MemoryFormatError(`entry ${block.id} has an unparsable meta line: ${JSON.stringify(line)}`, { file, id: block.id });
    }
    const key = m[1];
    if (!META_KEYS.includes(key)) {
      throw new MemoryFormatError(`entry ${block.id} has an unknown field "${key}"`, { file, id: block.id, key });
    }
    if (Object.hasOwn(meta, key)) {
      throw new MemoryFormatError(`entry ${block.id} repeats field "${key}"`, { file, id: block.id, key });
    }
    meta[key] = (m[2] ?? '').trim();
  }
  const missing = META_KEYS.filter((key) => !Object.hasOwn(meta, key));
  if (missing.length > 0) {
    throw new MemoryFormatError(`entry ${block.id} is missing fields: ${missing.join(', ')}`, { file, id: block.id, missing });
  }
  const detail = lines.slice(i).join('\n').trim();
  if (meta.project !== project) {
    throw new MemoryFormatError(
      `entry ${block.id} belongs to project "${meta.project}" but this store is "${project}"`,
      { file, id: block.id, project: meta.project, expected: project },
    );
  }
  if (expectedType !== undefined && meta.type !== expectedType) {
    throw new MemoryFormatError(
      `entry ${block.id} is type "${meta.type}" but lives in the ${expectedType} topic file`,
      { file, id: block.id, type: meta.type, expected: expectedType },
    );
  }
  const confidence = Number(meta.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new MemoryFormatError(`entry ${block.id} has an invalid confidence "${meta.confidence}"`, { file, id: block.id });
  }
  return {
    id: block.id,
    title: meta.title,
    type: meta.type,
    status: meta.status,
    project: meta.project,
    writer: meta.writer,
    confidence,
    risk: meta.risk,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    supersedes: meta.supersedes === '' ? null : meta.supersedes,
    supersededBy: meta.supersededBy === '' ? null : meta.supersededBy,
    source: meta.source === '' ? null : meta.source,
    evidence: meta.evidence === '' ? null : meta.evidence,
    detail,
  };
}

/**
 * 解析整个主题文件。
 *
 * @param {string} content 文件内容。
 * @param {{file:string, project:string, type?:string}} options
 * @returns {object[]} 条目数组（顺序按文件内出现顺序）。
 */
export function parseTopicFile(content, { file, project, type }) {
  const text = String(content);
  const trimmed = text.trim();
  if (trimmed.length > 0 && !trimmed.startsWith('# topics') && !text.includes('<!-- entry:')) {
    throw new MemoryFormatError('topic file has neither the topics header nor any entry block', { file });
  }
  const entries = splitBlocks(content, file);
  const seen = new Set();
  const parsed = [];
  for (const block of entries) {
    if (seen.has(block.id)) {
      throw new MemoryFormatError(`duplicate entry ${block.id}`, { file, id: block.id });
    }
    seen.add(block.id);
    parsed.push(parseBlock(block, { file, project, expectedType: type }));
  }
  return parsed;
}

const STATUS_ORDER = Object.freeze({ active: 0, proposed: 1, expired: 2, superseded: 3 });

/**
 * 生成 MEMORY.md 索引（派生文件，不参与外部修改检测）。
 *
 * @param {object[]} entries 全部条目。
 * @param {{project:string, now?:Date, maxChars?:number}} options
 * @returns {string}
 */
export function renderIndex(entries, { project, now = new Date(), maxChars = 64_000 } = {}) {
  const all = [...entries];
  const counts = { active: 0, proposed: 0, superseded: 0, expired: 0 };
  for (const entry of all) {
    if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
  }
  const sorted = [...all].sort((a, b) => {
    const byStatus = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  const head = [
    `# Memory index — ${project}`,
    '',
    '> Generated by dsh-context-governance from `topics/*.md`; do not edit by hand.',
    `> Updated: ${now.toISOString()} · active ${counts.active} · proposed ${counts.proposed} · superseded ${counts.superseded} · expired ${counts.expired}`,
    '',
  ].join('\n');
  const lines = [];
  let used = head.length;
  let omitted = 0;
  for (const entry of sorted) {
    const line = `- ${entry.id} · ${entry.status} · ${entry.type} · ${entry.title}`;
    if (used + line.length + 1 > maxChars) { omitted += 1; continue; }
    used += line.length + 1;
    lines.push(line);
  }
  const tail = omitted > 0 ? `\n\n> ${omitted} more entr${omitted === 1 ? 'y' : 'ies'} omitted to keep this index small.` : '';
  return `${head}${lines.length > 0 ? '\n' + lines.join('\n') + '\n' : ''}${tail}`;
}
