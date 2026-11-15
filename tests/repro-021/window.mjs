#!/usr/bin/env node
// Print a window of app.asar text around the first occurrence of a needle.
import fs from 'node:fs';

const file = 'C:/Users/19091/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const needle = process.argv[2];
const before = Number(process.argv[3] || 1000);
const after = Number(process.argv[4] || 3000);
const nth = Number(process.argv[5] || 1);
const b = fs.readFileSync(file);
const n = Buffer.from(needle, 'utf8');
let idx = -1;
for (let k = 0; k < nth; k++) { idx = b.indexOf(n, idx + 1); if (idx === -1) break; }
if (idx === -1) { console.error('not found'); process.exit(1); }
const s = Math.max(0, idx - before);
const e = Math.min(b.length, idx + after);
let t = '';
for (let k = s; k < e; k++) {
  const x = b[k];
  t += (x >= 32 && x < 127) || x === 10 || x === 9 ? String.fromCharCode(x) : '.';
}
console.log(t);
