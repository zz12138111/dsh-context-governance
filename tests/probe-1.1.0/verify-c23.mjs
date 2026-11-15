/**
 * 测试角色 · C23 渲染期异常隔离（需求 `d19f532`，D-MGMT-020）。
 *
 * 三条：
 * ① 任一入口渲染抛错 → 其余入口仍挂载可用；chip 退化为 `压 —`；
 * ② Console 可读错误：含入口名 + 原始 message，不许空白/静默；
 * ③ 静态：`lib/client.js` 里 `ctx.fetch` 引用 = 0；`ctx.<服务>` ⊆ 导出 inject（slots/locale/configForms）；
 *    fetch 必须走 `globalThis.fetch`。
 *
 * 运行：node tests\probe-1.1.0\verify-c23.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = 'packages/dsh-context-governance';
const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const clientSource = await fs.readFile(path.join(PKG, 'lib/client.js'), 'utf8');

// ── C23③ 静态：ctx.fetch 引用必须为 0；fetch 走 globalThis.fetch；服务 ⊆ 导出 inject ──
{
  const ctxFetchRefs = [...clientSource.matchAll(/\bctx\s*\??\.\s*fetch\b/g)].map((match) => match.index);
  const usesGlobalFetch = /globalThis\.fetch/.test(clientSource);
  const usedServices = [...new Set([...clientSource.matchAll(/\bctx\s*\??\.\s*(\w+)/g)].map((match) => match[1]))]
    .filter((name) => ['slots', 'locale', 'configForms'].includes(name));
  const exportedInjectDecl = /inject\s*=\s*\[([^\]]*)\]/.exec(clientSource);
  const injected = exportedInjectDecl === null ? [] : [...exportedInjectDecl[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const missing = usedServices.filter((name) => !injected.includes(name));
  check('C23-no-ctx-fetch', ctxFetchRefs.length === 0 && usesGlobalFetch,
    `ctx.fetch 引用=${ctxFetchRefs.length} globalThis.fetch=${usesGlobalFetch}`);
  check('C23-service-subset', usedServices.length > 0 && missing.length === 0,
    `ctx 服务=${JSON.stringify(usedServices)} 导出 inject=${JSON.stringify(injected)} 缺=${JSON.stringify(missing)}`);
}

function createReactRuntime() {
  const instances = new Map();
  let current = null;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const inst = current; const index = inst.cursor; inst.cursor += 1;
      if (!(index in inst.states)) inst.states[index] = initial;
      const set = (value) => { inst.states[index] = typeof value === 'function' ? value(inst.states[index]) : value; inst.render(); };
      return [inst.states[index], set];
    },
    useEffect(fn, deps) {
      const inst = current; const index = inst.cursor; inst.cursor += 1;
      const previous = inst.deps[index];
      const changed = !previous || !deps || deps.some((item, at) => item !== previous[at]);
      inst.deps[index] = deps;
      if (changed) inst.pendingEffects.push(fn);
    },
    useRef(initial) { return { current: initial }; },
    useCallback(fn) { return fn; },
    useMemo(factory) { return factory(); },
  };
  function mount(component, props) {
    let inst = instances.get(component);
    if (!inst) {
      inst = {
        component, props: null, states: [], deps: [], pendingEffects: [], cursor: 0, tree: null,
        render() {
          current = inst; inst.cursor = 0; inst.pendingEffects = [];
          inst.tree = component(inst.props);
          const pending = inst.pendingEffects; inst.pendingEffects = [];
          for (const effect of pending) { try { effect(); } catch { /* ignore */ } }
        },
      };
      instances.set(component, inst);
    }
    inst.props = props; inst.render();
    return { get tree() { return inst.tree; } };
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

