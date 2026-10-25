const fs = require('fs');
const p = process.env.TEMP + '\\dsh-00-session.jsonl';
const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
const events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }
const todayStart = new Date('2026-10-25T00:00:00+08:00').getTime();

function dist(from) {
  const per = new Map();
  for (const ev of events) {
    if ((ev.time || 0) < from) continue;
    if (ev.type !== 'tool/call') continue;
    const d = ev.data || {};
    const key = d.turn + ':' + d.step;
    per.set(key, (per.get(key) || 0) + 1);
  }
  const counts = {};
  for (const v of per.values()) counts[v] = (counts[v] || 0) + 1;
  return { steps: per.size, calls: [...per.values()].reduce((a, b) => a + b, 0), counts };
}
console.log('ALL', JSON.stringify(dist(0)));
console.log('TODAY', JSON.stringify(dist(todayStart)));
