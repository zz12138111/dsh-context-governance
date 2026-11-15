/**
 * 测试角色 · 1.1.0 D2（C8-C15）独立复核探针。
 * 用手写的最小 window/React stub 载入 lib/client.js，取真实导出做断言；
 * 额外复核开发单测未覆盖的 C15 降级分支（快照 4xx / 无 slots / configForms 缺失）与 C8/C11 文案事实。
 * 运行：node tests\probe-1.1.0\verify-d2.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
const facts = [];
function check(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}
function fact(id, detail) {
  facts.push({ id, detail });
  console.log(`FACT ${id} :: ${detail}`);
}

let seq = 0;
async function loadClient() {
  const captured = [];
  const savedWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (spec) => captured.push(spec) } };
  try {
    await import(pathToFileURL(path.join(process.cwd(), 'packages/dsh-context-governance/lib/client.js')).href + `?v=${seq += 1}`);
  } finally {
    globalThis.window = savedWindow;
  }
  assert.equal(captured.length, 1, 'client.js 必须自执行 load');
  assert.equal(captured[0].id, 'dsh-context-governance');
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };
  return captured[0].factory((name) => {
    assert.equal(name, 'react');
    return reactStub;
  });
}

const client = await loadClient();

/** 真实形状的假 slots：宿主契约恒有 inject；inject(slot, cb) 就绪即回调（可选延迟）。 */
function makeFakeSlots({ delay = false } = {}) {
  const registered = [];
  const pending = [];
  let ready = !delay;
  const slots = {
    inject(name, callback) {
      if (ready) callback();
      else pending.push([name, callback]);
    },
    register(spec, component) { registered.push({ spec, component }); },
  };
  return {
    slots,
    registered,
    pending,
    makeReady() {
      ready = true;
      for (const [, callback] of pending) callback();
      pending.length = 0;
    },
  };
}

// C12：三处入口的注册计划
const plan = client.registrationPlan({});
const dock = plan.find((entry) => entry.slot === 'conversation.composer.dock');
const overlay = plan.find((entry) => entry.slot === 'conversation.input.overlay');
const sectionPlan = plan.find((entry) => entry.slot === 'settings.section');
check('C12-registration-shape',
  dock?.id === 'context-governance.at' && dock?.order === 6 && overlay && sectionPlan,
  `dock=${dock?.id}@${dock?.order} overlay=${overlay?.id} section=${sectionPlan?.id}`);
check('C12-chip-label', client.chipLabel({ at: 0.65 }) === '压 65%' && client.chipLabel(null) === '压 —' && client.chipLabel({}) === '压 —',
  `65%="${client.chipLabel({ at: 0.65 })}" null="${client.chipLabel(null)}" empty="${client.chipLabel({})}"`);

// C8（ccfbd93 精确判据）：生命周期必须随 source 派生；负向：持久层不得出现会话文案
const PERSISTENT = '生效时点: 保存后生效、重启仍有效';
const SESSION = '生效时点: 本会话有效，重启后失效';
const bubble = client.renderBubbleText({ at: 0.55, source: 'plugin' });
fact('C8-bubble-plugin-text', JSON.stringify(bubble));
fact('C8-bubble-session-text', JSON.stringify(client.renderBubbleText({ at: 0.5, source: 'session' })));
const persistentSources = ['plugin', 'profile', 'project', 'builtin'];
const badPersistent = persistentSources.filter((source) => {
  const text = client.renderBubbleText({ at: 0.55, source });
  const line3 = text.split('\n')[2];
  return line3 !== PERSISTENT || /本会话有效/.test(text);
});
check('C8-session-durability-marker',
  client.renderBubbleText({ at: 0.5, source: 'session' }).split('\n')[2] === SESSION && badPersistent.length === 0,
  `session→第3行相符=${client.renderBubbleText({ at: 0.5, source: 'session' }).split('\n')[2] === SESSION}；持久层不符=${JSON.stringify(badPersistent)}`);
