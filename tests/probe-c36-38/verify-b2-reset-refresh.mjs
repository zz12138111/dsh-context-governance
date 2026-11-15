/**
 * 测试角色 · B2「reset 后走真实刷新链路」门（2026-11-15 需求/审核要求：不许只读 store 或直调 resetToGlobal）。
 *
 * 链路：vm 载 `lib/client.js` → 以迷你 hooks 运行时渲染气泡（state.open=true、snapshot=session:A1/45）
 *   → 找到并点击「恢复全局设置」按钮 → fetch 桩对 POST 返回 ok、对 GET 快照返回 plugin/58
 *   → 等订阅通知重渲染 → 断言**气泡文本**（来源层/生效时点/写入层）与**输入框值**三件同刷。
 *
 * 判据：reset 后 input=58、来源层=全局（source=plugin）、生效时点="保存后生效、重启仍有效"、无「重启失效」。
 *
 * 用法：node tests\probe-c36-38\verify-b2-reset-refresh.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const src = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('\n');
  const children = node.children ?? [];
  const own = node.props?.children;
  return `${textOf(children)}${own === undefined ? '' : `\n${textOf(own)}`}`;
}
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const item of node) findAll(item, predicate, out); return out; }
  if (typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  findAll(node.children ?? [], predicate, out);
  if (node.props?.children !== undefined) findAll(node.props.children, predicate, out);
  return out;
}

try {
  let spec = null;
  const requests = [];
  let resetCalled = false;
  const pluginSnapshotStub = { at: 0.58, source: 'plugin', sessionOverride: null, effectiveAt: '保存后生效、重启仍有效', native: 0.6785, defaultAt: 0.6 };
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url).includes('policy-snapshot')) {
      const snapshot = resetCalled
        ? { ...pluginSnapshotStub }
        : { at: 0.45, source: 'session:A1', sessionOverride: 0.45, effectiveAt: '本会话有效，重启后失效', native: 0.6785, defaultAt: 0.6 };
      return { ok: true, json: async () => snapshot };
    }
    resetCalled = true;
    return { ok: true, json: async () => ({ ok: true, reset: true, source: 'plugin' }) };
  };
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
    console,
    setTimeout,
    clearTimeout,
    fetch: fakeFetch,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // 迷你 hooks 运行时：每次渲染重置 cursor；set 值变化才重渲染；effect 每次渲染前清理。
  const hooks = [];
  const cleanups = new Map();
  const effectDeps = new Map();
  let cursor = 0;
  let schedule = null;
  const enqueue = (fn) => { queueMicrotask(() => { try { fn(); } catch { /* ignore */ } }); };

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (hooks[index] === undefined) hooks[index] = initial;
      const set = (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value;
        if (Object.is(next, hooks[index])) return;
        hooks[index] = next;
        if (schedule !== null) schedule();
      };
      return [hooks[index], set];
    },
    useEffect(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previousDeps = effectDeps.get(index);
      const changed = deps === undefined || previousDeps === undefined
        || deps.length !== previousDeps.length
        || deps.some((value, position) => !Object.is(value, previousDeps[position]));
      if (!changed) return;
      effectDeps.set(index, Array.isArray(deps) ? [...deps] : undefined);
      enqueue(() => {
        const previous = cleanups.get(index);
        if (typeof previous === 'function') { try { previous(); } catch { /* ignore */ } }
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.set(index, cleanup);
      });
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (hooks[index] === undefined) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
  };
  // B6（rc.14）：气泡 portal 到 document.body；`require` 是 factory 参数，必须放行 react-dom，
  // 否则"不渲染 + warn"会让本门假红（这是 stub 缺件，不是实现退化）。
  const fakeReactDom = { createPortal: (node, container) => ({ type: 'portal', props: { container }, children: [node], __portalContainer: container }) };
  const client = typeof spec?.factory === 'function'
    ? spec.factory((name) => (name === 'react' ? react : (name === 'react-dom' ? fakeReactDom : {})))
    : null;
  check('B2-client-loadable', typeof client?.createBubble === 'function' && typeof client?.createSettingsCard === 'function',
    `createBubble=${typeof client?.createBubble}`);

  const sessionId = 'session-b2reset-1111-2222-3333-444455556666';
  const state = { open: true, snapshot: { at: 0.45, source: 'session:A1', sessionOverride: 0.45, effectiveAt: '本会话有效，重启后失效' } };
  const store = {
    set(next) { Object.assign(state, next); for (const listener of store.listeners) listener(state); },
    listeners: new Set(),
    subscribe(listener) { store.listeners.add(listener); return () => store.listeners.delete(listener); },
  };
  const pluginCtx = { locale: { language: 'zh' }, sessionId };

  const Bubble = client.createBubble(state, store, pluginCtx);
  const renderTree = () => { cursor = 0; return Bubble({ sessionId, ctx: pluginCtx }); };

  let tree = null;
  let renderError = null;
  try {
    tree = renderTree();
    await flush();
    tree = renderTree();
    await flush();
  } catch (error) {
    renderError = error;
  }
  check('B2-render-bubble-without-throw', renderError === null && tree !== null,
    `err=${renderError === null ? 'none' : String(renderError.message).slice(0, 160)}（B4：client.js 缺声明会在此抛 ReferenceError）`);
  if (renderError !== null) { throw renderError; }
  const beforeText = textOf(tree);
  const beforeInput = findAll(tree, (node) => node.type === 'input')[0]?.props?.value ?? null;
  check('B2-before-reset-shows-session-a1',
    String(beforeInput) === '45' && beforeText.includes('source=session:A1'),
    `input=${JSON.stringify(beforeInput)} 来源行=${JSON.stringify(beforeText.split('\n').find((line) => line.includes('来源层')) ?? '')}`);

  const resetButton = findAll(tree, (node) => node.type === 'button' && typeof node.props?.onClick === 'function'
    && textOf(node).includes('恢复全局设置'))[0];
  check('B2-reset-button-present', resetButton !== undefined,
    `buttons=${JSON.stringify(findAll(tree, (node) => node.type === 'button').map((node) => textOf(node)))}`);

  if (resetButton !== undefined) {
    await resetButton.props.onClick();
    await flush();
    tree = renderTree();
    await flush();
    const afterText = textOf(tree);
    const afterInput = findAll(tree, (node) => node.type === 'input')[0]?.props?.value ?? null;
    check('B2-reset-refresh-input-value', String(afterInput) === '58',
      `input=${JSON.stringify(afterInput)}（期望 "58"；rc.11 留 "45"=输入框未重算）`);
    check('B2-reset-refresh-source-layer',
      afterText.includes('source=plugin') && afterText.includes('全局（影响所有会话）'),
      `来源行=${JSON.stringify(afterText.split('\n').filter((line) => line.includes('来源层')))}`);
    check('B2-reset-refresh-lifecycle',
      afterText.includes('保存后生效、重启仍有效') && !afterText.includes('重启失效'),
      `生效时点=${JSON.stringify(afterText.split('\n').filter((line) => line.includes('生效时点')))}`);
    check('B2-reset-posts-then-refetches',
      requests.some((item) => item.method === 'POST' && item.url.includes('session-policy'))
        && requests.some((item) => item.method === 'GET' && item.url.includes('policy-snapshot')),
      `requests=${JSON.stringify(requests)}（期望 reset POST 后重取快照）`);
  }
} catch (error) {
  check('B2-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nB2 reset 真实刷新链路 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
