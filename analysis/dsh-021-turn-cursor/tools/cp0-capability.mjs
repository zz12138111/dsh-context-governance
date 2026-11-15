#!/usr/bin/env node
/**
 * CP0 能力前置门检查（C36 平台级会话覆盖 + C37 项目模板 + C38 会话级记忆，审核用，只读）。
 *
 * 用法：
 *   node analysis/dsh-021-turn-cursor/tools/cp0-capability.mjs [--root <插件目录>]
 *
 * 默认 root = <repo>/packages/dsh-context-governance。
 * 判定：必需项任一缺失 → 退出码 1（「未就绪」，不得出放行结论）。
 * 说明：这是**源码静态存在性**检查；真机事件仍须按 CP1–CP8 / C37 / C38 现采。
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
  { name: 'session-governed（C36 ⑭ 自动纳入证据）', re: /['"]session-governed['"]/g },
  { name: 'root-unresolved（C36 ⑤）', re: /['"]root-unresolved['"]/g },
  { name: 'policy-resolved（C36 ③）', re: /['"]policy-resolved['"]/g },
  { name: 'source 枚举 session:A1（C36 ⑩）', re: /['"]session:A1['"]/g },
  { name: 'source 枚举 session:A2（C36 ⑩）', re: /['"]session:A2['"]/g },
  { name: 'project-template-set（C37 ⑥）', re: /['"]project-template-set['"]/g },
  { name: 'project-template-cleared（C37 ⑥）', re: /['"]project-template-cleared['"]/g },
  { name: 'memory-pointer-miss（C38 ③）', re: /['"]memory-pointer-miss['"]/g },
  { name: 'memory-promoted（C38 ⑤）', re: /['"]memory-promoted['"]/g },
  { name: 'memory-imported（C38 ⑩）', re: /['"]memory-imported['"]/g },
  { name: 'memory-imported-role（C38 ⑪）', re: /['"]memory-imported-role['"]/g },
  { name: 'memory-import-no-source（C38 ⑬）', re: /['"]memory-import-no-source['"]/g },
  { name: 'session-role-set（C38 ⑬）', re: /['"]session-role-set['"]/g },
  { name: 'header-truncated（C38 ④）', re: /['"]header-truncated['"]/g },
  { name: '--from-role（C38 ⑪ 入口）', re: /from-role/g },
  { name: '/cg set compact.at（基线能力）', re: /compact\.at/g },
];
const manual = [
  { name: 'legacy-shared-v1（C38 ⑩ 存量标记）', re: /legacy-shared-v1/g },
  { name: 'A2 持久化候选（文件名/字段）', re: /(policy-session|session-polic|persistedPolicy|a2)/gi },
  { name: 'root-unresolved 原因枚举', re: /(cwd-unreadable|cwd-unwritable|empty-cwd)/g },
  { name: 'C37「无项目模板」文案', re: /无项目模板/g },
  { name: 'C37「项目模板」显示', re: /项目模板/g },
  { name: 'policy-invalid(source=project)（C37 ⑤）', re: /policy-invalid/g },
  { name: 'C38 会话库路径候选', re: /(context-governance[\\/]sessions|sessions[\\/]|shared[\\/])/g },
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
