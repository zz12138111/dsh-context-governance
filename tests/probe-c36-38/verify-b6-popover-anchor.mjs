/**
 * 测试角色 · B6「面板必须 portal 到 body 再定位」静态门（rc.13 真机脱锚/裁切/遮对话区；审核规格 §3.1）。
 *
 * 定因（审核从宿主源码取证，`B6-取证与门规格-20261115.md` §0）：
 *   宿主 `.composerSeat{will-change:transform; position:sticky; z-index:9}` 使 `position:fixed` 后代的
 *   containing block 变成该座位 → 插件按视口算的 left/top 被当成相对 composer 的偏移 → 贴右下角 + 越界被裁。
 *   修法：**只把单个面板节点** portal 到 `document.body`（不搬入口组件、不往 body 追加第二个应用）。
 *
 * 判据（审核 §3.1 五条 + 本轮加牙）：
 *   ① `B6-fixed-requires-portal`：用 fixed 就必须有 portal 到 body 的路径；
 *   ② `B6-no-corner-fallback`：不得存在 `innerWidth−120`/`innerHeight−120` 假坐标兜底；
 *   ③ `B6-no-anchor-means-no-render`：取不到锚点必须 `setLayout(null)` 不渲染；
 *   ④ `B6-portal-target-is-body`（新增）：portal 目标必须是 `document.body`（源码 + 运行时双证）；
 *   ⑤ `B6-portal-single-node`（新增）：被 portal 的只是**单个面板节点**（含 `data-cg-popover`），
 *      不是整个入口组件；
 *   ⑥ `B6-portaled-attr-on-panel`（新增）：`data-cg-portaled="1"` 在面板节点上（仅 portal 成功时出现）；
 *   ⑦ `B6-no-reactdom-no-render`（新增）：`react-dom` 不可用时**不渲染 + warn**，不得静默退回 slot 原位。
 *
 * 用法：node tests\probe-c36-38\verify-b6-popover-anchor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const src = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const item of node) findAll(item, predicate, out); return out; }
  if (typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  findAll(node.children ?? [], predicate, out);
  if (node.props?.children !== undefined) findAll(node.props.children, predicate, out);
  return out;
}

// ---- 静态段 ----
const usesFixed = /position:\s*'fixed'/.test(src);
const portalsToBody = /(document\.body|doc\.body)[\s\S]{0,40}(createPortal|appendChild|append)/.test(src) || /createPortal/.test(src);
check('B6-fixed-requires-portal', usesFixed === false || portalsToBody === true,
  `usesFixed=${usesFixed} portalToBody=${portalsToBody}（fixed 在 slot 容器内会被祖先 transform 劫持）`);

const cornerFallback = /innerWidth\s*\?\?\s*\d+\s*\)\s*-\s*120|innerHeight\s*\?\?\s*\d+\s*\)\s*-\s*120/.test(src);
check('B6-no-corner-fallback', cornerFallback === false,
  `命中右下角假坐标=${cornerFallback}（rc.13 形态与截图吻合，必须删除）`);

const noAnchorBail = /if\s*\(chipRect === null\)\s*\{[\s\S]{0,80}setLayout\(null\)/.test(src)
  || /chipRect\s*===\s*null[\s\S]{0,200}setLayout\(null\)/.test(src);
check('B6-no-anchor-means-no-render', noAnchorBail === true,
  `无锚点回退 setLayout(null)=${noAnchorBail}（不得用猜测坐标出图）`);

check('B6-portal-target-is-body',
  /createPortal\(\s*node\s*,\s*(doc|document)\.body\s*\)/.test(src) && /doc\.body\s*===\s*null/.test(src),
  `createPortal(node, doc.body)=${/createPortal\(\s*node\s*,\s*(doc|document)\.body\s*\)/.test(src)} body 空校验=${/doc\.body\s*===\s*null/.test(src)}`);

const wrapperSingle = /const wrapper = h\('div',\s*\{[\s\S]{0,200}'data-cg-popover': '1'[\s\S]{0,120}'data-cg-portaled': '1'[\s\S]{0,120}\},\s*dialogNode\)/.test(src);
const portalCallsWrapper = /portalToBody\(\s*wrapper\s*\)/.test(src);
check('B6-portal-single-node', wrapperSingle && portalCallsWrapper,
  `wrapper 单节点=${wrapperSingle} 只 portal wrapper=${portalCallsWrapper}（不得搬入口组件）`);

const portaledAttrOnWrapper = /'data-cg-portaled': '1'[\s\S]{0,400}style: popoverStyle/.test(src);
check('B6-portaled-attr-on-panel', portaledAttrOnWrapper,
  `data-cg-portaled 在面板 wrapper=${portaledAttrOnWrapper}（仅 portal 成功时出现）`);

// ---- 运行时行为段（vm：真调 createBubble，验证 portal 目标与缺 react-dom 行为）----
const sessionId = 'session-b6anchor-1111-2222-3333-444455556666';

function makeHarness({ withReactDom }) {
  const warnings = [];
  let spec = null;
  const reactDom = { createPortal: (node, container) => ({ type: 'portal', props: { container }, children: [node], __portalContainer: container }) };
  const fakeDocument = {
    body: { appendChild() {} },
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { spec = value; } }, innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    document: fakeDocument,
    innerWidth: 1200,
    innerHeight: 800,
    console: { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) },
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ at: 0.45, source: 'session:A1' }) }),
    require: (name) => (name === 'react-dom' && withReactDom ? reactDom : {}),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  let active = null;
  const enqueue = (fn) => { queueMicrotask(() => { try { fn(); } catch { /* ignore */ } }); };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const inst = active; const index = inst.cursor; inst.cursor += 1;
      if (inst.hooks[index] === undefined) inst.hooks[index] = typeof initial === 'function' ? initial() : initial;
      const set = (value) => {
        const next = typeof value === 'function' ? value(inst.hooks[index]) : value;
        if (Object.is(next, inst.hooks[index])) return;
        inst.hooks[index] = next;
        enqueue(() => inst.render(inst.props));
      };
      return [inst.hooks[index], set];
    },
    useEffect(fn, deps) {
      const inst = active; const index = inst.cursor; inst.cursor += 1;
      const previousDeps = inst.deps.get(index);
      const changed = deps === undefined || previousDeps === undefined
        || deps.length !== previousDeps.length
        || deps.some((value, position) => !Object.is(value, previousDeps[position]));
      if (!changed) return;
      inst.deps.set(index, Array.isArray(deps) ? [...deps] : undefined);
      enqueue(() => { const cleanup = fn(); if (typeof cleanup === 'function') inst.cleanups.set(index, cleanup); });
    },
    useRef(initial) {
      const inst = active; const index = inst.cursor; inst.cursor += 1;
      if (inst.hooks[index] === undefined) inst.hooks[index] = { current: initial };
      return inst.hooks[index];
    },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    Component: class Base { constructor(props) { this.props = props; } },
  };
  const client = spec?.factory?.((name) => (name === 'react' ? react : (name === 'react-dom' && withReactDom ? reactDom : {})));
  const mount = (Component) => {
    const inst = {
      hooks: [], deps: new Map(), cleanups: new Map(), cursor: 0, props: null, last: { tree: null, error: null, hookCount: 0 },
      render(props) {
        inst.props = props; active = inst; inst.cursor = 0;
        let tree = null; let error = null;
        try { tree = Component(props); } catch (thrown) { error = thrown; }
        inst.last = { tree, error, hookCount: inst.cursor };
        active = null;
        return inst.last;
      },
    };
    return inst;
  };
  return { client, mount, warnings, reactDom, document: fakeDocument };
}

