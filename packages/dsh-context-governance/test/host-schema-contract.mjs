/**
 * 宿主 JSON Schema 子集契约（P1 回归护栏）。
 *
 * 规则从 `app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js` 的
 * `CONSTRAINT_KEYWORDS` / `ANNOTATION_KEYWORDS` / `checkSchemaNode` 复刻：
 * - 仅允许 type/oneOf/properties/required/additionalProperties/items/enum/const + description/title/default/examples；
 * - `required` 只能出现在 object 上，且必须是**字符串数组**、名字必须在 `properties` 里；
 * - `properties` 必须在 object 上；`items` 在 array；`enum`/`const` 类型必须匹配；
 * - 属性级 `required: true` 会被判为 “required is not supported on type …”（旧的 spec 形状的根因）。
 *
 * 这不是“近似”：本文件就是回归测试；宿主升级子集时需同步这里（见 docs/T7 说明）。
 */

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainArray(value) {
  return Array.isArray(value);
}

function isLosslessJson(value) {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
    case 'integer': return Number.isInteger(value) && !Object.is(value, -0);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function checkNode(node, path, violations, seen) {
  if (!isRecord(node)) {
    violations.push(`${path} must be a schema object`);
    return;
  }
  if (seen.has(node)) {
    violations.push(`${path} is circular`);
    return;
  }
  seen.add(node);
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue;
    if (ANNOTATION_KEYWORDS.has(key)) {
      if (!isLosslessJson(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
      continue;
    }
    violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') violations.push(`${path}.description must be a string`);
  if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') violations.push(`${path}.title must be a string`);

  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`);
    seen.delete(node);
    return;
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
    }
    seen.delete(node);
    return;
  }
  if (hasOneOf) {
    const oneOf = node.oneOf;
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`);
    }
    if (!isPlainArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
    else oneOf.forEach((arm, index) => checkNode(arm, `${path}.oneOf[${index}]`, violations, seen));
    seen.delete(node);
    return;
  }

  const type = node.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(Array.isArray(type)
      ? `${path}.type must be a single type string (type arrays are not supported)`
      : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    seen.delete(node);
    return;
  }
  const keywordTypes = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  };
  for (const [key, types] of Object.entries(keywordTypes)) {
    if (Object.hasOwn(node, key) && !types.includes(type)) {
      violations.push(`${path}.${key} is not supported on type "${type}"`);
    }
  }

  if (type === 'object') {
    const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined;
    if (Object.hasOwn(node, 'properties')) {
      if (!isRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
      else for (const [key, child] of Object.entries(properties)) checkNode(child, `${path}.properties.${key}`, violations, seen);
    }
    const hasRequired = Object.hasOwn(node, 'required');
    const required = hasRequired ? node.required : undefined;
    if (hasRequired && (!isPlainArray(required) || required.some((entry) => typeof entry !== 'string'))) {
      violations.push(`${path}.required must be an array of strings`);
    } else if (hasRequired) {
      const declared = isRecord(properties) ? properties : {};
      for (const key of required) {
        if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`);
    }
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) checkNode(node.items, `${path}.items`, violations, seen);
  } else {
    const hasEnum = Object.hasOwn(node, 'enum');
    const allowed = hasEnum ? node.enum : undefined;
    const enumValid = isPlainArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(type, entry));
    if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${type} values`);
    const hasConst = Object.hasOwn(node, 'const');
    if (hasConst) {
      const declaredConst = node.const;
      const constValid = scalarMatches(type, declaredConst);
      if (!constValid) violations.push(`${path}.const must be a ${type} value`);
      else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
    }
  }
  seen.delete(node);
}

/** 返回违规列表（空数组 = 宿主接受）。 */
export function jsonSchemaViolations(schema) {
  const violations = [];
  checkNode(schema, 'schema', violations, new Set());
  return violations;
}

/** 等价于宿主 `assertSupportedJsonSchema`。 */
export function assertSupportedJsonSchema(schema) {
  const violations = jsonSchemaViolations(schema);
  if (violations.length > 0) {
    const error = new Error(`unsupported JSON schema: ${violations.join('; ')}`);
    error.name = 'JsonSchemaError';
    error.violations = violations;
    throw error;
  }
}

/**
 * 复刻宿主 `ctx.tools.register` 的定义校验：
 * output 必须 `{schema, render}`；output.schema 必须过子集校验；
 * name 非空且不是保留名 `run_code`。
 */
export function assertToolDefinition(definition) {
  if (definition === null || typeof definition !== 'object') throw new TypeError('tool definition must be an object');
  const name = definition.name;
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('tool name must be a non-empty string');
  if (name === 'run_code') throw new Error('tool name "run_code" is reserved');
  const output = definition.output;
  if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new TypeError(`tool "${name}" must declare output { schema, render }`);
  }
  assertSupportedJsonSchema(output.schema);
  if (typeof definition.execute !== 'function') throw new TypeError(`tool "${name}" must declare execute`);
  return true;
}
