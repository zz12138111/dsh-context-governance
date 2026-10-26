/**
 * 记忆读写工具（宿主工具面）。
 *
 * `mem_write` / `mem_query` 只做参数整形与错误翻译，文件语义全在 MemoryStore。
 * 描述符直接使用**宿主 JSON Schema 子集**（`parameters` 与 `output.schema` 都是标准 JSON Schema）：
 * 宿主 `ctx.tools.register` 会对 `output.schema` 调 `assertSupportedJsonSchema`，模型侧把
 * `parameters` 原样当 JSON Schema 用；属性级 `required: true` 属于旧 spec 形状，会被拒绝。
 * 这里保持零宿主依赖，便于单测。
 */

import {
  ENTRY_STATUSES,
  ENTRY_TYPES,
  MemoryContractError,
  RISKS,
  WRITERS,
} from '../memory/contract.js';
import { MemoryReadOnlyError, MemoryStoreError } from '../memory/store.js';

export const MEM_WRITE_NAME = 'mem_write';
export const MEM_QUERY_NAME = 'mem_query';

const WRITE_DESCRIPTION = [
  'Write one durable project-memory entry (task state: decisions, preferences, todos, progress, facts, criteria, anchors).',
  'Memory survives context compaction; details stay in memory and are never re-injected.',
  'ops: create (new entry), update (patch an existing entry), confirm (proposed→active, user confirmation),',
  'supersede (new entry replaces an old one; the old one becomes superseded), expire (mark expired, never delete).',
  'Entries written by the model default to proposed and need explicit confirmation; never store secrets.',
].join(' ');

const QUERY_DESCRIPTION = [
  'Read project memory: list index rows (id/status/type/title) or fetch full details by ids.',
  'Use ids when you need the detail behind a re-injected pointer; filters search title and detail.',
  'Details are returned ONLY when ids are supplied.',
].join(' ');

/**
 * `mem_write` 参数：**标准 JSON Schema**（宿主 `ctx.tools.register` 只接受其 JSON Schema
 * 子集；旧的 ParameterSchemaSpec 形状——属性级 `required: true`——会被 `assertSupportedJsonSchema`
 * 拒绝，且模型侧拿到的 schema 也不合法）。必填项用**顶层 `required` 数组**。
 */
const writeParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: {
      type: 'string',
      enum: ['create', 'update', 'confirm', 'supersede', 'expire'],
      description: 'create | update | confirm | supersede | expire',
    },
    id: {
      type: 'string',
      description: 'Existing memory id (required for update/confirm/supersede/expire).',
    },
    type: {
      type: 'string',
      enum: [...ENTRY_TYPES],
      description: 'Entry type (required for create).',
    },
    title: {
      type: 'string',
      description: 'One-line title (required for create/supersede).',
    },
    detail: {
      type: 'string',
      description: 'Necessary detail; do not paste whole conversations or credentials.',
    },
    status: {
      type: 'string',
      enum: [...ENTRY_STATUSES],
      description: 'Explicit status; omit to let the writer/risk defaults decide.',
    },
    writer: {
      type: 'string',
      enum: [...WRITERS],
      description: 'user | rule | model (required for create/supersede).',
    },
    confidence: {
      type: 'number',
      description: '0..1; required when writer=model.',
    },
    risk: {
      type: 'string',
      enum: [...RISKS],
      description: 'low | high; high-risk entries start as proposed.',
    },
    source: {
      type: 'string',
      description: 'Pointer to where this came from (session id / message seq), never the raw text.',
    },
    evidence: {
      type: 'string',
      description: 'Evidence pointer (file path, hash, log position).',
    },
    project: {
      type: 'string',
      description: 'Project namespace; defaults to the store project.',
    },
    supersedes: {
      type: 'string',
      description: 'Id of the entry this one replaces (use the supersede op instead when possible).',
    },
  },
  required: ['op'],
};

const queryParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fetch these entries WITH details (max 20).',
    },
    type: {
      type: 'string',
      enum: [...ENTRY_TYPES],
    },
    status: {
      type: 'string',
      enum: [...ENTRY_STATUSES],
    },
    text: {
      type: 'string',
      description: 'Case-insensitive keyword search over title and detail.',
    },
    limit: {
      type: 'integer',
      description: 'Max rows (default 20, max 100).',
    },
  },
  required: [],
};

