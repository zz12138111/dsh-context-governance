/**
 * 测试角色 · C11②（plugin 层插件自持久化）独立探针
 *
 * 依据：需求 04be97b/793e6c4/9de0ea8 + 审核口径：
 *   ①保存 plugin → `~/.dsh/context-governance/plugin-policy.json` 落值（version 必带）
 *   ②同 profile「重启」（新实例/重新 apply）→ 读回、source=plugin、值一致
 *   ③重启回落 builtin = FAIL
 *   ④a 文件缺失 / ④b 损坏 / ④c version≠1 → 视为无持久值、回落 plugin 默认、不抛错（版本单列）
 *   另：writeAtIfChanged 幂等、外部改文件下次读生效、只替代 plugin 默认不越级（A1>A2>project>plugin）
 *
 * 不装、不启用、不重启：临时 home + 临时项目 + 两次 apply 模拟重启。
 * 用法：node tests\probe-c36-38\verify-c11b-plugin-policy.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, buildPolicyState, resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { createPluginPolicyStore, pluginPolicyFile } from '../../packages/dsh-context-governance/src/plugin-policy.js';

const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-c11b-'));
const home = path.join(base, 'home');
const proj = path.join(base, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const file = pluginPolicyFile(home);
const previousProfile = process.env.USERPROFILE;
process.env.USERPROFILE = home; // apply 内部按 USERPROFILE 取用户级路径

function fakeCtx() {
  const captured = { tools: [], commands: [], handlers: [] };
  const ctx = {
    commands: captured.commands,
    tools: { register: (d) => captured.tools.push(d) },
    get(name) {
      if (name === 'profileContext') return null;
      if (name === 'commands') return { register: (d) => captured.commands.push(d) };
      return undefined;
    },
    on() { return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  return ctx;
}

try {
  // ── A. 存储层契约 ──
  const a1 = [];
  const store = createPluginPolicyStore({ file, audit: (event, details) => a1.push({ event, details }) });
  check('C11b-file-path', file === path.join(home, '.dsh', 'context-governance', 'plugin-policy.json'), `path=${file}`);
  check('C11b-write-ok', store.writeAt(0.58) === true && fs.existsSync(file), `exists=${fs.existsSync(file)}`);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('C11b-file-version-and-source', disk.version === 1 && disk.at === 0.58 && disk.source === 'plugin',
    `disk=${JSON.stringify(disk)}`);
  const restartStore = createPluginPolicyStore({ file });
  check('C11b-readback-after-restart', restartStore.read()?.at === 0.58, `read=${JSON.stringify(restartStore.read())}`);
  const beforeMtime = fs.statSync(file).mtimeMs;
  const changed = restartStore.writeAtIfChanged(0.58);
  check('C11b-idempotent-write', changed === false && fs.statSync(file).mtimeMs === beforeMtime,
    `writeAtIfChanged=${changed}`);
  // 外部改文件 → 下次读生效
  fs.writeFileSync(file, JSON.stringify({ version: 1, at: 0.47, source: 'plugin', updatedAt: new Date().toISOString() }), 'utf8');
  check('C11b-external-change-visible', restartStore.read()?.at === 0.47, `read=${JSON.stringify(restartStore.read())}`);

  // ── B. 负向三档（缺失 / 损坏 / version≠1）──
  fs.rmSync(file, { force: true });
  const b1 = [];
  let missingThrew = false;
  let missing = null;
  try { const s = createPluginPolicyStore({ file, audit: (event, details) => b1.push({ event, details }) }); missing = s.read(); } catch { missingThrew = true; }
  check('C11b-4a-missing-no-throw', missingThrew === false && missing === null, `read=${JSON.stringify(missing)} threw=${missingThrew}`);

  fs.writeFileSync(file, '{not-json', 'utf8');
  const b2 = [];
  let corrupt = null; let corruptThrew = false;
  try { const s = createPluginPolicyStore({ file, audit: (event, details) => b2.push({ event, details }) }); corrupt = s.read(); } catch { corruptThrew = true; }
  check('C11b-4b-corrupt-null-and-audited', corruptThrew === false && corrupt === null
    && b2.some((row) => row.event === 'plugin-policy-load-failed'),
    `read=${JSON.stringify(corrupt)} audit=${JSON.stringify(b2.map((row) => row.event))}`);

  fs.writeFileSync(file, JSON.stringify({ version: 2, at: 0.5, source: 'plugin' }), 'utf8');
  const b3 = [];
  let unknownVersion = null;
  try { const s = createPluginPolicyStore({ file, audit: (event, details) => b3.push({ event, details }) }); unknownVersion = s.read(); } catch { unknownVersion = 'THREW'; }
  check('C11b-4c-unknown-version-null-and-audited', unknownVersion === null
    && b3.some((row) => row.event === 'plugin-policy-load-failed'),
    `read=${JSON.stringify(unknownVersion)} audit=${JSON.stringify(b3.map((row) => row.event))}`);

  // ── C. apply 端到端：持久文件（= 设置页 route 落盘后）→ 重启读回 source=plugin ──
  fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, at: 0.58, source: 'plugin', updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  const ctx1 = fakeCtx();
  await apply(ctx1, { projectRoot: proj, project: 'iso-c11b' });
  const policyOf = (ctx) => ctx.commands.find((d) => d.name === 'cg');
  const run = async (ctx, rawInput, sid = 'session-c11b-1') => String((await policyOf(ctx).handler({ rawInput, agent: { session: { id: sid, cwd: proj } } })).text ?? '');
  const status1 = await run(ctx1, 'status');
  check('C11b-persist-readback-source-plugin', /compact\.at=0\.58 \(source=plugin\)/.test(status1),
    `policyLine=${JSON.stringify(status1.split('\n').find((line) => line.startsWith('policy:')) ?? null)}`);

  // 重启（新实例/重新 apply，无 volatile）→ 仍 source=plugin
  const ctx2 = fakeCtx();
  await apply(ctx2, { projectRoot: proj, project: 'iso-c11b' });
  const status2 = await run(ctx2, 'status');
  check('C11b-restart-readback-source-plugin', /compact\.at=0\.58 \(source=plugin\)/.test(status2),
    `policyLine=${JSON.stringify(status2.split('\n').find((line) => line.startsWith('policy:')) ?? null)}`);
  check('C11b-restart-not-builtin', !/source=builtin/.test(status2.split('\n').find((line) => line.startsWith('policy:')) ?? ''),
    '重启后不得回 builtin');

  // ── D. apply 端到端负向：损坏/版本≠1/缺失 → 回落默认、不抛错 ──
  fs.writeFileSync(file, '{not-json', 'utf8');
  const ctx3 = fakeCtx();
  let corruptApplyThrew = false;
  try { await apply(ctx3, { projectRoot: proj, project: 'iso-c11b' }); } catch { corruptApplyThrew = true; }
  const status3 = corruptApplyThrew ? '' : await run(ctx3, 'status');
  check('C11b-corrupt-file-falls-back', corruptApplyThrew === false
    && /compact\.at=0\.60 \(source=builtin\)/.test(status3),
    `threw=${corruptApplyThrew} policyLine=${JSON.stringify(status3.split('\n').find((line) => line.startsWith('policy:')) ?? null)}`);

  fs.writeFileSync(file, JSON.stringify({ version: 9, at: 0.5, source: 'plugin' }), 'utf8');
  const ctx4 = fakeCtx();
  let versionApplyThrew = false;
  try { await apply(ctx4, { projectRoot: proj, project: 'iso-c11b' }); } catch { versionApplyThrew = true; }
  const status4 = versionApplyThrew ? '' : await run(ctx4, 'status');
  check('C11b-unknown-version-falls-back', versionApplyThrew === false
    && /compact\.at=0\.60 \(source=builtin\)/.test(status4),
    `threw=${versionApplyThrew} policyLine=${JSON.stringify(status4.split('\n').find((line) => line.startsWith('policy:')) ?? null)}`);

  // ── E. 只替代 plugin 默认，不越级（A2 覆盖持久 plugin 值）──
  fs.writeFileSync(file, JSON.stringify({ version: 1, at: 0.58, source: 'plugin' }), 'utf8');
  const a2File = path.join(home, '.dsh', 'context-governance', 'session-policy.json');
  const a2 = (await import('../../packages/dsh-context-governance/src/a2-store.js')).createA2Store({ file: a2File });
  a2.write('session-c11b-1', 0.62);
  const state = buildPolicyState(resolveConfig({ projectRoot: proj }), {
    a2Store: (await import('../../packages/dsh-context-governance/src/a2-store.js')).createA2Store({ file: a2File }),
    readFile: (f) => fs.readFileSync(f, 'utf8'),
    onPolicyResolved: () => {},
  });
  const resolved = state.resolve('session-c11b-1');
  check('C11b-no-override-of-higher-layers', resolved.values['compact.at'] === 0.62 && resolved.sources['compact.at'] === 'session:A2',
    `at=${resolved.values['compact.at']} source=${resolved.sources['compact.at']}`);

  // ── F. volatile 分支可达（2ba0b4e 修 resolveConfig 保留 policy.at）──
  const cfg = resolveConfig({ projectRoot: proj, policy: { at: 0.55 } });
  check('C11b-resolveconfig-keeps-at', cfg.policy.at === 0.55, `policy.at=${JSON.stringify(cfg.policy.at)}`);
  const ctx5 = fakeCtx();
  await apply(ctx5, { projectRoot: proj, project: 'iso-c11b', policy: { at: 0.63 } });
  const status5 = await run(ctx5, 'status', 'session-c11b-vol');
  const disk5 = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('C11b-apply-volatile-branch', /compact\.at=0\.63 \(source=plugin\)/.test(status5) && disk5.at === 0.63,
    `policyLine=${JSON.stringify(status5.split('\n').find((line) => line.startsWith('policy:')) ?? null)} diskAt=${disk5.at}`);
} finally {
  process.env.USERPROFILE = previousProfile;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC11② TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
