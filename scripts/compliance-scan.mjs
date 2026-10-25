#!/usr/bin/env node
/**
 * 发布前只读合规扫描（不改任何文件，只读仓库内容并写报告）。
 *
 * 用法：
 *   node scripts/compliance-scan.mjs [--root <dir>] [--out <file>] [--strict] [--no-untracked]
 *
 * 扫什么：
 *   1. 凭据形态：私钥块、GitHub token/PAT、OpenAI key、Slack token、AWS key、JWT、
 *      `password|secret|api_key|access_token = …` 赋值。
 *   2. 本机绝对路径：`C:\Users\<name>`、`/home/<name>`、`/Users/<name>` → 公开仓库前应脱敏。
 *   3. 真实会话 id：`session-<uuid>` → 公开仓库前应脱敏或排除 analysis/。
 *   4. 第三方许可痕迹：非 LICENSE 文件里出现 `Copyright (c) …` / `SPDX-License-Identifier` /
 *      `Apache License` / MIT 全文 → 可能复制了别人的代码，需人工确认归属。
 *   5. 入库产物：`node_modules/`、`dist/`、`.zip/.tgz/.7z/.asar/.exe`。
 *   6. 未跟踪但未忽略的文件（会被 `git add -A` 带进去）。
 *   7. remote URL 里内嵌凭据（`https://user:token@…`）。
 *
 * 分级：
 *   - blocker：硬凭据（非测试样例/非自描述文件）、依赖/产物入库、remote 内嵌凭据 → 发布前必须处理；
 *   - review ：疑似凭据赋值、代码文件里的第三方版权头、docs 里的第三方版权引用（需人工确认）；
 *   - info   ：本机路径、会话 id、测试样例里的假凭据、自描述文件里的正则 → 公开仓库前脱敏/知悉即可。
 *
 * 报告默认写到 `logs/compliance-scan-<时间>.md`（logs/ 已 gitignore）。
 * 退出码：默认 0；加 `--strict` 时**仅当有 blocker** 返回 1，便于做发布门禁。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const has = (name) => args.includes(name);

const root = path.resolve(opt('--root', process.cwd()));
const strict = has('--strict');
const includeUntracked = !has('--no-untracked');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.resolve(opt('--out', path.join(root, 'logs', `compliance-scan-${stamp}.md`)));

function git(argv) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

let tracked = [];
try {
  tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
} catch (error) {
  console.error('not a git repository:', root, String(error?.message ?? error));
  process.exit(0);
}

const untracked = [];
if (includeUntracked) {
  for (const entry of git(['status', '--porcelain', '-z']).split('\0')) {
    if (entry.startsWith('?? ')) untracked.push(entry.slice(3));
  }
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|zip|tgz|7z|asar|exe|dll|so|dylib|pdf|woff2?|ttf|mp[34]|wav)$/i;
const ARTIFACT_RE = /(^|\/)(node_modules|dist)\/|\.(zip|tgz|7z|asar|exe|dll)$/i;
const LICENSE_BASENAME = /^licen[cs]e(\.(md|txt))?$/i;
const TEST_FILE = /(^|\/)test\/.+\.(test|spec)\.mjs$|(^|\/)test\/.+fixture/i;
const SELF_DESCRIBED = /(^|\/)src\/memory\/contract\.js$|(^|\/)scripts\/compliance-scan\.mjs$/;
const DOC_FILE = /\.(md|txt)$/i;
// 历史复核摘录误报白名单（只针对 docs/review-*.md 里已知的“引用旧结论/脱敏样例”模式，
// 例如 `pass***` 被 credential-assignment 命中）：范围窄、可审；不放宽 blocker，也不白名单整个 docs/。
const HISTORICAL_REVIEW_FILE = /(^|\/)docs\/(?:review-[^/]+|T5-状态命令与审计)\.md$/;
const HISTORICAL_REVIEW_FALSE_POSITIVE = /password=\/api_key=|pass\*{2,}|\bghp_\/sk-|\bPRIVATE KEY\/，|hunter2|(?:secret|token|password)\*{2,}/i;

const CREDENTIALS = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['aws-secret', /\baws_secret_access_key\b/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{24,}\b/],
  ['credential-assignment', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{6,}/i],
];
const THIRD_PARTY = [
  ['copyright', /Copyright\s*\(c\)/i],
  ['spdx', /SPDX-License-Identifier:/i],
  ['apache-license', /Apache License,?\s*Version 2\.0/i],
  ['mit-license-text', /Permission is hereby granted, free of charge/i],
];
const ABS_PATH = [
  ['windows-user-path', /(?<![A-Za-z0-9])[A-Za-z]:\\Users\\[^\\\s"'`<>]+/g],
  ['home-path', /\/home\/[^/\s"'`<>]+/g],
  ['mac-user-path', /\/Users\/[^/\s"'`<>]+/g],
];
const SESSION_ID = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const findings = [];
const stats = { files: 0, skippedBinary: 0, lines: 0 };
const add = (kind, severity, file, line, sample) => {
  findings.push({ kind, severity, file, line, sample: String(sample).slice(0, 48) });
};

function scanText(file, text) {
  const lines = text.split('\n');
  stats.lines += lines.length;
  const isTest = TEST_FILE.test(file);
  const isSelf = SELF_DESCRIBED.test(file);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [kind, re] of CREDENTIALS) {
      const m = re.exec(line);
      if (!m) continue;
      const hard = kind !== 'credential-assignment';
      // 只按**匹配串本身**判误报（整行里恰好出现白名单串不能把同行的真 key 降级）。
      const historicalFp = HISTORICAL_REVIEW_FILE.test(file) && HISTORICAL_REVIEW_FALSE_POSITIVE.test(m[0]);
      const selfRegexLiteral = isSelf && /RegExp|\\b|\\w|\[\^/.test(line);
      const severity = isTest || selfRegexLiteral || historicalFp ? 'info' : hard ? 'blocker' : 'review';
      add(`credential:${kind}`, severity, file, i + 1, m[0].slice(0, 4) + '***');
    }
    for (const [kind, re] of ABS_PATH) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) add(`path:${kind}`, 'info', file, i + 1, m[0].replace(/[^\\/]+$/, '***'));
    }
    const s = SESSION_ID.exec(line);
    if (s) add('session-id', 'info', file, i + 1, s[0].slice(0, 16) + '…');
    if (!LICENSE_BASENAME.test(path.basename(file))) {
      for (const [kind, re] of THIRD_PARTY) {
        if (!re.test(line)) continue;
        const severity = DOC_FILE.test(file) || isSelf ? 'info' : 'review';
        add(`license:${kind}`, severity, file, i + 1, DOC_FILE.test(file) ? '（文档引用，需确认归属）' : '…');
      }
    }
  }
}

const files = [...new Set([...tracked, ...untracked])].sort();
for (const rel of files) {
  const abs = path.join(root, rel);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    continue;
  }
  if (ARTIFACT_RE.test(rel.replace(/\\/g, '/'))) {
    add('vendored-artifact', 'blocker', rel, 0, 'tracked artifact');
  }
  if (BINARY_EXT.test(rel) || buf.subarray(0, 8000).includes(0)) {
    stats.skippedBinary += 1;
    continue;
  }
  stats.files += 1;
  scanText(rel, buf.toString('utf8'));
}

let remoteNote = 'n/a';
try {
  const remotes = git(['remote', '-v']).split('\n').filter(Boolean);
  for (const line of remotes) {
    const m = /\/\/[^/@\s]+:[^/@\s]+@/.exec(line);
    if (m) add('remote-credential', 'blocker', '(git remote)', 0, m[0].slice(0, 6) + '***');
  }
  remoteNote = remotes.map((l) => l.replace(/(\/\/[^/@\s]+:)[^/@\s]+@/, '$1***@')).join('\n') || 'none';
} catch {
  remoteNote = 'unreadable';
}

const bySeverity = new Map();
const byKind = new Map();
for (const f of findings) {
  bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
}
const blockers = findings.filter((f) => f.severity === 'blocker');

const head = (() => {
  try { return git(['log', '-1', '--format=%h %s']).trim(); } catch { return 'unknown'; }
})();

const report = [];
report.push('# 发布前合规扫描报告');
report.push('');
report.push(`- 时间：${new Date().toISOString()}`);
report.push(`- 根目录：${root}`);
report.push(`- HEAD：${head}`);
report.push(`- 扫描：跟踪文件 ${tracked.length} + 未跟踪未忽略 ${untracked.length}；文本 ${stats.files} 个（跳过二进制 ${stats.skippedBinary} 个，${stats.lines} 行）`);
report.push(`- 结论：${blockers.length === 0 ? '**无 blocker**' : `**${blockers.length} 个 blocker**`}；review ${bySeverity.get('review') ?? 0}、info ${bySeverity.get('info') ?? 0}`);
report.push('');
report.push('## 分级汇总');
report.push('');
report.push('| 级别 | 数量 | 含义 |');
report.push('|---|---:|---|');
report.push(`| blocker | ${bySeverity.get('blocker') ?? 0} | 发布前必须处理 |`);
report.push(`| review | ${bySeverity.get('review') ?? 0} | 需人工确认 |`);
report.push(`| info | ${bySeverity.get('info') ?? 0} | 知悉即可（公开仓库前脱敏） |`);
report.push('');
report.push('| 类别 | 数量 |');
report.push('|---|---:|');
for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) report.push(`| \`${kind}\` | ${count} |`);
report.push('');
report.push('## 明细');
report.push('');
for (const severity of ['blocker', 'review', 'info']) {
  const list = findings.filter((f) => f.severity === severity);
  if (list.length === 0) continue;
  report.push(`### ${severity}（${list.length}）`);
  report.push('');
  const grouped = new Map();
  for (const f of list) {
    if (!grouped.has(f.kind)) grouped.set(f.kind, []);
    grouped.get(f.kind).push(f);
  }
  for (const [kind, items] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    report.push(`#### ${kind}（${items.length}）`);
    report.push('');
    for (const f of items.slice(0, 30)) report.push(`- \`${f.file}\`${f.line > 0 ? `:${f.line}` : ''} — ${f.sample}`);
    if (items.length > 30) report.push(`- …还有 ${items.length - 30} 条`);
    report.push('');
  }
}
report.push('## 备注');
report.push('');
report.push('- 只读扫描：不修改、不删除、不暂存任何文件。');
report.push('- 已知白名单：`test/**` 里的假凭据样例、`src/memory/contract.js`（凭据正则自描述）、`scripts/compliance-scan.mjs`（本脚本）记为 info；`LICENSE*` 不做第三方许可告警。');
report.push('- `analysis/` 里的本机路径与真实会话 id 属预期；公开仓库前需脱敏或把该目录排除在发布物外。');
report.push(`- git remote：\n\n\`\`\`\n${remoteNote}\n\`\`\``);
report.push('');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, report.join('\n'), 'utf8');

console.log(`compliance-scan: blocker=${blockers.length} review=${bySeverity.get('review') ?? 0} info=${bySeverity.get('info') ?? 0} (${stats.files} text files)`);
for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${kind}: ${count}`);
console.log(`report: ${outFile}`);
if (strict && blockers.length > 0) process.exit(1);
