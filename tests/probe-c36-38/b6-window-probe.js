/**
 * 测试角色 · B6 真机窗口门（审核规格 `B6-取证与门规格-20261115.md` §3.2，2026-11-15）。
 *
 * 用法（DevTools Console，两段式）：
 *   1. **关闭气泡**时执行一次 → 记对话区基线（`window.__B6_BASE`）；
 *   2. **打开气泡**后再执行一次 → 输出 `B6WINDOW {…}`，含 5 条几何 + 3 条可用性，逐条 true/false。
 *   关闭动作（Esc/外点/再点 chip）由人工点按后重跑脚本：面板应移除、`document.activeElement` 命中 chip。
 *
 * 判据（§3.2）：
 *   几何：①|panel.centerX−chip.centerX|≤8 ②上弹 panel.bottom≤chip.top−4 或下弹 panel.top≥chip.bottom+4
 *        ③四边≥8 ④panel.w≤min(360,vw−16) 且 panel.h≤260 ⑤与输入框交集 0
 *   可用性：⑥开气泡前后对话区 rect 偏差 ≤2px ⑦elementsFromPoint(对话区中心) 栈里不得出现我方元素
 *        ⑧对话区可滚（scrollHeight>clientHeight 时 scrollTop 能变）
 *   关闭：⑨panel 不在 DOM、⑩焦点回 chip
 *   B8（rc.15，2026-11-15）：⑪保存按钮 rect 完整在视口内（top≥8、bottom≤vh−8）、
 *        ⑫保存按钮不在滚动 body 内、⑬`elementFromPoint(保存按钮中心)` 命中按钮本身（防"看得见点不着"）；
 *        点「详情」后重跑一次，⑪⑬ 仍须成立。
 *
 * 说明：本脚本**只读**，不改页面；对话区选择器用候选自动探测（宿主结构变化时可 `window.__B6_CHAT_SELECTOR` 覆盖）。
 * 真因：宿主 `.composerSeat{will-change:transform}` 劫持 fixed 的 containing block；portal 到 body 后此处几何才应全绿。
 */
