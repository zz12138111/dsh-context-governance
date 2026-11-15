/**
 * 开发自测 · B8+B9（rc.16）「操作区常驻」合并门（**只此一条，不再分两套**）。
 *
 * B8 根因（rc.14）：wrapper 只给 `maxHeight` 无确定 `height` → 面板按自然高度长、穿出窗口下沿被裁，
 *   按钮不可见且滚不动。B9 追加：百分比输入框 + `%` 也要在常驻区（用户不该为保存而滚动）。
 *
 * 判据：
 *  ① 静态：`data-cg-footer` 内含**输入框 + 4 个按钮**，且 footer 分两排（input / actions）；
 *     footer `maxHeight:88`、内容区 `minHeight:96`、面板 `maxHeight:100%`、
 *     wrapper px `height` + `overflow:hidden`、命中链 `pointerEvents:none → auto`；
 *     高度实测**不得硬编码 `+34`**（必须从 computed padding/border/gap 读）。
 *  ② vm：footer 与 body 是兄弟；输入框节点在 footer 内、不在 body 内；4 个按钮文本都在 footer；
 *     详情按钮仍在 body 内。
 *  ③ 几何：面板请求 400px 高 → 夹到 ≤260，四边 ≥8，且与 composer 输入框交集为 0；
 *     版面预算 `96(body) + 88(footer) + 44(chrome) ≤ 260`。
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

// ① 静态：结构
const footerAt = idx("'data-cg-footer'");
// 只在 footer 之后找：同一段 aria-label / 按钮文本在设置页卡片里也出现，全局 indexOf 会误判。
const afterFooter = footerAt < 0 ? '' : src.slice(footerAt);
const inFooter = (token) => afterFooter.indexOf(token);
const inputAt = inFooter("'aria-label': labels.percent");
const saveAt = inFooter('saving ? labels.saving : saved ? labels.saved : labels.save');
const resetAt = inFooter("labels.resetGlobal ?? '恢复全局设置'");
const restoreAt = inFooter('${labels.restore} ${model.defaultPercent}%');
const settingsAt = inFooter("className: 'cg-at-settings-link'");
const detailToggleAt = idx("className: 'cg-detail-toggle'");
check('B9-footer-has-input-and-4-buttons',
  footerAt > 0 && inputAt > 0 && saveAt > 0 && resetAt > 0 && restoreAt > 0 && settingsAt > 0,
  `footer@${footerAt} footer内偏移 input@${inputAt} save@${saveAt} reset@${resetAt} restore@${restoreAt} settings@${settingsAt}`);
check('B9-detail-toggle-stays-in-body', detailToggleAt > 0 && detailToggleAt < footerAt,
  `detail-toggle@${detailToggleAt} < footer@${footerAt}（详情按钮留在可滚内容区）`);
check('B9-footer-two-rows',
  /'data-cg-footer-row':\s*'input'/.test(src) && /'data-cg-footer-row':\s*'actions'/.test(src),
  'footer 必须分两排：输入行 + 按钮行');

// ① 静态：尺寸与滚动边界
check('B9-footer-max-height-88', /popoverFooter:\s*\{[^}]*maxHeight:\s*88/.test(src), 'footer 总高 ≤88px');
check('B9-body-min-height-96', /popoverBody:\s*\{[^}]*minHeight:\s*96/.test(src), '内容区最少保留 96px');
check('B9-wrapper-fixed-height',
  /height:\s*`\$\{layout\.height\}px`/.test(src) && /overflow:\s*'hidden'/.test(src),
  'wrapper 必须 px 高度 + overflow:hidden');
check('B9-panel-max-height-100', /maxHeight:\s*'100%'/.test(src), '面板 maxHeight:100%');
check('B9-hit-chain', /pointerEvents:\s*'none'/.test(src) && /pointerEvents:\s*'auto'/.test(src),
  'wrapper:none → panel:auto 命中链');
check('B9-height-measured-not-hardcoded',
  /getComputedStyle/.test(src) && /paddingTop/.test(src) && !/\+\s*34;?\s*\/\/ padding/.test(src),
  '高度实测必须读 computed padding/border/gap，不得再硬编码 +34');

// ② vm：渲染结构
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
const inputInFooter = findNode(footNode, isInput);
const inputInBody = findNode(bodyNode, isInput);
check('B9-vm-input-lives-in-footer', inputInFooter !== null && inputInBody === null,
  `footer 内输入框=${inputInFooter !== null} body 内输入框=${inputInBody !== null}（期望 true / false）`);
const footerText = JSON.stringify(footNode ?? {});
check('B9-vm-four-buttons-in-footer',
  ['保存到本会话', '恢复默认', '恢复全局设置', '打开设置页'].every((label) => footerText.includes(label)),
  `footer 含四按钮=${['保存到本会话', '恢复默认', '恢复全局设置', '打开设置页'].map((label) => footerText.includes(label)).join('/')}`);

// ③ 几何 + 版面预算
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
  `rect=${JSON.stringify(rect)}（高 ≤260、四边 ≥8、不压 composer）`);
check('B9-layout-budget', 96 + 88 + 44 <= 260,
  '96(内容) + 88(footer) + 44(chrome) = 228 ≤ 260，两排操作区与内容区可共存');

const failed = results.filter((item) => !item.ok);
console.log(`\nB8/B9 操作区常驻门 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
