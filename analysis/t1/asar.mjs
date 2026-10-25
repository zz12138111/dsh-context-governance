// Minimal ASAR reader for read-only host inspection (no extraction of the whole archive).
// Usage:
//   node analysis/t1/asar.mjs list [prefix] [depth]
//   node analysis/t1/asar.mjs cat <path>
//   node analysis/t1/asar.mjs grep <regex> [prefix]
//   node analysis/t1/asar.mjs extract <destDir> <prefix>   (all files under prefix)
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'C:\\Users\\19091\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';
const fd = fs.openSync(ASAR, 'r');
const first = Buffer.alloc(16);
fs.readSync(fd, first, 0, 16, 0);
const headerSize = first.readUInt32LE(4);
const jsonSize = first.readUInt32LE(8);
const jsonStart = 16;
const dataStart = 8 + headerSize;
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, jsonStart);
const jsonText = jsonBuf.toString('utf8').replace(/\0+$/, '');
const jsonEnd = jsonText.lastIndexOf('}');
const tree = JSON.parse(jsonText.slice(0, jsonEnd + 1));

function getNode(p) {
  const parts = p.split('/').filter(Boolean);
  let node = tree;
  for (const part of parts) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

function readFile(p) {
  const node = getNode(p);
  if (!node || node.files) throw new Error('not a file: ' + p);
  if (node.unpacked) {
    const full = path.join(path.dirname(ASAR), 'app.asar.unpacked', p);
    return fs.readFileSync(full);
  }
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
  return buf;
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, p, out);
    else out.push({ path: p, size: child.size, unpacked: !!child.unpacked });
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') {
  const prefix = args[0] || '';
  const depth = Number(args[1] || 2);
  const node = getNode(prefix);
  if (!node) { console.error('missing ' + prefix); process.exit(1); }
  const base = prefix.split('/').filter(Boolean).length;
  const rec = (n, p, d) => {
    for (const [name, child] of Object.entries(n.files || {})) {
      const cp = p + '/' + name;
      if (child.files) {
        console.log('d ' + '  '.repeat(d) + cp + '/');
        if (d + 1 < depth) rec(child, cp, d + 1);
      } else {
        console.log('f ' + '  '.repeat(d) + cp + '  ' + child.size);
      }
    }
  };
  rec(node, prefix, 0);
} else if (cmd === 'cat') {
  const data = readFile(args[0]);
  process.stdout.write(data);
} else if (cmd === 'grep') {
  const re = new RegExp(args[0], 'i');
  const prefix = args[1] || '';
  const files = [];
  walk(getNode(prefix), prefix, files);
  let total = 0;
  for (const f of files) {
    if (f.size > 5_000_000) continue; // skip minified bundles > 5MB
    let text;
    try { text = readFile(f.path).toString('utf8'); } catch { continue; }
    const lines = text.split('\n');
    const hits = [];
    lines.forEach((line, i) => { if (re.test(line)) hits.push([i + 1, line.trim().slice(0, 300)]); });
    if (hits.length) {
      total += hits.length;
      console.log('== ' + f.path + ' (' + hits.length + ')');
      for (const [n, line] of hits.slice(0, 20)) console.log('  ' + n + ': ' + line);
    }
  }
  console.error('hits=' + total + ' files=' + files.length);
} else if (cmd === 'extract') {
  const dest = args[0]; const prefix = args[1];
  const files = [];
  walk(getNode(prefix), prefix, files);
  let n = 0;
  for (const f of files) {
    const target = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readFile(f.path));
    n++;
  }
  console.log('extracted ' + n + ' files to ' + dest);
} else {
  console.error('unknown cmd');
  process.exit(1);
}
fs.closeSync(fd);
