/**
 * D：项目模板 `.cg-policy.json` 的格式与解析。
 *
 * 文件是仓库可控输入，按不可信处理：
 * - 新格式 `{version:1, values:{...}}`（写入用此格式，带 schema 版本）；
 * - 兼容旧格式（整文件就是 values 映射，无 version）——保留只读兼容，不隐性回退到别的文件；
 * - 未知版本/非对象/坏 JSON → `{ok:false, reason}`，调用方记 `policy-invalid(source=project)` 且整层不生效。
 */
export const PROJECT_TEMPLATE_VERSION = 1;

export function parseProjectTemplate(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, reason: error instanceof SyntaxError ? 'invalid-json' : 'parse-failed' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid-shape' };
  }
  if (raw.values !== undefined) {
    if (raw.version !== PROJECT_TEMPLATE_VERSION) return { ok: false, reason: 'unknown-version' };
    if (raw.values === null || typeof raw.values !== 'object' || Array.isArray(raw.values)) {
      return { ok: false, reason: 'invalid-values' };
    }
    return { ok: true, version: PROJECT_TEMPLATE_VERSION, values: { ...raw.values } };
  }
  // 旧格式：整文件就是 values 映射（无 version）。
  return { ok: true, version: 0, values: { ...raw } };
}

export function serializeProjectTemplate(values) {
  const safe = values !== null && typeof values === 'object' && !Array.isArray(values) ? values : {};
  return `${JSON.stringify({ version: PROJECT_TEMPLATE_VERSION, values: safe }, null, 2)}\n`;
}
