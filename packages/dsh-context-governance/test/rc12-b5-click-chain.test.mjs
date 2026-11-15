/**
 * B5（rc.12a 回归门）：点击链路 + hook 顺序稳定。
 *
 * 真机 rc.12 现象：chip 点不动、气泡点不开（两个入口整体无响应）。
 * 根因：C40 把定位用的 `useState/useEffect` 放在 `if (!open) return null` **之后**——
 *   关闭态与打开态渲染的 hook 数量不同（14 → 16），React 抛
 *   "Rendered more hooks than during the previous render"，气泡渲染崩掉 → 入口表现为全哑。
 *
 * 本门用"严格 hook 计数"的假 React：同一组件两次渲染 hook 数量不等即抛错（与 React 同构），
 * 并真实走 chip.onClick → store.open、气泡 Esc → store.open 的关闭链路。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

let seq = 0;

async function loadStrict() {
  const captured = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(`${pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href}?v=b5-${seq += 1}`);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(captured.length, 1, 'client.js 必须自执行 load');
  const counts = [];
  let hookCount = 0;
  const bag = new Map();
  const reactStub = {
    Component: class { constructor(props) { this.props = props; this.state = {}; } },
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState(initial) {
      const index = hookCount;
      hookCount += 1;
      if (!bag.has(index)) bag.set(index, initial);
      const setter = (next) => { bag.set(index, typeof next === 'function' ? next(bag.get(index)) : next); };
      return [bag.get(index), setter];
    },
    useEffect(fn) {
      hookCount += 1;
      try { fn(); } catch { /* effect 内 DOM 访问允许失败 */ }
      return undefined;
    },
    useRef(initial) { hookCount += 1; return { current: initial }; },
    begin() { hookCount = 0; },
    end() { counts.push(hookCount); return hookCount; },
    reset() { hookCount = 0; bag.clear(); counts.length = 0; },
  };
  // B6：气泡 portal 到 body，测试给 react-dom stub。
  const reactDomStub = { createPortal: (node, container) => ({ __portal: true, node, container }) };
  globalThis.document = globalThis.document ?? { body: { __kind: 'body' } };
  const client = captured[0].factory((name) => {
    if (name === 'react') return reactStub;
    if (name === 'react-dom') return reactDomStub;
    return {};
  });
  return { client, react: reactStub };
}

function makeStore() {
  const store = {
    value: { open: false, snapshot: { at: 0.45, source: 'session:A1', defaultAt: 0.45 } },
    listeners: new Set(),
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    set(next) { this.value = { ...this.value, ...next }; for (const listener of this.listeners) listener(this.value); },
    get() { return this.value; },
  };
  return store;
}

test('B5：chip 点击必须打开气泡（不能"点不动"）', async () => {
  const { client, react } = await loadStrict();
  const store = makeStore();
  const state = { snapshot: store.value.snapshot, open: false };
  const Chip = client.createChip(state, store, { get: () => undefined });
  react.begin();
  const tree = Chip({ session: { id: 'session-b5' } });
  react.end();
  assert.ok(tree && tree.props, 'chip 必须渲染出节点');
  const handler = tree.props.onClick ?? tree.props.onPointerDown;
  assert.equal(typeof handler, 'function', 'chip 必须有可点的 onClick/onPointerDown');
  handler({ preventDefault() {}, stopPropagation() {} });
  assert.equal(store.value.open, true, 'chip 点击必须把 open 置 true');
});

test('B5：关闭态与打开态的 hook 数量必须一致（条件 hook = 气泡必崩）', async () => {
  const { client, react } = await loadStrict();
  const store = makeStore();
  const openSession = { session: { id: 'session-b5' } };

  // 关闭态：同一组件实例渲染 → 返回 null
  const closedBubble = client.createBubble({ snapshot: store.value.snapshot, open: false }, store, { get: () => undefined });
  react.reset();
  react.begin();
  const closedTree = closedBubble(openSession);
  const closedCount = react.end();
  assert.equal(closedTree, null, '关闭态应渲染 null（不挂载对话框）');

  // 打开态：新实例、hook 必须与关闭态同数量（React 校验同构）
  react.reset();
  const openBubble = client.createBubble({ snapshot: store.value.snapshot, open: true }, store, { get: () => undefined });
  react.begin();
  const openTree = openBubble(openSession);
  const openCount = react.end();
  assert.ok(openTree !== null, '打开态必须渲染出对话框');
  assert.equal(openCount, closedCount,
    `hook 数量必须跨开关一致（关闭 ${closedCount} / 打开 ${openCount}）——不一致即 React 抛 Rendered more hooks`);
});

