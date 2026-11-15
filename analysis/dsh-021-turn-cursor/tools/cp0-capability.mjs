#!/usr/bin/env node
/**
 * CP0 能力前置门检查（C36 平台级会话覆盖，审核用，只读）。
 *
 * 用法：
 *   node analysis/dsh-021-turn-cursor/tools/cp0-capability.mjs [--root <插件目录>]
 *
 * 默认 root = <repo>/packages/dsh-context-governance。
 * 判定：必需项任一缺失 → 退出码 1（「未就绪」，不得出放行结论）。
 * 说明：这是**源码静态存在性**检查；真机事件仍须按 CP1–CP8 现采。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const repo = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const root = path.resolve(opt('--root', path.join(repo, 'packages', 'dsh-context-governance')));

const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(m?js|cjs)$/.test(name)) files.push(full);
  }
};
for (const sub of ['src', 'lib']) {
  const dir = path.join(root, sub);
  if (fs.existsSync(dir)) walk(dir);
}
const sources = files.map((f) => ({ rel: path.relative(root, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
const count = (re) => sources.reduce((n, s) => n + (s.text.match(re) ?? []).length, 0);
const where = (re) => sources.filter((s) => re.test(s.text)).map((s) => s.rel);

const required = [
  { name: 'root-unresolved（审计事件/字段）', re: /['"]root-unresolved['"]/g },
  { name: 'policy-resolved（审计事件）', re: /['"]policy-resolved['"]/g },
  { name: 'source 枚举 session:A1', re: /['"]session:A1['"]/g },
  { name: 'source 枚举 session:A2', re: /['"]session:A2['"]/g },
  { name: '/cg set compact.at（基线能力）', re: /compact\.at/g },
];
const manual = [
  { name: 'source 枚举 project（泛字面，须人工确认是枚举而非普通词）', re: /['"]project['"]/g },
  { name: 'source 枚举 plugin（泛字面，同上）', re: /['"]plugin['"]/g },
  { name: 'A2 持久化候选（文件名/字段）', re: /(policy-session|session-polic|persistedPolicy|a2)/gi },
  { name: 'root-unresolved 原因枚举', re: /(cwd-unreadable|cwd-unwritable|empty-cwd|root-unresolved)/g },
  { name: '/cg status 的 source 输出', re: /source=\$\{|source:\s*source|source=\$source/g },
];

let fail = 0;
console.log(`# CP0 能力前置门（静态）\nroot = ${root}\n扫描文件 = ${sources.length}\n`);
console.log('| 必需项 | 命中 | 位置 | 判定 |');
console.log('|---|---:|---|---|');
for (const item of required) {
  const n = count(item.re);
  const ok = n > 0;
  if (!ok) fail += 1;
  console.log(`| ${item.name} | ${n} | ${n > 0 ? where(item.re).slice(0, 3).join(', ') : '—'} | ${ok ? 'PASS' : '**MISSING**'} |`);
}
console.log('\n## 供人工核（不计 pass/fail）\n');
for (const item of manual) {
  const n = count(item.re);
  console.log(`- ${item.name}: ${n} 命中 ${n > 0 ? '(' + where(item.re).slice(0, 3).join(', ') + ')' : ''}`);
}
console.log(`\n必需项缺失 = ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