const runtime = createReactRuntime();
const captured = [];
const savedWindow = globalThis.window;
const savedDocument = globalThis.document;
const savedFetch = globalThis.fetch;
const documentStub = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = documentStub;
globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) }, addEventListener: () => {}, removeEventListener: () => {}, document: documentStub };
// 真实契约：宿主客户端由 globalThis.fetch 取数（不是 ctx.fetch）
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
try {
  await import(pathToFileURL(path.join(process.cwd(), PKG, 'lib/client.js')).href + `?c23=${Date.now()}`);
} finally {
  globalThis.window = savedWindow;
  globalThis.document = savedDocument;
}
const client = captured[0].factory((name) => (name === 'react' ? runtime.react : (() => { throw new Error(name); })()));

const baseCtx = {
  locale: { language: 'zh' },
  configForms: { get: () => ({ set: async () => true }) },
};
// 仿真 Cordis：未注入属性 getter 抛错
const throwingCtx = new Proxy(baseCtx, {
  get(target, prop) {
    if (prop === 'fetch') throw new Error('cannot get property "fetch" without inject');
    return target[prop];
  },
});

const components = [];
client.apply({
  ...baseCtx,
  slots: { inject: (name, callback) => callback(), register: (spec, component) => components.push({ spec, component }) },
});
const bySlot = (name) => components.find((item) => item.spec.name === name);

// ── C23①：fetch getter 抛错时三处入口仍渲染（chip 退化 压 —） ──
{
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map((item) => String(item)).join(' '));
  const mounted = [];
  const errors = [];
  for (const { spec, component } of components) {
    try { mounted.push({ slot: spec.name, tree: runtime.mount(component, { ctx: throwingCtx }).tree }); }
    catch (error) { errors.push({ slot: spec.name, error: String(error?.message ?? error) }); }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  console.warn = originalWarn;
  const chip = mounted.find((item) => item.slot === 'conversation.composer.dock');
  const section = mounted.find((item) => item.slot === 'settings.section');
  check('C23-fetch-getter-isolated',
    errors.length === 0 && chip !== undefined && chip.tree !== null && textOf(chip.tree).includes('压')
    && section !== undefined && section.tree !== null && textOf(section.tree).includes('压缩触发阈值'),
    `渲染抛错=${JSON.stringify(errors)} chip=${JSON.stringify(textOf(chip?.tree ?? null).slice(0, 20))} section=${section !== undefined}`);
}

// ── C23②：单个入口 render 抛错 → 错误边界给出可读日志（入口名 + 原 message），其余入口仍在 ──
{
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map((item) => String(item)).join(' '));
  const chipComp = bySlot('conversation.composer.dock')?.component;
  const bubbleComp = bySlot('conversation.input.overlay')?.component;
  const sectionComp = bySlot('settings.section')?.component;

  // 让 chip 的渲染在 useState 处抛错，模拟"该入口 render 崩"
  const originalUseState = runtime.react.useState;
  runtime.react.useState = () => { throw new Error('boom-render-chip'); };
  let chipTree = null;
  try { chipTree = runtime.mount(chipComp, { ctx: baseCtx }).tree; } catch { chipTree = null; }
  runtime.react.useState = originalUseState;

  // 其余入口应正常
  let bubbleTree = null;
  let sectionTree = null;
  try { bubbleTree = runtime.mount(bubbleComp, { ctx: baseCtx }).tree; } catch { bubbleTree = null; }
  try { sectionTree = runtime.mount(sectionComp, { ctx: baseCtx }).tree; } catch { sectionTree = null; }
  await new Promise((resolve) => setTimeout(resolve, 20));
  console.warn = originalWarn;

  const readable = warnings.some((line) => /conversation\.composer\.dock/.test(line) && /boom-render-chip/.test(line));
  check('C23-render-boundary-readable', readable,
    `边界日志含入口名+原 message=${readable} 原文=${JSON.stringify(warnings)}`);
  check('C23-render-boundary-isolation',
    sectionTree !== null && sectionTree !== undefined && textOf(sectionTree).includes('压缩触发阈值')
    && bubbleTree !== null && bubbleTree !== undefined,
    `chip 崩后 bubble=${bubbleTree !== null} section=${sectionTree !== null}`);
}

globalThis.fetch = savedFetch;
const failed = results.filter((item) => !item.ok);
console.log(`\nC23 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