test('B5：closed→open→closed→open 三轮往返不抛（状态切换门，不是单帧）', async () => {
  const { client, react } = await loadStrict();
  const store = makeStore();
  const Bubble = client.createBubble({ snapshot: store.value.snapshot, open: false }, store, { get: () => undefined });
  const errors = [];
  const render = () => {
    react.begin();
    let tree = null;
    try {
      tree = Bubble({ session: { id: 'session-b5' } });
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
    try { react.end(); } catch (error) { errors.push(String(error?.message ?? error)); }
    return tree;
  };

  react.reset();
  assert.equal(render(), null, '第 1 轮：关闭态渲染 null');
  store.set({ open: true });
  assert.ok(render() !== null, '第 1 轮：打开必须渲染');
  store.set({ open: false });
  assert.equal(render(), null, '第 1 轮：关闭回到 null');
  store.set({ open: true });
  assert.ok(render() !== null, '第 2 轮：再次打开必须渲染');
  store.set({ open: false });
  assert.equal(render(), null, '第 2 轮：再次关闭回到 null');

  assert.equal(errors.length, 0, `三轮往返不得抛错：${JSON.stringify(errors)}`);
  // 防假绿：任何一次渲染里出现 hook 相关报错文本即失败。
  assert.equal(errors.some((text) => /hooks/i.test(text)), false, 'hook 相关报错必须判失败');
});

test('B6：气泡 portal 到 document.body（父节点 === body，不在 slot 容器内）', async () => {
  const captured = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const body = { __kind: 'body' };
  const store = makeStore();
  let tree = null;
  try {
    globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
    globalThis.document = { body };
    await import(`${pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href}?v=b6p-${seq += 1}`);
    const reactStub = {
      Component: class {},
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
    };
    const reactDomStub = { createPortal: (node, container) => ({ __portal: true, node, container }) };
    const client = captured[0].factory((name) => {
      if (name === 'react') return reactStub;
      if (name === 'react-dom') return reactDomStub;
      return {};
    });
    const Bubble = client.createBubble({ snapshot: store.value.snapshot, open: true }, store, { get: () => undefined });
    // 渲染时 document 必须是 stub —— portal 目标是文档级 body。
    tree = Bubble({ session: { id: 'session-b6' } });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
  assert.equal(tree?.__portal, true, '必须走 portal（不能直接渲染在 slot 容器内）');
  assert.equal(tree.container, body, 'portal 容器必须是 document.body（父节点 === body）');
  assert.equal(tree.node?.props?.['data-cg-portaled'], '1', 'wrapper 必须带 data-cg-portaled 标记（真机一眼可核）');
  const panelNode = tree.node?.props?.children?.[0] ?? tree.node?.props?.children;
  assert.equal(panelNode?.props?.['data-cg-panel'], '1', 'portal 里只挂单个面板节点（data-cg-panel）');
  assert.equal(panelNode?.props?.role, 'dialog');
});

test('B5：气泡能关（Esc → open=false）且对话框可点', async () => {
  const { client, react } = await loadStrict();
  const store = makeStore();
  store.value.open = true;
  const Bubble = client.createBubble({ snapshot: store.value.snapshot, open: true }, store, { get: () => undefined });
  react.begin();
  const tree = Bubble({ session: { id: 'session-b5' } });
  react.end();
  assert.ok(tree, '打开态必须有树');
  // portal 后顶层是 marker，对话框在 children 里（非 portal 时就是自身）。
  const childOf = tree.node?.props?.children;
  const dialogNode = tree.__portal === true ? (Array.isArray(childOf) ? childOf[0] : (childOf ?? tree.node)) : tree;
  assert.equal(typeof dialogNode.props.onKeyDown, 'function', '对话框必须有 onKeyDown（Esc 关闭）');
  dialogNode.props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} });
  assert.equal(store.value.open, false, 'Esc 必须关闭气泡');
});
