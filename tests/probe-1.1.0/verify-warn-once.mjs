/**
 * 测试角色 · 补充探针：U6 缺 defaultAt 的 fallback warn 必须"模块级一次"（多次渲染只 1 条）。
 * 需求前置条件①（2026-11-15）：warn-once 要有对应用例；本文件为测试侧独立验证，不计入 C21/C22 14 条。
 * 运行：node tests\probe-1.1.0\verify-warn-once.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = 'packages/dsh-context-governance';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return { get tree() { return inst.tree; } };
  }
  return { react, mount };
}

const runtime = createReactRuntime();
const captured = [];
const savedWindow = globalThis.window;
const savedDocument = globalThis.document;
const documentStub = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = documentStub;
globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) }, addEventListener: () => {}, removeEventListener: () => {}, document: documentStub };
try {
  await import(pathToFileURL(path.join(process.cwd(), PKG, 'lib/client.js')).href + `?warnonce=${Date.now()}`);
} finally {
  globalThis.window = savedWindow;
  globalThis.document = savedDocument;
}
const client = captured[0].factory((name) => (name === 'react' ? runtime.react : (() => { throw new Error(name); })()));

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map((item) => String(item)).join(' '));

// 快照缺 defaultAt → 触发 fallback warn
const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ at: 0.6, source: 'plugin', native: 0.6785, sessionOverride: null, effectiveAt: '' }) });
const configForms = { get: () => ({ set: async () => true }) };
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
runtime.mount(bubbleComp, props);
await sleep(40);

// 反复开关气泡（多次渲染）后统计 defaultAt warn
for (let i = 0; i < 5; i += 1) {
  try { chip.tree?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(30);
}
console.warn = originalWarn;

const defaultWarns = warnings.filter((line) => /defaultAt/i.test(line));
const ok = defaultWarns.length === 1;
console.log(`${ok ? 'PASS' : 'FAIL'} C21-defaultAt-warn-once :: 多次开关后 defaultAt warn 条数=${defaultWarns.length}（期望 1） ${JSON.stringify(defaultWarns)}`);
if (!ok) process.exitCode = 1;
