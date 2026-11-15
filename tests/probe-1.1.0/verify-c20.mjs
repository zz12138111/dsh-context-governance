/**
 * 测试角色 · 1.1.0 D2 离线契约探针（C20 客户端订阅/状态守卫）。
 * 判据：REQUIREMENTS.md（2026-11-15 新增，`3d209f3`；第 3 次预验第二真因后补）。
 *
 * 第二真因：三个组件 `useEffect(() => store.subscribe(...)())` —— 订阅后立即退订，
 * 快照写入 store 后无监听者 → chip 永远 `压 —`；open 与 snapshot 混一个 state → 气泡打不开。
 * C20：①静态守卫：lib/client.js 不得出现 subscribe(<args>)() 立即调用；②snapshot/open 必须独立 state；
 *      ③真机：保存/刷新后 chip 数值随动（本探针只做①②，③由真机窗口判）。
 *
 * 运行：node tests\probe-1.1.0\verify-c20.mjs
 */
import fs from 'node:fs/promises';

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}

const source = await fs.readFile('packages/dsh-context-governance/lib/client.js', 'utf8');
const lines = source.split(/\r?\n/);

// ── C20①：不得出现 subscribe(...)() 立即调用（订阅后立刻退订的经典写法） ──
const subscribeCallLines = lines
  .map((text, index) => ({ text, line: index + 1 }))
  .filter((item) => /\.subscribe\s*\(/.test(item.text));
const immediateUnsubscribe = subscribeCallLines.filter((item) => /\.subscribe\s*\([^]*\)\s*\(\s*\)/.test(item.text)
  || /\)\s*\(\s*\)\s*;?\s*$/.test(item.text));
// 单行正则之外，再检查跨行写法：subscribe(...) 之后紧跟 `)()`（在下一条语句开头）
for (let index = 0; index < lines.length; index += 1) {
  if (/\.subscribe\s*\(/.test(lines[index]) && /\)\s*\(\s*\)/.test(lines[index + 1] ?? '')) {
    immediateUnsubscribe.push({ text: `${lines[index]} ${lines[index + 1]}`, line: index + 1 });
  }
}
check('C20-no-immediate-unsubscribe', immediateUnsubscribe.length === 0,
  `subscribe 调用行=${JSON.stringify(subscribeCallLines.map((item) => item.line))} 立即调用命中=${JSON.stringify(immediateUnsubscribe.map((item) => item.line))}`);

// ── C20②：snapshot / open 必须独立 state（不得混一个对象） ──
const snapshotStates = (source.match(/useState\(state\.snapshot\)/g) ?? []).length;
const openStates = (source.match(/useState\(state\.open\)/g) ?? []).length;
const combinedState = /useState\(\s*\{\s*snapshot\s*:/.test(source) || /useState\(\s*\{\s*[^}]*open\s*:/.test(source);
check('C20-independent-state', snapshotStates >= 2 && openStates >= 2 && combinedState === false,
  `useState(state.snapshot)=${snapshotStates} useState(state.open)=${openStates} 混用对象=${combinedState}`);

// ── C20③（静态补充）：订阅回调必须分别 setView/setOpen，effect 返回退订函数 ──
const setBoth = /store\.subscribe\(\(next\) => \{\s*setView\(next\.snapshot\);\s*setOpen\(next\.open\);\s*\}\)/.test(source.replace(/\s+/g, ' '))
  || (source.match(/setView\(next\.snapshot\)/g) ?? []).length >= 1 && (source.match(/setOpen\(next\.open\)/g) ?? []).length >= 2;
check('C20-effect-sets-both', setBoth,
  `setView(next.snapshot) 命中=${(source.match(/setView\(next\.snapshot\)/g) ?? []).length} setOpen(next.open) 命中=${(source.match(/setOpen\(next\.open\)/g) ?? []).length}`);

const failed = results.filter((item) => !item.ok);
console.log(`\nC20 TOTAL ${results.length - failed.length}/${results.length} PASS（修复落地前预期为基线红）`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
