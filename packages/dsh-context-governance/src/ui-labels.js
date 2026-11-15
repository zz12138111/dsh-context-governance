/**
 * C32：来源层的用户可见标签（唯一映射，禁别名）。
 *
 * 约束（REQUIREMENTS C32）：
 * - 四层固定：`session:A1`→「本会话·临时（重启失效）」、`session:A2`→「本会话·已保存（重启保留）」、
 *   `project`→「项目模板（可选）」、`plugin`→「全局（影响所有会话）」；
 * - `builtin`→「内置默认」、`profile=<name>`→「配置 profile=<name>」；
 * - `/cg status` 与 client UI 必须用**同一张表、同一字面**；
 * - 历史值 `session`（A1 之前的字面）按 A1 显示，不做第二种叫法（禁别名）。
 *
 * 这张表同时被 `lib/client.js` 引用（浏览器侧不能 import 宿主源码，所以那边内联同一张表，
 * 由 `test/d2-ui-labels.test.mjs` 逐一断言两侧字面一致）。
 */

export const LAYER_LABELS = Object.freeze({
  'session:A1': '本会话·临时（重启失效）',
  'session:A2': '本会话·已保存（重启保留）',
  project: '项目模板（可选）',
  plugin: '全局（影响所有会话）',
  builtin: '内置默认',
});

/** 四层里可写的层（UI 只允许写 A2 与会话临时层；project/plugin 由配置文件/命令写）。 */
export const WRITABLE_LAYERS = Object.freeze(['session:A1', 'session:A2']);

/**
 * 层 → 用户可见标签。
 * `profile=<name>` 单独展开；未知来源原样返回（不造别名，便于诊断）。
 * @param {string|null|undefined} source
 * @returns {string}
 */
export function layerLabel(source) {
  const key = String(source ?? '');
  if (key === '') return '未知来源';
  if (key === 'session') return LAYER_LABELS['session:A1'];
  if (key.startsWith('profile=')) {
    const name = key.slice('profile='.length);
    return `配置 profile=${name}`;
  }
  return LAYER_LABELS[key] ?? key;
}

/** 生命周期文案（C8：随来源派生，禁用一句常量盖所有来源）。 */
export function lifecycleTextFor(source) {
  const key = String(source ?? '');
  if (key === 'session:A2') return '本会话已保存，重启保留';
  if (key === 'session' || key === 'session:A1') return '本会话有效，重启后失效';
  return '保存后生效、重启仍有效';
}

/** `/cg status` 用的一行标签（C8 的「键名 + 中文」并列，不改既有 `source=` 口径）。 */
export function sourceLabelSuffix(source) {
  return ` 层=${layerLabel(source)}`;
}
