/**
 * 测试角色 · B8「按钮行常驻/可达」门（2026-11-15 rc.14 真机：保存/恢复默认/恢复全局/打开设置
 * 全被窗口底边裁掉 → C40 不可操作，C40 未达成）。
 *
 * ⚠️ 2026-11-15 起由 `verify-ops-footer-pinned.mjs` 接管判红（B8+B9 合并：按钮 + 输入框操作区常驻）。
 * 本门保留为**子集证据**（footer 与滚动区分离、px 定高、详情展开不出界），两者口径不打架：
 * 若两门结论不一致，以 ops 门为准，并把差异报审核。
 *
 * 根因（审核）：wrapper 只有 `maxHeight` 没有确定 `height` → 面板 `max-height:100%` 解析为 none →
 *   面板按自然高度（≈290）长过 `layout.height`（估算 226）→ footer 穿出窗口被裁。
 *
 * 判据（三层里的离线两层；窗口层在 `b6-window-probe.js` 扩展）：
 *   ① footer 与 body 是**兄弟节点**，footer 在滚动内容之外（不得是 body 的后代）；
 *   ② body style 必须 `overflowY:'auto'` 且 `minHeight:0`（flex 子项能滚的前提）；
 *   ③ wrapper style 必须含**px 单位**的 `height`（只有 maxHeight → 红）；
 *   ④ 内容行（标题/大号/说明行）`flex-shrink:0`；
 *   ⑤ 展开「详情」后 footer 仍在树里，且面板高度 ≤260、`top+height ≤ vh−8`（不穿窗口下沿）；
 *   ⑥ 按钮行含保存按钮（不能只剩一个"详情"）。
 *
 * 用法：node tests\probe-c36-38\verify-b8-footer-visible.mjs
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
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('\n');
  const own = node.props?.children;
  return `${textOf(node.children ?? [])}${own === undefined ? '' : `\n${textOf(own)}`}`;
}
const pxValue = (value) => {
  const match = typeof value === 'string' ? /^(-?\d+(?:\.\d+)?)px$/.exec(value) : null;
  return match === null ? null : Number(match[1]);
};

const VIEWPORT = { width: 1400, height: 900 };

try {
  let spec = null;
  const fakeFetch = async (url) => {
    if (String(url).includes('policy-snapshot')) {
      return { ok: true, json: async () => ({ at: 0.45, source: 'session:A1', sessionOverride: 0.45, effectiveAt: '本会话有效，重启后失效', native: 0.6785, defaultAt: 0.6 }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const chipElement = {
    getBoundingClientRect: () => ({ left: 1100, top: 700, right: 1190, bottom: 728, width: 90, height: 28, x: 1100, y: 700 }),
    focus() {},
    select() {},
    closest: () => chipElement,
  };
  const inputElement = {
    getBoundingClientRect: () => ({ left: 300, top: 860, right: 1100, bottom: 900, width: 800, height: 40, x: 300, y: 860 }),
    focus() {},
    select() {},
  };
  const fakeDocument = {
    body: { appendChild() {} },
    documentElement: { clientWidth: VIEWPORT.width, clientHeight: VIEWPORT.height },
    querySelector: (selector) => (String(selector).includes('chip') ? chipElement : (String(selector).includes('textarea') || String(selector).includes('composer') ? inputElement : null)),
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { spec = value; } }, innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height, addEventListener() {}, removeEventListener() {} },
    document: fakeDocument,
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    console,
    setTimeout,
    clearTimeout,
    fetch: fakeFetch,
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
  const fakeReactDom = { createPortal: (node, container) => ({ type: 'portal', props: { container }, children: [node], __portalContainer: container }) };
  const client = typeof spec?.factory === 'function'
    ? spec.factory((name) => (name === 'react' ? react : (name === 'react-dom' ? fakeReactDom : {})))
    : null;
  const bubbleFactory = client?.createBubble;
  check('B8-client-loadable', typeof bubbleFactory === 'function', `createBubble=${typeof bubbleFactory}`);

  function mount(Component) {
    const inst = {
      hooks: [], deps: new Map(), cleanups: new Map(), cursor: 0, props: null,
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
  }

  const sessionId = 'session-b8footer-1111-2222-3333-444455556666';
  const state = { open: false, snapshot: { at: 0.45, source: 'session:A1', sessionOverride: 0.45 } };
  const store = {
    set(next) { Object.assign(state, next); for (const listener of store.listeners) listener(state); },
    listeners: new Set(),
    subscribe(listener) { store.listeners.add(listener); return () => store.listeners.delete(listener); },
  };
  const pluginCtx = { locale: { language: 'zh' }, sessionId };
  const bubble = mount(bubbleFactory(state, store, pluginCtx));
  bubble.render({ sessionId, ctx: pluginCtx });
  await flush();
  store.set({ open: true });
  await flush();
  check('B8-open-renders', bubble.last.error === null && bubble.last.tree !== null,
    `err=${bubble.last.error === null ? 'none' : String(bubble.last.error.message).slice(0, 160)}`);

  const byAttr = (name, value) => findAll(bubble.last.tree, (node) => node.props?.[name] === value)[0];
  const wrapper = byAttr('data-cg-popover', '1');
  const panel = byAttr('data-cg-panel', '1');
  const body = byAttr('data-cg-body', '1');
  const footer = byAttr('data-cg-footer', '1');
  check('B8-structure-exists', wrapper !== undefined && panel !== undefined && body !== undefined && footer !== undefined,
    `wrapper=${wrapper !== undefined} panel=${panel !== undefined} body=${body !== undefined} footer=${footer !== undefined}`);

  // ① footer 与 body 兄弟：都在 panel 的直接子节点里
  const panelChildren = panel?.children ?? [];
  const bodyIndex = panelChildren.indexOf(body);
  const footerIndex = panelChildren.indexOf(footer);
  check('B8-footer-sibling-of-body', bodyIndex >= 0 && footerIndex >= 0 && bodyIndex !== footerIndex,
    `bodyIdx=${bodyIndex} footerIdx=${footerIndex}（footer 必须是 panel 的直接子、不得在 body 内）`);

  // ② body 可滚前提
  const bodyStyle = body?.props?.style ?? {};
  check('B8-body-scrollable', bodyStyle.overflowY === 'auto' && Number(bodyStyle.minHeight) === 0 && bodyStyle.flex !== '0 0 auto',
    `overflowY=${JSON.stringify(bodyStyle.overflowY)} minHeight=${JSON.stringify(bodyStyle.minHeight)} flex=${JSON.stringify(bodyStyle.flex)}`);

  // ③ wrapper 确定高度（px），不是只有 maxHeight
  const wrapperStyle = wrapper?.props?.style ?? {};
  const wrapperHeight = pxValue(wrapperStyle.height);
  check('B8-wrapper-has-px-height', wrapperHeight !== null && wrapperHeight > 0 && wrapperHeight <= 260,
    `height=${JSON.stringify(wrapperStyle.height)} px=${wrapperHeight} maxHeight=${JSON.stringify(wrapperStyle.maxHeight)}（只有 maxHeight 会复现 B8）`);

  // ④ 内容行 flexShrink:0（标题/大号/说明行）
  const contentRows = (body?.children ?? []).filter((node) => node !== null && node !== undefined && typeof node === 'object');
  const nonShrink = contentRows.slice(0, 3).every((node) => Number(node.props?.style?.flexShrink) === 0);
  check('B8-content-rows-flex-shrink', contentRows.length >= 2 && nonShrink,
    `rows=${contentRows.length} 前三行 flexShrink=${JSON.stringify(contentRows.slice(0, 3).map((node) => node.props?.style?.flexShrink))}`);

  // ⑥ 按钮行含保存按钮（至少 3 个按钮：恢复默认/恢复全局/保存）
  const footerButtons = findAll(footer, (node) => node.type === 'button');
  check('B8-footer-has-save-button', footerButtons.length >= 3,
    `footerButtons=${JSON.stringify(footerButtons.map((node) => textOf(node)))}`);

  // ⑤ 展开详情后：footer 仍在、高度 ≤260、top+height ≤ vh−8
  const detailToggle = findAll(bubble.last.tree, (node) => node.className === 'cg-detail-toggle')[0]
    ?? findAll(bubble.last.tree, (node) => node.props?.className === 'cg-detail-toggle')[0];
  if (detailToggle !== undefined && typeof detailToggle.props?.onClick === 'function') {
    detailToggle.props.onClick();
    await flush();
    const footerAfter = byAttr('data-cg-footer', '1');
    const wrapperAfter = byAttr('data-cg-popover', '1');
    const styleAfter = wrapperAfter?.props?.style ?? {};
    const heightAfter = pxValue(styleAfter.height);
    const topAfter = pxValue(styleAfter.top);
    check('B8-footer-survives-detail-expand', footerAfter !== undefined && footerAfter === byAttr('data-cg-footer', '1'),
      `footerAfter=${footerAfter !== undefined}`);
    check('B8-detail-expand-stays-in-viewport',
      heightAfter !== null && heightAfter <= 260 && topAfter !== null && topAfter + heightAfter <= VIEWPORT.height - 8,
      `height=${JSON.stringify(styleAfter.height)} top=${JSON.stringify(styleAfter.top)} vh=${VIEWPORT.height}（期望 top+height ≤ ${VIEWPORT.height - 8}）`);
  } else {
    check('B8-footer-survives-detail-expand', false, '未找到 cg-detail-toggle 按钮');
    check('B8-detail-expand-stays-in-viewport', false, '未找到 cg-detail-toggle 按钮');
  }
} catch (error) {
  check('B8-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nB8 footer 常驻/可达 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