function toolError(error) {
  if (error instanceof MemoryContractError || error instanceof MemoryStoreError) {
    return new Error(`[${error.code}] ${error.message}`);
  }
  if (error instanceof MemoryReadOnlyError) {
    return new Error(`[READ_ONLY] memory is read-only: ${error.reason}`);
  }
  return error;
}

/** 默认子会话判定：宿主 SessionHeader.origin/parentSession。 */
export function isSubagentExec(exec) {
  const header = exec?.agent?.session?.header;
  if (header === null || typeof header !== 'object') return false;
  return header.origin === 'subagent' || header.parentSession !== undefined;
}

function execSessionId(exec) {
  const id = exec?.agent?.session?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function reject(code, message) {
  return new Error(`[${code}] ${message}`);
}

/**
 * P2 预留：根路由 resolver 形状。
 * `resolveStore(exec)` 返回 `{ok:true, store, entry}` 或 `{ok:false, code, message, root, rootId, reason}`。
 * P1 不注入（默认单 store），只保证拒绝路径可测。
 */
function defaultResolver(store) {
  return () => ({ ok: true, store, entry: null });
}


async function runWrite(store, args, exec) {
  const op = String(args?.op ?? '');
  const source = typeof args?.source === 'string' && args.source.trim() !== ''
    ? args.source
    : exec?.agent?.session?.id !== undefined ? `session:${exec.agent.session.id}` : undefined;
  switch (op) {
    case 'create': {
      const entry = await store.create({ ...args, source });
      return { id: entry.id, status: entry.status, type: entry.type, title: entry.title };
    }
    case 'update': {
      if (args.status !== undefined) {
        throw new Error('[BAD_OP] status transitions use confirm/expire/supersede, not update');
      }
      const entry = await store.update(args.id, {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.detail === undefined ? {} : { detail: args.detail }),
        ...(args.source === undefined && source === undefined ? {} : { source: args.source ?? source }),
        ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
        ...(args.risk === undefined ? {} : { risk: args.risk }),
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.type === undefined ? {} : { type: args.type }),
      });
      return { id: entry.id, status: entry.status, type: entry.type, title: entry.title };
    }
    case 'confirm': {
      const entry = await store.confirm(args.id);
      return { id: entry.id, status: entry.status, type: entry.type, title: entry.title };
    }
    case 'expire': {
      const entry = await store.expire(args.id);
      return { id: entry.id, status: entry.status, type: entry.type, title: entry.title };
    }
    case 'supersede': {
      const result = await store.supersede(args.id, { ...args, source });
      return {
        id: result.entry.id,
        status: result.entry.status,
        type: result.entry.type,
        title: result.entry.title,
        superseded: result.superseded.id,
      };
    }
    default:
      throw new Error(`[BAD_OP] unknown mem_write op "${op}"`);
  }
}

/**
 * 构造工具描述符与处理函数。
 *
 * @param {import('../memory/store.js').MemoryStore|null} store 默认 store（P1 单根）
 * @param {object} [options]
 * @param {(exec:object)=>object} [options.resolveStore] P2 根路由（返回 {ok:true,store,entry} 或 {ok:false,code,message,...}）
 * @param {(exec:object)=>boolean} [options.isSubagent] 子会话判定（默认看宿主 SessionHeader）
 * @param {{append?:Function}} [options.audit] 根级拒绝审计（memory-tool-rejected）
 */