check('C8-no-constant-leak',
  !/本会话有效/.test(client.renderBubbleText({ at: 0.55, source: 'plugin' })) && /本会话有效/.test(client.renderBubbleText({ at: 0.5, source: 'session' })),
  `持久层不含「本会话有效」；session 层含`);

// C8 宿主侧同源：policySnapshot().effectiveAt 也随 source 派生
const { lifecycleText, policySnapshot, PERSISTENT_LIFECYCLE_TEXT, SESSION_LIFECYCLE_TEXT } = await import(
  pathToFileURL(path.join(process.cwd(), 'packages/dsh-context-governance/src/settings-policy.js')).href
);
check('C8-snapshot-effectiveAt',
  policySnapshot({ values: { 'compact.at': 0.55 }, sources: { 'compact.at': 'plugin' } }).effectiveAt === PERSISTENT_LIFECYCLE_TEXT
  && policySnapshot({ values: { 'compact.at': 0.5 }, sources: { 'compact.at': 'session' } }).effectiveAt === SESSION_LIFECYCLE_TEXT
  && lifecycleText('session') === SESSION_LIFECYCLE_TEXT && lifecycleText('builtin') === PERSISTENT_LIFECYCLE_TEXT,
  `snapshot/plugin=${PERSISTENT_LIFECYCLE_TEXT} snapshot/session=${SESSION_LIFECYCLE_TEXT}`);

// C11（ccfbd93 精确判据）：第 4 行 == 静态写入层文案
const WRITE_LAYER = '本次修改写入：plugin 层（profile patch）';
const bubbleLines = bubble.split('\n');
check('C11-write-layer-wording', bubbleLines[3] === WRITE_LAYER, `第4行="${bubbleLines[3]}"`);

// C13（改判）：4 行 —— 前 3 行语义 = 当前生效 / 来源层 / 生效时点，第 4 行 = 写入层
check('C13-three-info-plus-writelayer',
  bubbleLines.length === 4 && /55%/.test(bubbleLines[0]) && /^来源层: plugin/.test(bubbleLines[1]) && bubbleLines[2] === PERSISTENT && bubbleLines[3] === WRITE_LAYER,
  `lines=${bubbleLines.length}`);

// 两处界面分别取：气泡函数文本 + 设置页 section 渲染树文本（共用 renderBubbleText，须两边都取到）
const clientSource = await (await import('node:fs/promises')).readFile('packages/dsh-context-governance/lib/client.js', 'utf8');
const callSites = clientSource.split(/\r?\n/).filter((line) => line.includes('renderBubbleText(view ?? {}, labels)')).length;
const registered = [];
const fakeForSection = makeFakeSlots({ delay: false });
client.apply({ locale: { language: 'zh' }, slots: fakeForSection.slots });
registered.push(...fakeForSection.registered);
const sectionComp = registered.find((item) => item.spec.name === 'settings.section')?.component;
const flatten = (node, out = []) => {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out; }
  if (typeof node === 'object') {
    if (node.props?.children !== undefined) flatten(node.props.children, out);
    if (node.children !== undefined) flatten(node.children, out);
  }
  return out;
};
const sectionText = sectionComp ? flatten(sectionComp({ ctx: {} })).join('\n') : '';
fact('C8/C11-section-text', JSON.stringify(sectionText));
check('C8/C11-both-surfaces',
  callSites >= 2
  && /生效时点: 保存后生效、重启仍有效/.test(sectionText)
  && sectionText.includes(WRITE_LAYER)
  && bubbleLines[3] === WRITE_LAYER,
  `renderBubbleText 调用点=${callSites}；section 含持久层时点与写入层=${/生效时点: 保存后生效、重启仍有效/.test(sectionText) && sectionText.includes(WRITE_LAYER)}`);
