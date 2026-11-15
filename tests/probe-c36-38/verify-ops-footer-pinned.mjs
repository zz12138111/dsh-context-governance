/**
 * 测试角色 · 「操作区常驻」合并门 `verify-ops-footer-pinned`（B8 + B9，2026-11-15）。
 *
 * 判定链：B8 = 按钮行常驻（rc.14 真机被窗口底边裁掉）；B9 = 百分比输入框也常驻（用户验收项，
 *   不计需求缺口——C40 口径 L15「超高内部滚动」）。两件同性质，合并为**一条**门，避免两套口径打架。
 *
 * 离线判据（vm 渲染 + 源码）：
 *   ① `[data-cg-footer]` 同时含：百分比输入框（`type=text`）、恢复默认、恢复全局、保存到本会话、打开设置页；
 *   ② footer 的两个行容器（`data-cg-footer-row`）有 `display:flex` + `gap` 样式（不得 undefined）；
 *   ③ body 可滚：`overflowY:auto` + `minHeight:0` + `flex:1 1 auto`，且 footer 与 body 是**兄弟**；
 *   ④ wrapper 有 **px** 高度且 ≤260（只有 maxHeight 会复现 B8）；
 *   ⑤ 高度**实测**：源码含 `scrollHeight` + `getBoundingClientRect` 重算路径（不能只靠硬编码估算）；
 *   ⑥ 点「详情」后：input 仍在 footer、四个按钮仍在、`top+height ≤ vh−8`；
 *   ⑦ 静态：面板 `maxHeight ≤ 260`。
 *
 * 窗口判据（`b6-window-probe.js`，离线测不了真实布局，本门只标 INFO，判红以窗口门为准）：
 *   输入框与 4 按钮 rect 全在视口内（四边 ≥8、`bottom ≤ vh−8`）、无需滚动、
 *   `elementFromPoint(输入框中心)` 命中 input、`activeElement` 命中、详情展开后仍成立。
 *
 * 用法：node tests\probe-c36-38\verify-ops-footer-pinned.mjs
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
    focus() {}, select() {}, closest: () => chipElement,
  };
  const inputElement = {
    getBoundingClientRect: () => ({ left: 300, top: 860, right: 1100, bottom: 900, width: 800, height: 40, x: 300, y: 860 }),
    focus() {}, select() {},
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
  check('OPS-client-loadable', typeof client?.createBubble === 'function', `createBubble=${typeof client?.createBubble}`);

  const mount = (Component) => {
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
  };

  const sessionId = 'session-opsfooter-1111-2222-3333-444455556666';
  const state = { open: false, snapshot: { at: 0.45, source: 'session:A1', sessionOverride: 0.45 } };
  const store = {
    set(next) { Object.assign(state, next); for (const listener of store.listeners) listener(state); },
    listeners: new Set(),
    subscribe(listener) { store.listeners.add(listener); return () => store.listeners.delete(listener); },
  };
  const pluginCtx = { locale: { language: 'zh' }, sessionId };
  const bubble = mount(client.createBubble(state, store, pluginCtx));
  bubble.render({ sessionId, ctx: pluginCtx });
  await flush();
  store.set({ open: true });
  await flush();
  check('OPS-open-renders', bubble.last.error === null && bubble.last.tree !== null,
    `err=${bubble.last.error === null ? 'none' : String(bubble.last.error.message).slice(0, 160)}`);

  const byAttr = (name, value) => findAll(bubble.last.tree, (node) => node.props?.[name] === value)[0];
  const wrapper = byAttr('data-cg-popover', '1');
  const panel = byAttr('data-cg-panel', '1');
  const body = byAttr('data-cg-body', '1');
  const footer = byAttr('data-cg-footer', '1');
  check('OPS-structure-exists', wrapper !== undefined && panel !== undefined && body !== undefined && footer !== undefined,
    `wrapper=${wrapper !== undefined} panel=${panel !== undefined} body=${body !== undefined} footer=${footer !== undefined}`);

  // ① footer 同时含输入框 + 四个按钮
  const footerInput = findAll(footer ?? null, (node) => node.type === 'input' || node.props?.type === 'text')[0];
  const footerButtons = findAll(footer ?? null, (node) => node.type === 'button');
  const buttonTexts = footerButtons.map((node) => textOf(node));
  const hasRestore = buttonTexts.some((text) => /恢复默认/.test(text));
  const hasResetGlobal = buttonTexts.some((text) => /恢复全局/.test(text));
  const hasSave = buttonTexts.some((text) => /保存/.test(text));
  const hasSettings = buttonTexts.some((text) => /设置/.test(text));
  check('OPS-footer-has-input-and-buttons',
    footerInput !== undefined && footerButtons.length >= 4 && hasRestore && hasResetGlobal && hasSave && hasSettings,
    `input=${footerInput !== undefined} buttons=${JSON.stringify(buttonTexts)}（还需：恢复默认=${hasRestore} 恢复全局=${hasResetGlobal} 保存=${hasSave} 设置=${hasSettings}）`);

  // ② footer 行容器样式（input 行 + actions 行）不得 undefined
  const footerRows = findAll(footer ?? null, (node) => node.props?.['data-cg-footer-row'] !== undefined);
  const rowsStyled = footerRows.length >= 2 && footerRows.every((node) => {
    const style = node.props?.style ?? {};
    return style.display === 'flex' && Number(style.gap) > 0;
  });
  check('OPS-footer-row-styles-defined', rowsStyled,
    `rows=${JSON.stringify(footerRows.map((node) => ({ row: node.props?.['data-cg-footer-row'], display: node.props?.style?.display, gap: node.props?.style?.gap })))}（期望两条行容器都是 flex 且有 gap）`);

  // ③ body 可滚 + footer 兄弟
  const bodyStyle = body?.props?.style ?? {};
  const panelChildren = panel?.children ?? [];
  const bodyIndex = panelChildren.indexOf(body);
  const footerIndex = panelChildren.indexOf(footer);
  check('OPS-body-scrollable-and-footer-sibling',
    bodyStyle.overflowY === 'auto' && Number(bodyStyle.minHeight) === 0 && bodyStyle.flex === '1 1 auto'
      && bodyIndex >= 0 && footerIndex >= 0 && bodyIndex !== footerIndex,
    `overflowY=${JSON.stringify(bodyStyle.overflowY)} minHeight=${JSON.stringify(bodyStyle.minHeight)} flex=${JSON.stringify(bodyStyle.flex)} bodyIdx=${bodyIndex} footerIdx=${footerIndex}`);

  // ④ wrapper px 高度 ≤260
  const wrapperStyle = wrapper?.props?.style ?? {};
  const wrapperHeight = pxValue(wrapperStyle.height);
  check('OPS-wrapper-px-height', wrapperHeight !== null && wrapperHeight > 0 && wrapperHeight <= 260,
    `height=${JSON.stringify(wrapperStyle.height)} px=${wrapperHeight} maxHeight=${JSON.stringify(wrapperStyle.maxHeight)}`);

  // ⑤ 高度实测（scrollHeight + footer 实测高度重算路径；不认"只靠硬编码估算"）
  const footerMeasure = /(footerRef\.current|footerEl)[^;]{0,80}getBoundingClientRect/.test(src);
  const measured = /scrollHeight/.test(src) && footerMeasure && /Math\.min\(\s*260/.test(src);
  check('OPS-height-measured-not-hardcoded', measured,
    `scrollHeight=${/scrollHeight/.test(src)} footer实测=${footerMeasure} min260=${/Math\.min\(\s*260/.test(src)}（硬编码估算不能是唯一来源）`);

  // ⑦ 静态面板 maxHeight ≤ 260
  const panelMax = /maxHeight:\s*['"]?260/.test(src) || /Math\.min\(260/.test(src);
  check('OPS-panel-max-height-260', panelMax, `maxHeight ≤260 命中=${panelMax}`);

  // ⑥ 详情展开后操作区仍在
  const detailToggle = findAll(bubble.last.tree, (node) => node.props?.className === 'cg-detail-toggle')[0];
  if (detailToggle !== undefined && typeof detailToggle.props?.onClick === 'function') {
    detailToggle.props.onClick();
    await flush();
    const footerAfter = byAttr('data-cg-footer', '1');
    const inputAfter = findAll(footerAfter ?? null, (node) => node.type === 'input')[0];
    const buttonsAfter = findAll(footerAfter ?? null, (node) => node.type === 'button');
    const wrapperAfter = byAttr('data-cg-popover', '1');
    const styleAfter = wrapperAfter?.props?.style ?? {};
    const heightAfter = pxValue(styleAfter.height);
    const topAfter = pxValue(styleAfter.top);
    check('OPS-detail-expand-keeps-ops',
      inputAfter !== undefined && buttonsAfter.length >= 4
        && heightAfter !== null && heightAfter <= 260 && topAfter !== null && topAfter + heightAfter <= VIEWPORT.height - 8,
      `inputAfter=${inputAfter !== undefined} buttonsAfter=${buttonsAfter.length} height=${JSON.stringify(styleAfter.height)} top=${JSON.stringify(styleAfter.top)} vh=${VIEWPORT.height}`);
  } else {
    check('OPS-detail-expand-keeps-ops', false, '未找到 cg-detail-toggle 按钮');
  }

  console.log('INFO OPS-window-pending :: 输入框/4 按钮 rect 在视口内、无需滚动、elementFromPoint 命中、activeElement 聚焦、详情后仍成立——离线无真实布局，由 b6-window-probe.js 窗口层判，本门不计红');
} catch (error) {
  check('OPS-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\n操作区常驻（B8+B9 合并）TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
