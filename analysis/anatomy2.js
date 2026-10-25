// 解剖补充：工具参数/工具定义/最大工具结果
const fs = require('fs');
const path = require('path');
const SRC = path.join(process.env.TEMP, 'dsh-00-session.jsonl');
const lines = fs.readFileSync(SRC, 'utf8').split('\n').filter(Boolean);
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }
const TZ = 8 * 3600 * 1000;
const fmt = (n) => n.toLocaleString('en-US');

const callNames = new Map();
const argByName = {};
const resByName = {};
const bigResults = [];
let lastHeader = null;
for (const ev of events) {
  const d = ev.data || {};
  if (ev.type === 'tool/call') {
    callNames.set(d.callId, d.name);
    const n = d.name || '?'; argByName[n] = argByName[n] || { count: 0, chars: 0, max: 0, maxSample: '' };
    const a = d.arguments || '';
    argByName[n].count++; argByName[n].chars += a.length;
    if (a.length > argByName[n].max) { argByName[n].max = a.length; argByName[n].maxSample = a.slice(0, 120); }
  } else if (ev.type === 'tool/result') {
    const n = callNames.get(d.message && d.message.toolCallId) || '?';
    const text = ((d.message && d.message.content) || []).map(p => p.text || '').join('');
    resByName[n] = resByName[n] || { count: 0, chars: 0 };
    resByName[n].count++; resByName[n].chars += text.length;
    bigResults.push({ name: n, chars: text.length, t: ev.time, sample: text.slice(0, 100) });
  } else if (ev.type === 'request/header') { lastHeader = ev.data.header; }
}

const rows = Object.entries(argByName).sort((a, b) => b[1].chars - a[1].chars).slice(0, 15);
console.log('== TOOL CALL ARGS TOP ==');
for (const [k, v] of rows) console.log(`${k}\t${v.count}\t${v.chars}\tmax=${v.max}`);

console.log('\n== TOOL DEFINITION SIZE TOP (last header, tools=' + ((lastHeader?.tools) || []).length + ') ==');
const defs = (lastHeader?.tools || []).map(t => ({ name: t.name, chars: JSON.stringify(t).length })).sort((a, b) => b.chars - a.chars);
let total = 0; for (const x of defs) total += x.chars;
console.log('total tool defs chars', total);
for (const x of defs.slice(0, 15)) console.log(`${x.name}\t${x.chars}`);

console.log('\n== BIGGEST TOOL RESULTS ==');
bigResults.sort((a, b) => b.chars - a.chars);
for (const x of bigResults.slice(0, 10)) console.log(`${x.name}\t${x.chars}\t${new Date(x.t + TZ).toISOString().slice(0, 16)}\t${x.sample.replace(/\n/g, ' ').slice(0, 70)}`);

// 今日回合/步数
const todayStart = new Date('2026-10-25T00:00:00+08:00').getTime();
let turns = 0, steps = 0;
for (const ev of events) {
  if ((ev.time || 0) < todayStart) continue;
  if (ev.type === 'turn/start') turns++;
  if (ev.type === 'step/start') steps++;
}
console.log('\nTODAY turns', turns, 'steps', steps);
