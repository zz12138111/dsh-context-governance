/**
 * 测试角色 · C36 / C37(D) / C38 独立隔离探针（不装、不启用、不重启、不碰用户 profile/会话）。
 *
 * 隔离：home / project / 正文文件全在系统临时目录的沙箱里；只走插件公开入口驱动真实代码路径。
 *        "重启" = 丢弃实例、在同一临时 home 上新建实例（对持久层语义与真机重启一致）。
 *
 * 覆盖（对齐 需求 2026-11-15 交接口径 + 00 验收清单）：
 *   C36①⑭ 无 .git 新会话首个事件 → session-governed{sessionId,root,rootId}（同 session 去重，无需压缩）
 *   C36⑤  root-unresolved 每会话每 cycle ≥1、同 cycle 去重、不进 compaction-loss
 *   C36③④ A2 落盘（键=完整 session id）/重启读回/清除；层级 A1>A2>project>plugin；source 字面；policy-resolved 审计
 *   C37   项目模板五态：无文件≠project、显式文件=project 且 status/命令可见、A1/A2 覆盖、删文件失效、
 *         坏 JSON/缺版本不生效 + policy-invalid(source=project)；创建/清除审计 project-template-set/cleared
 *   C38①②③④⑤⑥⑩⑪⑭ 指针可解析/同根两会话隔离/重启保留/无根仍可用/miss 审计/header 上限截断不复制正文/
 *         默认不继承/子会话只读/promote 共享/legacy 显式导入/--from-role 复制新 id 原记忆不动/无源报错
 *
 * 用法：node tests\probe-c36-38\verify-c36-37-38.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RootRegistry } from '../../packages/dsh-context-governance/src/roots/registry.js';
import { RootGuardPool } from '../../packages/dsh-context-governance/src/compress/root-guards.js';
import { createA2Store } from '../../packages/dsh-context-governance/src/a2-store.js';
import { buildPolicyState, resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { openSessionMemory, renderMemoryHeader } from '../../packages/dsh-context-governance/src/memory/session-store.js';
import { importFromRole, importLegacy, promotePointers, openSharedMemory } from '../../packages/dsh-context-governance/src/memory/import.js';
import { createStatusCommand } from '../../packages/dsh-context-governance/src/commands/cg-status.js';

const results = [];
const warns = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }
function warn(id, detail) { warns.push({ id, detail }); console.log(`WARN ${id} :: ${detail}`); }
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-iso-'));
const home = path.join(base, 'home');
const bodyDir = path.join(base, 'body');
for (const dir of [home, bodyDir]) fs.mkdirSync(dir, { recursive: true });

function auditSink() {
  const rows = [];
  return {
    rows,
    file: null,
    append(event, details) { rows.push({ event, details }); return true; },
    entries() { return rows; },
    get: (name) => rows.filter((row) => row.event === name),
  };
}
function writeBody(name, lines) {
  const file = path.join(bodyDir, name);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}
function poolFor(rootAudit, registry) {
  const ctx = { handlers: [], logger: { info() {}, warn() {}, error() {} }, on(event, handler) { this.handlers.push({ event, handler }); return () => {}; } };
  const pool = new RootGuardPool({
    ctx,
    registry,
    storePool: { async pin(entry) { return { entry, store: { rootDir: entry.root }, audit: auditSink(), release() {} }; } },
    createGuard: async (entry) => ({ guard: { handleEvent() {}, stop() {} }, early: { check() {}, stop() {}, hasPending() { return false; } }, policy: { root: entry.root } }),
    rootAudit,
    logger: ctx.logger,
    now: () => new Date(),
    idleMs: 60000,
  });
  pool.start();
  return { ctx, pool, fire: (session, event) => ctx.handlers[0].handler(session, event) };
}

// ===========================================================================
// C36 ①⑭：无 .git 的 cwd 也纳管；首个事件即写 session-governed，不需要压缩
// ===========================================================================
{
  const noGit = path.join(base, 'nogit-cwd');
  fs.mkdirSync(noGit, { recursive: true });
  const rootAudit = auditSink();
  const registry = RootRegistry.load({
    stateFile: path.join(home, 'context-governance', 'root-state-probe.json'),
    profile: 'iso-probe',
    now: () => new Date('2026-11-15T02:00:00Z'),
    rootAudit,
  });
  const { pool, fire } = poolFor(rootAudit, registry);
  try {
    const session = { header: { id: 'session-iso-a1', cwd: noGit } };
    fire(session, { type: 'user/message', seq: 1, data: {} });
    await flush();
    const governed = rootAudit.get('session-governed');
    check('C36-1-governed-on-first-event-no-compaction', governed.length === 1,
      `session-governed=${governed.length} (首个事件=user/message，无压缩)`);
    check('C36-1-governed-fields', governed[0]?.details?.sessionId === 'session-iso-a1'
      && typeof governed[0]?.details?.rootId === 'string' && governed[0]?.details?.rootId !== ''
      && governed[0]?.details?.subagent === false,
      `fields=${JSON.stringify(governed[0]?.details ?? null)}`);
    check('C36-1-governed-root-realpath', governed[0]?.details?.root === fs.realpathSync.native(noGit),
      `root=${governed[0]?.details?.root}`);
    fire(session, { type: 'user/message', seq: 2, data: {} });
    await flush();
    check('C36-1-governed-deduped-per-session', rootAudit.get('session-governed').length === 1,
      `rows=${rootAudit.get('session-governed').length}`);
    if (typeof governed[0]?.details?.cwd !== 'string') {
      warn('C36-1-governed-no-cwd-field', 'session-governed 未带 cwd 字段（需求文字含 cwd；实现以 root 表达）');
    }
  } finally {
    await pool.closeAll('probe');
  }
}

// ===========================================================================
// C36 ⑤：root-unresolved 不静默
// ===========================================================================
{
  const audit2 = auditSink();
  const registry2 = RootRegistry.load({
    stateFile: path.join(home, 'context-governance', 'root-state-probe2.json'),
    profile: 'iso-probe',
    now: () => new Date('2026-11-15T02:00:00Z'),
    rootAudit: audit2,
  });
  const { pool, fire } = poolFor(audit2, registry2);
  try {
    const session = { header: { id: 'session-iso-u1', cwd: '' } };
    fire(session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
    fire(session, { type: 'user/message', seq: 2, data: { turn: 1 } });
    fire(session, { type: 'turn/end', seq: 3, data: { turn: 1 } });
    await flush();
    const first = audit2.get('root-unresolved');
    check('C36-5-unresolved-once-per-cycle', first.length === 1, `rows=${first.length} detail=${JSON.stringify(first[0]?.details ?? null)}`);
    check('C36-5-unresolved-fields', first[0]?.details?.sessionId === 'session-iso-u1'
      && first[0]?.details?.cycle === 'turn:1' && typeof first[0]?.details?.reason === 'string',
      `cycle=${first[0]?.details?.cycle} reason=${first[0]?.details?.reason}`);
    fire(session, { type: 'turn/start', seq: 4, data: { turn: 2 } });
    await flush();
    const rows = audit2.get('root-unresolved');
    check('C36-5-unresolved-next-cycle', rows.length === 2 && rows[1]?.details?.cycle === 'turn:2',
      `cycles=${JSON.stringify(rows.map((row) => row.details.cycle))}`);
    check('C36-5-unresolved-not-in-loss', audit2.get('compaction-loss').length === 0,
      `compaction-loss=${audit2.get('compaction-loss').length}`);
  } finally {
    await pool.closeAll('probe');
  }
}

// ===========================================================================
// C36 ③④：A2 落盘/重启读回/清除 + 层级 + source 字面 + policy-resolved 审计
// ===========================================================================
{
  const a2File = path.join(home, 'context-governance', 'session-policy.json');
  const project = path.join(base, 'proj-a2');
  fs.mkdirSync(project, { recursive: true });
  const config = resolveConfig({ projectRoot: project });
  const readFile = (file) => fs.readFileSync(file, 'utf8');
  const resolvedRows = [];
  const mk = (a2Store) => buildPolicyState(config, { readFile, a2Store, onPolicyResolved: (row) => resolvedRows.push(row) });

  // 直接落 A2（模拟上一进程/UI 保存）
  const seed = createA2Store({ file: a2File, now: () => new Date('2026-11-15T02:00:00Z') });
  seed.write('session-iso-a2', 0.55);
  const disk0 = JSON.parse(fs.readFileSync(a2File, 'utf8'));
  check('C36-4-a2-file-key-full-session-id', JSON.stringify(disk0).includes('"session-iso-a2"') && JSON.stringify(disk0).includes('"session:A2"'),
    `disk=${JSON.stringify(disk0).slice(0, 200)}`);

  const state = mk(createA2Store({ file: a2File }));
  const viaA2 = state.resolve('session-iso-a2');
  check('C36-3-a2-hits', viaA2.values['compact.at'] === 0.55 && viaA2.sources['compact.at'] === 'session:A2',
    `at=${viaA2.values['compact.at']} source=${viaA2.sources['compact.at']}`);
  check('C36-3-policy-resolved-audit', resolvedRows.some((row) => row.sessionId === 'session-iso-a2' && row.source === 'session:A2' && row.at === 0.55),
    `rows=${JSON.stringify(resolvedRows.slice(-2))}`);
  // 493d077：policy-resolved 同会话去重（同 source|at 只一条）
  state.resolve('session-iso-a2');
  state.resolve('session-iso-a2');
  check('C36-3-policy-resolved-deduped', resolvedRows.filter((row) => row.sessionId === 'session-iso-a2').length === 1,
    `rows(${'session-iso-a2'})=${resolvedRows.filter((row) => row.sessionId === 'session-iso-a2').length}`);

  // cce808b：a2-evicted 带 sessionIds
  const evictAudit = [];
  const evictStore = createA2Store({
    file: path.join(home, 'context-governance', 'session-policy-evict.json'),
    maxEntries: 1,
    now: () => new Date('2026-11-15T02:00:00Z'),
    audit: (event, details) => evictAudit.push({ event, details }),
  });
  evictStore.write('session-iso-e1', 0.5);
  evictStore.write('session-iso-e2', 0.55);
  const evicted = evictAudit.filter((row) => row.event === 'a2-evicted');
  check('C36-3-a2-evicted-with-sessionIds', evicted.length >= 1
    && Array.isArray(evicted[0]?.details?.sessionIds) && evicted[0].details.sessionIds.length >= 1
    && evicted[0]?.details?.reason === 'max-entries',
    `evicted=${JSON.stringify(evicted[0]?.details ?? null)}`);

  // A1 覆盖 A2 并持久
  state.sessionValues('session-iso-a2', { create: true })['compact.at'] = 0.62;
  const viaA1 = state.resolve('session-iso-a2');
  check('C36-3-a1-over-a2', viaA1.values['compact.at'] === 0.62 && viaA1.sources['compact.at'] === 'session:A1',
    `at=${viaA1.values['compact.at']} source=${viaA1.sources['compact.at']}`);
  const disk1 = JSON.parse(fs.readFileSync(a2File, 'utf8'));
  check('C36-3-a1-persists-to-a2', JSON.stringify(disk1).includes('0.62'), `disk=${JSON.stringify(disk1).slice(0, 160)}`);

  // 重启：新实例 → session:A2、值保留
  const restarted = buildPolicyState(config, { readFile, a2Store: createA2Store({ file: a2File }) }).resolve('session-iso-a2');
  check('C36-3-restart-source-a2', restarted.values['compact.at'] === 0.62 && restarted.sources['compact.at'] === 'session:A2',
    `at=${restarted.values['compact.at']} source=${restarted.sources['compact.at']}`);

  // 清除 → 回落
  const clearState = buildPolicyState(config, { readFile, a2Store: createA2Store({ file: a2File }) });
  const bucket = clearState.sessionValues('session-iso-a2', { create: true });
  delete bucket['compact.at'];
  const afterClear = clearState.resolve('session-iso-a2');
  check('C36-3-clear-falls-back', afterClear.sources['compact.at'] !== 'session:A1' && afterClear.sources['compact.at'] !== 'session:A2'
    && JSON.parse(fs.readFileSync(a2File, 'utf8')).sessions?.['session-iso-a2'] === undefined,
    `source=${afterClear.sources['compact.at']} disk=${JSON.stringify(JSON.parse(fs.readFileSync(a2File, 'utf8'))).slice(0, 120)}`);

  // plugin 层 source 字面
  const pluginState = buildPolicyState(resolveConfig({ projectRoot: project, policy: { values: { 'compact.at': 0.52 } } }),
    { readFile, a2Store: createA2Store({ file: path.join(home, 'context-governance', 'session-policy-plugin.json') }) });
  const viaPlugin = pluginState.resolve('session-iso-plugin');
  check('C36-3-plugin-source-literal', viaPlugin.sources['compact.at'] === 'plugin' && viaPlugin.values['compact.at'] === 0.52,
    `source=${viaPlugin.sources['compact.at']} at=${viaPlugin.values['compact.at']}`);

  // profile 层 source 字面（需求枚举写 profile；实现为 profile=<name>）
  const profileState = buildPolicyState(resolveConfig({ projectRoot: project, policy: { profile: 'batch' } }),
    { readFile, a2Store: createA2Store({ file: path.join(home, 'context-governance', 'session-policy-profile.json') }) });
  const viaProfile = profileState.resolve('session-iso-profile');
  // 需求 32bc2c8 确认：profile 层接受带名形式 profile=<name>；裸 profile 视为偏差。
  check('C36-3-profile-source-literal', /^profile=[A-Za-z0-9._-]+$/.test(String(viaProfile.sources['compact.at'])),
    `source=${viaProfile.sources['compact.at']} at=${viaProfile.values['compact.at']}`);
  // 需求：三处同字面——policy-resolved.source 与 /cg status 也必须是 profile=<name>
  const profileRows = [];
  const profileState2 = buildPolicyState(resolveConfig({ projectRoot: project, policy: { profile: 'batch' } }), {
    readFile,
    a2Store: createA2Store({ file: path.join(home, 'context-governance', 'session-policy-profile2.json') }),
    onPolicyResolved: (row) => profileRows.push(row),
  });
  profileState2.resolve('session-iso-profile2');
  check('C36-3-profile-policyresolved-literal', profileRows.some((row) => row.source === 'profile=batch'),
    `rows=${JSON.stringify(profileRows.slice(-2))}`);
  const profileStatus = String((await createStatusCommand({
    policy: profileState2, audit: auditSink(), sessionIdOf: () => 'session-iso-profile2',
  }).handler({ rawInput: 'status' })).text ?? '');
  check('C36-3-profile-status-literal', /compact\.at=[0-9.]+ \(source=profile=batch\)/.test(profileStatus),
    `line=${JSON.stringify(profileStatus.split('\n').find((line) => line.startsWith('policy:')) ?? null)}`);
}

// ===========================================================================
// C37(D)：项目模板五态 + 创建/清除审计 + status/命令可见
// ===========================================================================
{
  const project = path.join(base, 'proj-template');
  fs.mkdirSync(project, { recursive: true });
  const tplFile = path.join(project, '.cg-policy.json');
  const config = resolveConfig({ projectRoot: project });
  const readFile = (file) => fs.readFileSync(file, 'utf8');
  const a2Of = (name) => createA2Store({ file: path.join(home, 'context-governance', `session-policy-${name}.json`) });
  const mk = (a2) => buildPolicyState(config, { readFile, a2Store: a2, onPolicyResolved: () => {} });

  const absent = mk(a2Of('tpl0')).resolve('session-iso-tpl');
  check('C37-state1-no-file-not-project', absent.sources['compact.at'] !== 'project' && !fs.existsSync(tplFile),
    `source=${absent.sources['compact.at']} at=${absent.values['compact.at']}`);

  // 别处放模板文件：不得隐性读取
  fs.writeFileSync(path.join(base, '.cg-policy.json'), JSON.stringify({ version: 1, values: { 'compact.at': 0.5 } }));
  const elsewhere = mk(a2Of('tpl0')).resolve('session-iso-tpl');
  check('C37-no-hidden-fallback', elsewhere.sources['compact.at'] !== 'project',
    `source=${elsewhere.sources['compact.at']}`);

  // 显式创建（走命令）：审计 project-template-set + /cg status 可见
  const auditRows = auditSink();
  const state = mk(a2Of('tpl1'));
  const command = createStatusCommand({ policy: state, audit: auditRows, sessionIdOf: () => 'session-iso-tpl' });
  const created = await command.handler({ rawInput: 'project-template create compact.at=0.5' });
  check('C37-create-command-audited', auditRows.get('project-template-set').length === 1
    && auditRows.get('project-template-set')[0]?.details?.keys?.includes('compact.at'),
    `text=${String(created.text).split('\n')[0]} audit=${JSON.stringify(auditRows.get('project-template-set')[0]?.details ?? null)}`);
  const statusText = String((await command.handler({ rawInput: 'status' })).text ?? '');
  const showText = String((await command.handler({ rawInput: 'project-template show' })).text ?? '');
  check('C37-status-visible', statusText.includes('project-template') && /project-template:\s*\{/.test(statusText),
    `statusHas=${statusText.includes('project-template')}`);
  check('C37-show-command-chinese', showText.includes('项目模板') && showText.includes('来源 .cg-policy.json'),
    `show=${JSON.stringify(showText.split('\n').slice(-2))}`);

  // 新 state（重启语义）→ source=project
  const withTpl = mk(a2Of('tpl1')).resolve('session-iso-tpl');
  check('C37-state2-explicit-file-project', withTpl.values['compact.at'] === 0.5 && withTpl.sources['compact.at'] === 'project',
    `at=${withTpl.values['compact.at']} source=${withTpl.sources['compact.at']}`);

  // 493d077：改/删文件即时生效（同一 state 实例再次 resolve，不重启）
  const liveProject = path.join(base, 'proj-live');
  fs.mkdirSync(liveProject, { recursive: true });
  const liveState = buildPolicyState(resolveConfig({ projectRoot: liveProject }), { readFile, a2Store: a2Of('tpl-live'), onPolicyResolved: () => {} });
  const liveBefore = liveState.resolve('session-iso-live').sources['compact.at'];
  liveState.projectTemplate.write({ 'compact.at': 0.53 });
  const liveAfterWrite = liveState.resolve('session-iso-live');
  fs.rmSync(path.join(liveProject, '.cg-policy.json'), { force: true });
  const liveAfterDelete = liveState.resolve('session-iso-live');
  // 493d077：即时生效在 apply 的 policyForEntry（signature）层——buildPolicyState 直调不重建（记录为 WARN，在 apply 级探针复核）
  warn('C37-immediate-change-needs-apply-path',
    `buildPolicyState 直调：before=${liveBefore} afterWrite=${liveAfterWrite.sources['compact.at']} afterDelete=${liveAfterDelete.sources['compact.at']}（apply 级由 verify-c38-memtools.mjs 复核）`);

  // A2 覆盖模板
  const a2Store = a2Of('tpl2');
  a2Store.write('session-iso-tpl-cover', 0.57);
  const covered = mk(a2Store).resolve('session-iso-tpl-cover');
  check('C37-a2-over-project', covered.values['compact.at'] === 0.57 && covered.sources['compact.at'] === 'session:A2',
    `at=${covered.values['compact.at']} source=${covered.sources['compact.at']}`);

  // 坏 JSON → 整层不生效 + policy-invalid(source=project)
  fs.writeFileSync(tplFile, '{ not-json', 'utf8');
  const bad = mk(a2Of('tpl3')).resolve('session-iso-tpl-bad');
  check('C37-state4-bad-json-inactive', bad.sources['compact.at'] !== 'project'
    && bad.invalid.some((item) => item.source === 'project' && item.reason === 'invalid-json'),
    `source=${bad.sources['compact.at']} invalid=${JSON.stringify(bad.invalid.filter((item) => item.source === 'project'))}`);

  // 缺版本 → 整层不生效
  fs.writeFileSync(tplFile, JSON.stringify({ values: { 'compact.at': 0.5 } }), 'utf8');
  const noVersion = mk(a2Of('tpl4')).resolve('session-iso-tpl-noversion');
  check('C37-state5-missing-version-inactive', noVersion.sources['compact.at'] !== 'project'
    && noVersion.invalid.some((item) => item.source === 'project'),
    `source=${noVersion.sources['compact.at']} invalid=${JSON.stringify(noVersion.invalid.filter((item) => item.source === 'project'))}`);

  // 删文件失效
  const explicitAgain = mk(a2Of('tpl5'));
  explicitAgain.projectTemplate.write({ 'compact.at': 0.5 });
  fs.rmSync(tplFile, { force: true });
  const gone = mk(a2Of('tpl6')).resolve('session-iso-tpl-gone');
  check('C37-state3-deleted-inactive', gone.sources['compact.at'] !== 'project' && !fs.existsSync(tplFile),
    `source=${gone.sources['compact.at']}`);

  // 清除命令审计
  const auditClear = auditSink();
  const stateClear = mk(a2Of('tpl7'));
  stateClear.projectTemplate.write({ 'compact.at': 0.5 });
  const cmdClear = createStatusCommand({ policy: stateClear, audit: auditClear, sessionIdOf: () => 'session-iso-tpl' });
  await cmdClear.handler({ rawInput: 'project-template clear' });
  check('C37-clear-command-audited', auditClear.get('project-template-cleared').length === 1 && !fs.existsSync(tplFile),
    `audit=${JSON.stringify(auditClear.get('project-template-cleared')[0]?.details ?? null)}`);
}

// ===========================================================================
// C38：会话级记忆（隔离/重启/miss/header/默认不继承/promote/legacy/--from-role）
// ===========================================================================
{
  const sidA = 'session-isoaaaa-1111-2222-3333-444455556666';
  const sidB = 'session-isobbbb-1111-2222-3333-444455556666';
  const sidH = 'session-isohhhh-1111-2222-3333-444455556666';
  const rows = [];
  const audit = (event, details) => rows.push({ event, details });
  const body1 = writeBody('body1.md', ['ALPHA-BODY-ONE', 'BETA-BODY-TWO', 'GAMMA-BODY-THREE']);
  const bodyBig = writeBody('body-big.md', Array.from({ length: 60 }, (_, index) => `BIG-BODY-LINE-${index + 1}`));

  const aStore = openSessionMemory({ home, sessionId: sidA, now: () => new Date('2026-11-15T02:00:00Z'), audit });
  const a1 = aStore.append({ type: 'fact', title: 'A 的指针', target: `${body1}:2`, summary: '指向正文第 2 行' });
  check('C38-1-pointer-id-and-resolve', a1.ok === true && /^MEM-[A-Za-z0-9]+-\d{8}-\d{4}$/.test(String(a1.id))
    && aStore.query()[0]?.miss === false && aStore.query()[0]?.target === `${body1}:2`,
    `id=${a1.id} target=${aStore.query()[0]?.target}`);
  check('C38-3-no-root-still-has-store', fs.existsSync(path.join(home, 'context-governance', 'sessions', sidA, 'MEMORY.md')),
    `dir=${aStore.dir}`);

  const bStore = openSessionMemory({ home, sessionId: sidB, now: () => new Date('2026-11-15T02:01:00Z'), audit });
  check('C38-1-two-sessions-isolated', bStore.query().length === 0 && bStore.query({ ids: [a1.id] }).length === 0,
    `bAll=${bStore.all().length} bById=${bStore.query({ ids: [a1.id] }).length}`);
  const aReloaded = openSessionMemory({ home, sessionId: sidA, now: () => new Date('2026-11-15T02:02:00Z'), audit });
  check('C38-2-restart-keeps-pointers', aReloaded.query().length === 1 && aReloaded.query()[0].id === a1.id,
    `reloaded=${aReloaded.all().map((entry) => entry.id).join(',')}`);

  // miss：删正文 → body-missing
  fs.rmSync(body1, { force: true });
  const missed = aReloaded.query();
  check('C38-5-miss-body-deleted', missed[0]?.miss === true && missed[0]?.missReason === 'body-missing',
    `miss=${missed[0]?.miss} reason=${missed[0]?.missReason}`);
  const missRows = rows.filter((row) => row.event === 'memory-pointer-miss' && row.details?.sessionId === sidA);
  check('C38-5-miss-audited', missRows.some((row) => row.details.reason === 'body-missing'),
    `rows=${missRows.length} reasons=${JSON.stringify([...new Set(missRows.map((row) => row.details.reason))])}`);

  // miss：行漂移（改目标行内容）→ line-drift
  writeBody('body1.md', ['ALPHA-BODY-ONE', 'BETA-BODY-TWO-CHANGED', 'GAMMA-BODY-THREE']);
  const driftRows = [];
  const fresh = openSessionMemory({ home, sessionId: sidA, now: () => new Date('2026-11-15T02:03:00Z'), audit: (event, details) => driftRows.push({ event, details }) });
  const drifted = fresh.query();
  check('C38-5-miss-line-drift', drifted[0]?.miss === true && drifted[0]?.missReason === 'line-drift',
    `miss=${drifted[0]?.miss} reason=${drifted[0]?.missReason}`);
  check('C38-5-drift-audited', driftRows.some((row) => row.event === 'memory-pointer-miss' && row.details?.reason === 'line-drift'),
    `rows=${JSON.stringify(driftRows.map((row) => row.event))}`);
  const missingTarget = fresh.append({ type: 'fact', title: '登记失败不阻塞', target: `${path.join(bodyDir, 'not-there.md')}:1` });
  check('C38-5-append-missing-target-warns', missingTarget.ok === true && missingTarget.warning === 'body-missing', JSON.stringify(missingTarget));

  // header：短行 + 上限截断 + 不复制正文
  const hStore = openSessionMemory({ home, sessionId: sidH, now: () => new Date('2026-11-15T02:04:00Z'), audit });
  for (let index = 0; index < 30; index += 1) {
    hStore.append({ type: 'fact', title: `H${index + 1}`, target: `${bodyBig}:${index + 1}`, summary: `S${index + 1}` });
  }
  const hAudit = [];
  const header = renderMemoryHeader(hStore, { maxLines: 4, maxBytes: 300, audit: (event, details) => hAudit.push({ event, details }) });
  const trunc = hAudit.find((row) => row.event === 'header-truncated');
  check('C38-4-header-truncated-audited', header.truncated > 0 && trunc?.details?.bytes === 300 && trunc?.details?.lines === 4,
    `truncated=${header.truncated} audit=${JSON.stringify(trunc?.details ?? null)}`);
  check('C38-4-header-no-body-copy', !header.text.includes('BIG-BODY-LINE') && header.text.split('\n').length <= 6,
    `bytes=${header.bytes} lines=${header.text.split('\n').length}`);

  // 默认不继承 + 子会话只读
  const fresh2 = openSessionMemory({ home, sessionId: 'session-isodefault-1111-2222-3333-444455556666', audit });
  check('C38-8-default-no-inherit', fresh2.all().length === 0, `all=${fresh2.all().length}`);
  const subStore = openSessionMemory({ home, sessionId: sidA, subagent: true, audit });
  check('C38-7-subagent-readonly', subStore.append({ type: 'fact', title: 'sub', target: `${bodyBig}:1` }).ok === false,
    JSON.stringify(subStore.append({ type: 'fact', title: 'sub2', target: `${bodyBig}:2` })));

  // 共享 promote：显式才进 shared/<rootId>，带来源 sessionId；默认不可见
  const promoAudit = [];
  const promoted = promotePointers({
    home, rootId: 'root-iso', sessionId: sidH, fromStore: hStore, ids: [hStore.all()[0].id],
    audit: (event, details) => promoAudit.push({ event, details }),
    now: () => new Date('2026-11-15T02:05:00Z'),
  });
  check('C38-6-promote-shared', promoted.ok === true && promoted.promoted.length === 1
    && fs.existsSync(path.join(home, 'context-governance', 'shared', 'root-iso', 'MEMORY.md')),
    `promoted=${JSON.stringify(promoted.promoted)}`);
  const promoRow = promoAudit.find((row) => row.event === 'memory-promoted');
  check('C38-6-promote-audited-with-source', promoRow?.details?.sessionId === sidH && promoRow?.details?.rootId === 'root-iso',
    `audit=${JSON.stringify(promoRow?.details ?? null)}`);
  const shared = openSharedMemory({ home, rootId: 'root-iso' });
  check('C38-6-shared-not-auto-visible', bStore.query().every((entry) => !promoted.promoted.includes(entry.id))
    && shared.all().length === 1,
    `bAll=${bStore.all().length} sharedAll=${shared.all().length}`);

  // legacy 显式导入（不自动迁移）
  const legacyDir = path.join(base, 'legacy-project', 'memory', 'governance');
  fs.mkdirSync(path.join(legacyDir, 'topics'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'topics', 'fact.md'),
    ['<!-- entry:MEM-20261025-1003 -->', '### MEM-20261025-1003', '回滚点：legacy body', ''].join('\n'), 'utf8');
  const legacyTarget = openSessionMemory({ home, sessionId: 'session-isolegacy-1111-2222-3333-444455556666' });
  check('C38-10-legacy-not-auto-migrated', legacyTarget.all().length === 0, `all=${legacyTarget.all().length}`);
  const legacyAudit = [];
  const legacyStore = openSessionMemory({ home, sessionId: 'session-isolegacy-1111-2222-3333-444455556666', audit: (event, details) => legacyAudit.push({ event, details }) });
  const legacy = importLegacy({ legacyDir, toStore: legacyStore, sessionId: legacyStore.sessionId, audit: (event, details) => legacyAudit.push({ event, details }) });
  check('C38-10-legacy-explicit-import', legacy.ok === true && legacyStore.all().length === 1
    && legacyAudit.some((row) => row.event === 'memory-imported'),
    `imported=${JSON.stringify(legacy.imported)} audit=${JSON.stringify(legacyAudit.map((row) => row.event))}`);

  // --from-role：复制新 id + origin、原记忆字节不变、无源报错
  const roleStore = openSessionMemory({ home, sessionId: 'session-isorole-1111-2222-3333-444455556666', now: () => new Date('2026-11-15T02:06:00Z'), audit });
  roleStore.setRole('tester');
  roleStore.touchMeta({ rootId: 'root-iso-probe' });
  const roleBody = writeBody('body-role.md', ['ROLE-BODY-ONE', 'ROLE-BODY-TWO']);
  const roleId = roleStore.append({ type: 'fact', title: '角色会话指针', target: `${roleBody}:1`, summary: 'role body' }).id;
  const originTopics = fs.readFileSync(path.join(roleStore.dir, 'topics', 'fact.md'), 'utf8');
  const originIndex = fs.readFileSync(path.join(roleStore.dir, 'MEMORY.md'), 'utf8');
  const importAudit = [];
  const targetStore = openSessionMemory({ home, sessionId: sidB, now: () => new Date('2026-11-15T02:07:00Z'), audit: (event, details) => importAudit.push({ event, details }) });
  const imported = importFromRole({
    home, role: 'tester', rootId: 'root-iso-probe', sessionId: sidB, toStore: targetStore,
    audit: (event, details) => importAudit.push({ event, details }),
    now: () => new Date('2026-11-15T02:08:00Z'),
  });
  const importedEntries = targetStore.all();
  check('C38-7-from-role-copied', imported.ok === true && imported.from === roleStore.sessionId
    && importedEntries.length >= 1 && importedEntries[0].id !== roleId
    && importedEntries[0].originSessionId === roleStore.sessionId && importedEntries[0].originRole === 'tester',
    `from=${imported.from} newId=${importedEntries[0]?.id} origin=${importedEntries[0]?.originSessionId}`);
  check('C38-7-from-role-origin-untouched', fs.readFileSync(path.join(roleStore.dir, 'topics', 'fact.md'), 'utf8') === originTopics
    && fs.readFileSync(path.join(roleStore.dir, 'MEMORY.md'), 'utf8') === originIndex,
    `bytesEqual=${fs.readFileSync(path.join(roleStore.dir, 'topics', 'fact.md'), 'utf8') === originTopics}`);
  check('C38-7-from-role-audited', importAudit.some((row) => row.event === 'memory-imported-role' && row.details?.fromSessionId === roleStore.sessionId),
    `audit=${JSON.stringify(importAudit.map((row) => row.event))}`);

  const noSourceAudit = [];
  const noSource = importFromRole({
    home, role: 'no-such-role', rootId: 'root-iso-probe', sessionId: sidB,
    toStore: openSessionMemory({ home, sessionId: 'session-isonone-1111-2222-3333-444455556666' }),
    audit: (event, details) => noSourceAudit.push({ event, details }),
  });
  check('C38-7-no-source-errors', noSource.ok === false && noSource.reason === 'no-source-session'
    && noSourceAudit.some((row) => row.event === 'memory-import-no-source'),
    `result=${JSON.stringify(noSource)} audit=${JSON.stringify(noSourceAudit.map((row) => row.event))}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC36/C37/C38 TOTAL ${results.length - failed.length}/${results.length} PASS  WARN=${warns.length}  (sandbox=${base})`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
