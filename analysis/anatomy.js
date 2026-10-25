// 00 会话上下文解剖：把 session.v4.jsonl 的事件按"进入上下文的类别"聚合。
// 输入：%TEMP%\dsh-00-session.jsonl（已由 zstd 解压的 JSONL）
// 输出：analysis\00-session-anatomy.md + 控制台摘要
const fs = require('fs');
const path = require('path');

const SRC = path.join(process.env.TEMP, 'dsh-00-session.jsonl');
const OUT = path.join(__dirname, '00-session-anatomy.md');
const TZ = 8 * 3600 * 1000;
const todayStart = new Date('2026-10-25T00:00:00+08:00').getTime();

const lines = fs.readFileSync(SRC, 'utf8').split('\n').filter(Boolean);
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

const textLen = (content) => {
  if (!content) return 0;
  let n = 0;
  for (const p of content) {
    if (typeof p.text === 'string') n += p.text.length;
    else if (p.type === 'tool_use') n += JSON.stringify(p.input || '').length;
    else if (p.type === 'tool-addition') n += 0;
  }
  return n;
};

const dayKey = (t) => new Date(t + TZ).toISOString().slice(0, 10);

const byCat = {};          // category -> chars
const byDay = {};          // day -> category -> chars
const toolRes = {};        // tool name -> {count, chars, max, samples[]}
const callNames = new Map(); // callId -> tool name
const topEvents = [];
const userKinds = {};      // source kind -> {count, chars}
const compaction = [];     // {time, summaryChars, pruneTokens}
const headerStats = [];
const turns = new Set();
const steps = new Set();
const days = new Set();
let toolCallCount = 0, assistantCount = 0, resultCount = 0;

const add = (cat, t, chars, meta) => {
  byCat[cat] = (byCat[cat] || 0) + chars;
  const d = dayKey(t);
  byDay[d] = byDay[d] || {};
  byDay[d][cat] = (byDay[d][cat] || 0) + chars;
  if (chars > 2000) topEvents.push({ cat, chars, t, ...meta });
};

for (const ev of events) {
  const t = Number(ev.time) || 0; const type = ev.type; const d = ev.data || {};
  if (t) days.add(dayKey(t));
  if (type === 'turn/start') { turns.add(d.turn); }
  else if (type === 'step/start') { steps.add((d.turn || 0) + ':' + (d.step || 0)); }
  else if (type === 'user/message') {
    const chars = textLen(d.content);
    const kind = (d.source && d.source.kind) || 'unknown';
    userKinds[kind] = userKinds[kind] || { count: 0, chars: 0 };
    userKinds[kind].count++; userKinds[kind].chars += chars;
    add('user:' + kind, t, chars, { preview: (d.content?.[0]?.text || '').slice(0, 80) });
  } else if (type === 'assistant/message') {
    assistantCount++;
    const content = (d.message && d.message.content) || [];
    for (const p of content) {
      if (p.type === 'reasoning') add('assistant:reasoning(输出侧)', t, (p.text || '').length, {});
      else if (p.type === 'text') add('assistant:text', t, (p.text || '').length, { preview: (p.text || '').slice(0, 80) });
      else if (p.type === 'tool_use') add('assistant:tool_use(args)', t, JSON.stringify(p.input || '').length, { name: p.name });
    }
  } else if (type === 'tool/call') {
    toolCallCount++;
    callNames.set(d.callId, d.name);
    add('tool_call:args', t, (d.arguments || '').length, { name: d.name });
  } else if (type === 'tool/result') {
    resultCount++;
    const name = callNames.get(d.message && d.message.toolCallId) || '?';
    const chars = textLen((d.message && d.message.content) || []);
    toolRes[name] = toolRes[name] || { count: 0, chars: 0, max: 0 };
    toolRes[name].count++; toolRes[name].chars += chars;
    toolRes[name].max = Math.max(toolRes[name].max, chars);
    add('tool_result:' + name, t, chars, { name, preview: ((d.message?.content?.[0]?.text) || '').slice(0, 80) });
  } else if (type === 'system/message' || type === 'developer/message') {
    add(type, t, textLen((d.message && d.message.content) || []), {});
  } else if (type === 'request/header') {
    const h = d.header || {};
    headerStats.push({ chars: JSON.stringify(h).length, tools: (h.tools || []).length, t });
    add('request_header(固定开销)', t, JSON.stringify(h).length, {});
  } else if (type === 'compaction/summary') {
    compaction.push({ time: t, summaryChars: textLen(d.summary), pruneTokens: 0 });
    add('compaction:summary(输出侧)', t, textLen(d.summary), {});
  } else if (type === 'compaction/prune') {
    const last = compaction[compaction.length - 1];
    if (last) last.pruneTokens += (d.shadowedTokenCount || 0);
    add('compaction:prune标记', t, 0, { tokens: d.shadowedTokenCount });
  }
}

const catTotal = Object.values(byCat).reduce((a, b) => a + b, 0);
const inputCats = Object.keys(byCat).filter(k => !k.includes('输出侧'));
const inputTotal = inputCats.reduce((a, k) => a + byCat[k], 0);
const sortCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

const fmt = (n) => n.toLocaleString('en-US');
const pct = (n) => (n / catTotal * 100).toFixed(1) + '%';

const toolRows = Object.entries(toolRes).sort((a, b) => b[1].chars - a[1].chars);
const top = topEvents.sort((a, b) => b.chars - a.chars).slice(0, 20);