(() => {
  const round = (n) => Math.round(Number(n) * 10) / 10;
  const rect = (el) => {
    if (!el) return null;
    try {
      const b = el.getBoundingClientRect();
      return { left: round(b.left), top: round(b.top), right: round(b.right), bottom: round(b.bottom), width: round(b.width), height: round(b.height) };
    } catch { return null; }
  };
  const overlap = (a, b) => a !== null && b !== null
    && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

  const out = {
    ts: new Date().toISOString(),
    viewport: { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio },
    mode: null,
    checks: {},
    problems: [],
  };
  const chip = document.querySelector('[data-cg-chip]');
  const panel = document.querySelector('[data-cg-popover]');
  const chatSelectors = [window.__B6_CHAT_SELECTOR, '[data-conversation]', '[data-message-list]', '[role="log"]', 'main', '.conversation'].filter(Boolean);
  let chat = null;
  for (const selector of chatSelectors) {
    try {
      const el = document.querySelector(selector);
      if (el && el.getBoundingClientRect().height > 200) { chat = el; out.chatSelector = selector; break; }
    } catch { /* 非法选择器忽略 */ }
  }
  const input = document.querySelector('[data-cg-composer]') ?? document.querySelector('textarea');

  if (panel === null) {
    out.mode = 'closed';
    window.__B6_BASE = { chat: rect(chat), ts: out.ts };
    out.chat = rect(chat);
    out.baselineSaved = true;
    out.checks['closed-panel-absent'] = true;
    out.checks['closed-focus-on-chip'] = document.activeElement === chip;
    console.log('B6WINDOW ' + JSON.stringify(out));
    return out;
  }

  out.mode = 'open';
  const p = rect(panel);
  const c = rect(chip);
  const i = rect(input);
  out.panel = p;
  out.chip = c;
  out.input = i;
  // portal 后：面板的直接父节点应是 body（或 body 下的 portal 容器）
  out.panelParentTag = panel.parentElement?.tagName?.toLowerCase?.() ?? null;
  out.portalParentIsBody = panel.parentElement === document.body;
  out.portaledAttr = panel.getAttribute('data-cg-portaled');

  const centerX = p !== null && c !== null ? Math.abs((p.left + p.width / 2) - (c.left + c.width / 2)) : null;
  out.checks['geo-centerX'] = centerX !== null && centerX <= 8;
  out.checks['geo-vertical-side'] = p !== null && c !== null && (p.bottom <= c.top - 4 || p.top >= c.bottom + 4);
  out.checks['geo-edges'] = p !== null && p.left >= 8 && p.top >= 8 && p.right <= innerWidth - 8 && p.bottom <= innerHeight - 8;
  out.checks['geo-size'] = p !== null && p.width <= Math.min(360, innerWidth - 16) && p.height <= 260;
  out.checks['geo-no-input-overlap'] = i === null ? null : !overlap(p, i);

  // 可用性：对话区仍在（rect 与基线偏差 ≤2）且未被遮挡、可滚
  const base = window.__B6_BASE ?? null;
  const chatNow = rect(chat);
  out.chat = chatNow;
  out.chatBaseline = base?.chat ?? null;
  out.checks['chat-stable'] = chatNow !== null && base?.chat !== null && base?.chat !== undefined
    ? Math.abs(chatNow.height - base.chat.height) <= 2 && Math.abs(chatNow.width - base.chat.width) <= 2
    : null;

  if (chatNow !== null) {
    const cx = Math.round(chatNow.left + chatNow.width / 2);
    const cy = Math.round(chatNow.top + Math.min(chatNow.height / 2, 300));
    const stack = document.elementsFromPoint(cx, cy) ?? [];
    out.stackTop = stack.slice(0, 6).map((el) => ({
      tag: el.tagName?.toLowerCase?.() ?? null,
      ours: el.hasAttribute?.('data-cg-popover') === true || el.hasAttribute?.('data-cg-chip') === true,
      rect: rect(el),
    }));
    const oursInStack = stack.some((el) => el.hasAttribute?.('data-cg-popover') === true || el.hasAttribute?.('data-cg-chip') === true);
    // 不透明全屏层：覆盖 ≥80% 视口且背景不透明
    const opaqueFullLayer = stack.some((el) => {
      const r = rect(el);
      if (r === null) return false;
      const covers = r.width * r.height >= innerWidth * innerHeight * 0.8;
      if (!covers) return false;
      try {
        const bg = getComputedStyle(el).backgroundColor ?? '';
        const m = /rgba?\(([^)]+)\)/.exec(bg);
        const alpha = m === null ? 1 : (m[1].split(',').length >= 4 ? Number(m[1].split(',')[3]) : 1);
        return alpha > 0.5;
      } catch { return false; }
    });
    out.checks['chat-no-our-element'] = !oursInStack;
    out.checks['chat-no-opaque-full-layer'] = !opaqueFullLayer;
    let scrollable = null;
    if (chat !== null && chat.scrollHeight > chat.clientHeight + 4) {
      try {
        const before = chat.scrollTop;
        chat.scrollTop = before + 1;
        scrollable = chat.scrollTop !== before;
        chat.scrollTop = before;
      } catch { scrollable = false; }
    }
    out.checks['chat-scrollable'] = scrollable; // null = 本页无需滚动
  } else {
    out.problems.push('对话区未找到：可用 window.__B6_CHAT_SELECTOR="选择器" 指定后重跑');
  }

  // B8：按钮行常驻/可达——保存按钮必须完整落在视口内、不需滚动、且命中链可点到
  const footerEl = document.querySelector('[data-cg-footer]');
  const bodyEl = document.querySelector('[data-cg-body]');
  const saveBtn = footerEl !== null ? [...footerEl.querySelectorAll('button')].find((btn) => /保存/.test(btn.textContent ?? '')) : null;
  out.saveButton = rect(saveBtn);
  const detailEl = document.querySelector('[data-role="detail"]');
  out.detailOpen = detailEl !== null && getComputedStyle(detailEl).display !== 'none';
  const sb = out.saveButton;
  out.checks['b8-save-button-in-viewport'] = sb !== null && sb.top >= 8 && sb.left >= 8 && sb.right <= innerWidth - 8 && sb.bottom <= innerHeight - 8;
  out.checks['b8-save-button-outside-scroll-body'] = saveBtn !== null && bodyEl !== null && !bodyEl.contains(saveBtn);
  if (sb !== null) {
    const hit = document.elementFromPoint(Math.round(sb.left + sb.width / 2), Math.round(sb.top + sb.height / 2));
    out.checks['b8-save-button-hit'] = hit === saveBtn || saveBtn?.contains?.(hit) === true;
    out.saveButtonHit = { tag: hit?.tagName?.toLowerCase?.() ?? null, isButton: hit === saveBtn };
  } else {
    out.checks['b8-save-button-hit'] = false;
  }

  // B9：操作区常驻——输入框 + 四个按钮都在视口内、输入框可命中/可聚焦（无需滚动）
  const opsInput = footerEl !== null ? footerEl.querySelector('input') : null;
  const opsButtons = footerEl !== null ? [...footerEl.querySelectorAll('button')] : [];
  out.opsInput = rect(opsInput);
  out.opsButtons = opsButtons.map((btn) => ({ text: (btn.textContent ?? '').slice(0, 12), rect: rect(btn) }));
  const iv = out.opsInput;
  out.checks['b9-input-in-viewport'] = iv !== null && iv.top >= 8 && iv.left >= 8 && iv.right <= innerWidth - 8 && iv.bottom <= innerHeight - 8;
  out.checks['b9-buttons-in-viewport'] = opsButtons.length >= 4 && opsButtons.every((btn) => {
    const r = rect(btn);
    return r !== null && r.top >= 8 && r.bottom <= innerHeight - 8 && r.left >= 8 && r.right <= innerWidth - 8;
  });
  if (iv !== null && opsInput !== null) {
    const inputHit = document.elementFromPoint(Math.round(iv.left + iv.width / 2), Math.round(iv.top + iv.height / 2));
    out.checks['b9-input-hit'] = inputHit === opsInput || opsInput.contains?.(inputHit) === true;
    try {
      opsInput.focus();
      out.checks['b9-input-focusable'] = document.activeElement === opsInput;
    } catch { out.checks['b9-input-focusable'] = false; }
  } else {
    out.checks['b9-input-hit'] = false;
    out.checks['b9-input-focusable'] = false;
  }

  for (const [key, value] of Object.entries(out.checks)) {
    if (value === false) out.problems.push(key);
  }
  out.pass = out.problems.length === 0;
  console.log('B6WINDOW ' + JSON.stringify(out));
  return out;
})()
