/**
 * B6 真机取证片段 v2（用户/00 在 DevTools Console 粘贴执行，一次性输出全部所需事实）。
 *
 * 用法：打开气泡（面板在右下角、对话区空白的状态）→ Console 粘贴整段 → 回车 → 复制 `B6PROBE` 那行 JSON 回来。
 * 只读：不改 DOM、不写存储、不发网络请求。
 *
 * v2 变更（审核 2026-11-15 口径）：
 *  - `stackAtChatCenter`：用 `elementsFromPoint` 取**全栈**（top 8），区分 A/C/D 三支；
 *  - `panelChain`：祖先链 10 层，每层带 rect + position + transform/filter/contain/overflow + background + zIndex；
 *  - 保留 `pointCenterTop`（单点）与 `panelStyle`。
 */
(() => {
  const panel = document.querySelector('[role="dialog"][aria-modal="true"]')
    ?? [...document.querySelectorAll('[role="dialog"]')].pop();
  const chip = document.querySelector('[data-cg-chip]');
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const styleOf = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { position: cs.position, left: cs.left, top: cs.top, width: cs.width, height: cs.height,
      transform: cs.transform, filter: cs.filter, contain: cs.contain, overflow: cs.overflow,
      zIndex: cs.zIndex, background: cs.backgroundColor, display: cs.display, opacity: cs.opacity };
  };
  const describe = (el) => (el ? {
    tag: el.tagName,
    cls: String(el.className ?? '').slice(0, 80),
    id: el.id || null,
    role: el.getAttribute?.('role') ?? null,
    rect: rectOf(el),
    style: styleOf(el),
  } : null);

  // 面板祖先链 10 层：谁有 transform/filter/contain/overflow/不透明底，谁就是"劫持者/遮罩者"
  const panelChain = [];
  for (let el = panel?.parentElement, i = 0; el && i < 10; el = el.parentElement, i += 1) {
    panelChain.push(describe(el));
  }

  // 对话区中心：单点 + 全栈（区分"我们的全覆盖容器"(D) / "宿主全屏层"(C) / "被 fixed 劫持"(A)）
  const cx = Math.round(innerWidth / 2);
  const cy = Math.round(innerHeight / 2);
  const stack = (typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(cx, cy) : [])
    .slice(0, 8)
    .map(describe);

  const probe = {
    viewport: { innerWidth, innerHeight, dpr: devicePixelRatio, scrollY },
    chip: rectOf(chip),
    panel: rectOf(panel),
    panelStyle: styleOf(panel),
    panelChain,
    pointCenterTop: stack[0] ?? null,
    stackAtChatCenter: stack,
  };
  console.log('B6PROBE ' + JSON.stringify(probe));
  return probe;
})();
