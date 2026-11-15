/**
 * 测试角色 · 1.1.0 D2「友好最低标准」离线探针（C21 气泡结构与交互 / C22 输入体验）。
 * 判据：REQUIREMENTS.md:1136-1140（2026-11-15 新增，U1-U12；用户 D-MGMT-018）。
 *
 * 用自带最小 React 运行时驱动真实组件（不装宿主、不碰真机）；R10 属真机，不在本文件。
 * 修复落地前预期为基线红。运行：node tests\probe-1.1.0\verify-c21-c22.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}

const PKG = 'packages/dsh-context-governance';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clientSource = await fs.readFile(path.join(PKG, 'lib/client.js'), 'utf8');

function createReactRuntime() {
  const instances = new Map();
  let current = null;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const inst = current;
      const index = inst.cursor;
      inst.cursor += 1;
      if (!(index in inst.states)) inst.states[index] = initial;
      const set = (value) => {
        inst.states[index] = typeof value === 'function' ? value(inst.states[index]) : value;
        inst.render();
      };
      return [inst.states[index], set];
    },
    useEffect(fn, deps) {
      const inst = current;
      const index = inst.cursor;
      inst.cursor += 1;
      const previous = inst.deps[index];
      const changed = !previous || !deps || deps.some((item, at) => item !== previous[at]);
      inst.deps[index] = deps;
      if (changed) inst.pendingEffects.push(fn);
    },
    useRef(initial) { return { current: initial }; },
    useCallback(fn) { return fn; },
  };
  function mount(component, props) {
    let inst = instances.get(component);
    if (!inst) {
      inst = {
        component, props: null, states: [], deps: [], pendingEffects: [], cursor: 0, tree: null,
        render() {
          current = inst;
          inst.cursor = 0;
          inst.pendingEffects = [];
          inst.tree = component(inst.props);
          const pending = inst.pendingEffects;
          inst.pendingEffects = [];
          for (const effect of pending) { try { effect(); } catch { /* ignore */ } }
        },
      };
      instances.set(component, inst);
    }
    inst.props = props;
    inst.render();
    return { get tree() { return inst.tree; }, rerender: () => inst.render() };
  }
  return { react, mount };
}

function walk(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  if (typeof node === 'object') {
    out.push(node);
    for (const child of node.children ?? []) walk(child, out);
    if (node.props?.children !== undefined) walk(node.props.children, out);
  }
  return out;
}
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('');
  let text = '';
  for (const child of node.children ?? []) text += textOf(child);
  if (node.props?.children !== undefined) text += textOf(node.props.children);
  return text;
}
const indexOfNode = (tree, predicate) => walk(tree).findIndex((node) => predicate(node));
const firstByClass = (tree, className) => walk(tree).find((node) => String(node.props?.className ?? '').includes(className));
const allByClass = (tree, className) => walk(tree).filter((node) => String(node.props?.className ?? '').includes(className));
const buttonByText = (tree, text) => walk(tree).find((node) => node.type === 'button' && (String(node.props?.children ?? '').includes(text) || textOf(node).includes(text)));

async function setup() {
  const runtime = createReactRuntime();
  const captured = [];
  const documentListeners = [];
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  // 浏览器里 document 是全局对象（globalThis.document）；window.document 指向同一对象。
  const documentStub = {
    addEventListener: (type, handler, options) => documentListeners.push({ type, handler, options }),
    removeEventListener: () => {},
  };
  globalThis.document = documentStub;
  globalThis.window = {
    __ModuleLoader__: { load: (spec) => captured.push(spec) },
    addEventListener: () => {}, removeEventListener: () => {},
    document: documentStub,
  };
  try {
    await import(pathToFileURL(path.join(process.cwd(), PKG, 'lib/client.js')).href + `?c21=${Date.now()}`);
  } catch (error) {
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
    throw error;
  }
  // 保持 window/document stub 到 apply/mount 之后：组件在 effect 里注册 document 监听（外部点击）时才能被捕获。
  const client = captured[0].factory((name) => {
    if (name !== 'react') throw new Error(`unexpected require: ${name}`);
    return runtime.react;
  });
  const calls = { fetches: 0, saves: [] };
  const fakeFetch = async () => {
    calls.fetches += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        at: 0.6,
        source: 'plugin',
        native: 0.6785,
        effectiveAt: '保存后生效、重启仍有效',
        sessionOverride: null,
        defaultAt: 0.45, // U6：恢复默认必须取快照的 defaultAt（与常量 0.60 区分）
      }),
    };
  };
  const configForms = { get: () => ({ set: async (key, value) => { calls.saves.push({ key, value }); return true; } }) };
  const components = [];
  client.apply({
    locale: { language: 'zh' },
    slots: { inject: (name, callback) => callback(), register: (spec, component) => components.push({ spec, component }) },
    fetch: fakeFetch,
    configForms,
  });
  const chipComp = components.find((item) => item.spec.name === 'conversation.composer.dock')?.component;
  const bubbleComp = components.find((item) => item.spec.name === 'conversation.input.overlay')?.component;
  const props = { ctx: { locale: { language: 'zh' }, fetch: fakeFetch, configForms } };
  const chip = runtime.mount(chipComp, props);
  const bubble = runtime.mount(bubbleComp, props);
  await sleep(30);
  // 打开气泡
  try { chip.tree?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(30);
  return { runtime, client, chip, bubble, calls, documentListeners, props, savedWindow, savedDocument };
}

