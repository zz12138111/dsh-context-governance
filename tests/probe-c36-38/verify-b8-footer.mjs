/**
 * 开发自测 · B8（rc.15）「按钮常驻」门：footer 不在滚动区内 + 高度定值 + 不越界。
 *
 * 真机 rc.14：面板按钮行不可见（点详情后更糟）、"点不动"。
 * 根因（审核代码确证）：wrapper 只给 `maxHeight` 没有确定 `height` → 面板 `maxHeight:100%`
 * 解析为 none → 面板按自然高度长（~290px），而 `layout.height` 是猜的 226 → 面板穿过窗口下沿
 * 被裁、且内部无滚动余量。
 *
 * 判据：
 *  ① 静态：内容区 `data-cg-body` 带 `overflowY:auto` + `minHeight:0`；`data-cg-footer` 带
 *     `flex:0 0 auto`；保存/恢复/设置按钮都在 footer 内；wrapper 有 px `height`；面板 `maxHeight:100%`；
 *  ② vm：渲染出的树上，footer 是 dialog 的**直接子节点且不含在 body 内**；保存按钮文本在 footer 里；
 *     面板 `pointerEvents:auto`（命中链不断）；
 *  ③ 几何：面板请求高度 >260 时被夹到 260，且 `top+height ≤ vh−8`、四边 ≥8。
 *
 * 用法：node tests\probe-c36-38\verify-b8-footer.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const src = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');

// ① 静态
check('B8-static-body-scrollable',
  /popoverBody:\s*\{[^}]*overflowY:\s*'auto'[^}]*\}/.test(src) && /popoverBody:\s*\{[^}]*minHeight:\s*0/.test(src),
  'popoverBody 必须 overflowY:auto + minHeight:0（flex 子项可滚动的前提）');
check('B8-static-footer-outside-scroll',
  /popoverFooter:\s*\{[^}]*flex:\s*'0 0 auto'/.test(src) && /'data-cg-footer':\s*'1'/.test(src),
  'footer 必须 flex:0 0 auto 且带 data-cg-footer 标记');
const footerIndex = src.indexOf("'data-cg-footer'");
const saveIndex = src.indexOf('saving ? labels.saving : saved ? labels.saved : labels.save');
const detailToggleIndex = src.indexOf("className: 'cg-detail-toggle'");
check('B8-static-buttons-in-footer', footerIndex > 0 && saveIndex > footerIndex && detailToggleIndex < footerIndex,
  `footer@${footerIndex} save@${saveIndex} detail-toggle@${detailToggleIndex}（详情按钮在 body 内、保存按钮在 footer 内）`);
check('B8-static-wrapper-fixed-height',
  /height:\s*`\$\{layout\.height\}px`/.test(src) && /overflow:\s*'hidden'/.test(src),
  'wrapper 必须有 px 高度 + overflow:hidden（只给 maxHeight 会让面板长出去）');
check('B8-static-panel-max-height-100',
  /maxHeight:\s*'100%'/.test(src), '面板必须 maxHeight:100%（受 wrapper 定值约束）');

// ② vm：渲染结构（footer 是 dialog 直接子节点、保存按钮在 footer 内）
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
const tree = Bubble({ sessionId: 'session-b8', session: { id: 'session-b8' } });
const wrapperNode = tree?.__portal === true ? tree.node : tree;
const dialogNode = Array.isArray(wrapperNode?.props?.children) ? wrapperNode.props.children[0] : wrapperNode?.props?.children;
const kids = Array.isArray(dialogNode?.props?.children) ? dialogNode.props.children : [dialogNode?.props?.children];
const bodyNode = kids.find((child) => child?.props?.['data-cg-body'] === '1');
const footNode = kids.find((child) => child?.props?.['data-cg-footer'] === '1');
check('B8-vm-footer-is-sibling-of-body', bodyNode !== undefined && footNode !== undefined,
  `body=${bodyNode !== undefined} footer=${footNode !== undefined}`);
const footerText = JSON.stringify(footNode ?? {});
check('B8-vm-save-button-in-footer', /保存到本会话/.test(footerText) && /恢复默认/.test(footerText),
  `footerText 含保存/恢复=${/保存到本会话/.test(footerText)}/${/恢复默认/.test(footerText)}`);
// vm 里 layout 为 null（effect 不跑）时面板是 hidden 态，故命中链断言放静态侧：
// wrapper `pointerEvents:none` + panel `pointerEvents:auto` 必须同时存在于源码。
check('B8-static-hit-chain',
  /pointerEvents:\s*'none'/.test(src) && /pointerEvents:\s*'auto'/.test(src),
  'wrapper:none → panel:auto 命中链必须在源码里（否则对话区点不动或面板点不到）');

// ③ 几何：超高请求被夹到 260 且不越界
const rect = client.computePopoverRect({
  chip: { x: 600, y: 500, width: 80, height: 26 },
  panel: { width: 320, height: 400 },
  viewport: { width: 900, height: 594 },
  input: { x: 120, y: 520, width: 660, height: 36 },
});
check('B8-geometry-clamped', rect.height <= 260 && rect.top >= 8 && rect.left >= 8
  && rect.top + rect.height <= 594 - 8 && rect.left + rect.width <= 900 - 8,
  `rect=${JSON.stringify(rect)}（高 ≤260、四边 ≥8）`);

const failed = results.filter((item) => !item.ok);
console.log(`\nB8 按钮常驻门 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