check('C13-settings-link', /打开设置页/.test(clientSource) && /cg-at-settings-link/.test(clientSource) && /openSettings/.test(clientSource),
  `气泡源码含「打开设置页」按钮与 openSettings 兜底`);

// C9：换算与边界
check('C9-percent-conversion',
  client.toRatio('55') === 0.55 && client.toRatio(20) === 0.2 && client.toRatio('19') === 0.19,
  `55→${client.toRatio('55')} 20→${client.toRatio(20)} 19→${client.toRatio('19')}`);
check('C9-reject-below-min',
  client.computeSave('19', {}).ok === false && /下限 0\.2/.test(client.computeSave('19', {}).reason),
  `19%→${client.computeSave('19', {}).reason}`);
check('C9-reject-low-threshold-ack',
  client.computeSave('25', {}).ok === false && /lowThresholdAck/.test(client.computeSave('25', {}).reason),
  `25%→${client.computeSave('25', {}).reason}`);
check('C9-reject-project-layer',
  client.computeSave('44', { source: 'project' }).ok === false && /0\.45/.test(client.computeSave('44', { source: 'project' }).reason),
  `44%@project→${client.computeSave('44', { source: 'project' }).reason}`);
check('C9-reject-native-ceiling',
  client.computeSave('66', { native: 0.6785 }).ok === false && /0\.66|上限/.test(client.computeSave('66', { native: 0.6785 }).reason),
  `66%@native0.6785→${client.computeSave('66', { native: 0.6785 }).reason}`);
check('C9-save-55', client.computeSave('55', { at: 0.6 }).ok === true && client.computeSave('55', { at: 0.6 }).ratio === 0.55,
  `55→${JSON.stringify(client.computeSave('55', { at: 0.6 }))}`);

// C10：写入面只有 policy.at（静态事实）+ 注入面不含安全参数
check('C10-inject-no-safety', !client.inject.some((name) => /estimateSafety|lowThresholdAck|armed/.test(name)),
  `inject=${JSON.stringify(client.inject)}`);

// C15：降级分支（开发单测未覆盖的部分）
const failFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
check('C15-snapshot-4xx', (await client.fetchSnapshot(failFetch)) === null, `4xx→${JSON.stringify(await client.fetchSnapshot(failFetch))}`);
const throwingFetch = async () => { throw new Error('network down'); };
check('C15-snapshot-throw', (await client.fetchSnapshot(throwingFetch)) === null, `throw→null`);
check('C15-snapshot-no-fetch', (await client.fetchSnapshot(undefined)) === null, `无 fetch→null`);
check('C15-no-slots', (() => { try { client.apply({}); return true; } catch { return false; } })(), `无 slots 不抛错`);
// 真实形状：inject 就绪即回调；register 在某个 slot 抛错 → 只影响该入口，其余照常
check('C15-slot-throw-isolated', (() => {
  const ok = [];
  const slots = {
    inject(name, callback) { callback(); },
    register(spec) {
      if (spec.name === 'conversation.input.overlay') throw new Error('missing');
      ok.push(spec.name);
    },
  };
  try {
    client.apply({ slots });
  } catch {
    return false;
  }
  return ok.includes('conversation.composer.dock') && ok.includes('settings.section') && !ok.includes('conversation.input.overlay');
})(), `inject 路径下，一个 slot 的 register 抛错不影响其余入口`);
// 失真形状（只 register、无 inject）只能验证 warn，不能拿来判 C8/C11/C15 通过
check('C15-register-only-warn', (() => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map((item) => String(item)).join(' ')); };
  try {
    client.apply({ slots: { register: () => { throw new Error('should not register via compat path'); } } });
  } catch {
    return false;
  } finally {
    console.warn = originalWarn;
  }
  return warnings.some((line) => /slots service unavailable/.test(line));
})(), `只提供 register 的假 ctx：必须 warn，不得走直注册兼容分支`);

const failed = results.filter((item) => !item.ok);
console.log(`\nD2 PROBE TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
