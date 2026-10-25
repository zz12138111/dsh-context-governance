/**
 * P1 回归：工具描述符必须过宿主 JSON Schema 子集 + 注册契约。
 *
 * 背景：v0.1.3 真机 `mem_write`/`mem_query` 未注册，根因是 output.schema 用了旧的
 * ParameterSchemaSpec 形状（属性级 `required: true`），被 `ctx.tools.register` 的
 * `assertSupportedJsonSchema` 拒绝，异常又被插件 catch 成 warn。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { MemoryStore } from '../src/memory/store.js';
import { MEM_QUERY_NAME, MEM_WRITE_NAME, createMemoryTools, registerMemoryTools } from '../src/tools/mem-tools.js';
import { assertSupportedJsonSchema, assertToolDefinition, jsonSchemaViolations } from './host-schema-contract.mjs';
import { tempDir } from './helpers.mjs';

async function withStore(fn) {
  const rootDir = await tempDir();
  const store = await MemoryStore.open({ rootDir, project: 'test-project' });
  try {
    await fn(store);
  } finally {
    await store.close().catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test('P1-schema：两个工具的 parameters 与 output.schema 都过宿主子集', async () => {
  await withStore((store) => {
    const tools = createMemoryTools(store);
    for (const name of [MEM_WRITE_NAME, MEM_QUERY_NAME]) {
      const definition = tools[name].definition;
      assert.deepEqual(jsonSchemaViolations(definition.parameters), [], `${name}.parameters 子集违规`);
      assert.deepEqual(jsonSchemaViolations(definition.output.schema), [], `${name}.output.schema 子集违规`);
      assert.doesNotThrow(() => assertToolDefinition(definition));
      assert.equal(definition.parameters.type, 'object', `${name}.parameters 必须是 object 根`);
      assert.ok(Array.isArray(definition.parameters.required), `${name}.parameters 必须有顶层 required 数组`);
    }
    // 模型侧把 parameters 原样当 JSON Schema 用，这里再确认一次。
    assert.doesNotThrow(() => assertSupportedJsonSchema(tools[MEM_WRITE_NAME].definition.parameters));
  });
});

test('P1-schema：必填项只在顶层 required，不在 properties 里', async () => {
  await withStore((store) => {
    const tools = createMemoryTools(store);
    const write = tools[MEM_WRITE_NAME].definition;
    assert.deepEqual(write.parameters.required, ['op']);
    assert.equal(Object.hasOwn(write.parameters.properties.op, 'required'), false);
    assert.equal(Object.hasOwn(write.parameters.properties.id, 'required'), false);
    assert.deepEqual(write.output.schema.required, ['id', 'status', 'type', 'title']);
    for (const property of Object.values(write.output.schema.properties)) {
      assert.equal(Object.hasOwn(property, 'required'), false, 'output 属性级 required 必须去掉');
    }
    const query = tools[MEM_QUERY_NAME].definition;
    assert.deepEqual(query.output.schema.required, ['count', 'entries']);
    assert.deepEqual(
      query.output.schema.properties.entries.items.required,
      ['id', 'status', 'type', 'title'],
    );
  });
});

test('P1-schema：宿主 register 校验通过后逐个注册成功', async () => {
  await withStore((store) => {
    const registered = [];
    const ctx = {
      tools: {
        register: (definition) => {
          assertToolDefinition(definition); // 与宿主 `register()` 的校验顺序一致
          registered.push(definition.name);
        },
      },
    };
    const result = registerMemoryTools(ctx, store);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(registered, [MEM_WRITE_NAME, MEM_QUERY_NAME]);
  });
});

test('P1-schema：旧的 spec 形状（属性级 required）会被宿主规则拒绝（防回归）', () => {
  const oldWriteOutput = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      status: { type: 'string', required: true },
    },
  };
  const violations = jsonSchemaViolations(oldWriteOutput);
  assert.ok(violations.some((line) => line.includes('required is not supported on type "string"')), violations.join('\n'));
  assert.throws(() => assertSupportedJsonSchema(oldWriteOutput), /unsupported JSON schema/);

  const oldArrayItems = {
    type: 'array',
    required: true,
    items: { type: 'string' },
  };
  assert.ok(jsonSchemaViolations(oldArrayItems).some((line) => line.includes('required is not supported on type "array"')));

  const badRequired = { type: 'object', properties: { a: { type: 'string' } }, required: 'a' };
  assert.ok(jsonSchemaViolations(badRequired).some((line) => line.includes('required must be an array of strings')));

  const unknownName = { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] };
  assert.ok(jsonSchemaViolations(unknownName).some((line) => line.includes('which is not in properties')));
});

test('P1-schema：注册失败原因不再被静默吞掉（failure 数组可见）', async () => {
  await withStore((store) => {
    const ctx = { tools: { register: () => { throw new Error('UNSUPPORTED_SCHEMA: schema.properties.x.required'); } } };
    const result = registerMemoryTools(ctx, store);
    assert.equal(result.registered.length, 0);
    assert.deepEqual(result.failures.map((failure) => failure.name), [MEM_WRITE_NAME, MEM_QUERY_NAME]);
    assert.match(result.failures[0].message, /UNSUPPORTED_SCHEMA/);
  });
});
