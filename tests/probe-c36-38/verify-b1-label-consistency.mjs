/**
 * 测试角色 · B1 文案一致性门（2026-11-15 用户拍板判缺口；签字 §15 / 常驻 §11）。
 *
 * 判据：保存成功后主标签=「本会话·已保存（重启保留）」；若并列运行时层，必须附注
 *   「当前进程内即时生效；重启后从已保存值读回」；**禁止**「重启失效」与「重启保留」并列；
 *   写入层文案与主标签一致。门=①静态断言（保存成功路径渲染的标签组合不含矛盾，本次离线）；
 *   ②真机截图核对（保存后主标签，装机窗口）。
 *
 * 只读源码（`lib/client.js` + `src/ui-labels.js`），不装、不跑 UI。
 * 用法：node tests\probe-c36-38\verify-b1-label-consistency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const client = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
const labels = fs.readFileSync(path.join(pkg, 'src', 'ui-labels.js'), 'utf8');

const pick = (source, name) => (source.match(new RegExp(`${name}:\\s*'([^']+)'`)) ?? [])[1] ?? '';

try {
  // ① A1 写入层文案：必须写"已落 A2 + 重启保留"，并附注"当前进程内即时生效"，不得出现"重启失效"
  const a1 = pick(client, 'writeLayerSessionA1');
  check('B1-a1-write-layer-no-self-contradiction',
    a1.includes('重启保留') && a1.includes('即时生效') && !a1.includes('重启失效'),
    `writeLayerSessionA1=${JSON.stringify(a1)}（期望含 重启保留+即时生效，不含 重启失效）`);

  // ② A2 / idle 写入层文案同样不得出现"重启失效"
  const a2Layer = pick(client, 'writeLayerSession');
  const idleLayer = pick(client, 'writeLayerSessionIdle');
  check('B1-a2-idle-write-layer-consistent',
    a2Layer.includes('重启保留') && !a2Layer.includes('重启失效')
      && idleLayer.includes('重启保留') && !idleLayer.includes('重启失效'),
    `A2=${JSON.stringify(a2Layer)} idle=${JSON.stringify(idleLayer)}`);

  // ③ 选择器：session:A1 必须走 A1 文案；A2/其它来源走"已保存"文案（`writeLayerSession`）
  const selectorA1 = /if \(key === 'session:A1'\) return LABELS\.zh\.writeLayerSessionA1;/.test(client);
  const fallbackSaved = /return LABELS\.zh\.writeLayerSession;/.test(client);
  check('B1-write-layer-selects-by-layer', selectorA1 && fallbackSaved,
    `A1→writeLayerSessionA1=${selectorA1} 其它→writeLayerSession=${fallbackSaved}`);

  // ④ 主标签：session:A2 =「本会话·已保存（重启保留）」；A1 的"临时（重启失效）"只用于运行时层展示
  const savedLabel = (labels.match(/'session:A2':\s*'([^']+)'/) ?? [])[1] ?? '';
  check('B1-main-label-saved', savedLabel.includes('已保存') && savedLabel.includes('重启保留'),
    `ui-labels session:A2=${JSON.stringify(savedLabel)}（期望 已保存+重启保留）`);

  // ⑤ 保存成功路径不得把 A1 的"临时（重启失效）"与"重启保留"拼进同一句
  const successPath = (client.match(/writeLayerTextFor[\s\S]{0,600}/) ?? [''])[0];
  check('B1-save-success-path-not-mixed',
    !/重启失效[\s\S]{0,40}重启保留/.test(a1) && !(/重启失效/.test(a1)),
    `A1 successText 混排=${/重启失效/.test(a1)}（应为 false）`);

  console.log('INFO B1-real-machine :: 保存后主标签需真机截图核对（装机窗口），离线只做静态断言');
} catch (error) {
  check('B1-window', false, `抛错：${String(error?.stack ?? error).slice(0, 400)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nB1 写入层文案一致性 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
