/**
 * C38 ⑮⑯：默认会话指针库契约——有 session id 读写会话库；无 session id 根写入拒绝。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MEM_QUERY_NAME, MEM_WRITE_NAME, registerMemoryTools } from '../src/tools/mem-tools.js';

function tools({ sessionId = null } = {}) {
  const pointers = [{
    id: 'MEM-aaaa1111-20261115-0001',
    type: 'fact',
    title: '会话指针',
    summary: '摘要',
    status: 'proposed',
    miss: false,
    missReason: null,
  }];
  const definitions = [];
  const exec = () => (sessionId === null ? { agent: { session: null } } : { agent: { session: { id: sessionId } } });
  registerMemoryTools({ tools: { register(definition) { definitions.push(definition); } } }, null, {
    resolveStore: () => ({ ok: false, code: 'NO_ROOT', message: 'no root' }),
    legacyReadOnly: true,
    resolveSessionMemory: (current) => {
      const sid = current?.agent?.session?.id ?? null;
      if (typeof sid !== 'string' || sid === '') return null;
      return {
        query({ text = '', type = null, ids = null } = {}) {
          void text; void type; void ids;
          return pointers;
        },
      };
    },
  });
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return { tools: byName, exec };
}

test('C38 ⑮：默认会话指针库——带 session id 时 mem_write 拒绝写正文（POINTER_ONLY），mem_query 读会话指针', async () => {
  const { tools: defs, exec } = tools({ sessionId: 'session-aaaa1111' });
  const write = defs.get(MEM_WRITE_NAME);
  const query = defs.get(MEM_QUERY_NAME);
  await assert.rejects(write.execute({ op: 'create', type: 'fact', title: 'x', detail: 'y' }, exec()), /POINTER_ONLY/);
  const result = await query.execute({}, exec());
  assert.equal(result.count, 1);
  assert.equal(result.entries[0].id, 'MEM-aaaa1111-20261115-0001');
});

test('C38 ⑯：无 session id 时根写入按 legacy 只读拒绝（LEGACY_READ_ONLY）', async () => {
  const { tools: defs, exec } = tools({ sessionId: null });
  const write = defs.get(MEM_WRITE_NAME);
  await assert.rejects(write.execute({ op: 'create', type: 'fact', title: 'x', detail: 'y' }, exec()), /LEGACY_READ_ONLY/);
});