try {
  // ⑥ 运行时：portal 目标 = document.body，且只 portal 面板节点
  const okHarness = makeHarness({ withReactDom: true });
  const state = { open: false, snapshot: { at: 0.45, source: 'session:A1', sessionOverride: 0.45 } };
  const store = {
    set(next) { Object.assign(state, next); for (const listener of store.listeners) listener(state); },
    listeners: new Set(),
    subscribe(listener) { store.listeners.add(listener); return () => store.listeners.delete(listener); },
  };
  const pluginCtx = { locale: { language: 'zh' }, sessionId };
  const bubble = okHarness.mount(okHarness.client.createBubble(state, store, pluginCtx));
  bubble.render({ sessionId, ctx: pluginCtx });
  await flush();
  store.set({ open: true });
  await flush();
  const portal = findAll(bubble.last.tree, (node) => node.type === 'portal')[0];
  const panel = findAll(bubble.last.tree, (node) => node.props?.['data-cg-popover'] === '1')[0];
  const portaledAttr = panel?.props?.['data-cg-portaled'] === '1';
  const onlyPanel = portal !== undefined && (portal.children ?? []).filter((node) => node !== null && node !== undefined).length === 1
    && portal.children[0] === panel;
  check('B6-runtime-portal-to-body', portal !== undefined && portal.__portalContainer === okHarness.document.body,
    `portalNode=${portal !== undefined} containerIsBody=${portal !== undefined && portal.__portalContainer === okHarness.document.body}（createPortal 必须收到 document.body，不是 slot 容器）`);
  check('B6-runtime-portal-single-panel', onlyPanel && portaledAttr,
    `portal.children=${(portal?.children ?? []).length} 面板带 portaled 标记=${portaledAttr}（只搬面板，不搬入口组件）`);

  // ⑦ 运行时：react-dom 不可用 → 不渲染 + warn，不得退回 slot
  const offHarness = makeHarness({ withReactDom: false });
  const offState = { open: true, snapshot: { at: 0.45, source: 'session:A1', sessionOverride: 0.45 } };
  const offStore = {
    set(next) { Object.assign(offState, next); for (const listener of offStore.listeners) listener(offState); },
    listeners: new Set(),
    subscribe(listener) { offStore.listeners.add(listener); return () => offStore.listeners.delete(listener); },
  };
  const offBubble = offHarness.mount(offHarness.client.createBubble(offState, offStore, pluginCtx));
  offBubble.render({ sessionId, ctx: pluginCtx });
  await flush();
  const offPanel = findAll(offBubble.last.tree, (node) => node.props?.['data-cg-popover'] === '1')[0];
  const warned = offHarness.warnings.some((line) => /portal unavailable/i.test(line));
  check('B6-no-reactdom-no-render', offBubble.last.error === null && offPanel === undefined && offBubble.last.tree === null && warned,
    `tree=${offBubble.last.tree === null ? 'null' : '非空'} panel=${offPanel !== undefined} warn=${warned}（缺 react-dom 必须不渲染 + warn，绝不退回原位）`);
} catch (error) {
  check('B6-runtime-window', false, `运行时段抛错：${String(error?.stack ?? error).slice(0, 400)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nB6 定位静态门 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
