/**
 * rc.12 / 1.1.1 · B1 + B2 门（用户拍板 B1 必须修；审核 §15、需求第 31 条）。
 *
 * B1：保存成功后主标签必须是「本会话·已保存（重启保留）」；A1 与 A2 并列时必须附注
 *     「当前进程内即时生效；重启后从已保存值读回」；**禁止「重启失效」与「重启保留」并列**。
 * B2：reset 成功后气泡与输入框同刷值/来源层/生命周期/写入层（58%/plugin 即显 58%/plugin）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

let clientImportSeq = 0;
async function loadClient() {
  const captured = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(`${pathToFileURL(path.join(process.cwd(), 'lib/client.js')).href}?v=${clientImportSeq += 1}`);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(captured.length, 1, 'client.js 必须自执行 load');
  assert.equal(captured[0].id, 'dsh-context-governance');
  const reactStub = {
    Component: class { constructor(props) { this.props = props; this.state = {}; } },
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
  return captured[0].factory((name) => {
    assert.equal(name, 'react');
    return reactStub;
  });
}

test('B1：A1 生效时主标签按「已保存」呈现，禁止「重启失效」与「重启保留」并列', async () => {
  const client = await loadClient();
  const view = client.bubbleView({ at: 0.45, source: 'session:A1', defaultAt: 0.45 });
  const all = view.fields.join('\n');

  assert.match(view.fields[0], /本会话·已保存（重启保留）/, '主标签必须是已保存口径');
  assert.equal(view.fields[0].includes('临时'), false, '主标签不得再出现"临时（重启失效）"');
  assert.equal(/重启后失效/.test(all), false, '整块禁止出现「重启后失效」');
  assert.match(all, /重启后从已保存值读回/, '必须附注"重启后从已保存值读回"');
  assert.match(all, /当前进程内即时生效/, '必须附注"当前进程内即时生效"');
  assert.match(view.fields.at(-1), /已落 A2，重启保留/,
    '写入层与主标签同口径（已保存/重启保留）');

  // 生命周期行也必须是已保存口径（不能还是"本会话有效，重启后失效"）。
  assert.match(view.fields[1], /本会话已保存，重启保留/);
});

test('B1：A1 与非 A1 都不允许出现「重启失效」+「重启保留」并列（负向扫描）', async () => {
  const client = await loadClient();
  for (const source of ['session:A1', 'session:A2', 'session', 'plugin', 'project']) {
    const text = client.renderBubbleText({ at: 0.45, source });
    const both = text.includes('重启后失效') && text.includes('重启保留');
    assert.equal(both, false, `source=${source} 出现并列：\n${text}`);
  }
  // A1 的原始键必须留在附注里，便于诊断（不能藏掉）。
  const a1 = client.renderBubbleText({ at: 0.45, source: 'session:A1' });
  assert.match(a1, /source=session:A1/, '原始层键必须在附注中可见');
  assert.match(a1, /来源层: 本会话·已保存（重启保留） \(source=session:A2\)/, '展示层来源=A2');
  // A2/plugin/project 的原有口径不回归。
  assert.equal(client.renderBubbleText({ at: 0.55, source: 'plugin' }).split('\n').length, 4);
  assert.match(client.renderBubbleText({ at: 0.5, source: 'session' }), /本会话有效，重启后失效/);
});

test('B4：client 载入 + 渲染打开态气泡不抛（运行时未声明标识符门）', async () => {
  const client = await loadClient();
  const state = { snapshot: { at: 0.45, source: 'session:A1', defaultAt: 0.45 }, open: true };
  const store = { subscribe: () => () => {}, set: () => {}, get: () => state };
  const Bubble = client.createBubble(state, store, { get: () => undefined });
  assert.equal(typeof Bubble, 'function');
  // 打开态渲染：`ref: dialogRef` 与外点监听的 `dialogRef.current` 都会被执行到——
  // 声明缺失时这里抛 ReferenceError（`node --check` 抓不到）。
  const tree = Bubble({ session: { id: 'session-b4' } });
  assert.ok(tree !== null && tree !== undefined, '气泡必须渲染出节点');
  const flat = JSON.stringify(tree);
  assert.match(flat, /当前生效|55%|45%/, '渲染内容应含生效值文本');
});

test('B2：reset 成功后状态必须回落到全局口径（值/来源/写层），输入框不留旧值', async () => {
  const client = await loadClient();
  const next = { at: 0.58, source: 'plugin' };
  const state = client.stateAfterReset(next);
  assert.equal(state.draft, '58', '输入框必须回填生效值 58');
  assert.equal(state.lastAction, 'reset');
  assert.equal(state.source, 'plugin');

  const view = client.bubbleView(next, { lastAction: 'reset' });
  assert.equal(view.percentText, '58%', '大字回落到 plugin 值');
  assert.match(view.fields[0], /全局（影响所有会话） \(source=plugin\)/, '来源层显示 plugin');
  assert.match(view.fields[1], /保存后生效、重启仍有效/, '生命周期按 plugin 层');
  assert.match(view.fields[2], /已清除本会话覆盖（A1\+A2）/, '写入层必须换口径');
  assert.equal(view.fields[2].includes('session:A2'), false, 'reset 后不得再显示 session:A2 写入层');
  assert.match(view.fields[2], /全局（影响所有会话）/, '写层说明当前生效来自全局层');

  // 保存成功后 reset 残留必须被清掉（写层回会话口径）。
  const saved = client.bubbleView({ at: 0.45, source: 'session:A1' }, { lastAction: client.stateAfterSave({ at: 0.45, source: 'session:A1' }).lastAction });
  assert.equal(saved.fields.join('\n').includes('已清除本会话覆盖'), false, '保存后不得残留 reset 文案');
  assert.equal(client.stateAfterSave({ at: 0.45 }).draft, '45', '保存后输入框跟生效值');
});
