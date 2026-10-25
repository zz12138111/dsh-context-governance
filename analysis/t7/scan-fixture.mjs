/**
 * fixture 泄漏扫描（独立于测试，可单独跑）：
 *   node analysis/t7/scan-fixture.mjs <fixture.json...>
 *
 * 判据（审核二轮要求）：
 * - 递归所有**字符串**：不得含 CJK、Windows/POSIX 绝对路径、URL、session-uuid、裸 uuid、长 token；
 * - 把同一文档所有字符串按 JSON 遍历顺序 join（含分隔符）后再查一遍；
 * - 原文件文本（JSON.stringify 后）再查一遍。
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const CJK_RE = /[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/])/;
const POSIX_PATH_RE = /\/(?:usr|home|etc|var|tmp|opt|mnt|root|Users)\//;
const URL_RE = /(?:https?|ftp|file):\/\/[^\s"'<>]+/i;
const SESSION_RE = /session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const LONG_TOKEN_RE = /[A-Za-z0-9+/_=-]{64,}/;

export const FORBIDDEN = [
  ['CJK', CJK_RE],
  ['absolute-path', ABS_PATH_RE],
  ['posix-path', POSIX_PATH_RE],
  ['url', URL_RE],
  ['session-id', SESSION_RE],
  ['uuid', UUID_RE],
  ['long-token', LONG_TOKEN_RE],
];

export function collectStrings(value, trail = '$', out = []) {
  if (typeof value === 'string') out.push({ trail, value });
  else if (Array.isArray(value)) value.forEach((item, index) => collectStrings(item, `${trail}[${index}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) collectStrings(child, `${trail}.${key}`, out);
  }
  return out;
}

export function scanFixture(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const violations = [];
  const strings = collectStrings(parsed);
  for (const [label, pattern] of FORBIDDEN) {
    for (const { trail, value } of strings) {
      if (pattern.test(value)) violations.push(`${label} @ ${trail}: ${value.slice(0, 80)}`);
    }
  }
  // join 后整体复检（token 数组/短片段绕过单串检查的根因）：带分隔符 + 不带分隔符各查一遍。
  // 拼接后长 ASCII 串可能是正常枚举值相连，长 token 只在单串层面判；其余模式 join 后仍必须干净。
  const joinedChecks = FORBIDDEN.filter(([label]) => label !== 'long-token');
  const joined = strings.map((entry) => entry.value).join('\n');
  const joinedTight = strings.map((entry) => entry.value).join('');
  for (const [label, pattern] of joinedChecks) {
    if (pattern.test(joined)) violations.push(`${label} @ joined`);
    if (pattern.test(joinedTight)) violations.push(`${label} @ joined-tight`);
  }
  // 原文件（JSON 文本）复检：只查不会与 JSON 转义混淆的模式；
  // 绝对路径已在解析后的字符串与 join 两侧查过（raw 的 `\\` 是转义，规则会误报）。
  const rawChecks = [
    ['CJK', CJK_RE],
    ['url', URL_RE],
    ['session-id', SESSION_RE],
    ['uuid', UUID_RE],
  ];
  for (const [label, pattern] of rawChecks) {
    if (pattern.test(raw)) violations.push(`${label} @ raw-file`);
  }
  return { file, strings: strings.length, violations };
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node analysis/t7/scan-fixture.mjs <fixture.json...>');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const result = scanFixture(file);
    console.log(`${result.file}: strings=${result.strings} violations=${result.violations.length}`);
    for (const violation of result.violations.slice(0, 20)) console.log(`  - ${violation}`);
    if (result.violations.length > 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
