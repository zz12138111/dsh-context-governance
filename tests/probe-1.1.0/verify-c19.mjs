/**
 * 测试角色 · 1.1.0 D2 离线契约探针（C19 客户端取数鲁棒性）。
 * 判据：REQUIREMENTS.md（2026-11-15 新增，`20a87a1`；第 3 次预验 chip 仍 `压 —` 后补）。
 *
 * 事实：policy-snapshot 200+JSON 正确，但 chip 仍 `压 —`；根因 = 客户端取数静默 null、首拉不重试、无日志。
 * C19：①失败必须 warn（状态码/次数）、首拉退避重试，[500,200] 恢复；②全失败 warn 含次数、chip `压 —`、不抛；
 *      ③focus / 打开气泡 / 保存成功 各至少触发一次取数（假 fetch 计数）。
 *
 * 修复落地前预期为基线红。运行：node tests\probe-1.1.0\verify-c19.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}

const PKG = 'packages/dsh-context-governance';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 可重渲染的最小 React 运行时：多实例、useState/useEffect(deps)、store 订阅触发 rerender。 */
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
    useMemo(factory) { return factory(); },
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
          for (const effect of pending) {
            try { effect(); } catch { /* ignore */ }
          }
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

async function loadClient(react) {
  const captured = [];
  const savedWindow = globalThis.window;
  const stub = globalThis.window && globalThis.window.__capture === true
    ? globalThis.window
    : { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  globalThis.window = { ...stub, __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), PKG, 'lib/client.js')).href + `?c19=${Date.now()}`);
  } finally {
    globalThis.window = savedWindow;
  }
  return captured[0].factory((name) => {
    if (name !== 'react') throw new Error(`unexpected require: ${name}`);
    return react;
  });
}

function makeFetchSeq(statuses) {
  let calls = 0;
  const fake = async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    if (status >= 200 && status < 300) {
      return { ok: true, status, json: async () => ({ at: 0.45, source: 'project', native: 0.6785, effectiveAt: '保存后生效、重启仍有效', sessionOverride: null }) };
    }
    return { ok: false, status, json: async () => ({}) };
  };
  return { fake, count: () => calls };
}

function captureWarn() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.map((item) => String(item)).join(' '));
  return { lines, restore: () => { console.warn = original; } };
}

function findElement(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) findElement(child, predicate, out);
    return out;
  }
  if (typeof node === 'object') {
    if (predicate(node)) out.push(node);
    for (const child of node.children ?? []) findElement(child, predicate, out);
    if (node.props?.children !== undefined) findElement(node.props.children, predicate, out);
  }
  return out;
}

