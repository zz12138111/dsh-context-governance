/**
 * 测试角色 · C39「可移植性 / 外发边界」常驻门（出包必跑清单 §4 / CP9）。
 *
 * 覆盖（判据出处：REQUIREMENTS.md C39 `59713cb`；常驻清单 `a746503` §4）：
 *  ① 发布物零机器绑定：package.json `files` 列出的全部文件 + 根元数据里不得含
 *     本机盘符路径、用户名、机器名、`DS-HARNESS`/`DS-PROJECT`、写死的 `-desktop` 后缀。
 *  ② 假 home 全量落盘：假 `profileContext{name:'ext', home:<temp>/ext-home, dir:<temp>/ext-dir}`
 *     → A2 / plugin-policy / root-state-* / root-audit-* / pending-reconcile-* / sessions / shared / logs
 *     全部落在 temp 下；`%USERPROFILE%\.dsh`、`%USERPROFILE%\context-governance`、进程 cwd 零新文件。
 *  ③ 仅 env 无 identity → fallback 行为一致；两者皆缺 → 不写盘 + `/cg status` 显式 `user-store: unavailable`。
 *  ④ 旧位置兼容：预置旧 `sessions/<id>` store → 能读回；新写落新基座；只复制一次、不移动不删除。
 *  ⑤ 命令面同源：`/cg memory show|register` 与事件面同一 home（不得走 os.homedir() 兜底）。
 *  ⑥ 测试自身可移植：探针不得依赖本机盘符/用户名；缺失环境 → SKIP 而非 FAIL。
 *  ⑦ 真机「假 DSH_HOME 冷启动」未开窗口 → 记 SKIP/未覆盖（不得算 PASS）。
 *
 * 隔离：临时目录 + 假 profileContext + 命令层真实 handler；不装、不启用、不重启、不碰真实 profile。
 * 用法：node tests\probe-c36-38\verify-c39-portability.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, resolveConfig } from '../../packages/dsh-context-governance/src/index.js';
import { resolvePersistenceIdentity } from '../../packages/dsh-context-governance/src/root-state.js';
import { reconcileStoreFile, writeReconcileStore } from '../../packages/dsh-context-governance/src/compress/reconcile-store.js';
import { openSessionMemory } from '../../packages/dsh-context-governance/src/memory/session-store.js';
import { rootIdOf } from '../../packages/dsh-context-governance/src/roots/identity.js';

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, skip: false });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`);
}
function skip(id, detail) {
  results.push({ id, ok: true, skip: true });
  console.log(`SKIP ${id} :: ${detail}`);
}

const repo = path.resolve(import.meta.dirname, '..', '..');
const pluginDir = path.join(repo, 'packages', 'dsh-context-governance');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-c39-'));
const realHome = (() => { try { return os.homedir(); } catch { return ''; } })();
const realUser = (() => { try { return os.userInfo().username; } catch { return ''; } })();
const hostName = (() => { try { return os.hostname(); } catch { return ''; } })();

const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const savedCwd = process.cwd();
const prevCwd = savedCwd;

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}
function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  return walkFiles(dir).map((file) => path.relative(dir, file).replace(/\\/g, '/')).sort();
}
function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function makeCtx(profileContext, captured) {
  return {
    get(name) {
      if (name === 'profileContext') return profileContext ?? null;
      if (name === 'commands') return { register: (definition) => captured.commands.push(definition) };
      return undefined;
    },
    tools: { register: (definition) => captured.tools.push(definition) },
    on(event, handler) { captured.handlers.push({ event, handler }); return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
}
function walkAudit(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const file of walkFiles(dir)) {
    if (file.endsWith('.jsonl') || file.endsWith('.audit')) out.push(file);
  }
  return out;
}
function readRows(dir) {
  const rows = [];
  for (const file of walkAudit(dir)) {
    for (const line of readTextSafe(file).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return rows;
}
async function fireSessionStart(captured, session) {
  const noopNext = async () => undefined;
  for (const entry of captured.handlers) {
    if (entry.event !== 'session/event') continue;
    try {
      await entry.handler(session, { type: 'turn/start', seq: 1, data: { turn: 1 } }, noopNext);
    } catch { /* 中间件签名差异：忽略 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
}
/** 在真实用户目录里找我们这次独有的测试会话目录——用来证明"没写到真实 home"。 */
function findSessionDirOnDisk(root, sessionId, depth = 4) {
  if (typeof root !== 'string' || root === '' || !fs.existsSync(root) || depth < 0) return null;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === sessionId) return full;
    if (depth > 0) {
      const hit = findSessionDirOnDisk(full, sessionId, depth - 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------- ① 发布物静态扫描
const DRIVE_PATH = /(^|[^A-Za-z0-9_\\])([A-Za-z]:\\[^\s"'`<>|]*)/g;
const GENERIC_SEGMENT = /^(?:x|…|<[^>]*>|%[^%]+%|path|dir|root|User|username|\*)$/i;

function shippedFiles() {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const files = new Set(['package.json']);
  for (const name of ['README.md', 'cordis.patch.yml', 'LICENSE']) {
    if (fs.existsSync(path.join(pluginDir, name))) files.add(name);
  }
  for (const entry of pkgJson.files ?? []) {
    const abs = path.join(pluginDir, entry);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const file of walkFiles(abs)) files.add(path.relative(pluginDir, file).replace(/\\/g, '/'));
    } else {
      files.add(entry.replace(/\\/g, '/'));
    }
  }
  return [...files].sort();
}

function scanPackageFace() {
  const blockers = [];
  const exceptions = [];
  const files = shippedFiles();
  for (const rel of files) {
    const abs = path.join(pluginDir, rel);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const where = `${rel}:${i + 1}`;
      // 机器绑定目录名
      for (const marker of ['DS-HARNESS', 'DS-PROJECT']) {
        if (line.includes(marker)) blockers.push(`${where} 机器路径标记 ${marker}`);
      }
      // 写死的 profile 后缀
      if (/(^|[^A-Za-z0-9])-desktop\b/.test(line)) blockers.push(`${where} 写死 profile 后缀 -desktop`);
      // 真实用户名 / 机器名
      if (realUser.length >= 3 && line.includes(realUser)) blockers.push(`${where} 真实用户名 ${realUser}`);
      if (hostName.length >= 3 && line.toLowerCase().includes(hostName.toLowerCase())) {
        blockers.push(`${where} 机器名 ${hostName}`);
      }
      // 含盘符的绝对路径（长路径语法示例与通用盘符占位登记为例外）
      DRIVE_PATH.lastIndex = 0;
      let match;
      while ((match = DRIVE_PATH.exec(line)) !== null) {
        const raw = match[2];
        const longPathSyntax = line.includes('\\\\?\\');
        const segments = raw.split('\\').filter((segment) => segment !== '');
        const generic = segments.length <= 1 || segments.every((segment) => GENERIC_SEGMENT.test(segment));
        if (longPathSyntax || generic) exceptions.push(`${where} 例外：${raw.slice(0, 40)}`);
        else blockers.push(`${where} 绝对路径 ${raw.slice(0, 60)}`);
      }
    }
  }
  return { blockers, exceptions, files };
}

{
  const { blockers, exceptions, files } = scanPackageFace();
  check('C39-1-package-zero-machine-binding', blockers.length === 0,
    `blockers=${blockers.length} files=${files.length} 例外=${exceptions.length}${blockers.length > 0 ? ` | ${blockers.slice(0, 6).join(' ; ')}` : ''}`);
  const defaults = resolveConfig({});
  const portable = defaults.projectRoot === ''
    && typeof defaults.memoryRoot === 'string' && !path.isAbsolute(defaults.memoryRoot)
    && defaults.diagnostics.logFile === '';
  check('C39-1-config-defaults-portable', portable,
    `projectRoot=${JSON.stringify(defaults.projectRoot)} memoryRoot=${JSON.stringify(defaults.memoryRoot)} logFile=${JSON.stringify(defaults.diagnostics.logFile)}`);
  const pkgText = readTextSafe(path.join(pluginDir, 'package.json'));
  check('C39-1-package-metadata-clean', !/DS-HARNESS|DS-PROJECT|-desktop/.test(pkgText),
    `package.json 机器绑定=${/DS-HARNESS|DS-PROJECT|-desktop/.test(pkgText)}`);
}

// ---------------------------------------------------------------- ② 假 home 冷启动
let coldStart = null;
try {
  const extHome = path.join(base, 'ext-home');
  const extDir = path.join(base, 'ext-dir');
  const fakeProfile = path.join(base, 'fake-userprofile');
  const emptyCwd = path.join(base, 'cwd-cold');
  const proj = path.join(base, 'proj-cold');
  for (const dir of [extHome, extDir, fakeProfile, emptyCwd, path.join(proj, 'memory', 'topics')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const body = path.join(base, 'cold-body.md');
  fs.writeFileSync(body, 'COLD-LINE-1\nCOLD-LINE-2\n', 'utf8');

  // 模拟"另一个用户的机器"：USERPROFILE 指向假 profile（旧基座/`.dsh` fallback 都落这里）
  process.env.USERPROFILE = fakeProfile;
  delete process.env.HOME;
  process.chdir(emptyCwd);

  const captured = { tools: [], commands: [], handlers: [] };
  const profileContext = { name: 'ext', dir: extDir, home: extHome };
  const ctx = makeCtx(profileContext, captured);
  await apply(ctx, { projectRoot: proj, project: 'ext', policy: { at: 0.5 } });

  const sid = 'session-c39ext-1111-2222-3333-444455556666';
  const session = { id: sid, cwd: proj, header: { id: sid, cwd: proj } };
  await fireSessionStart(captured, session);

  const cg = captured.commands.find((definition) => definition.name === 'cg');
  const run = async (rawInput) => String((await cg.handler({ rawInput, agent: { session: { id: sid, cwd: proj } } })).text ?? '');
  const statusText = await run('status');
  await run('set compact.at=0.45');
  const registerText = await run(`memory register fact ${body}:1 cold-start pointer`);
  const registerId = /registered:\s*(MEM-[A-Za-z0-9-]+)/.exec(registerText)?.[1] ?? '';
  const showText = await run('memory show');
  const promoteText = registerId === '' ? '' : await run(`memory promote ${registerId}`);
  const sharedText = await run('memory shared');

  const userData = path.join(extHome, 'context-governance');
  const expectedFiles = {
    'session-policy': path.join(userData, 'session-policy.json'),
    'plugin-policy': path.join(userData, 'plugin-policy.json'),
    'root-state': path.join(userData, 'root-state-ext.json'),
    'root-audit': path.join(userData, 'root-audit-ext.jsonl'),
    'logs': path.join(userData, 'logs'),
    'sessions': path.join(userData, 'sessions', sid),
  };
  for (const [name, target] of Object.entries(expectedFiles)) {
    const ok = fs.existsSync(target);
    check(`C39-2-coldstart-${name}-under-home`, ok, `path=${target} exists=${ok}`);
  }
  // 后缀推导：profile 来自 profileContext.name（ext），不是写死的 -desktop
  const suffixOk = fs.existsSync(path.join(userData, 'root-state-ext.json'))
    && !fs.existsSync(path.join(userData, 'root-state-desktop.json'));
  check('C39-2-profile-suffix-derived', suffixOk,
    `root-state-ext=${fs.existsSync(path.join(userData, 'root-state-ext.json'))} root-state-desktop=${fs.existsSync(path.join(userData, 'root-state-desktop.json'))}`);

  // pending-reconcile：位置必须由同一 identity 推导（离线无真压缩，按推导+落盘验）
  const identity = resolvePersistenceIdentity(ctx);
  const rootId = rootIdOf(proj);
  const reconcileFile = reconcileStoreFile(identity, rootId);
  const reconcileOk = typeof reconcileFile === 'string' && reconcileFile.startsWith(userData);
  if (reconcileOk) {
    try { writeReconcileStore(reconcileFile, [{ cycle: 'c39-offline', sessionId: sid, writtenAt: Date.now() }]); } catch { /* 由下一次断言暴露 */ }
  }
  check('C39-2-coldstart-pending-reconcile-under-home', reconcileOk && fs.existsSync(reconcileFile),
    `identity=${identity?.ok === true ? identity.name : JSON.stringify(identity)} file=${reconcileFile}`);

  // shared：promote 后必须落在 <home>/context-governance/shared/<rootId>
  const sharedDir = path.join(userData, 'shared', rootId);
  const sharedOk = fs.existsSync(sharedDir);
  check('C39-2-coldstart-shared-under-home', sharedOk,
    `promote=${JSON.stringify(promoteText.split('\n').slice(-2))} sharedDir=${sharedDir} exists=${sharedOk}`);
  check('C39-2-coldstart-shared-queryable', !sharedText.includes('root-unresolved'),
    `sharedText=${JSON.stringify(sharedText.split('\n').slice(-1))}`);

  // 假 profile 下（旧基座 `.dsh` / `context-governance`）必须零新增
  const legacyBase = path.join(fakeProfile, 'context-governance');
  const dotDsh = path.join(fakeProfile, '.dsh');
  check('C39-2-no-write-fake-userprofile', !fs.existsSync(legacyBase) && !fs.existsSync(dotDsh),
    `dot-dsh=${fs.existsSync(dotDsh)} legacy-base=${fs.existsSync(legacyBase)} tree=${JSON.stringify(listTree(fakeProfile))}`);
  // 进程 cwd 必须零新增
  const cwdTree = listTree(emptyCwd);
  check('C39-2-no-write-process-cwd', cwdTree.length === 0, `cwd=${emptyCwd} files=${JSON.stringify(cwdTree.slice(0, 8))}`);
  // 真实 home 不得有本次独有会话目录（命令面若走 os.homedir() 兜底会在这里露馅）
  const leakDir = findSessionDirOnDisk(path.join(realHome, 'context-governance'), sid)
    ?? findSessionDirOnDisk(path.join(realHome, '.dsh', 'context-governance'), sid);
  check('C39-2-no-write-real-user-home', leakDir === null, `realHome=${realHome} leak=${leakDir}`);
  // status 显示解析后的实际路径（供核），且同一基座
  const statusPathsOk = statusText.includes(extHome) || statusText.includes(extHome.replace(/\\/g, '/'));
  check('C39-2-status-shows-resolved-paths', statusPathsOk,
    `statusLines=${JSON.stringify(statusText.split('\n').filter((line) => /user-store|root-audit|persistence-identity/.test(line)).map((line) => line.slice(0, 160)))}`);
  // 落盘文件里不得出现本机机器绑定路径（全部绝对路径应指向 temp base）
  const machineLeak = [];
  const outsideBase = [];
  for (const file of walkFiles(userData)) {
    // 审计是 JSONL：路径里的反斜杠已转义成 `\\`，先归一才能判前缀。
    const text = readTextSafe(file).replace(/\\\\/g, '\\');
    if (/DS-HARNESS|DS-PROJECT/i.test(text)) machineLeak.push(path.relative(base, file));
    if (hostName.length >= 3 && text.toLowerCase().includes(hostName.toLowerCase())) machineLeak.push(path.relative(base, file));
    const re = /[A-Za-z]:\\[^\s"'`<>|,)]+/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!match[0].startsWith(base)) outsideBase.push(`${path.relative(base, file)} -> ${match[0].slice(0, 80)}`);
    }
  }
  check('C39-2-state-audit-no-machine-strings', machineLeak.length === 0, `hits=${JSON.stringify([...new Set(machineLeak)].slice(0, 5))}`);
  check('C39-2-state-audit-paths-inside-temp', outsideBase.length === 0,
    `outside=${outsideBase.length} ${JSON.stringify([...new Set(outsideBase)].slice(0, 5))}`);
  check('C39-2-command-face-same-home', showText.includes(`session: ${sid}`) && fs.existsSync(path.join(userData, 'sessions', sid, 'MEMORY.md')),
    `showHead=${JSON.stringify(showText.split('\n').slice(0, 4))}`);
  coldStart = { sid, proj, extHome, userData, rootId };
} catch (error) {
  check('C39-2-coldstart-apply', false, `apply 抛错：${String(error?.stack ?? error).slice(0, 400)}`);
} finally {
  if (process.cwd() !== prevCwd) process.chdir(prevCwd);
}

// ---------------------------------------------------------------- ③ 仅 env 无 identity
{
  const envBase = path.join(base, 'env-cold');
  const fakeProfile = path.join(base, 'env-userprofile');
  const emptyCwd = path.join(base, 'cwd-env');
  const proj = path.join(base, 'proj-env');
  for (const dir of [fakeProfile, emptyCwd, proj]) fs.mkdirSync(dir, { recursive: true });
  process.env.USERPROFILE = fakeProfile;
  delete process.env.HOME;
  process.chdir(emptyCwd);
  try {
    const captured = { tools: [], commands: [], handlers: [] };
    const ctx = makeCtx(null, captured); // 无 profileContext
    await apply(ctx, { projectRoot: proj, project: 'env', policy: { at: 0.5 } });
    const sid = 'session-c39env-1111-2222-3333-444455556666';
    await fireSessionStart(captured, { id: sid, cwd: proj, header: { id: sid, cwd: proj } });
    const cg = captured.commands.find((definition) => definition.name === 'cg');
    const statusText = String((await cg.handler({ rawInput: 'status', agent: { session: { id: sid, cwd: proj } } })).text ?? '');
    const setText = String((await cg.handler({ rawInput: 'set compact.at=0.45', agent: { session: { id: sid, cwd: proj } } })).text ?? '');
    const userStoreLine = statusText.split('\n').find((line) => line.startsWith('user-store:')) ?? '(none)';
    // env fallback 基座：插件口径 = <USERPROFILE>/.dsh（见 src/user-paths.js）；只要求"唯一且一致"
    const candidates = [
      path.join(fakeProfile, '.dsh', 'context-governance'),
      path.join(fakeProfile, 'context-governance'),
    ];
    const landed = candidates.filter((dir) => fs.existsSync(dir));
    const baseDir = landed[0] ?? null;
    check('C39-3-env-fallback-single-base', landed.length === 1, `landed=${JSON.stringify(landed.map((dir) => path.relative(base, dir)))}`);
    // identity 不可得时，root-state/root-audit 无落点（该两者要求 profileContext）；A2/plugin 由 env fallback 承担。
    const filesOk = baseDir !== null
      && fs.existsSync(path.join(baseDir, 'plugin-policy.json'))
      && fs.existsSync(path.join(baseDir, 'session-policy.json'));
    check('C39-3-env-fallback-state-under-base', filesOk,
      `base=${baseDir === null ? null : path.relative(base, baseDir)} set=${JSON.stringify(setText.split('\n').slice(0, 2))} tree=${baseDir === null ? '[]' : JSON.stringify(listTree(baseDir).slice(0, 10))}`);
    check('C39-3-env-fallback-cwd-clean', listTree(emptyCwd).length === 0, `cwdTree=${JSON.stringify(listTree(emptyCwd))}`);
    check('C39-3-env-fallback-status-user-store', userStoreLine.includes('context-governance'),
      `line=${userStoreLine}（env fallback 基座=${baseDir === null ? 'none' : path.relative(base, baseDir)}）`);
  } catch (error) {
    check('C39-3-env-fallback-apply', false, `apply 抛错：${String(error?.stack ?? error).slice(0, 400)}`);
  } finally {
    if (process.cwd() !== prevCwd) process.chdir(prevCwd);
  }
}

// ---------------------------------------------------------------- ③b 两者皆缺 → fail-closed
{
  // 独立子目录：本用例要断言"零落盘"，不能把前几个用例的产物算进来
  const noneCase = path.join(base, 'none-case');
  const emptyCwd = path.join(noneCase, 'cwd');
  const proj = path.join(noneCase, 'proj');
  for (const dir of [emptyCwd, proj]) fs.mkdirSync(dir, { recursive: true });
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  process.chdir(emptyCwd);
  try {
    const captured = { tools: [], commands: [], handlers: [] };
    const ctx = makeCtx(null, captured);
    await apply(ctx, { projectRoot: proj, project: 'none' });
    const cg = captured.commands.find((definition) => definition.name === 'cg');
    const sid = 'session-c39none-1111-2222-3333-444455556666';
    const statusText = String((await cg.handler({ rawInput: 'status', agent: { session: { id: sid, cwd: proj } } })).text ?? '');
    const userStoreLine = statusText.split('\n').find((line) => line.startsWith('user-store:')) ?? '(none)';
    check('C39-4-empty-base-status-unavailable', /user-store:\s*unavailable/.test(statusText),
      `line=${userStoreLine}`);
    check('C39-4-empty-base-cwd-clean', listTree(emptyCwd).length === 0, `cwdTree=${JSON.stringify(listTree(emptyCwd))}`);
    // 审核口径：cwd、配置根、temp 下都不得出现新的 `.dsh` / `context-governance` 目录
    const strayDirs = [];
    (function walkDirs(dir, depth) {
      if (depth < 0) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === '.dsh' || entry.name === 'context-governance') { strayDirs.push(path.relative(noneCase, full)); continue; }
        walkDirs(full, depth - 1);
      }
    })(noneCase, 6);
    check('C39-4-empty-base-zero-user-store-dirs', strayDirs.length === 0,
      `stray=${JSON.stringify(strayDirs)}（cwd/配置根/temp 下不得新建 .dsh 或 context-governance）`);
    // 审计行：身份不可得 → 没有用户级审计目标（root-audit 由 profileContext 推导）；有则必须落一行。
    const userAuditFiles = walkAudit(noneCase).filter((file) => file.includes('context-governance'));
    const auditRow = readRows(noneCase).find((row) => row.event === 'user-store-unavailable');
    if (userAuditFiles.length === 0) skip('C39-4-empty-base-audit-row', '身份不可得 → 无用户级审计目标（root-audit 需 profileContext）；status 已显式，审计行记未覆盖');
    else check('C39-4-empty-base-audit-row', auditRow !== undefined, `user-store-unavailable=${auditRow !== undefined} userAuditFiles=${userAuditFiles.length}`);
    // 审核口径：该状态下 `/cg set` 仍按 A1 临时生效、不报错（无持久层是预期）
    const setText = String((await cg.handler({ rawInput: 'set compact.at=0.5', agent: { session: { id: sid, cwd: proj } } })).text ?? '');
    check('C39-4-empty-base-set-still-works-a1', /applied:\s*compact\.at=0\.5(?:0)?/.test(setText),
      `setText=${JSON.stringify(setText.split('\n').slice(0, 3))}`);
    // 不写盘 + 显式不可用（83cc516 实现补洞：memory/role 改显式错误，不再抛）
    let memoryText = '';
    try { memoryText = String((await cg.handler({ rawInput: 'memory show', agent: { session: { id: sid, cwd: proj } } })).text ?? ''); } catch (error) { memoryText = `throw:${String(error?.message ?? error)}`; }
    let registerText = '';
    try { registerText = String((await cg.handler({ rawInput: 'memory register fact x:1 y', agent: { session: { id: sid, cwd: proj } } })).text ?? ''); } catch (error) { registerText = `throw:${String(error?.message ?? error)}`; }
    let roleText = '';
    try { roleText = String((await cg.handler({ rawInput: 'role set tester', agent: { session: { id: sid, cwd: proj } } })).text ?? ''); } catch (error) { roleText = `throw:${String(error?.message ?? error)}`; }
    const explicitError = 'user-store unavailable (profileContext)';
    check('C39-4-empty-base-memory-explicit', memoryText.includes(explicitError) && registerText.includes(explicitError),
      `memoryShow=${JSON.stringify(memoryText.slice(0, 120))} register=${JSON.stringify(registerText.slice(0, 120))}`);
    check('C39-4-empty-base-role-explicit', roleText.includes(explicitError), `role=${JSON.stringify(roleText.slice(0, 120))}`);
    const cwdLeak = listTree(emptyCwd).length === 0;
    const realLeak = findSessionDirOnDisk(path.join(realHome, 'context-governance'), sid) !== null;
    check('C39-4-empty-base-memory-no-write', cwdLeak && !realLeak,
      `cwdLeak=${!cwdLeak} realLeak=${realLeak}`);
  } catch (error) {
    check('C39-4-empty-base-apply', false, `apply 抛错：${String(error?.stack ?? error).slice(0, 400)}`);
  } finally {
    if (process.cwd() !== prevCwd) process.chdir(prevCwd);
  }
}

// ---------------------------------------------------------------- ④ 旧位置兼容（只复制一次）
{
  const fakeProfile = path.join(base, 'legacy-userprofile');
  const extHome = path.join(base, 'legacy-ext-home');
  const extDir = path.join(base, 'legacy-ext-dir');
  const proj = path.join(base, 'proj-legacy');
  for (const dir of [fakeProfile, extHome, extDir, proj]) fs.mkdirSync(dir, { recursive: true });
  const sid = 'session-c39legacy-1111-2222-3333-444455556666';
  const body = path.join(base, 'legacy-body.md');
  fs.writeFileSync(body, 'LEGACY-LINE-1\n', 'utf8');
  try {
    // 旧基座 = <userprofile>/context-governance/sessions/<sid>（rc.9 及以前）
    const legacyStore = openSessionMemory({ home: fakeProfile, sessionId: sid });
    const legacyId = legacyStore.append({ type: 'fact', title: '旧指针', target: `${body}:1` }).id;
    const legacyFile = path.join(fakeProfile, 'context-governance', 'sessions', sid, 'MEMORY.md');
    const legacyTextBefore = readTextSafe(legacyFile);

    process.env.USERPROFILE = fakeProfile;
    delete process.env.HOME;
    const captured = { tools: [], commands: [], handlers: [] };
    const ctx = makeCtx({ name: 'legacyext', dir: extDir, home: extHome }, captured);
    await apply(ctx, { projectRoot: proj, project: 'legacyext' });
    await fireSessionStart(captured, { id: sid, cwd: proj, header: { id: sid, cwd: proj } });
    const memQuery = captured.tools.find((tool) => tool.name === 'mem_query');
    const seen = [];
    for (let round = 0; round < 2; round += 1) {
      try {
        const out = await memQuery.execute({}, { agent: { session: { id: sid } } });
        seen.push({ round, count: out?.count ?? null, ids: (out?.entries ?? []).map((entry) => entry.id) });
      } catch (error) {
        seen.push({ round, error: String(error?.message ?? error).slice(0, 160) });
      }
    }
    const newIndex = path.join(extHome, 'context-governance', 'sessions', sid, 'MEMORY.md');
    check('C39-5-legacy-read-back', seen[0]?.ids?.includes(legacyId) === true || seen[0]?.count > 0,
      `queries=${JSON.stringify(seen)} legacyId=${legacyId}`);
    const copiedRows = readRows(base).filter((row) => row.event === 'session-memory-legacy-copied');
    check('C39-5-legacy-copied-once', copiedRows.length === 1, `rows=${copiedRows.length} from=${JSON.stringify(copiedRows.map((row) => row.from ?? row.details?.from))}`);
    check('C39-5-legacy-not-moved-or-deleted', fs.existsSync(legacyFile) && readTextSafe(legacyFile) === legacyTextBefore,
      `legacyExists=${fs.existsSync(legacyFile)} unchanged=${readTextSafe(legacyFile) === legacyTextBefore}`);
    const cg = captured.commands.find((definition) => definition.name === 'cg');
    const registerText = String((await cg.handler({ rawInput: `memory register fact ${body}:1 新基座写入`, agent: { session: { id: sid, cwd: proj } } })).text ?? '');
    const newId = /registered:\s*(MEM-[A-Za-z0-9-]+)/.exec(registerText)?.[1] ?? '';
    const newText = readTextSafe(newIndex);
    check('C39-5-new-write-lands-new-base', newId !== '' && newText.includes(newId) && fs.existsSync(newIndex),
      `registered=${newId} newIndexExists=${fs.existsSync(newIndex)} legacyUnchanged=${readTextSafe(legacyFile) === legacyTextBefore}`);
  } catch (error) {
    check('C39-5-legacy-window', false, `旧位置兼容窗口抛错：${String(error?.stack ?? error).slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------- ⑤ 命令面同源（os.homedir 兜底不得生效）
{
  const extHome = path.join(base, 'cmdsrc-ext-home');
  const extDir = path.join(base, 'cmdsrc-ext-dir');
  const proj = path.join(base, 'proj-cmdsrc');
  const fakeProfile = path.join(base, 'cmdsrc-userprofile');
  for (const dir of [extHome, extDir, proj, fakeProfile]) fs.mkdirSync(dir, { recursive: true });
  process.env.USERPROFILE = fakeProfile;
  delete process.env.HOME;
  try {
    const captured = { tools: [], commands: [], handlers: [] };
    const ctx = makeCtx({ name: 'cmdsrc', dir: extDir, home: extHome }, captured);
    await apply(ctx, { projectRoot: proj, project: 'cmdsrc' });
    const sid = 'session-c39cmd-1111-2222-3333-444455556666';
    await fireSessionStart(captured, { id: sid, cwd: proj, header: { id: sid, cwd: proj } });
    const cg = captured.commands.find((definition) => definition.name === 'cg');
    const body = path.join(base, 'cmdsrc-body.md');
    fs.writeFileSync(body, 'CMD-LINE-1\n', 'utf8');
    const registerText = String((await cg.handler({ rawInput: `memory register fact ${body}:1 命令面`, agent: { session: { id: sid, cwd: proj } } })).text ?? '');
    const id = /registered:\s*(MEM-[A-Za-z0-9-]+)/.exec(registerText)?.[1] ?? '';
    const underInjected = fs.existsSync(path.join(extHome, 'context-governance', 'sessions', sid, 'MEMORY.md'));
    const realLeak = findSessionDirOnDisk(path.join(realHome, 'context-governance'), sid) !== null
      || findSessionDirOnDisk(path.join(realHome, '.dsh', 'context-governance'), sid) !== null;
    check('C39-5-command-surface-injected-home', underInjected && !realLeak && id !== '',
      `registered=${id} underInjected=${underInjected} realLeak=${realLeak}`);
  } catch (error) {
    check('C39-5-command-surface-window', false, `命令面窗口抛错：${String(error?.stack ?? error).slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------- ⑥ 根失败显式（不静默、不猜路径）
{
  // ⑥a 门级：无根可解析（不配根 + 无持久化状态 + 会话 cwd 不存在）→ 显式 no-project-root / root-unresolved。
  const fakeProfile = path.join(base, 'noroot-userprofile');
  const extHome = path.join(base, 'noroot-ext-home');
  const extDir = path.join(base, 'noroot-ext-dir');
  const ghostCwd = path.join(base, 'noroot-cwd-does-not-exist');
  for (const dir of [fakeProfile, extHome, extDir]) fs.mkdirSync(dir, { recursive: true });
  process.env.USERPROFILE = fakeProfile;
  delete process.env.HOME;
  try {
    const captured = { tools: [], commands: [], handlers: [] };
    const ctx = makeCtx({ name: 'noroot', dir: extDir, home: extHome }, captured);
    await apply(ctx, { project: 'noroot' }); // 不给 projectRoot
    const sid = 'session-c39noroot-1111-2222-3333-444455556666';
    await fireSessionStart(captured, { id: sid, cwd: ghostCwd, header: { id: sid, cwd: ghostCwd } });
    const cg = captured.commands.find((definition) => definition.name === 'cg');
    const statusText = String((await cg.handler({ rawInput: 'status', agent: { session: { id: sid, cwd: ghostCwd } } })).text ?? '');
    const memoryText = String((await cg.handler({ rawInput: 'memory show', agent: { session: { id: sid, cwd: ghostCwd } } })).text ?? '');
    check('C39-6-root-unresolved-explicit',
      /project-root:\s*unknown \(no-project-root\)/.test(statusText) || /source=none/.test(statusText),
      `statusLines=${JSON.stringify(statusText.split('\n').filter((line) => /project-root|unresolved|fail-closed|no-project-root|memory:/.test(line)).map((line) => line.slice(0, 140)))}`);
    check('C39-6-memory-says-root-unresolved', memoryText.includes('(root-unresolved)'),
      `memoryLines=${JSON.stringify(memoryText.split('\n').slice(0, 5))}`);
    check('C39-6-no-guessed-fallback-path', !fs.existsSync(path.join(ghostCwd, 'memory', 'governance')),
      `ghostStoreExists=${fs.existsSync(path.join(ghostCwd, 'memory', 'governance'))}`);
  } catch (error) {
    check('C39-6-root-unresolved-window', false, `无根窗口抛错：${String(error?.stack ?? error).slice(0, 400)}`);
  }

  // ⑥b 观测项（非门级）：配置了**不存在的**根时，产品把它当 source=config 采用并自动建 store。
  const ghostRoot = path.join(base, 'ghost-root-configured');
  try {
    const captured = { tools: [], commands: [], handlers: [] };
    const ctx = makeCtx({ name: 'ghost', dir: path.join(base, 'ghost-dir'), home: path.join(base, 'ghost-home') }, captured);
    await apply(ctx, { projectRoot: ghostRoot, project: 'ghost' });
    const cg = captured.commands.find((definition) => definition.name === 'cg');
    const statusText = String((await cg.handler({ rawInput: 'status', agent: { session: { id: 'session-c39ghost-1111-2222-3333-444455556666', cwd: ghostRoot } } })).text ?? '');
    const rootLine = statusText.split('\n').find((line) => line.startsWith('project-root:')) ?? '(none)';
    console.log(`INFO C39-6-configured-nonexistent-root :: ${rootLine} | storeCreated=${fs.existsSync(path.join(ghostRoot, 'memory', 'governance'))}（非门级：config 根被直接采用并自动建目录；C39③ 只判"无可用根"）`);
  } catch (error) {
    console.log(`INFO C39-6-configured-nonexistent-root :: apply 抛错 ${String(error?.message ?? error).slice(0, 160)}`);
  }
}

// ---------------------------------------------------------------- ⑦ 测试自身可移植 + 真机未覆盖
{
  const probes = fs.readdirSync(import.meta.dirname).filter((name) => name.endsWith('.mjs') && name !== path.basename(import.meta.filename));
  const hits = [];
  for (const name of probes) {
    const text = readTextSafe(path.join(import.meta.dirname, name));
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      DRIVE_PATH.lastIndex = 0;
      const match = DRIVE_PATH.exec(line);
      if (match !== null) hits.push(`${name}:${i + 1} 盘符 ${match[2].slice(0, 30)}`);
      for (const marker of ['DS-HARNESS', 'DS-PROJECT']) if (line.includes(marker)) hits.push(`${name}:${i + 1} ${marker}`);
      if (realUser.length >= 3 && line.includes(realUser)) hits.push(`${name}:${i + 1} 用户名`);
      if (hostName.length >= 3 && line.toLowerCase().includes(hostName.toLowerCase())) hits.push(`${name}:${i + 1} 机器名`);
    }
  }
  check('C39-7-probes-portable', hits.length === 0, `hits=${hits.length} ${JSON.stringify(hits.slice(0, 6))}`);
  const realDshHome = process.env.CG_C39_REAL_DSH_HOME ?? '';
  if (realDshHome === '') {
    skip('C39-7-real-machine-dsh-home-coldstart', '未覆盖：真机第二个 DSH_HOME 冷启动需另起 DSH 实例（要 00/用户开窗口）；离线以假 profileContext 覆盖，不得算 PASS');
  } else {
    check('C39-7-real-machine-dsh-home-coldstart', fs.existsSync(realDshHome), `外部真机读数由窗口提供：${realDshHome}`);
  }
  check('C39-7-probes-use-tempdir', probes.every((name) => readTextSafe(path.join(import.meta.dirname, name)).includes('os.tmpdir()') || readTextSafe(path.join(import.meta.dirname, name)).includes('mkdtempSync')),
    `probes=${probes.length}`);
}

// ---------------------------------------------------------------- 汇总
process.env.USERPROFILE = savedEnv.USERPROFILE;
if (savedEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.HOME;
if (process.cwd() !== prevCwd) process.chdir(prevCwd);
fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });

const failed = results.filter((item) => !item.ok);
const skipped = results.filter((item) => item.skip);
console.log(`\nC39 外发可移植性 TOTAL ${results.length - failed.length - 0}/${results.length} PASS · SKIP ${skipped.length} · FAIL ${failed.length}`);
if (skipped.length > 0) console.log(`SKIP: ${skipped.map((item) => item.id).join(', ')}`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }
