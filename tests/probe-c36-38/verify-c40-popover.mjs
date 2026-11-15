/**
 * 测试角色 · C40/B3「chip 弹层交互 + 文案精简」离线段（用户验收项，2026-11-15 口径 `c7e409f`）。
 *
 * 判据（`C40-chip弹层交互口径-20261115.md` §2/§3/§7）：
 *   ① 主视图**至多 3 行**；② 每行 ≤18 个汉字（数值行不受限）；
 *   ③ 主视图**不得出现** `source=`、`session:A1/A2` 层级代码、"本次修改写入"流程短语；
 *   ④ 保存成功主视图须含「已保存」+「重启后（仍生效|保留）」，不得含「重启失效」；
 *   ⑤ reset 后主视图须含「已恢复全局」或「已清除本会话覆盖」；
 *   ⑥ 几何：`getBoundingClientRect` 定位 + 向上/翻转/贴边/输入框避让（离线 rect 断言的前提）。
 * 真机：三档截图（宽>1200 / 窄≈800 / 矮<700）+ 关闭动作，见 INFO 行，不在离线门内。
 *
 * 手法：vm 载 `lib/client.js`，取导出的 `renderBubbleText` 渲染主视图；几何按源码存在性判。
 * 用法：node tests\probe-c36-38\verify-c40-popover.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const src = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
const cjkCount = (line) => (String(line).match(/[\u4e00-\u9fff]/g) ?? []).length;

try {
  let spec = null;
  const sandbox = { window: { __ModuleLoader__: { load: (value) => { spec = value; } } }, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), useMemo: (fn) => fn(), useCallback: (fn) => fn };
  const client = typeof spec?.factory === 'function' ? spec.factory((name) => (name === 'react' ? fakeReact : {})) : null;
  const render = client?.renderBubbleText;
  check('C40-render-entry-loadable', typeof render === 'function', `renderBubbleText=${typeof render}`);

  const viewOf = (snapshot, options) => (typeof render === 'function' ? String(render(snapshot, undefined, options)) : '');
  const saveText = viewOf({ at: 0.45, source: 'session:A1' }, { entry: 'session', lastAction: 'save' });
  const resetText = viewOf({ at: 0.58, source: 'plugin' }, { entry: 'session', lastAction: 'reset' });
  const saveLines = saveText.split('\n').map((line) => line.trim()).filter(Boolean);

  // ① 主视图至多 3 行
  check('C40-main-view-max-3-lines', saveLines.length <= 3,
    `lines=${saveLines.length} ${JSON.stringify(saveLines)}（期望 ≤3 行）`);

  // ② 每行 ≤18 汉字（数值行不受限：纯数字/百分号行跳过）
  const cjkLines = saveLines.filter((line) => !/^[\d.%…\s—]+$/.test(line));
  const tooLong = cjkLines.filter((line) => cjkCount(line) > 18);
  check('C40-main-view-line-length', tooLong.length === 0,
    `超长=${JSON.stringify(tooLong.map((line) => [cjkCount(line), line]))}（期望每行 ≤18 汉字）`);

  // ③ 不得出现技术字段/层级代码/流程短语
  const forbidden = ['source=', 'session:A1', 'session:A2', '本次修改写入'];
  const hits = forbidden.filter((token) => saveText.includes(token));
  check('C40-main-view-no-tech-fields', hits.length === 0, `命中=${JSON.stringify(hits)}（期望空）`);

  // ④ 保存成功：已保存 + 重启后仍生效/保留，且无「重启失效」
  check('C40-main-view-saved-wording',
    saveText.includes('已保存') && /(重启后?仍生效|重启保留|重启后仍有效)/.test(saveText) && !saveText.includes('重启失效'),
    `text=${JSON.stringify(saveLines)}`);

  // ⑤ reset 后文案
  check('C40-reset-wording', /已恢复全局|已清除本会话覆盖/.test(resetText),
    `text=${JSON.stringify(resetText.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3))}`);

  // ⑥ 几何：源码里必须存在 rect 定位与向上/翻转/贴边/输入框避让
  const hasRect = /getBoundingClientRect/.test(src);
  const hasFlip = /(flip|flipped|向上|向上方|下方|placement|placeAbove|placeBelow)/.test(src);
  const hasEdgeClamp = /(Math\.max\(|Math\.min\().*(viewport|innerWidth|innerHeight)/.test(src) || /clamp/.test(src);
  const hasInputAvoid = /(composer|inputRect|inputTop|inputBox)/.test(src);
  check('C40-geometry-rect-and-flip', hasRect && hasFlip,
    `getBoundingClientRect=${hasRect} 翻转/向上=${hasFlip}（无 = B3 未实现）`);
  check('C40-geometry-edge-and-input-avoid', hasEdgeClamp && hasInputAvoid,
    `贴边 clamp=${hasEdgeClamp} 输入框避让=${hasInputAvoid}`);

  // ⑦ 三档窗口 rect 断言：优先用 client 导出的定位函数（有则真算，无则红）
  const geometryName = Object.keys(client ?? {}).find((key) => /rect|popover|placement|position/i.test(key) && typeof client[key] === 'function');
  if (geometryName === undefined) {
    check('C40-geometry-three-viewports', false,
      'client 未导出任何 rect/placement 函数 → 无法做三档 rect 断言（B3 未实现）');
  } else {
    const viewports = [
      { name: 'wide', width: 1400, height: 900, chip: { x: 1100, y: 700, width: 90, height: 28 }, input: { x: 300, y: 860, width: 800, height: 40 } },
      { name: 'narrow', width: 800, height: 800, chip: { x: 600, y: 640, width: 80, height: 26 }, input: { x: 80, y: 740, width: 640, height: 38 } },
      { name: 'short', width: 900, height: 640, chip: { x: 680, y: 500, width: 80, height: 26 }, input: { x: 120, y: 590, width: 660, height: 36 } },
    ];
    const panel = { width: 320, height: 240 };
    const problems = [];
    for (const viewport of viewports) {
      let rect = null;
      try { rect = client[geometryName]({ chip: viewport.chip, panel, viewport, input: viewport.input }); } catch (error) { problems.push(`${viewport.name}: 调用抛错 ${String(error?.message)}`); continue; }
      if (rect === null || typeof rect !== 'object') { problems.push(`${viewport.name}: 返回空`); continue; }
      const width = Number(rect.width ?? panel.width);
      const height = Number(rect.height ?? panel.height);
      if (width > Math.min(360, viewport.width - 16)) problems.push(`${viewport.name}: 宽 ${width} 超限`);
      if (height > 260) problems.push(`${viewport.name}: 高 ${height} 超 260`);
      const left = Number(rect.x ?? rect.left);
      const top = Number(rect.y ?? rect.top);
      if (left < 8 || top < 8 || left + width > viewport.width - 8 || top + height > viewport.height - 8) problems.push(`${viewport.name}: 越界/裁切 (${left},${top},${width},${height})`);
      const overlapsInput = left < viewport.input.x + viewport.input.width && left + width > viewport.input.x
        && top < viewport.input.y + viewport.input.height && top + height > viewport.input.y;
      if (overlapsInput) problems.push(`${viewport.name}: 遮挡输入框`);
      const chipCenter = viewport.chip.x + viewport.chip.width / 2;
      const panelCenter = left + width / 2;
      if (Math.abs(chipCenter - panelCenter) > 8) problems.push(`${viewport.name}: 中心偏差 ${Math.round(Math.abs(chipCenter - panelCenter))}px > 8px`);
    }
    check('C40-geometry-three-viewports', problems.length === 0,
      `fn=${geometryName} problems=${JSON.stringify(problems)}（三档：宽/窄/矮，翻转向下 + 不遮输入框）`);
  }

  console.log('INFO C40-real-machine :: 三档截图（宽>1200 / 窄≈800 / 矮<700 触发向下翻转）+ 关闭动作（点外部/Esc/再点 chip）需真机取数');
} catch (error) {
  check('C40-window', false, `抛错：${String(error?.stack ?? error).slice(0, 500)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC40/B3 弹层几何与文案 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
