/**
 * 记忆读写工具（宿主工具面）。
 *
 * `mem_write` / `mem_query` 只做参数整形与错误翻译，文件语义全在 MemoryStore。
 * 工具描述符按宿主 `ctx.tools.register` 的 ParameterSchemaSpec 形状书写，
 * 由 T3 的插件入口用 `defineTool` 包一层；这里保持零宿主依赖，便于单测。
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

const writeParameters = {
  op: {
    type: 'string',
    required: true,
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
};

const queryParameters = {
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
 * @param {import('../memory/store.js').MemoryStore} store
 */
export function createMemoryTools(store) {
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
              id: { type: 'string', required: true },
              status: { type: 'string', required: true },
              type: { type: 'string', required: true },
              title: { type: 'string', required: true },
              superseded: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.superseded === undefined
              ? `${value.id} [${value.status}] ${value.type} · ${value.title}`
              : `${value.id} [${value.status}] ${value.type} · ${value.title} (supersedes ${value.superseded})`,
          }],
        },
        execute: async (args, exec) => {
          try {
            return await runWrite(store, args, exec);
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
              count: { type: 'integer', required: true },
              entries: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    type: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            if (value.count === 0) return [{ type: 'text', text: 'No memory entries matched.' }];
            const lines = value.entries.map((entry) => (entry.detail === undefined
              ? `${entry.id} [${entry.status}] ${entry.type} · ${entry.title}`
              : `${entry.id} [${entry.status}] ${entry.type} · ${entry.title}\n    ${entry.detail.replace(/\n/g, '\n    ')}`));
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        execute: async (args) => {
          if (Array.isArray(args?.ids) && args.ids.length > 20) {
            throw new Error('[BAD_ARGS] mem_query accepts at most 20 ids per call');
          }
          const ids = Array.isArray(args?.ids) ? args.ids : undefined;
          const result = store.query({
            ...(ids === undefined ? {} : { ids }),
            ...(args?.type === undefined ? {} : { type: args.type }),
            ...(args?.status === undefined ? {} : { status: args.status }),
            ...(args?.text === undefined ? {} : { text: args.text }),
            ...(args?.limit === undefined ? {} : { limit: args.limit }),
          });
          return result;
        },
      },
    },
  };
}

/** 兼容宿主 `defineTool` 的注册入口；返回注册结果，不因单个工具失败中断。 */
export function registerMemoryTools(ctx, store, { defineTool = (definition) => definition } = {}) {
  const tools = createMemoryTools(store);
  const registered = [];
  const failures = [];
  for (const { definition } of Object.values(tools)) {
    try {
      if (typeof ctx?.tools?.register !== 'function') throw new Error('ctx.tools.register is unavailable');
      ctx.tools.register(defineTool(definition));
      registered.push(definition.name);
    } catch (error) {
      failures.push({ name: definition.name, message: String(error?.message ?? error).slice(0, 400) });
    }
  }
  return { registered, failures };
}
