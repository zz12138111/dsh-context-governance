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
  const infos = [];
  // B10：实现若不收敛（校正环），VM 会被无限重渲染拖死——给预算并在超限时判红，而不是挂住不返回。
  let renderBudget = 60;
  let budgetExhausted = false;
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
    console: { ...console, info: (...args) => { infos.push(args.map(String).join(' ')); }, warn: (...args) => { infos.push(args.map(String).join(' ')); } },
    setTimeout,
    clearTimeout,
    fetch: fakeFetch,
    // B8/B9 高度实测读面板 computed 样式（padding/border/gap）；离线给固定值，便于公式化验证。
    getComputedStyle: () => ({ paddingTop: '16px', paddingBottom: '16px', borderTopWidth: '1px', borderBottomWidth: '1px', rowGap: '10px', gap: '10px' }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  let active = null;
  const enqueue = (fn) => {
    if (budgetExhausted) return;
    renderBudget -= 1;
    if (renderBudget < 0) { budgetExhausted = true; return; }
    queueMicrotask(() => { try { fn(); } catch { /* ignore */ } });
  };
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

  // 离线布局模型：让组件的高度实测路径（bodyRef.scrollHeight / footerRef.rect / panel computed）真的跑起来，
  // 从而能断言"内容少时 footer 不被裁""内容多时可滚"——而不是把 minHeight 之类的样式常量锁死。
  const layoutModel = { bodyScroll: 40, footerHeight: 88 };
  const CHROME = 16 + 16 + 1 + 1 + 10; // padding×2 + border×2 + gap（与 getComputedStyle stub 一致）
  const makeElementStub = (node) => {
    const attrs = node.props ?? {};
    const stub = {
      focus() {}, select() {}, contains() { return true; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
      scrollHeight: 0,
      clientHeight: 0,
    };
    if (attrs['data-cg-body'] === '1') { stub.scrollHeight = layoutModel.bodyScroll; stub.clientHeight = 96; }
    if (attrs['data-cg-footer'] === '1') {
      stub.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: layoutModel.footerHeight, width: 0, height: layoutModel.footerHeight, x: 0, y: 0 });
    }
    if (attrs['data-cg-panel'] === '1') { stub.contains = () => true; }
    return stub;
  };
  const bindRefs = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const item of node) bindRefs(item); return; }
    if (typeof node !== 'object') return;
    const ref = node.props?.ref;
    if (ref !== null && ref !== undefined && typeof ref === 'object' && ref.current === null) ref.current = makeElementStub(node);
    bindRefs(node.children ?? []);
    if (node.props?.children !== undefined) bindRefs(node.props.children);
  };

  const mount = (Component) => {
    const inst = {
      hooks: [], deps: new Map(), cleanups: new Map(), cursor: 0, props: null, renderCount: 0, layouts: [],
      render(props) {
        inst.props = props; active = inst; inst.cursor = 0;
        let tree = null; let error = null;
        try { tree = Component(props); } catch (thrown) { error = thrown; }
        inst.last = { tree, error, hookCount: inst.cursor };
        active = null;
        bindRefs(tree);
        inst.renderCount += 1;
        const wrapper = findAll(tree, (node) => node.props?.['data-cg-popover'] === '1')[0];
        inst.layouts.push({ top: wrapper?.props?.style?.top ?? null, height: wrapper?.props?.style?.height ?? null });
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

  // ② footer 布局样式（B11 扁平化后不再要求"两行容器"；footer 自身必须 flex + gap）
  const footerStyle = footer?.props?.style ?? {};
  const footerRows = findAll(footer ?? null, (node) => node?.props?.['data-cg-footer-row'] !== undefined);
  const rowsStyled = footerStyle.display === 'flex' && Number(footerStyle.gap) > 0
    && (footerRows.length >= 2 ? footerRows.every((node) => node.props?.style?.display === 'flex') : true);
  check('OPS-footer-row-styles-defined', rowsStyled,
    `footer.display=${JSON.stringify(footerStyle.display)} footer.gap=${JSON.stringify(footerStyle.gap)} 行容器=${footerRows.length}（扁平或两行均可，footer 必须 flex+gap）`);

  // ③ body 可滚 + footer 兄弟（不再把 minHeight 样式常量当判据——改由下方低/高内容行为断言）
  const bodyStyle = body?.props?.style ?? {};
  const panelChildren = panel?.children ?? [];
  const bodyIndex = panelChildren.indexOf(body);
  const footerIndex = panelChildren.indexOf(footer);
  check('OPS-body-scrollable-and-footer-sibling',
    bodyStyle.overflowY === 'auto' && bodyStyle.flex === '1 1 auto'
      && bodyIndex >= 0 && footerIndex >= 0 && bodyIndex !== footerIndex,
    `overflowY=${JSON.stringify(bodyStyle.overflowY)} flex=${JSON.stringify(bodyStyle.flex)} bodyIdx=${bodyIndex} footerIdx=${footerIndex}（minHeight 不再作判据）`);

  // ④ wrapper px 高度 ≤260
  const wrapperStyle = wrapper?.props?.style ?? {};
  const wrapperHeight = pxValue(wrapperStyle.height);
  check('OPS-wrapper-px-height', wrapperHeight !== null && wrapperHeight > 0 && wrapperHeight <= 260,
    `height=${JSON.stringify(wrapperStyle.height)} px=${wrapperHeight} maxHeight=${JSON.stringify(wrapperStyle.maxHeight)}`);

  // ⑤ 高度算法（行为，不查字面量）：vm 实调 `computePopoverHeight`——
  //    低内容走 floor（96+footer+chrome）、高内容封顶、maxHeight 可被压低（防未来把 260 写死）。
  const heightFn = typeof client?.computePopoverHeight === 'function' ? client.computePopoverHeight : null;
  const hLow = heightFn !== null ? heightFn({ bodyScroll: 0, footerHeight: 88, chrome: 44 }) : null;
  const hTall = heightFn !== null ? heightFn({ bodyScroll: 900, footerHeight: 88, chrome: 44 }) : null;
  const hCapped = heightFn !== null ? heightFn({ bodyScroll: 0, footerHeight: 88, chrome: 44, maxHeight: 120 }) : null;
  check('OPS-height-floor-and-cap', hLow === 228 && hTall === 260 && hCapped === 120,
    `low=${hLow}(期望228=96+88+44) tall=${hTall}(期望260封顶) capped=${hCapped}(期望120，上限可压低)`);

  // ⑦ 面板上限由 **wrapper 的 px 高度**保证（panel 自身 maxHeight/height 相对 wrapper = 100%）
  const panelInline = panel?.props?.style ?? {};
  check('OPS-panel-relative-to-wrapper-height',
    panelInline.maxHeight === '100%' && panelInline.height === '100%'
      && wrapperHeight !== null && wrapperHeight <= 260,
    `panel.maxHeight=${JSON.stringify(panelInline.maxHeight)} panel.height=${JSON.stringify(panelInline.height)} wrapper=${JSON.stringify(wrapperStyle.height)}（不要求 panel 上有数值 maxHeight）`);

  // B10（审核 2026-11-15）：校正环保护——渲染次数 / 校正日志 / layout 变化必须有界，
  // 否则"measured 恒 0×0"的实现会无限重渲染，门本身被拖死（19112b5 上 exit=1 就是此因）。
  const totalRenders = bubble.renderCount ?? 0;
  const popoverLogs = infos.filter((line) => line.includes('popover-rect')).length;
  const layoutSeq = (bubble.layouts ?? [])
    .map((item) => `${item.top}/${item.height}`)
    .filter((value, index, arr) => index === 0 || value !== arr[index - 1]);
  check('OPS-render-bounded', totalRenders <= 8,
    `renders=${totalRenders} budgetExhausted=${budgetExhausted}（校正环=无限重渲染；有界才有收敛）`);
  check('OPS-correct-log-bounded', popoverLogs <= 2,
    `popover-rect logs=${popoverLogs}（每次打开只应校一次）`);
  check('OPS-correct-once', layoutSeq.length <= 2,
    `layout 变化序列=${JSON.stringify(layoutSeq)}（>2 说明每帧都在纠）`);

  // B11（2026-11-15 真机：输入框占满整行，保存/设置被挤出面板）：**三档宽度**都要放得下。
  // 宽度估算透明可核：汉字=fontSize 13px、其余字符 7px、按钮=文本+padding 24+border 2。
  // 280 是最容易翻车的一档——320 下"两排"只是临界（开发实测超 4px），再窄一点就 3 排被裁。
  const footerNode = byAttr('data-cg-footer', '1');
  const PAD = 16;
  const ROW_GAP = 8;
  const FONT = 13;
  const textWidth = (text) => [...String(text)].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? FONT : 7), 0);
  const pxOf = (value) => {
    const match = typeof value === 'number' ? [String(value), String(value)] : /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? ''));
    return match === null ? null : Number(match[1]);
  };
  const measureFooter = (panelWidth) => {
    const contentW = panelWidth - PAD * 2;
    const measureNode = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (node.type === 'input') {
        const width = pxOf(node.props?.style?.width);
        const flex = String(node.props?.style?.flex ?? '');
        return { kind: 'input', width: width ?? (flex.includes('1') ? contentW : 56), text: '' };
      }
      if (node.type === 'button') {
        const width = pxOf(node.props?.style?.width);
        return { kind: 'button', width: width ?? (textWidth(textOf(node)) + 26), text: textOf(node) };
      }
      if (node.type === 'span') return { kind: 'span', width: textWidth(textOf(node)), text: textOf(node) };
      return null;
    };
    const flatChildren = (footerNode?.children ?? []).filter((node) => node?.type === 'input' || node?.type === 'button' || node?.type === 'span');
    const groups = flatChildren.length > 0
      ? [flatChildren]
      : (footerNode?.children ?? []).map((child) => (child?.children ?? []).filter((node) => node?.type === 'input' || node?.type === 'button' || node?.type === 'span'));
    const rows = [];
    for (const group of groups) {
      const measured = group.map(measureNode).filter(Boolean);
      let row = [];
      let rowWidth = 0;
      for (const item of measured) {
        const need = row.length === 0 ? item.width : rowWidth + ROW_GAP + item.width;
        if (row.length > 0 && need > contentW) { rows.push({ items: row, width: rowWidth }); row = [item]; rowWidth = item.width; }
        else { row.push(item); rowWidth = need; }
      }
      if (row.length > 0) rows.push({ items: row, width: rowWidth });
    }
    const itemHeight = (item) => (item.kind === 'input' ? 32 : item.kind === 'button' ? 30 : 14);
    const rowHeight = (row) => Math.max(...row.items.map(itemHeight));
    const totalHeight = rows.reduce((sum, row, index) => sum + rowHeight(row) + (index === 0 ? 0 : ROW_GAP), 0);
    const footerMaxHeight = Number(footerNode?.props?.style?.maxHeight ?? 88);
    const allItems = rows.flatMap((row) => row.items);
    const buttons = allItems.filter((item) => item.kind === 'button');
    const inputItem = allItems.find((item) => item.kind === 'input');
    const inputSameRowAsButton = rows.some((row) => row.items.some((item) => item.kind === 'input') && row.items.some((item) => item.kind === 'button'));
    const rowsDump = rows.map((row) => `${row.width}:[${row.items.map((item) => `${item.kind}${item.kind === 'button' ? `(${item.text})` : ''}=${Math.round(item.width)}`).join(', ')}]`);
    return {
      contentW, rows, rowsDump, totalHeight, footerMaxHeight, buttons, inputItem, inputSameRowAsButton,
      overflowHeight: totalHeight > footerMaxHeight + 1,
      overflowWidth: rows.some((row) => row.width > contentW + 1),
    };
  };
  const wrapperTopPx = pxValue(byAttr('data-cg-popover', '1')?.props?.style?.top);
  const wrapperHeightPx = pxValue(byAttr('data-cg-popover', '1')?.props?.style?.height);
  const panelTop = wrapperTopPx ?? 0;
  const panelBottom = panelTop + (wrapperHeightPx ?? 228);
  const footerTop = panelTop + PAD;
  const bands = [280, 320, 360].map((width) => ({ width, ...measureFooter(width) }));

  for (const band of bands) {
    const footerBottom = footerTop + band.totalHeight;
    const insidePanel = footerBottom <= panelBottom;
    const insideViewport = footerTop >= 8 && footerBottom <= VIEWPORT.height - 8;
    const tag = `@${band.width}`;
    check(`OPS-footer-button-count-4${tag}`, band.buttons.length === 4,
      `buttons=${band.buttons.length} ${JSON.stringify(band.buttons.map((item) => item.text))}（精确 4 个）`);
    check(`OPS-input-width-cap${tag}`, band.inputItem !== undefined && band.inputItem.width <= 72,
      `inputWidth=${band.inputItem === undefined ? 'missing' : Math.round(band.inputItem.width)}（期望 ≤72，目标 56）`);
    check(`OPS-footer-no-overflow${tag}`, !band.overflowHeight && !band.overflowWidth,
      `footerHeight=${band.totalHeight} maxHeight=${band.footerMaxHeight} rows=${JSON.stringify(band.rowsDump)}（越界⇒按钮被裁）`);
    check(`OPS-footer-all-items-in-panel${tag}`, !band.overflowHeight && insidePanel && insideViewport,
      `totalHeight=${band.totalHeight} maxHeight=${band.footerMaxHeight} footer=[${footerTop},${footerBottom}] panel=[${panelTop},${panelBottom}] viewportH=${VIEWPORT.height}（全部控件须在面板与视口内）`);
    check(`OPS-input-same-row-as-button${tag}`, band.inputSameRowAsButton,
      `rows=${JSON.stringify(band.rowsDump)}（输入框必须与至少一个按钮同行）`);
  }
  // 不许用 overflow:hidden 兜底：3 排（>maxHeight）必须靠提高上限或改布局解决，不能"裁掉但仍算过"
  const mainBand = bands.find((band) => band.width === 320) ?? bands[1];
  check('OPS-footer-not-clipped-by-maxheight', mainBand.totalHeight <= mainBand.footerMaxHeight + 1,
    `contentHeight=${mainBand.totalHeight} footerClientHeight≈${mainBand.footerMaxHeight}`
    + `（contentHeight>clientHeight ⇒ 被 hidden 裁；允许提高 maxHeight 到 ≥contentHeight，不允许裁掉还过）`);

  // B11 极端档（审核要求）：每个控件独占一行（footer ≈184）。最坏情况下控件**不可裁**优先于"内容区保底"，
  // 允许 body 滚动、允许提高 footer maxHeight，但 5 个控件必须在 panel 内且不被 hidden 裁掉。
  const extreme = measureFooter(110 + PAD * 2); // contentW=110 → 每控件独占一行
  const extremeFooterBottom = footerTop + extreme.totalHeight;
  const extremeInsidePanel = extremeFooterBottom <= panelBottom;
  const extremeInsideViewport = extremeFooterBottom <= VIEWPORT.height - 8;
  check('OPS-footer-extreme-all-items-in-panel',
    extreme.buttons.length === 4 && extreme.rows.length >= 5 && extremeInsidePanel && extremeInsideViewport,
    `rows=${extreme.rows.length} footerHeight=${extreme.totalHeight} footerBottom=${extremeFooterBottom} panelBottom=${panelBottom} viewportH=${VIEWPORT.height}（5 控件必须全部在面板与视口内）`);
  check('OPS-footer-extreme-no-overflow', !extreme.overflowWidth && extreme.totalHeight <= extreme.footerMaxHeight + 1,
    `contentHeight=${extreme.totalHeight} footerClientHeight≈${extreme.footerMaxHeight} rows=${JSON.stringify(extreme.rowsDump)}（不许被 hidden 裁；可提高 maxHeight，body 滚动是合法结果）`);
  check('OPS-footer-extreme-body-scroll-allowed', String(body?.props?.style?.overflowY ?? '') === 'auto',
    `body.overflowY=${JSON.stringify(body?.props?.style?.overflowY)}（控件不可裁 > 内容区保底：body 滚动合法）`);
  check('OPS-panel-height-le-260', wrapperHeightPx !== null && wrapperHeightPx <= 260,
    `wrapperHeight=${wrapperHeightPx}（极端档 panel 高度仍须 ≤260）`);

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

  // ⑧ 低内容行为（审核裁 B 的验收点）：内容很少时面板**不得小于"body 保底 + footer + chrome"**，
  //    否则 footer 会被 wrapper overflow:hidden 裁掉（B8 在"内容少"场景的复发）。
  //    这里走真实实测路径：bodyRef.scrollHeight=40、footerRef 高=88、panel computed 固定。
  const lowHeight = pxValue(byAttr('data-cg-popover', '1')?.props?.style?.height);
  const floorBudget = 96 + layoutModel.footerHeight + CHROME;
  check('OPS-low-content-footer-not-clipped', lowHeight !== null && lowHeight >= floorBudget && lowHeight <= 260,
    `panelHeight=${lowHeight} floor(96+${layoutModel.footerHeight}+${CHROME})=${floorBudget}（小于 floor ⇒ footer 被裁；期望 ≥${floorBudget} 且 ≤260）`);

  // ⑨ 高内容行为：20 行量级 → 面板封顶 260 且内容区可滚（footer 仍完整；不靠把面板撑出视口）。
  layoutModel.bodyScroll = 20 * 26; // 20 行
  const tallState = { open: false, snapshot: { at: 0.45, source: 'session:A1', sessionOverride: 0.45 } };
  const tallStore = {
    set(next) { Object.assign(tallState, next); for (const listener of tallStore.listeners) listener(tallState); },
    listeners: new Set(),
    subscribe(listener) { tallStore.listeners.add(listener); return () => tallStore.listeners.delete(listener); },
  };
  const tallBubble = mount(client.createBubble(tallState, tallStore, pluginCtx));
  tallBubble.render({ sessionId, ctx: pluginCtx });
  await flush();
  tallStore.set({ open: true });
  await flush();
  const tallWrapper = findAll(tallBubble.last.tree ?? null, (node) => node.props?.['data-cg-popover'] === '1')[0];
  const tallHeight = pxValue(tallWrapper?.props?.style?.height);
  const bodyContent = layoutModel.bodyScroll;
  const bodyViewport = tallHeight !== null ? tallHeight - layoutModel.footerHeight - CHROME : null;
  check('OPS-tall-content-capped-and-scrollable',
    tallHeight !== null && tallHeight <= 260
      && bodyViewport !== null && bodyContent > bodyViewport
      && tallHeight >= floorBudget,
    `panelHeight=${tallHeight} bodyContent=${bodyContent} bodyViewport=${bodyViewport}（面板封顶 260、内容区可滚、footer 仍完整）`);

  console.log('INFO OPS-window-pending :: 输入框/4 按钮 rect 在视口内、无需滚动、elementFromPoint 命中、activeElement 聚焦、详情后仍成立——离线无真实布局，由 b6-window-probe.js 窗口层判，本门不计红');
} catch (error) {
  check('OPS-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\n操作区常驻（B8+B9 合并）TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
