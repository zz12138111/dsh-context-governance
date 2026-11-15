/**
 * 测试角色 · B5「点击能打开 / 能关闭」门（2026-11-15 rc.12 真机 BLOCKER 补门，v3）。
 *
 * 真机证据（00 DevTools）：`Uncaught Error: Minified React error #310`（Rendered more hooks than
 * during the previous render），组件 = `conversation.input.overlay`（`client.js` 的 `createBubble`）。
 * 根因：`87794f2` 里 `if (!open) return null`（`L662`）在 `const [layout] = useState`（`L669`）之前
 *   → 关闭态 14 hook、打开态 16 hook → 首次点 chip 崩、chip/气泡齐哑。
 *
 * 本门 v1/v2 的教训：迷你运行时若把所有组件塞进同一个 hooks 数组，hook 数永远"稳定"，测不出；
 *   且必须**同一组件实例**先 closed 再 open（新 mount 一帧 open 永远不触发 #310）。
 * v3：每组件实例独立 hooks/deps/cleanups；store 驱动 setState → 微任务重渲染；
 *   对同一 bubble 实例做 close→open→close→open 往返，比较每次 hook 数——不一致即模拟 #310 判红。
 *
 * 判据：①点击 toggle ②Enter 开/Esc 关 ③点外部关 ④切会话自动关 ⑤open 态渲染 role=dialog
 *   ⑥**同一实例 open/close 的 hook 数一致**（不一致＝React #310）。
 *
 * 用法：node tests\probe-c36-38\verify-b5-click-open.mjs
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

try {
  let spec = null;
  const fakeFetch = async (url) => {
    if (String(url).includes('policy-snapshot')) {
      return { ok: true, json: async () => ({ at: 0.45, source: 'session:A1', sessionOverride: 0.45, effectiveAt: '本会话有效，重启后失效', native: 0.6785, defaultAt: 0.6 }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const listeners = { pointerdown: new Set(), keydown: new Set(), focus: new Set() };
  const fakeDocument = {
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    querySelector: () => null,
    addEventListener: (type, fn) => { if (listeners[type]) listeners[type].add(fn); },
    removeEventListener: (type, fn) => { if (listeners[type]) listeners[type].delete(fn); },
  };
  const fakeWindow = {
    __ModuleLoader__: { load: (value) => { spec = value; } },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, fn) => { if (listeners[type]) listeners[type].add(fn); },
    removeEventListener: (type, fn) => { if (listeners[type]) listeners[type].delete(fn); },
  };
  const sandbox = { window: fakeWindow, document: fakeDocument, innerWidth: 1200, innerHeight: 800, console, setTimeout, clearTimeout, fetch: fakeFetch };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // 迷你 hooks 运行时：每个组件实例独立 hooks；setState 微任务重渲染（模拟 React 异步渲染）。
  let active = null;
  const enqueue = (fn) => { queueMicrotask(() => { try { fn(); } catch { /* ignore */ } }); };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const inst = active;
      const index = inst.cursor;
      inst.cursor += 1;
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
      const inst = active;
      const index = inst.cursor;
      inst.cursor += 1;
      const previousDeps = inst.deps.get(index);
      const changed = deps === undefined || previousDeps === undefined
        || deps.length !== previousDeps.length
        || deps.some((value, position) => !Object.is(value, previousDeps[position]));
      if (!changed) return;
      inst.deps.set(index, Array.isArray(deps) ? [...deps] : undefined);
      enqueue(() => {
        const previous = inst.cleanups.get(index);
        if (typeof previous === 'function') { try { previous(); } catch { /* ignore */ } }
        const cleanup = fn();
        if (typeof cleanup === 'function') inst.cleanups.set(index, cleanup);
      });
    },
    useRef(initial) {
      const inst = active;
      const index = inst.cursor;
      inst.cursor += 1;
      if (inst.hooks[index] === undefined) inst.hooks[index] = { current: initial };
      return inst.hooks[index];
    },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    Component: class Base { constructor(props) { this.props = props; } },
  };
  const client = typeof spec?.factory === 'function' ? spec.factory((name) => (name === 'react' ? react : {})) : null;
  check('B5-client-loadable', typeof client?.createChip === 'function' && typeof client?.createBubble === 'function',
    `createChip=${typeof client?.createChip} createBubble=${typeof client?.createBubble}`);

  function mount(Component) {
    const inst = {
      hooks: [], deps: new Map(), cleanups: new Map(), cursor: 0, props: null, last: { tree: null, error: null, hookCount: 0 },
      render(props) {
        inst.props = props;
        active = inst;
        inst.cursor = 0;
        let tree = null;
        let error = null;
        try { tree = Component(props); } catch (thrown) { error = thrown; }
        const hookCount = inst.cursor;
        active = null;
        inst.last = { tree, error, hookCount };
        return inst.last;
      },
    };
    return inst;
  }

  const sessionId = 'session-b5click-1111-2222-3333-444455556666';
  const state = { open: false, snapshot: { at: 0.45, source: 'session:A1', sessionOverride: 0.45, effectiveAt: '本会话有效，重启后失效' } };
  const store = {
    set(next) { Object.assign(state, next); for (const listener of store.listeners) listener(state); },
    listeners: new Set(),
    subscribe(listener) { store.listeners.add(listener); return () => store.listeners.delete(listener); },
  };
  const pluginCtx = { locale: { language: 'zh' }, sessionId };

  // ---- chip 点击链（独立实例）----
  const chip = mount(client.createChip(state, store, pluginCtx));
  chip.render({ sessionId, ctx: pluginCtx });
  await flush();
  chip.render({ sessionId, ctx: pluginCtx });
  await flush();
  check('B5-chip-renders-without-throw', chip.last.error === null && chip.last.tree !== null,
    `err=${chip.last.error === null ? 'none' : String(chip.last.error.message).slice(0, 160)}`);

  const chipNode = () => findAll(chip.last.tree, (node) => node.props?.['data-cg-chip'] === 'true')[0];
  check('B5-chip-has-onclick', typeof chipNode()?.props?.onClick === 'function',
    `chip=${chipNode() === undefined ? 'missing' : 'present'} onClick=${typeof chipNode()?.props?.onClick}`);

  chipNode()?.props?.onClick?.();
  await flush();
  let expanded = chipNode()?.props?.['aria-expanded'];
  check('B5-chip-click-opens', state.open === true && expanded === 'true',
    `state.open=${state.open} aria-expanded=${JSON.stringify(expanded)}`);

  chipNode()?.props?.onClick?.();
  await flush();
  expanded = chipNode()?.props?.['aria-expanded'];
  check('B5-chip-click-again-closes', state.open === false && expanded === 'false',
    `state.open=${state.open} aria-expanded=${JSON.stringify(expanded)}`);

  chipNode()?.props?.onKeyDown?.({ key: 'Enter', preventDefault() {} });
  await flush();
  check('B5-chip-enter-opens', state.open === true, `state.open=${state.open}`);
  chipNode()?.props?.onKeyDown?.({ key: 'Escape' });
  await flush();
  check('B5-chip-escape-closes', state.open === false, `state.open=${state.open}`);

  // ---- 气泡：同一实例 close→open→close→open（这是真机 #310 的触发形态）----
  const bubble = mount(client.createBubble(state, store, pluginCtx));
  const bubbleProps = (sid) => ({ sessionId: sid, ctx: pluginCtx });
  const closed1 = bubble.render(bubbleProps(sessionId));
  await flush();
  check('B5-bubble-closed-renders', closed1.error === null,
    `hookCount=${closed1.hookCount} err=${closed1.error === null ? 'none' : String(closed1.error.message).slice(0, 120)}`);

  store.set({ open: true });
  await flush(); // store 通知 → setOpen(true)
  const open1 = bubble.last;
  const dialog = findAll(open1.tree ?? null, (node) => node.props?.role === 'dialog')[0];
  check('B5-open-bubble-renders-dialog', open1.error === null && dialog !== undefined,
    `hookCount=${open1.hookCount} err=${open1.error === null ? 'none' : String(open1.error.message).slice(0, 160)} dialog=${dialog !== undefined}`);

  const counts = [closed1.hookCount, open1.hookCount];
  store.set({ open: false });
  await flush();
  counts.push(bubble.last.hookCount);
  store.set({ open: true });
  await flush();
  counts.push(bubble.last.hookCount);
  const stable = counts.every((count) => count === counts[0]) && open1.error === null;
  check('B5-bubble-hook-count-stable-across-open-close', stable,
    `hookCounts(closed,open,closed,open)=${JSON.stringify(counts)}`
    + `${stable ? '' : ' → 模拟 React #310 "Rendered more hooks than during the previous render"(conversation.input.overlay)'}`);

  // 点外部关闭（当前 open 态）
  store.set({ open: true });
  await flush();
  const outsideHandler = [...(listeners.pointerdown ?? [])].pop();
  if (typeof outsideHandler === 'function') {
    outsideHandler({ target: { closest: () => null } });
    await flush();
    check('B5-outside-pointer-closes', state.open === false, `state.open=${state.open}`);
  } else {
    check('B5-outside-pointer-closes', false, '未注册 document pointerdown 监听');
  }

  // 切会话自动关闭：同一实例改 props.sessionId
  store.set({ open: true });
  await flush();
  bubble.render(bubbleProps('session-b5-other-9999'));
  await flush();
  check('B5-session-switch-closes', state.open === false, `state.open=${state.open}（切会话应自动关）`);
} catch (error) {
  check('B5-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nB5 点击开/关交互门 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
