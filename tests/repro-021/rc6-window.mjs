/**
 * 测试角色 · rc.6 真机窗口取数（UI 写层 / policy-set 归因 / C38 会话记忆事件）。
 *
 * 用法：node tests\repro-021\rc6-window.mjs --since <ISO> [--session <id>] [audit.jsonl...]
 *   缺省审计：D:\DS-PROJECT\DSH插件开发\memory\governance\audit.jsonl + G:\DS-HARNESS\memory\governance\audit.jsonl
 * 口径（与审核对表）：
 *   - `policy-set` 带 sessionId = 归因补丁生效；按 key 分布看五条路径是否都出现。
 *   - 主入口（chip/气泡）保存应产生 `policy-set{source:session,key:'compact.at'}`。
 *   - 设置页写 plugin（宿主 configForms），**不应**产生 `policy-set`。
 *   - C38：`memory-mode`/`memory-pointer-miss`/`memory-legacy-detected` 计数，miss 行是否带 id。
 * 只读：不写、不装、不改任何配置。
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
let since = '';
let session = '';
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--since') { since = args[++i]; continue; }
  if (args[i] === '--session') { session = args[++i]; continue; }
  files.push(args[i]);
}
if (since === '') { console.error('usage: rc6-window.mjs --since <ISO> [--session <id>] [audit...]'); process.exit(2); }
if (files.length === 0) {
  files.push(
    'D:/DS-PROJECT/DSH插件开发/memory/governance/audit.jsonl',
    'G:/DS-HARNESS/memory/governance/audit.jsonl',
    `${process.env.USERPROFILE ?? 'C:/Users/19091'}/.dsh/context-governance/root-audit-desktop.jsonl`,
  );
}

const rows = [];
for (const file of files) {
  if (!fs.existsSync(file)) { console.log(`MISSING ${file}`); continue; }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
}
rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
const sinceMs = Date.parse(since);
const after = (ts) => {
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value > sinceMs : String(ts) > since;
};
const post = rows.filter((row) => after(row.ts) && (session === '' || row.sessionId === session));
console.log(`since=${since}${session === '' ? '' : ` session=${session}`} rows=${post.length} (files=${files.length})`);

const pick = (event) => post.filter((row) => row.event === event);
const policySet = pick('policy-set');
const byKey = {};
for (const row of policySet) byKey[String(row.key ?? '?')] = (byKey[String(row.key ?? '?')] ?? 0) + 1;
const withSession = policySet.filter((row) => typeof row.sessionId === 'string' && row.sessionId !== '');
console.log(`policy-set=${policySet.length} withSessionId=${withSession.length} keys=${JSON.stringify(byKey)}`);
for (const row of policySet.slice(-8)) {
  console.log(`  policy-set ts=${row.ts} source=${row.source ?? '-'} key=${row.key ?? '-'} value=${row.value ?? '-'} sessionId=${row.sessionId ?? '(none)'}`);
}
const bubbleWrites = policySet.filter((row) => row.source === 'session' && row.key === 'compact.at');
console.log(`bubble/A2 写(compact.at,source=session)=${bubbleWrites.length}${bubbleWrites.length > 0 ? '' : ' ← 若本窗口在气泡保存过而=0，报审核'}`);

for (const event of ['session-governed', 'root-unresolved', 'policy-resolved', 'memory-mode', 'memory-pointer-miss', 'memory-legacy-detected', 'memory-promoted', 'memory-imported-role', 'header-injected', 'header-truncated']) {
  const list = pick(event);
  const extra = event === 'memory-pointer-miss'
    ? ` withId=${list.filter((row) => typeof row.id === 'string').length}`
    : '';
  console.log(`${event}=${list.length}${extra}`);
}
const miss = pick('memory-pointer-miss');
if (miss.length > 0) console.log(`  miss rows=${JSON.stringify(miss.slice(-3).map((row) => ({ ts: row.ts, id: row.id ?? null, target: row.target ?? null, reason: row.reason ?? null })))}`);
