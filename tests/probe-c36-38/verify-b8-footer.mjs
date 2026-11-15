/**
 * 开发自测 · B8+B9+B10（rc.16）「操作区常驻 + 无校正环」合并门（只此一条）。
 *
 * B8：wrapper 只给 maxHeight 无确定 height → 面板按自然高度长、穿出窗口下沿被裁（按钮不可见/滚不动）。
 * B9：百分比输入框 + `%` 必须与四按钮同处常驻 footer；footer ≤88、内容区保底 96、高度全实测且带下限。
 * B10：校正 effect 必须有收敛保护（0×0 不校正 / 每次打开只校一次 / 同值返回 prev），否则无限重渲染。
 *
 * 用法：node tests\probe-c36-38\verify-b8-footer.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const src = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
const idx = (token) => src.indexOf(token);

// ---------- ① 静态：结构 ----------
const footerAt = idx("'data-cg-footer'");
const afterFooter = footerAt < 0 ? '' : src.slice(footerAt);
const inFooter = (token) => afterFooter.indexOf(token);
const inputAt = inFooter("'aria-label': labels.percent");
const saveAt = inFooter('saving ? labels.saving : saved ? labels.saved : labels.save');
const resetAt = inFooter("labels.resetGlobal ?? '恢复全局设置'");
const restoreAt = inFooter('${labels.restore} ${model.defaultPercent}%');
const settingsAt = inFooter("className: 'cg-at-settings-link'"); // B12：应为 -1（按钮已删）
const detailToggleAt = idx("className: 'cg-detail-toggle'");
check('B12-footer-has-input-and-3-buttons',
  footerAt > 0 && inputAt > 0 && saveAt > 0 && resetAt > 0 && restoreAt > 0,
  `footer@${footerAt} 之内 input@${inputAt} save@${saveAt} reset@${resetAt} restore@${restoreAt}`);
check('B12-settings-button-removed', settingsAt === -1,
  `'打开设置页' 按钮偏移=${settingsAt}（应为 -1：用户要求删除，设置页仍从 DSH 设置进入）`);
check('B9-detail-toggle-stays-in-body', detailToggleAt > 0 && detailToggleAt < footerAt,
  `detail-toggle@${detailToggleAt} < footer@${footerAt}`);
check('B11-footer-wrap-allowed',
  /popoverFooter:[^}]*flexWrap: 'wrap'/.test(src),
  'B11：允许换排（wrap），不是固定的两排结构');
check('B11-footer-never-clips',
  /popoverFooter:[^}]*flexWrap: 'wrap'/.test(src)
  && !/popoverFooter:[^}]*overflow: 'hidden'/.test(src)
  && !/popoverFooter:[^}]*maxHeight/.test(src),
  'B11：footer 不得用 overflow:hidden / maxHeight 兜底裁控件；换排即可');
check('B11-footer-input-narrow',
  /popoverFooterInput:[^}]*width: 56/.test(src)
  && /popoverFooterInput:[^}]*flex: '0 0 56px'/.test(src)
  && /popoverFooterButton:[^}]*flex: '0 0 auto'/.test(src)
  && /popoverFooterButton:[^}]*whiteSpace: 'nowrap'/.test(src),
  'B11：输入框固定 56px 不增长；按钮 0 0 auto + nowrap（不压缩不折行）');
check('B11-body-floor-dynamic',
  /computeBodyFloor/.test(src) && /minHeight: bodyMin/.test(src) && !/popoverBody:\s*\{[^}]*minHeight:\s*96/.test(src),
  '内容区保底必须动态（computeBodyFloor → bodyMin），不得写死 96（否则 footer 变大时顶穿面板）');
check('B9-wrapper-fixed-height',
  /height:\s*`\$\{layout\.height\}px`/.test(src) && /overflow:\s*'hidden'/.test(src),
  'wrapper px 高度 + overflow:hidden');
check('B9-panel-max-height-100', /maxHeight:\s*'100%'/.test(src), '面板 maxHeight:100%');
check('B9-hit-chain', /pointerEvents:\s*'none'/.test(src) && /pointerEvents:\s*'auto'/.test(src),
  'wrapper:none → panel:auto');
check('B9-height-measured-not-hardcoded',
  /getComputedStyle/.test(src) && /paddingTop/.test(src) && !/96 \+ lines\.length \* 22 \+ 64/.test(src),
  '高度读 computed padding/border/gap，且不再有 96+行数*22+64 猜测式');

// ---------- ① 静态：B10 环保护 ----------
check('B10-uncorrectable-skip', /Number\(rect\.width\) < 1/.test(src) && /Number\(rect\.height\) < 1/.test(src),
  '0×0（未布局/隐藏）时不得校正');
check('B10-correct-once-per-open', /correctedOnceRef/.test(src) && /correctedOnceRef\.current = false/.test(src),
  '每次打开重置、只校正一次');
check('B10-same-rect-keeps-prev', /setLayout\(\(prev\) => \(samePopoverRect\(prev, corrected\) \? prev : corrected\)\)/.test(src),
  '同值返回 prev，避免无意义重渲染');

// ---------- ② vm：结构与纯函数 ----------
const sandbox = { window: { __ModuleLoader__: { load: (spec) => { sandbox.__spec = spec; } } }, console, setTimeout, clearTimeout, document: { body: {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
};
const client = sandbox.__spec.factory((name) => {
  if (name === 'react') return fakeReact;
  if (name === 'react-dom') return { createPortal: (node, container) => ({ __portal: true, node, container }) };
  return {};
});
const store = { value: { open: true, snapshot: { at: 0.45, source: 'session:A1', defaultAt: 0.45 } }, subscribe: () => () => {}, set() {}, get() { return this.value; } };
const Bubble = client.createBubble({ snapshot: store.value.snapshot, open: true }, store, { get: () => undefined });
const tree = Bubble({ sessionId: 'session-b9', session: { id: 'session-b9' } });
const wrapperNode = tree?.__portal === true ? tree.node : tree;
const dialogNode = Array.isArray(wrapperNode?.props?.children) ? wrapperNode.props.children[0] : wrapperNode?.props?.children;
const kids = Array.isArray(dialogNode?.props?.children) ? dialogNode.props.children : [dialogNode?.props?.children];
const bodyNode = kids.find((child) => child?.props?.['data-cg-body'] === '1');
const footNode = kids.find((child) => child?.props?.['data-cg-footer'] === '1');
check('B9-vm-footer-sibling-of-body', bodyNode !== undefined && footNode !== undefined,
  `body=${bodyNode !== undefined} footer=${footNode !== undefined}`);

const findNode = (node, predicate) => {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  const children = node?.props?.children;
  const list = Array.isArray(children) ? children : (children === undefined ? [] : [children]);
  for (const child of list) {
    const hit = findNode(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
};
const isInput = (node) => node?.props?.type === 'text' && node?.props?.['aria-label'] !== undefined;
check('B9-vm-input-lives-in-footer',
  findNode(footNode, isInput) !== null && findNode(bodyNode, isInput) === null,
  '输入框在 footer 内、不在 body 内');
const footerText = JSON.stringify(footNode ?? {});
check('B12-vm-three-buttons-in-footer',
  ['保存到本会话', '恢复默认', '恢复全局设置'].every((label) => footerText.includes(label))
  && footerText.includes('打开设置页') === false,
  `三按钮在 footer=${['保存到本会话', '恢复默认', '恢复全局设置'].map((label) => footerText.includes(label)).join('/')} 含打开设置页=${footerText.includes('打开设置页')}`);

// ---------- ③ 几何 + 高度算法 ----------
const rect = client.computePopoverRect({
  chip: { x: 600, y: 500, width: 80, height: 26 },
  panel: { width: 320, height: 400 },
  viewport: { width: 900, height: 594 },
  input: { x: 120, y: 520, width: 660, height: 36 },
});
const overlapY = rect.top < 520 + 36 && rect.top + rect.height > 520;
const overlapX = rect.left < 120 + 660 && rect.left + rect.width > 120;
check('B9-geometry-clamped-and-no-composer-overlap',
  rect.height <= 260 && rect.top >= 8 && rect.left >= 8
  && rect.top + rect.height <= 594 - 8 && rect.left + rect.width <= 900 - 8
  && !(overlapX && overlapY),
  `rect=${JSON.stringify(rect)}`);

const floorHeight = client.computePopoverHeight({ bodyScroll: 40, footerHeight: 88, chrome: 44 });
const tallHeight = client.computePopoverHeight({ bodyScroll: 900, footerHeight: 88, chrome: 44 });
check('B9-low-content-floor', floorHeight >= 96 + 88 + 44 && floorHeight <= 260,
  `height=${floorHeight}（内容少时 ≥ ${96 + 88 + 44}，否则 footer 被裁）`);
check('B9-high-content-capped', tallHeight === 260, `height=${tallHeight}（超高封顶 260）`);
check('B9-footer-inside-panel', floorHeight >= 96 + 88 + 44 && tallHeight >= 96 + 88 + 44,
  '两种情形 footer.bottom ≤ panel.bottom 的等价条件均成立');
check('B9-layout-budget', 96 + 88 + 44 <= 260, '96 + 88 + 44 = 228 ≤ 260');

const sameRect = client.samePopoverRect(
  { left: 10, top: 20, width: 320, height: 228, placement: 'up' },
  { left: 10.6, top: 19.5, width: 320, height: 228, placement: 'up' },
);
const diffRect = client.samePopoverRect(
  { left: 10, top: 20, width: 320, height: 228, placement: 'up' },
  { left: 40, top: 60, width: 320, height: 228, placement: 'up' },
);
const extremeFooter = 5 * 30 + 4 * 8; // 5 排（每控件独占一行）≈182
const extremeHeight = client.computePopoverHeight({ bodyScroll: 0, footerHeight: extremeFooter, chrome: 44 });
const extremeFloor = client.computeBodyFloor({ footerHeight: extremeFooter, chrome: 44 });
check('OPS-footer-extreme-narrow-no-clip',
  extremeHeight === 260 && extremeFooter + 44 + extremeFloor <= 260 && extremeFloor === 260 - extremeFooter - 44,
  `footer=${extremeFooter} bodyFloor=${extremeFloor} height=${extremeHeight}（footer 完整、面板不溢出、内容区让位滚动）`);
check('B11-normal-footer-floor-96', client.computeBodyFloor({ footerHeight: 88, chrome: 44 }) === 96,
  '常规 footer(88) 时内容区保底仍为 96');

check('B10-same-rect-semantics', sameRect === true && diffRect === false,
  `same=${sameRect} diff=${diffRect}（≤1px 视为同一个）`);

const failed = results.filter((item) => !item.ok);
console.log(`\nB8/B9/B10 操作区常驻+环保护门 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