/** 只取节点自身直接文本（不吞子容器文本），用于判断层级顺序。 */
function leafText(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return '';
  let text = '';
  for (const child of node.children ?? []) {
    if (typeof child === 'string' || typeof child === 'number') text += String(child);
  }
  const own = node.props?.children;
  if (typeof own === 'string' || typeof own === 'number') text += String(own);
  return text.trim();
}

const { client, chip, bubble, calls, documentListeners, savedWindow, savedDocument } = await setup();
const bubbleRoot = () => firstByClass(bubble.tree, 'cg-at-bubble') ?? bubble.tree;
const inputEl = () => walk(bubble.tree).find((node) => node.type === 'input');
const buttons = () => walk(bubble.tree).filter((node) => node.type === 'button');
const errorEl = () => walk(bubble.tree).find((node) => node.props?.role === 'alert' || String(node.props?.className ?? '').includes('cg-at-error'));

// ── C21①：结构与顺序（U2） ──
{
  const nodes = walk(bubble.tree);
  const findIdx = (predicate) => nodes.findIndex(predicate);
  const titleAt = findIdx((node) => leafText(node) === '压缩触发阈值');
  const valueAt = findIdx((node) => /^\d{1,3}%$/.test(leafText(node)));
  const metaAt = findIdx((node) => leafText(node).includes('来源层'));
  const inputAt = findIdx((node) => node.type === 'input');
  const errorAt = findIdx((node) => node.props?.role === 'alert' || String(node.props?.className ?? '').includes('cg-at-error'));
  const actionsAt = findIdx((node) => node.type === 'button' && /保存/.test(leafText(node)));
  const hasPercentUnit = nodes.some((node) => leafText(node) === '%');
  check('C21-structure-order',
    titleAt >= 0 && valueAt > titleAt && metaAt > valueAt && inputAt > metaAt && errorAt > inputAt && actionsAt > errorAt
    && textOf(bubble.tree).includes('恢复默认') && hasPercentUnit,
    `顺序 title=${titleAt} value=${valueAt} meta=${metaAt} input=${inputAt} error=${errorAt} actions=${actionsAt}; %单位=${hasPercentUnit}`);
}