// ── C19(a)：[500,200] → 最终拿到快照；期间 warn 含状态码与 attempt ──
{
  const client = await loadClient(createReactRuntime().react);
  const seq = makeFetchSeq([500, 200]);
  const warn = captureWarn();
  let snapshot = null;
  let threw = null;
  try {
    snapshot = await client.fetchSnapshot(seq.fake);
  } catch (error) {
    threw = String(error?.message ?? error);
  } finally {
    warn.restore();
  }
  check('C19-retry-recovers',
    threw === null && snapshot !== null && snapshot.at === 0.45
    && warn.lines.some((line) => /HTTP 500/.test(line)) && warn.lines.some((line) => /attempt 1\//.test(line)),
    `snapshot=${JSON.stringify(snapshot)} threw=${threw} warn=${JSON.stringify(warn.lines)}`);
}

// ── C19(b)：全失败 → null、warn 含失败次数、chipLabel=压 —、不抛 ──
{
  const client = await loadClient(createReactRuntime().react);
  const seq = makeFetchSeq([500, 500, 500]);
  const warn = captureWarn();
  let snapshot = 'unset';
  let threw = null;
  try {
    snapshot = await client.fetchSnapshot(seq.fake);
  } catch (error) {
    threw = String(error?.message ?? error);
  } finally {
    warn.restore();
  }
  check('C19-all-fail',
    threw === null && snapshot === null && client.chipLabel(null) === '压 —'
    && warn.lines.some((line) => /failed after 3 attempts/.test(line)) && warn.lines.some((line) => /HTTP 500/.test(line)),
    `snapshot=${JSON.stringify(snapshot)} warn=${JSON.stringify(warn.lines)}`);
}

// ── C19(c)：mount / 打开气泡 / 保存成功 / focus 各触发取数（假 fetch 计数） ──
{
  const runtime = createReactRuntime();
  let focusHandler = null;
  const windowStub = {
    __capture: true,
    __ModuleLoader__: { load: () => {} },
    addEventListener: (type, handler) => { if (type === 'focus') focusHandler = handler; },
    removeEventListener: () => {},
    document: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  const savedWindow = globalThis.window;
  globalThis.window = windowStub;
  let client = null;
  try {
    client = await loadClient(runtime.react);
  } catch (error) {
    globalThis.window = savedWindow;
    throw error;
  }

  const seq = makeFetchSeq([200, 200, 200, 200, 200, 200, 200, 200]);
  const components = [];
  client.apply({
    locale: { language: 'zh' },
    slots: { inject: (name, callback) => callback(), register: (spec, component) => components.push({ spec, component }) },
    fetch: seq.fake,
    configForms: { get: () => ({ set: async () => true }) },
  });
  const chipComp = components.find((item) => item.spec.name === 'conversation.composer.dock')?.component;
  const bubbleComp = components.find((item) => item.spec.name === 'conversation.input.overlay')?.component;

  const props = {
    ctx: {
      locale: { language: 'zh' },
      fetch: seq.fake,
      configForms: { get: () => ({ set: async () => true }) },
    },
  };

  const chip = chipComp ? runtime.mount(chipComp, props) : null;
  await sleep(20);
  const afterMount = seq.count();

  const bubble = bubbleComp ? runtime.mount(bubbleComp, props) : null;
  await sleep(20);
  const afterBubbleMount = seq.count();

  // 打开气泡：点 chip → store.open=true → 气泡 rerender（expected: 触发一次取数）
  try { chip?.tree?.props?.onClick?.(); } catch { /* ignore */ }
  await sleep(40);
  const afterOpen = seq.count();

  // 保存成功：填输入 60 → 点保存 → 成功后刷新（expected: 触发取数）
  let afterSave = afterOpen;
  const inputElement = findElement(bubble?.tree, (node) => node.type === 'input')[0];
  if (inputElement?.props?.onChange) {
    try { inputElement.props.onChange({ target: { value: '60' } }); } catch { /* ignore */ }
    await sleep(20);
  }
  const buttonLabel = (node) => String(node.props?.children ?? '') + (node.children ?? []).map((child) => (typeof child === 'string' ? child : '')).join('');
  const saveButton = findElement(bubble?.tree, (node) => node.type === 'button' && buttonLabel(node).includes('保存') && !buttonLabel(node).includes('恢复'))[0];
  if (saveButton?.props?.onClick) {
    try { await saveButton.props.onClick(); } catch { /* ignore */ }
    await sleep(60);
    afterSave = seq.count();
  }

  // focus 触发
  const beforeFocus = seq.count();
  if (typeof focusHandler === 'function') { try { focusHandler(); } catch { /* ignore */ } }
  await sleep(60);
  const afterFocus = seq.count();

  check('C19-mount-fetch', afterMount >= 1, `mount 后取数=${afterMount}`);
  check('C19-open-refetch', afterOpen > afterBubbleMount, `气泡 mount 后=${afterBubbleMount} 打开后=${afterOpen}`);
  check('C19-save-refetch', afterSave > afterOpen, `保存后=${afterSave}（打开后=${afterOpen}）`);
  check('C19-focus-refetch', afterFocus > beforeFocus, `focus 前=${beforeFocus} focus 后=${afterFocus}`);
  globalThis.window = savedWindow;
  void chip;
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC19 TOTAL ${results.length - failed.length}/${results.length} PASS（修复落地前预期为基线红）`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
