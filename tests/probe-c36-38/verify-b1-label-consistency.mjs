/**
 * 测试角色 · B1 文案一致性门（2026-11-15 用户拍板判缺口；签字 §15/§16、常驻 §11）。
 *
 * 判据：保存成功后**主标签**=「本会话·已保存（重启保留）」；若并列运行时层（A1），
 *   必须附注「当前进程内即时生效；重启后从已保存值读回」；**禁止**「重启失效」与「重启保留」同屏；
 *   reset 后文案说明"已清除本会话覆盖、当前生效来自 X"。
 *
 * 断言对象 = **实际渲染文本**（`renderBubbleText` 输出的整段，含来源层 + 生效时点 + 备注 + 写入层），
 *   不是 store/写层字符串本身；另保留两条写层字符串断言做兜底。
 * 手法：vm 里以假 `window.__ModuleLoader__` 加载浏览器半侧 client.js，取 `renderBubbleText` 直接渲染。
 *   不装、不跑 UI、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-b1-label-consistency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const src = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
const labelsSource = fs.readFileSync(path.join(pkg, 'src', 'ui-labels.js'), 'utf8');

try {
  let spec = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { spec = value; } } },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const fakeReact = {
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
  };
  const require2 = (name) => (name === 'react' ? fakeReact : {});
  const client = typeof spec?.factory === 'function' ? spec.factory(require2) : null;
  const render = client?.renderBubbleText;
  check('B1-render-entry-loadable', typeof render === 'function', `renderBubbleText=${typeof render}（vm 加载浏览器半侧）`);

  const text = (snapshot, options) => (typeof render === 'function' ? String(render(snapshot, undefined, options)) : '');
  const saveA1 = text({ at: 0.45, source: 'session:A1' }, { entry: 'session', lastAction: 'save' });
  const saveA2 = text({ at: 0.45, source: 'session:A2' }, { entry: 'session', lastAction: 'save' });
  const idleA1 = text({ at: 0.45, source: 'session:A1' }, { entry: 'session' });
  const resetText = text({ at: 0.58, source: 'plugin' }, { entry: 'session', lastAction: 'reset' });

  // ① 保存成功（原始层 A1）渲染：主标签必须是"已保存（重启保留）"，且不得出现"重启失效"
  check('B1-save-success-main-label-saved',
    saveA1.includes('本会话·已保存（重启保留）') && !/来源层:[^\n]*重启失效/.test(saveA1),
    `渲染=${JSON.stringify(saveA1.split('\n').slice(0, 3))}`);

  // ② 负向：同屏不得同时出现「重启失效」与「重启保留」
  const bothInSave = saveA1.includes('重启失效') && saveA1.includes('重启保留');
  check('B1-save-success-no-contradiction', bothInSave === false,
    `含 重启失效=${saveA1.includes('重启失效')} 含 重启保留=${saveA1.includes('重启保留')}（期望不同时出现）`);

  // ③ 并列运行时层时必须有附注：重启后从已保存值读回
  check('B1-runtime-layer-note-present', saveA1.includes('重启后从已保存值读回'),
    `备注行=${JSON.stringify(saveA1.split('\n').filter((line) => line.includes('备注')))}`);

  // ④ A2 保存渲染：不得出现"重启失效"
  check('B1-save-success-a2-no-expiry-wording', saveA2.includes('重启保留') && !saveA2.includes('重启失效'),
    `渲染=${JSON.stringify(saveA2.split('\n').slice(0, 3))}`);

  // ⑤ 非保存态（仅运行时层 A1 展示）：允许显示"临时（重启失效）"，但不得同时出现"重启保留"
  check('B1-idle-a1-allows-runtime-label-only',
    idleA1.includes('重启失效') ? !idleA1.includes('重启保留') : true,
    `idle=${JSON.stringify(idleA1.split('\n').slice(0, 3))}（允许临时口径，但不得与保留并列）`);

  // ⑥ reset 渲染：说明已清除覆盖 + 当前生效来自 X，不得出现"重启失效"
  check('B1-reset-render', resetText.includes('已清除本会话覆盖') && !resetText.includes('重启失效'),
    `渲染=${JSON.stringify(resetText.split('\n').slice(0, 3))}`);

  // ⑦ 兜底：A1 写层字符串自身不得出现"重启失效"
  const a1Layer = (src.match(/writeLayerSessionA1:\s*'([^']+)'/) ?? [])[1] ?? '';
  check('B1-write-layer-string-fallback', a1Layer.includes('重启保留') && !a1Layer.includes('重启失效'),
    `writeLayerSessionA1=${JSON.stringify(a1Layer)}`);

  // ⑧ 主标签：ui-labels 的 session:A2 = 已保存（重启保留）
  const savedLabel = (labelsSource.match(/'session:A2':\s*'([^']+)'/) ?? [])[1] ?? '';
  check('B1-ui-labels-saved-literal', savedLabel.includes('已保存') && savedLabel.includes('重启保留'),
    `ui-labels session:A2=${JSON.stringify(savedLabel)}`);

  console.log('INFO B1-real-machine :: 保存后主标签需真机截图核对（装机窗口），离线已按实际渲染文本断言');
} catch (error) {
  check('B1-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nB1 渲染组合文案门 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
