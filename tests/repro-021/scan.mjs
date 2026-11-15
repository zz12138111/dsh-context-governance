#!/usr/bin/env node
// Scan a binary file for a UTF-8 needle and print surrounding context as text (printable runs).
import fs from 'node:fs';

const file = process.argv[2];
const needle = process.argv[3];
const before = Number(process.argv[4] || 600);
const after = Number(process.argv[5] || 600);
const maxHits = Number(process.argv[6] || 10);
const buf = fs.readFileSync(file);
const nb = Buffer.from(needle, 'utf8');
let idx = -1, hits = 0;
while ((idx = buf.indexOf(nb, idx + 1)) !== -1 && hits < maxHits) {
  hits++;
  const s = Math.max(0, idx - before);
  const e = Math.min(buf.length, idx + nb.length + after);
  // printable-ish rendering
  let out = '';
  for (let i = s; i < e; i++) {
    const b = buf[i];
    out += (b >= 32 && b < 127) || b === 10 || b === 9 ? String.fromCharCode(b) : (b >= 128 ? '~' : '.');
  }
  console.log(`\n===== hit ${hits} at ${idx} =====`);
  console.log(out);
}
console.log(`\ntotal hits shown: ${hits}`);
