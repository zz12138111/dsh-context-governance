const fs = require('fs');
const p = process.argv[2];
let s = fs.readFileSync(p, 'utf8');
const i = s.indexOf('{"objects"');
if (i < 0) { console.log('no json found'); process.exit(0); }
s = s.slice(i);
let j;
try { j = JSON.parse(s); } catch (e) { console.log('parse fail', e.message); process.exit(1); }
const re = /(compact|memory|context|mnemon|recall|summar|history|archive)/i;
const hits = j.objects.map(o => o.package).filter(pk => re.test(pk.name + ' ' + (pk.description || '')));
console.log('total', j.objects.length, 'hits', hits.length);
for (const pk of hits) {
  console.log([pk.name, pk.version, (pk.description || '').replace(/\s+/g, ' ').slice(0, 180)].join(' | '));
}