let md = `# 00 会话上下文解剖（${new Date().toISOString()}）\n\n`;
md += `来源：\`C:\\Users\\19091\\.dsh\\sessions\\--G-DS-HARNESS--\\session-53ece2c2...\\session.v4.jsonl.zstd\`（24.3 MB 压缩，解压 ${(fs.statSync(SRC).size/1048576).toFixed(1)} MB JSONL）\n\n`;
md += `## 总览\n\n`;
md += `- 事件 ${fmt(events.length)} 条，覆盖 ${days.size} 天（${[...days].sort().join(', ')}）\n`;
md += `- 回合 ${turns.size}，步 ${steps.size}，assistant 消息 ${assistantCount}，工具调用 ${toolCallCount}，工具结果 ${resultCount}\n`;
md += `- 压缩 ${compaction.length} 次，prune 累计 shadowedToken ${fmt(compaction.reduce((a, c) => a + c.pruneTokens, 0))}\n`;
md += `- 内容总字符 ${fmt(catTotal)}（含输出侧 reasoning）\n\n`;
md += `## 按类别（字符占比）\n\n| 类别 | 字符 | 占比 |\n|---|---:|---:|\n`;
for (const [k, v] of sortCats) md += `| ${k} | ${fmt(v)} | ${pct(v)} |\n`;
md += `\n输入侧合计 ${fmt(inputTotal)} 字符（不含 reasoning 与压缩摘要输出）\n\n`;

md += `## 用户/注入消息来源\n\n| 来源 kind | 条数 | 字符 |\n|---|---:|---:|\n`;
for (const [k, v] of Object.entries(userKinds).sort((a, b) => b[1].chars - a[1].chars)) md += `| ${k} | ${v.count} | ${fmt(v.chars)} |\n`;

md += `\n## 工具结果 Top\n\n| 工具 | 次数 | 字符 | 平均 | 单次最大 |\n|---|---:|---:|---:|---:|\n`;
for (const [k, v] of toolRows.slice(0, 20)) md += `| ${k} | ${v.count} | ${fmt(v.chars)} | ${fmt(Math.round(v.chars / v.count))} | ${fmt(v.max)} |\n`;

md += `\n## 每日内容增量（字符）\n\n| 日期 | 合计 | 最大类目 |\n|---|---:|---|\n`;
for (const day of Object.keys(byDay).sort()) {
  const arr = Object.entries(byDay[day]).sort((a, b) => b[1] - a[1]);
  const total = arr.reduce((a, b) => a + b[1], 0);
  md += `| ${day} | ${fmt(total)} | ${arr[0] ? arr[0][0] + ' ' + fmt(arr[0][1]) : ''} |\n`;
}

md += `\n## 单条最大事件 Top20\n\n| 类别 | 字符 | 时间 | 预览 |\n|---|---:|---|---|\n`;
for (const e of top) md += `| ${e.cat} | ${fmt(e.chars)} | ${new Date(e.t + TZ).toISOString().slice(0, 16).replace('T', ' ')} | ${(e.preview || '').replace(/\|/g, '\\|').slice(0, 60)} |\n`;

// 今日（10-25）切片
let todayIn = 0; const todayCats = {};
for (const [k, v] of Object.entries(byDay['2026-10-25'] || {})) { todayCats[k] = v; todayIn += k.includes('输出侧') ? 0 : v; }
md += `\n## 今日（10-25）新增内容\n\n`;
md += `输入侧字符 ${fmt(todayIn)}\n\n| 类别 | 字符 |\n|---|---:|\n`;
for (const [k, v] of Object.entries(todayCats).sort((a, b) => b[1] - a[1]).slice(0, 15)) md += `| ${k} | ${fmt(v)} |\n`;

md += `\n## 压缩事件\n\n| 时间 | summary 字符 | prune tokens |\n|---|---:|---:|\n`;
for (const c of compaction) md += `| ${new Date(c.time + TZ).toISOString().slice(0, 16).replace('T', ' ')} | ${fmt(c.summaryChars)} | ${fmt(c.pruneTokens)} |\n`;

// 固定开销与真实调用对照
const hFirst = headerStats[0], hLast = headerStats[headerStats.length - 1];
md += `\n## 固定开销与真实 token（对照）\n\n`;
if (hLast) md += `- request/header 最近一次：JSON ${fmt(hLast.chars)} 字符，工具 ${hLast.tools} 个（每次调用都随请求发送）\n`;
md += `- 今日（10-25，cost-meter）：678 次调用 / 非缓存输入 934,058 / 缓存读 176,561,407 / 输出 409,037 / 费用 ¥6.10\n`;
md += `- **平均每次调用 prompt ≈ (176,561,407+934,058)/678 ≈ 261,793 tokens**\n`;
md += `- 今日新增唯一内容 ${fmt(todayIn)} 字符 ≈ ${fmt(Math.round(todayIn/1.8))} tokens（按 1.8 字符/token 粗估）\n`;
md += `- 结论：成本 ≈ 每次调用读一遍上下文 × 调用次数；"新增内容"只占很小一部分。\n`;

fs.writeFileSync(OUT, md);
console.log('WROTE', OUT);
console.log('events', events.length, 'chars', catTotal, 'inputChars', inputTotal);
console.log('TOP10');
for (const [k, v] of sortCats.slice(0, 10)) console.log(k, v, pct(v));
console.log('TOOLS');
for (const [k, v] of toolRows.slice(0, 10)) console.log(k, v.count, v.chars);
console.log('TODAY input chars', todayIn);
