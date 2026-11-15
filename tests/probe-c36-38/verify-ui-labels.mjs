/**
 * 测试角色 · UI / 文案判据探针
 * 覆盖：C11③（主入口写 A2，00 定调不接受降级）、C11④（A2 未实现前入口隐藏/置灰或产品内警示）、
 *       C11②（生效时点）、C32（四层固定标签 / 中文 / 禁裸 source / /cg status 同字面）、
 *       C37⑥（主 usage 可见，需求 60f3287 口径；client 模板入口为终版可选项）。
 *
 * 手法：lib/client.js 是手写产物，以**静态文案断言**核（需求 C32 即「文案断言」）；/cg 命令侧用
 *       createStatusCommand 的真实输核。不装、不启用、不重启、不碰用户环境。
 *
 * 用法：node tests\probe-c36-38\verify-ui-labels.mjs
 * 分区：RC 门 = C11③/C11④/C37⑥ 主 usage；终版门 = C32 四条 + C37⑥ client 入口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPolicyState, resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { createStatusCommand } from '../../packages/dsh-context-governance/src/commands/cg-status.js';

const results = [];
const GATE = new Map();
function check(id, ok, detail, gate = '终版') { GATE.set(id, gate); results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} [${gate}] :: ${detail}`); }

const pkg = path.resolve(import.meta.dirname, '..', '..', 'packages', 'dsh-context-governance');
const client = fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8');
const statusSrc = fs.readFileSync(path.join(pkg, 'src', 'commands', 'cg-status.js'), 'utf8');

// ── 结构切分：bubble（主入口）vs settings.section（全局入口）──
const bubbleBody = (client.match(/const createBubble = \([\s\S]*?\n    \};/) ?? [])[0] ?? '';
const settingsBody = (client.match(/const createSettingsCard = \([\s\S]*?\n    \};/) ?? [])[0] ?? '';
const writeLayerLine = (client.match(/const WRITE_LAYER = '([^']*)'/) ?? [])[1] ?? '';
const bubbleSessionWrite = /session-policy|saveSession|sessionPolicy|configForms\.set\(['"]policy\.at['"][^)]*session/.test(bubbleBody);
const settingsSessionWrite = /session-policy|saveSession|sessionPolicy/.test(settingsBody);

// ── C11③（RC）：主入口（chip/气泡）必须写 A2；settings.section 写 plugin；两处不混用 ──
check('C11-3-bubble-entry-writes-a2', bubbleSessionWrite,
  `bubble 会话写入口=${bubbleSessionWrite} WRITE_LAYER=${JSON.stringify(writeLayerLine)}（00 定调：不接受降级）`, 'RC');
check('C11-3-settings-entry-writes-plugin', /saveAttempt|configForms/.test(settingsBody) && settingsSessionWrite === false,
  `settings 走 configForms/saveAttempt=${/saveAttempt|configForms/.test(settingsBody)}`, 'RC');
check('C11-3-two-entries-not-mixed', !(/saveAttempt|configForms/.test(bubbleBody) && settingsSessionWrite === false),
  `bubble 也走 configForms/saveAttempt=${/saveAttempt|configForms/.test(bubbleBody)}（混用=主入口改全局）`, 'RC');

// ── C11④（需求 2026-11-15：已改为定调记录，不再作为独立验收项）── 仅记录，不计入 PASS/FAIL ──
const bubbleWarning = /影响所有会话|会改全局/.test(bubbleBody) || /影响所有会话|会改全局/.test(writeLayerLine);
const bubbleSaveGuarded = /saving \?|disabled: !model\.canSave|disabled: true/.test(bubbleBody) && !/onClick: save/.test(bubbleBody);
console.log(`INFO C11-4(record-only) :: 产品内警示=${bubbleWarning} 保存隐藏/置灰=${bubbleSaveGuarded}（00 定调：rc.4 装机待 C11③ 真 A2，不接受过渡方案）`);

// ── C11②（终版）：生效时点文案 ──
check('C11-2-effect-time-text', /重启后失效/.test(client) && /重启保留/.test(client),
  `A1「重启后失效」/A2「重启保留」=${/重启后失效/.test(client) && /重启保留/.test(client)}`);

// ── C32（终版）：四层固定标签 + 中文 + 禁裸 source + /cg status 同字面 ──
const FIXED_LABELS = ['本会话·临时（重启失效）', '本会话·已保存（重启保留）', '项目模板（可选）', '全局（影响所有会话）'];
const missingLabels = FIXED_LABELS.filter((label) => !client.includes(label));
check('C32-four-fixed-labels', missingLabels.length === 0, `missing=${JSON.stringify(missingLabels)}`);
check('C32-builtin-profile-labels', /内置默认/.test(client) && /配置 profile=/.test(client),
  `内置默认=${/内置默认/.test(client)} 配置 profile==${/配置 profile=/.test(client)}`);
check('C32-no-raw-source-alias', /layerLabel\s*\(/.test(client) && !/source\s*:\s*`\$\{snapshot\.source\}`/.test(client),
  `经 layerLabel 映射=${/layerLabel\s*\(/.test(client)}（裸值直出=${/source\s*:\s*`\$\{snapshot\.source\}`/.test(client)}）`);

// ── /cg status 与 UI 同字面（真实输出）──
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ui-'));
const project = path.join(base, 'proj');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, '.cg-policy.json'), JSON.stringify({ version: 1, values: { 'compact.at': 0.5 } }), 'utf8');
const state = buildPolicyState(resolveConfig({ projectRoot: project }), {
  readFile: (file) => fs.readFileSync(file, 'utf8'), a2Store: null, onPolicyResolved: () => {},
});
const statusText = String((await createStatusCommand({
  policy: state, audit: { append() {}, entries: () => [], file: null }, sessionIdOf: () => 'session-ui',
}).handler({ rawInput: 'status' })).text ?? '');
const policyLine = statusText.split('\n').find((line) => line.startsWith('policy:')) ?? '';
const templateLine = statusText.split('\n').find((line) => line.startsWith('project-template:')) ?? '';
check('C32-status-same-literal', /项目模板（可选）|本会话·/.test(statusText),
  `policyLine=${JSON.stringify(policyLine)} templateLine=${JSON.stringify(templateLine)}`);
check('C32-status-template-line', /project-template:\s*\{/.test(statusText), `templateLine=${JSON.stringify(templateLine)}`);
fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });

// ── C37⑥（RC）：模板入口可见——需求 60f3287：以 /cg 主 usage 为准，input.hint 不判 ──
const usageHasTemplate = /project-template \[show\|create/.test(statusSrc) && /项目模板：显式创建\/清除/.test(statusSrc);
check('C37-6-main-usage-lists-project-template', usageHasTemplate,
  `主 usage 含 project-template create/clear=${usageHasTemplate}`, 'RC');
check('C37-6-command-template-chinese', /项目模板/.test(statusSrc) && /来源 \.cg-policy\.json/.test(statusSrc),
  `cg-template 中文文案=${/项目模板/.test(statusSrc)}`, 'RC');
check('C37-6-ui-entry-visible', /项目模板/.test(client), `client 含模板入口=${/项目模板/.test(client)}（终版可选项）`);

const failed = results.filter((item) => !item.ok);
const rcFailed = failed.filter((item) => GATE.get(item.id) === 'RC');
console.log(`\nUI TOTAL ${results.length - failed.length}/${results.length} PASS（RC 失败 ${rcFailed.length}）`);
console.log('计数口径：12 条 = 11 项 + `C32-status-template-line` 单独拆分；合并计 11 项。终版要求 12/12 全绿；C11④ 仅 INFO、不计。');
if (failed.length > 0) console.log(`FAILED: ${failed.map((item) => `${item.id}[${GATE.get(item.id)}]`).join(', ')}`);
if (rcFailed.length > 0) { console.log(`RC-BLOCKING: ${rcFailed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
