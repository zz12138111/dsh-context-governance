#!/usr/bin/env node
/**
 * 记忆噪音清理（P2-4 第 5 条，维护脚本）。
 *
 * 用法：
 *   node scripts/memory-cleanup.mjs [--dry-run|--apply] [--root <memory root>] [--out <json>]
 *
 * 默认 --dry-run：只列出“将会被标记 expired 的条目”，不写任何文件。
 * --apply：先整目录备份到仓库外（默认 D:\DS-PROJECT\_backup\），再逐条 expire + 写 memory-cleanup 审计。
 *
 * ⚠ 记忆只能由持锁进程写：DSH 运行中会报 MemoryReadOnlyError: writer-lock:<pid>，需先停 DSH。
 */
import fs from 'node:fs';
import path from 'node:path';

import { AuditLog } from '../packages/dsh-context-governance/src/audit.js';
import { MemoryStore } from '../packages/dsh-context-governance/src/memory/store.js';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const apply = args.includes('--apply');
const root = path.resolve(opt('--root', 'memory/governance'));
const project = opt('--project', 'DSH插件开发');
const backupBase = opt('--backup-dir', 'D:/DS-PROJECT/_backup');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.resolve(opt('--out', `.tmp/memory-cleanup-${stamp}.json`));

const isRuleNoise = (entry) => {
  if (entry.status !== 'active') return false;
  if (String(entry.writer ?? '') !== 'rule') return false; // P3：只看自动写入的 rule 条目
  if (entry.type === 'progress') return true;
  return /^[\d\s/／.\-:年月日]+$/.test(String(entry.title ?? '').trim());
};

const store = await MemoryStore.open({ rootDir: root, project, readOnly: !apply });
const targets = store.allEntries().filter(isRuleNoise).map((entry) => ({
  id: entry.id,
  type: entry.type,
  title: String(entry.title ?? '').slice(0, 80),
  from: entry.status,
  to: 'expired',
}));

if (!apply) {
  console.log(`[memory-cleanup] DRY-RUN root=${root} targets=${targets.length}`);
  for (const item of targets) console.log(`  ${item.id} ${item.type} ${item.from}->${item.to} ${item.title}`);
  // dry-run 也要覆盖不可写：否则用户看到“N 条目标”以为能 apply，到 apply 才发现锁被占。
  if (store.status.writable !== true) {
    console.log(
      `[memory-cleanup] ⚠ 当前不可写（${store.status.readOnlyReason ?? 'unknown'}）：` +
      '--apply 会失败；请先退出/重启 DSH 释放写者锁。',
    );
  } else {
    console.log('[memory-cleanup] 当前可写；加 --apply 才会写，写前会先整目录备份到仓库外。');
  }
  await store.close();
  process.exit(0);
}

// P3-3：--apply 前先判可写；被写者锁持有 → 友好退出、exit 2、**不生成备份**。
if (store.status.writable !== true) {
  console.error(
    `[memory-cleanup] 无法写入记忆库：${store.status.readOnlyReason ?? 'unknown'}。` +
    'DSH 运行中会持有写者锁；请先退出/重启 DSH（释放锁）再 --apply。',
  );
  await store.close();
  process.exit(2);
}

const backup = path.resolve(backupBase, `governance-bak-${stamp}`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.cpSync(root, backup, { recursive: true });
const audit = new AuditLog({ file: path.join(root, 'audit.jsonl') });
const before = store.status.counts;
for (const item of targets) {
  await store.expire(item.id);
  audit.append('memory-cleanup', { code: item.id, reason: 'p2-4-rule-noise', source: `was:${item.type}/${item.from}` });
}
const after = store.status.counts;
const mapping = { root, backup, before, after, cleaned: targets.length, targets };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(mapping, null, 2), 'utf8');
console.log(`[memory-cleanup] applied=${targets.length} backup=${backup} out=${outFile}`);
console.log(`[memory-cleanup] active: ${before.active} -> ${after.active}`);
await store.close();
