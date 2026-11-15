/**
 * 测试角色 · 第二次真机窗口（2026-11-14 21:58）读数独立复核。
 * 只读 G:\DS-HARNESS\memory\governance 与 audit.jsonl；不写任何文件。
 *
 * 运行：node tests\probe-1.0.3\verify-window-2158.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { detectTitleTruncation, normalizeTitleKey, titleKeyMatches } from '../../packages/dsh-context-governance/src/memory/contract.js';

const ROOT = 'G:\\DS-HARNESS\\memory\\governance';
const TOPICS = path.join(ROOT, 'topics');
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}

const entries = [];
for (const name of await fs.readdir(TOPICS)) {
  if (!name.endsWith('.md')) continue;
  const text = await fs.readFile(path.join(TOPICS, name), 'utf8');
  for (const match of text.matchAll(/<!-- entry:(MEM-[^\s]+) -->([\s\S]*?)<!-- \/entry -->/g)) {
    const body = match[2];
    const lines = body.split(/\r?\n/);
    const meta = (key) => {
      const line = lines.find((item) => item.startsWith(`- ${key}: `));
      return line === undefined ? '' : line.slice(String(key).length + 3).trim();
    };
    const blank = lines.findIndex((item, index) => index > 3 && item.trim() === '');
    const detail = lines.slice(blank + 1).join('\n').trim();
    entries.push({
      id: match[1], file: name, type: meta('type'), status: meta('status'),
      title: meta('title'), createdAt: meta('createdAt'), source: meta('source'),
      evidence: meta('evidence'), detailLen: detail.length,
    });
  }
}

const counts = entries.reduce((acc, entry) => { acc[entry.status] = (acc[entry.status] ?? 0) + 1; return acc; }, {});
check('counts-total', entries.length === 32 && counts.active === 11 && counts.proposed === 9 && counts.expired === 12,
  `total=${entries.length} active=${counts.active} proposed=${counts.proposed} expired=${counts.expired}`);

const newIds = ['MEM-20261114-1005', 'MEM-20261114-1009', 'MEM-20261114-1010'];
const fresh = entries.filter((entry) => newIds.includes(entry.id));
check('new-three', fresh.length === 3, `命中 ${fresh.map((entry) => entry.id).join(', ')}`);

// 5a：protection 条目正文非空 + 指针可解析；evidence 的 compactionId 能在 audit.jsonl 命中
const auditText = await fs.readFile(path.join(ROOT, 'audit.jsonl'), 'utf8');
for (const entry of fresh) {
  const titleOk = detectTitleTruncation(entry.title) === null;
  const sourceOk = /^[A-Za-z][\w-]*:\S+$/.test(entry.source);
  const evidenceOk = /^compaction:[0-9a-f-]{8,}$/i.test(entry.evidence);
  const evidenceHit = evidenceOk && auditText.includes(entry.evidence.slice('compaction:'.length));
  check(`5a-${entry.id}`, entry.detailLen > 0 && sourceOk && evidenceOk && evidenceHit,
    `detailLen=${entry.detailLen} source=${entry.source} evidence=${entry.evidence} auditHit=${evidenceHit}`);
  // 5c：标题不截断（无未闭合反引号/尾分隔符/换行/省略号）
  check(`5c-${entry.id}`, titleOk, `title="${entry.title.slice(0, 60)}..." trunc=${detectTitleTruncation(entry.title)}`);
}

// 5b：本窗口新增条目里，同一归一化标题（含实现的前缀近似）≤1
const pairs = [];
for (let i = 0; i < fresh.length; i += 1) {
  for (let j = i + 1; j < fresh.length; j += 1) {
    if (titleKeyMatches(normalizeTitleKey(fresh[i].title), normalizeTitleKey(fresh[j].title))) {
      pairs.push([fresh[i].id, fresh[j].id]);
    }
  }
}
check('5b-no-duplicate', pairs.length === 0, `重复对=${JSON.stringify(pairs)}`);

// 旁证：第二次压缩 1007/1008 未落库（同标题被去重）
const ids = new Set(entries.map((entry) => entry.id));
check('5b-dedup-evidence', !ids.has('MEM-20261114-1007') && !ids.has('MEM-20261114-1008'),
  '1007(rules)/1008(batch) 未出现在 topics（与既有条目同标题被去重）');

// 观察：1009 / 1010 近同内容未合并的原因（短键 < 8）
const k9 = normalizeTitleKey(fresh.find((entry) => entry.id === 'MEM-20261114-1009').title);
const k10 = normalizeTitleKey(fresh.find((entry) => entry.id === 'MEM-20261114-1010').title);
check('obs-near-dup-not-merged', titleKeyMatches(k9, k10) === false,
  `key1009="${k9}"(len=${k9.length}) key1010="${k10}"(len=${k10.length}) 短键<8 → 不合并`);

const failed = results.filter((item) => !item.ok);
console.log(`\nWINDOW2158 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
