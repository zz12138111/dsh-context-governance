/**
 * 能力探测（v0.1.3）：apply 时把"事件面相关 API 是否存在"一次性 dump 出来。
 *
 * 原则：
 * - **只记类型，不记值**：对象只报 `obj`/`obj(dispatch=fn)`，字符串/数字只报 `string`/`number`；
 *   任何路径都不 dump 内容（会话 id、消息、配置值都不会出现）。
 * - 每个探测点单独 try/catch：宿主 ctx 是 Proxy，读一个未挂载的服务可能抛错。
 * - 输出是**单行** `name=value` 列表，便于在 `logs/governance.log` 里 grep。
 */

/** 直接属性探测（`ctx.xxx`）。 */
const SELF_PROBES = Object.freeze([
  'on',
  'emit',
  'get',
  'events',
  'bus',
  'session',
  'sessions',
  'agents',
  'workspace',
  'compaction',
  'commands',
  'tools',
  'tokenMeter',
  'logger',
  'sessionProjections',
]);

/** 服务名探测（`ctx.get('xxx')`）。 */
const SERVICE_PROBES = Object.freeze([
  'events',
  'sessions',
  'session',
  'agents',
  'workspace',
  'commands',
  'tools',
  'compaction',
  'tokenMeter',
  'sessionProjections',
]);

/** 把一个值压成不含内容的类型标记。 */
export function describeValue(value) {
  if (value === undefined || value === null) return 'absent';
  const type = typeof value;
  if (type === 'function') return 'fn';
  if (type === 'object') {
    try {
      return typeof value.dispatch === 'function' ? 'obj(dispatch=fn)' : 'obj';
    } catch {
      return 'obj(unreadable)';
    }
  }
  return type; // string/number/boolean/bigint/symbol → 只报类型
}

function readSelf(ctx, name) {
  try {
    return describeValue(ctx[name]);
  } catch {
    return 'throws';
  }
}

function readService(ctx, name) {
  try {
    if (typeof ctx?.get !== 'function') return 'no-get';
    return describeValue(ctx.get(name));
  } catch {
    return 'throws';
  }
}

/**
 * 探测宿主上下文的能力面。
 *
 * @param {object} ctx 插件上下文
 * @returns {{entries: Array<[string, string]>, eventApi: boolean, eventBus: string, sessionsApi: string}}
 */
export function probeCapability(ctx) {
  const entries = [];
  for (const name of SELF_PROBES) entries.push([name, readSelf(ctx, name)]);
  for (const name of SERVICE_PROBES) entries.push([`get.${name}`, readService(ctx, name)]);
  let rootSelf = 'unknown';
  try {
    rootSelf = ctx?.root === ctx ? 'self' : 'child';
  } catch {
    rootSelf = 'throws';
  }
  entries.push(['root', rootSelf]);

  const find = (name) => entries.find(([key]) => key === name)?.[1] ?? 'absent';
  return {
    entries,
    eventApi: find('on') === 'fn',
    eventBus: find('events'),
    sessionsApi: find('get.sessions') === 'absent' ? find('sessions') : find('get.sessions'),
  };
}

/**
 * 把探测结果渲染成逗号分隔的 `name=value` 串（供诊断行与测试共用）。
 * @param {Array<[string, string]>} entries
 */
export function formatCapability(entries = []) {
  return entries.map(([name, value]) => `${name}=${value}`).join(',');
}