// ── C21②：打开聚焦 + 全选（U1） ──
{
  const autoFocus = inputEl()?.props?.autoFocus === true;
  const focusSelectInSource = /\.focus\??\.\(/.test(clientSource) && /\.select\??\.\(/.test(clientSource);
  const refInSource = /useRef/.test(clientSource) && /\.focus\??\.\(/.test(clientSource);
  check('C21-open-focus-select', autoFocus || (refInSource && focusSelectInSource),
    `input.autoFocus=${autoFocus} 源码 focus()+select()=${focusSelectInSource} ref 聚焦=${refInSource}`);
}

// ── C21③：Esc / 再点 chip / 点外部 关闭（U7） ──
{
  const isOpen = () => walk(bubble.tree).some((node) => String(node.props?.className ?? '').includes('cg-at-bubble') || node.props?.role === 'dialog');
  const ensureOpen = async () => { if (!isOpen()) { try { chip.tree?.props?.onClick?.(); } catch { /* ignore */ } await sleep(20); } };
  await ensureOpen();
  // Esc
  const dialog = walk(bubble.tree).find((node) => String(node.props?.className ?? '').includes('cg-at-bubble') || node.props?.role === 'dialog');
  try { dialog?.props?.onKeyDown?.({ key: 'Escape' }); } catch { /* ignore */ }
  const escClosed = !isOpen();
  // 再点 chip 关闭
  await ensureOpen();
  try { chip.tree?.props?.onClick?.(); } catch { /* ignore */ }
  const chipClosed = !isOpen();
  // 点外部关闭（U7 定死：document 级 pointerdown capture；空白背景 relatedTarget=null 也必须关）
  await ensureOpen();
  const outsideEntry = documentListeners.find((entry) => /pointerdown/.test(entry.type));
  const outsideHandler = outsideEntry?.handler;
  const outsideCapture = outsideEntry?.options === true || outsideEntry?.options?.capture === true;
  const pointerdownOutside = (() => {
    if (typeof outsideHandler !== 'function') return false;
    try { outsideHandler({ type: 'pointerdown', target: { nodeType: 1, closest: () => null }, composedPath: () => [] }); } catch { /* ignore */ }
    return !isOpen();
  })();
  // 焦点移到外部元素（onBlur 路径，作为交互补充，不替代 pointerdown）
  await ensureOpen();
  const blurTarget = walk(bubble.tree).find((node) => typeof node.props?.onBlur === 'function' && walk(node).some((child) => child.type === 'input'));
  if (blurTarget) {
    try { blurTarget.props.onBlur({ relatedTarget: { id: 'outside-el' }, currentTarget: { contains: () => false } }); } catch { /* ignore */ }
  }
  const outsideElClosed = blurTarget !== undefined && !isOpen();
  const outsideClosed = pointerdownOutside || outsideElClosed;
  await ensureOpen();
  check('C21-close-esc-chip-outside', escClosed && chipClosed && outsideClosed,
    `Esc关闭=${escClosed} 再点chip关闭=${chipClosed} 外部关闭=${outsideClosed}（pointerdown=${pointerdownOutside} capture=${outsideCapture}，onBlur=${outsideElClosed}）`);
  // C21-outside-null：document pointerdown（capture）到空白背景（relatedTarget=null）→ 必须关闭；点 chip 是切换不算外部
  await ensureOpen();
  const beforeChipPointerdown = isOpen();
  if (typeof outsideHandler === 'function') {
    try {
      outsideHandler({
        type: 'pointerdown',
        target: { nodeType: 1, closest: (selector) => (String(selector).includes('data-cg-chip') ? { dataset: {} } : null) },
        composedPath: () => [],
      });
    } catch { /* ignore */ }
  }
  const chipNotTreatedAsOutside = beforeChipPointerdown && isOpen();
  await ensureOpen();
  check('C21-outside-null', typeof outsideHandler === 'function' && outsideCapture && pointerdownOutside && chipNotTreatedAsOutside,
    `document pointerdown capture=${outsideCapture} 空白背景关闭=${pointerdownOutside} 点chip不被当外部=${chipNotTreatedAsOutside}`);
}

// ── C21④：错误 role=alert + aria-invalid（U4/U8） ──
{
  const input = inputEl();
  try { input?.props?.onChange?.({ target: { value: '10' } }); } catch { /* ignore */ }
  await sleep(10);
  // 失焦触发校验
  try { inputEl()?.props?.onBlur?.({ target: { value: '10' } }); } catch { /* ignore */ }
  await sleep(10);
  const error = errorEl();
  const alertEl = walk(bubble.tree).find((node) => node.props?.role === 'alert');
  const ariaInvalid = inputEl()?.props?.['aria-invalid'];
  check('C21-error-role-aria',
    error !== undefined && alertEl !== undefined && (ariaInvalid === true || ariaInvalid === 'true'),
    `错误行=${error !== undefined} role=alert=${alertEl !== undefined} aria-invalid=${JSON.stringify(ariaInvalid)}`);
}

// ── C21⑤：保存可用与"已保存"态（U5）；禁用态见 C21⑦（快照未就绪） ──
{
  // 合法值 55 时保存可用，成功后按钮变"已保存"≥1.5s
  const input = inputEl();
  try { input?.props?.onChange?.({ target: { value: '55' } }); } catch { /* ignore */ }
  await sleep(10);
  const saveBtn2 = buttonByText(bubble.tree, '保存');
  const enabledAfterEdit = saveBtn2 !== undefined && saveBtn2.props?.disabled !== true;
  try { await saveBtn2?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(40);
  const savedText = walk(bubble.tree).some((node) => /已保存/.test(textOf(node)));
  await sleep(1600);
  const backToSave = walk(bubble.tree).some((node) => textOf(node) === '保存');
  check('C21-saved-state',
    enabledAfterEdit === true && savedText === true && backToSave === true,
    `合法值可用=${enabledAfterEdit} 已保存态=${savedText} 1.5s后恢复=${backToSave}`);
}

// ── C21⑥：恢复默认只填值不保存（U6）且取 snapshot.defaultAt ──
{
  const before = calls.saves.length;
  const resetBtn = buttonByText(bubble.tree, '恢复默认');
  try { resetBtn?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(20);
  const value = inputEl()?.props?.value;
  const noSave = calls.saves.length === before;
  const usesDefaultAt = String(value).includes('45'); // 快照 defaultAt=0.45（若取常量会是 60）
  check('C21-reset-fills-only', resetBtn !== undefined && usesDefaultAt && noSave,
    `恢复默认按钮=${resetBtn !== undefined} 填入值=${JSON.stringify(value)} 取 defaultAt(45)=${usesDefaultAt} 未发保存=${noSave}`);
  const fallbackInSource = /defaultAt/.test(clientSource) && /0\.6/.test(clientSource) && /warn/i.test(clientSource);
  check('C21-reset-defaultAt-fallback', fallbackInSource,
    `源码含 defaultAt 兜底 0.6 + warn=${fallbackInSource}`);
}

// ── C21⑧：U10 CSS 变量必须带 fallback（不写死背景色） ──
{
  const varUsages = [...clientSource.matchAll(/var\(([^)]*)\)/g)].map((match) => match[1]);
  const missingFallback = varUsages.filter((inner) => !inner.includes(','));
  const hardcodedBg = /background(?:-color)?\s*:\s*(?:#|rgb|hsl|white|black)/i.test(clientSource);
  check('C21-css-var-fallback', missingFallback.length === 0 && hardcodedBg === false,
    `var() 用法=${varUsages.length} 无 fallback=${JSON.stringify(missingFallback)} 写死背景=${hardcodedBg}`);
}

// ── C21⑦：无 alert/prompt/confirm（U12） ──
{
  const usesAlert = /(?<![\w.])alert\s*\(/.test(clientSource) || /(?<![\w.])confirm\s*\(/.test(clientSource) || /(?<![\w.])prompt\s*\(/.test(clientSource);
  check('C21-no-alert', usesAlert === false, `client.js 使用 alert/prompt/confirm=${usesAlert}`);
}

// ── C21⑦：快照未就绪 → "读取中…/暂不可用"且保存禁用（U9） ──
{
  const runtime2 = createReactRuntime();
  const captured2 = [];
  const savedWindow2 = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured2.push(spec) }, addEventListener: () => {}, removeEventListener: () => {}, document: { addEventListener: () => {}, removeEventListener: () => {} } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), PKG, 'lib/client.js')).href + `?c21loading=${Date.now()}`);
  } finally {
    globalThis.window = savedWindow2;
  }
  const client2 = captured2[0].factory((name) => (name === 'react' ? runtime2.react : (() => { throw new Error(name); })()));
  const comps2 = [];
  const failFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const props2 = { ctx: { locale: { language: 'zh' }, fetch: failFetch, configForms: { get: () => ({ set: async () => true }) } } };
  client2.apply({ locale: { language: 'zh' }, slots: { inject: (name, callback) => callback(), register: (spec, component) => comps2.push({ spec, component }) }, fetch: failFetch, configForms: props2.ctx.configForms });
  const chip2 = runtime2.mount(comps2.find((item) => item.spec.name === 'conversation.composer.dock')?.component, props2);
  const bubble2 = runtime2.mount(comps2.find((item) => item.spec.name === 'conversation.input.overlay')?.component, props2);
  await sleep(40);
  try { chip2.tree?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(40);
  const text2 = textOf(bubble2.tree);
  const save2 = walk(bubble2.tree).find((node) => node.type === 'button' && /保存|重试/.test(textOf(node)));
  check('C21-loading-unavailable',
    /读取中|暂不可用|不可用|重试/.test(text2),
    `快照失败时气泡文本含加载/不可用=${/读取中|暂不可用|不可用|重试/.test(text2)} 文本=${JSON.stringify(text2.slice(0, 80))}`);
}

// ── C22①：只收数字 / % 免输 / 全角归一 / 粘贴清洗（U3） ──
{
  const input = inputEl();
  const type = (text) => {
    try { input?.props?.onChange?.({ target: { value: text } }); } catch { /* ignore */ }
    return inputEl()?.props?.value;
  };
  const letters = type('a5b5');
  const fullwidth = type('５５');
  const pastePercent = type(' 55% ');
  check('C22-input-cleaning',
    String(letters) === '55' && String(fullwidth) === '55' && String(pastePercent) === '55',
    `字母混输=${JSON.stringify(letters)} 全角=${JSON.stringify(fullwidth)} 粘贴含%=${JSON.stringify(pastePercent)}`);
}

// ── C22②：非法值不发保存请求（U4） ──
{
  const before = calls.saves.length;
  const input = inputEl();
  try { input?.props?.onChange?.({ target: { value: '10' } }); } catch { /* ignore */ }
  await sleep(10);
  const saveBtn = buttonByText(bubble.tree, '保存');
  try { await saveBtn?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(20);
  check('C22-invalid-no-request', calls.saves.length === before && errorEl() !== undefined,
    `非法值保存请求增量=${calls.saves.length - before} 错误行可见=${errorEl() !== undefined}`);
}

// ── C22③：保存失败保留输入（U5） ──
{
  const input = inputEl();
  try { input?.props?.onChange?.({ target: { value: '55' } }); } catch { /* ignore */ }
  await sleep(10);
  // 注入失败 configForms：换 props 重挂不可行；直接用现有组件 + 让 set 失败需重新 setup
  const failingRuntime = createReactRuntime();
  const captured2 = [];
  const savedWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured2.push(spec) }, addEventListener: () => {}, removeEventListener: () => {}, document: { addEventListener: () => {}, removeEventListener: () => {} } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), PKG, 'lib/client.js')).href + `?c22fail=${Date.now()}`);
  } finally {
    globalThis.window = savedWindow;
  }
  const client2 = captured2[0].factory((name) => (name === 'react' ? failingRuntime.react : (() => { throw new Error(name); })()));
  const comps2 = [];
  client2.apply({
    locale: { language: 'zh' },
    slots: { inject: (name, callback) => callback(), register: (spec, component) => comps2.push({ spec, component }) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ at: 0.6, source: 'plugin', native: 0.6785, sessionOverride: null, effectiveAt: '' }) }),
    configForms: { get: () => ({ set: async () => false }) },
  });
  const chip2 = failingRuntime.mount(comps2.find((item) => item.spec.name === 'conversation.composer.dock')?.component, { ctx: { locale: { language: 'zh' }, fetch: async () => ({ ok: true, status: 200, json: async () => ({ at: 0.6, source: 'plugin' }) }), configForms: { get: () => ({ set: async () => false }) } } });
  const bubble2 = failingRuntime.mount(comps2.find((item) => item.spec.name === 'conversation.input.overlay')?.component, chip2 === null ? {} : { ctx: { locale: { language: 'zh' }, fetch: async () => ({ ok: true, status: 200, json: async () => ({ at: 0.6, source: 'plugin' }) }), configForms: { get: () => ({ set: async () => false }) } } });
  await sleep(30);
  try { chip2.tree?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(20);
  const input2 = walk(bubble2.tree).find((node) => node.type === 'input');
  try { input2?.props?.onChange?.({ target: { value: '55' } }); } catch { /* ignore */ }
  await sleep(10);
  const save2 = walk(bubble2.tree).find((node) => node.type === 'button' && String(node.props?.children ?? '').includes('保存'));
  try { await save2?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(30);
  const keptValue = walk(bubble2.tree).find((node) => node.type === 'input')?.props?.value;
  const errorShown = walk(bubble2.tree).some((node) => node.props?.role === 'alert');
  check('C22-failure-keeps-input', String(keptValue) === '55' && errorShown,
    `失败后输入值=${JSON.stringify(keptValue)} 错误可见=${errorShown}`);
}

globalThis.window = savedWindow;
globalThis.document = savedDocument;

const failed = results.filter((item) => !item.ok);
console.log(`\nC21/C22 TOTAL ${results.length - failed.length}/${results.length} PASS（修复落地前预期为基线红；R10 属真机，不在本探针）`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