export function createMemoryTools(store, options = {}) {
  const resolveStore = typeof options.resolveStore === 'function' ? options.resolveStore : defaultResolver(store);
  const subagentOf = typeof options.isSubagent === 'function' ? options.isSubagent : isSubagentExec;
  const audit = options.audit ?? null;

  const rejectWith = (tool, exec, code, message, extra = {}) => {
    try {
      audit?.append?.('memory-tool-rejected', {
        tool,
        code,
        sessionId: execSessionId(exec),
        subagent: subagentOf(exec),
        reason: extra.reason,
        root: extra.root ?? null,
        rootId: extra.rootId ?? null,
      });
    } catch {
      /* 审计失败不得掩盖工具错误 */
    }
    return reject(code, message);
  };

  const storeFor = (tool, exec) => {
    let resolved;
    try {
      resolved = resolveStore(exec);
    } catch (error) {
      throw rejectWith(tool, exec, 'ROOT_UNAVAILABLE', String(error?.message ?? error), { reason: 'resolver-threw' });
    }
    if (resolved === null || typeof resolved !== 'object' || resolved.ok !== true) {
      const code = typeof resolved?.code === 'string' && resolved.code !== '' ? resolved.code : 'NO_ROOT';
      const message = typeof resolved?.message === 'string' && resolved.message !== ''
        ? resolved.message
        : 'no project root for this session';
      throw rejectWith(tool, exec, code, message, {
        reason: resolved?.reason,
        root: resolved?.root,
        rootId: resolved?.rootId,
      });
    }
    return resolved.store;
  };

  return {
    [MEM_WRITE_NAME]: {
      definition: {
        name: MEM_WRITE_NAME,
        description: WRITE_DESCRIPTION,
        parameters: writeParameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              type: { type: 'string' },
              title: { type: 'string' },
              superseded: { type: 'string' },
            },
            required: ['id', 'status', 'type', 'title'],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.superseded === undefined
              ? `${value.id} [${value.status}] ${value.type} · ${value.title}`
              : `${value.id} [${value.status}] ${value.type} · ${value.title} (supersedes ${value.superseded})`,
          }],
        },
        execute: async (args, exec) => {
          if (subagentOf(exec)) {
            throw rejectWith(
              MEM_WRITE_NAME,
              exec,
              'SUBAGENT_NO_MEMORY_WRITE',
              'subagent sessions may read memory but must not write it',
              { reason: 'subagent' },
            );
          }
          const target = storeFor(MEM_WRITE_NAME, exec);
          try {
            return await runWrite(target, args, exec);
          } catch (error) {
            throw toolError(error);
          }
        },
      },
    },
    [MEM_QUERY_NAME]: {
      definition: {
        name: MEM_QUERY_NAME,
        description: QUERY_DESCRIPTION,
        parameters: queryParameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'integer' },
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    type: { type: 'string' },
                    title: { type: 'string' },
                    detail: { type: 'string' },
                  },
                  required: ['id', 'status', 'type', 'title'],
                },
              },
            },
            required: ['count', 'entries'],
          },
          render: (_args, value) => {
            if (value.count === 0) return [{ type: 'text', text: 'No memory entries matched.' }];
            const lines = value.entries.map((entry) => (entry.detail === undefined
              ? `${entry.id} [${entry.status}] ${entry.type} · ${entry.title}`
              : `${entry.id} [${entry.status}] ${entry.type} · ${entry.title}\n    ${entry.detail.replace(/\n/g, '\n    ')}`));
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        execute: async (args, exec) => {
          if (Array.isArray(args?.ids) && args.ids.length > 20) {
            throw new Error('[BAD_ARGS] mem_query accepts at most 20 ids per call');
          }
          const target = storeFor(MEM_QUERY_NAME, exec);
          const ids = Array.isArray(args?.ids) ? args.ids : undefined;
          return target.query({
            ...(ids === undefined ? {} : { ids }),
            ...(args?.type === undefined ? {} : { type: args.type }),
            ...(args?.status === undefined ? {} : { status: args.status }),
            ...(args?.text === undefined ? {} : { text: args.text }),
            ...(args?.limit === undefined ? {} : { limit: args.limit }),
          });
        },
      },
    },
  };
}

/** 注册到宿主 `ctx.tools`；返回注册结果，不因单个工具失败中断。 */
export function registerMemoryTools(ctx, store, options = {}) {
  const tools = createMemoryTools(store, options);
  const registered = [];
  const failures = [];
  for (const { definition } of Object.values(tools)) {
    try {
      if (typeof ctx?.tools?.register !== 'function') throw new Error('ctx.tools.register is unavailable');
      ctx.tools.register(definition);
      registered.push(definition.name);
    } catch (error) {
      failures.push({ name: definition.name, message: String(error?.message ?? error).slice(0, 400) });
    }
  }
  return { registered, failures };
}
