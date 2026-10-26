/**
 * 2a 单根模型：持久化身份、状态文件、首次推断与 /cg status 可见性。
 *
 * 需求锚点（草案 v0.6）：
 * - R-MEMROOT-2：显式配置 > 持久化状态 > 首次推断；推断不出 → no-project-root，不换根。
 * - R-MEMROOT-4：推断结果必须持久化，重启沿用、不重新推断；根变化 status/审计可见。
 * - 审核硬条件：身份唯一来源 profileContext；身份不可用 = fail-closed（不写盘、不猜路径、根未知）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../src/index.js';
import { createStatusCommand } from '../src/commands/cg-status.js';
import {
  identityDiagnostic,
  inferRootFromCwd,
  normalizeRootPath,
  persistInferredRoot,
  readRootState,
  resolvePersistenceIdentity,
  samePath,
  safeProfileName,
  sessionCwd,
  writeRootState,
} from '../src/root-state.js';


async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function ctxWithProfile(profile, extra = {}) {
  return {
    get(name) {
      if (name === 'profileContext') return profile;
      return undefined;
    },
    ...extra,
  };
}

const PROFILE_DIR = path.resolve('C:\\Users\\tester\\.dsh\\profiles\\main');
const PROFILE_HOME = path.resolve('C:\\Users\\tester');

// ---------------------------------------------------------------- identity

test('2a 身份：home 存在 → anchor=home，状态文件落在 home 下', () => {
  const identity = resolvePersistenceIdentity(ctxWithProfile({
    name: 'main',
    dir: PROFILE_DIR,
    home: PROFILE_HOME,
  }));
  assert.equal(identity.ok, true);
  assert.equal(identity.anchor, 'home');
  assert.equal(identity.name, 'main');
  assert.equal(identity.dir, PROFILE_DIR);
  assert.equal(identity.home, PROFILE_HOME);
  assert.equal(identity.stateFile, path.join(PROFILE_HOME, 'context-governance', 'root-state-main.json'));
});

test('2a 身份：home 缺失/非法 → fallback anchor=dir，状态文件落在 profile dir', () => {
  for (const home of [undefined, null, '', 'relative\\home', 42]) {
    const identity = resolvePersistenceIdentity(ctxWithProfile({ name: 'main', dir: PROFILE_DIR, home }));
    assert.equal(identity.ok, true, `home=${String(home)} 应回落到 dir 锚点`);
    assert.equal(identity.anchor, 'dir');
    assert.equal(identity.home, null);
    assert.equal(identity.stateFile, path.join(PROFILE_DIR, 'context-governance', 'root-state.json'));
  }
});

test('2a 身份：fail-closed 分支（pc 缺失/非对象/name 空/dir 非绝对）', () => {
  const cases = [
    [undefined, 'profileContext-unavailable'],
    [null, 'profileContext-unavailable'],
    ['nope', 'profileContext-unavailable'],
    [[], 'profileContext-unavailable'],
    [{ name: '', dir: PROFILE_DIR }, 'profile-name-invalid'],
    [{ name: '   ', dir: PROFILE_DIR }, 'profile-name-invalid'],
    [{ name: 7, dir: PROFILE_DIR }, 'profile-name-invalid'],
    [{ name: 'main', dir: '' }, 'profile-dir-invalid'],
    [{ name: 'main', dir: 'relative\\dir' }, 'profile-dir-invalid'],
    [{ name: 'main', dir: PROFILE_DIR, home: PROFILE_HOME, extra: true }], // 合法兜底
  ];
  for (const [profile, reason] of cases.slice(0, -1)) {
    const identity = resolvePersistenceIdentity(ctxWithProfile(profile));
    assert.equal(identity.ok, false, `pc=${JSON.stringify(profile)} 应拒绝`);
    assert.equal(identity.reason, reason);
    assert.equal(identity.stateFile, undefined);
  }
  const valid = resolvePersistenceIdentity(ctxWithProfile(cases.at(-1)[0]));
  assert.equal(valid.ok, true);
});

test('2a 身份：ctx.get 抛错/不存在 → unavailable，不猜路径', () => {
  const throwing = { get() { throw new Error('boom'); } };
  assert.deepEqual(resolvePersistenceIdentity(throwing), { ok: false, reason: 'profileContext-unavailable' });
  assert.deepEqual(resolvePersistenceIdentity({}), { ok: false, reason: 'profileContext-unavailable' });
  assert.deepEqual(resolvePersistenceIdentity(null), { ok: false, reason: 'profileContext-unavailable' });
});

test('2a 身份：不读 env（DSH_HOME/DSH_PROFILE 存在与否都不影响）', () => {
  const saved = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
  process.env.DSH_HOME = 'C:\\evil-home';
  process.env.DSH_PROFILE = 'evil-profile';
  try {
    const withEnv = resolvePersistenceIdentity(ctxWithProfile({ name: 'main', dir: PROFILE_DIR, home: PROFILE_HOME }));
    assert.equal(withEnv.anchor, 'home');
    assert.equal(withEnv.stateFile, path.join(PROFILE_HOME, 'context-governance', 'root-state-main.json'));
    delete process.env.DSH_HOME;
    delete process.env.DSH_PROFILE;
    const withoutEnv = resolvePersistenceIdentity(ctxWithProfile({ name: 'main', dir: PROFILE_DIR, home: PROFILE_HOME }));
    assert.deepEqual(withoutEnv, withEnv);
  } finally {
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home;
    if (saved.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = saved.profile;
  }
});

test('2a 身份：两个 profile 各写各的状态文件（同一 home 不串）', () => {
  const a = resolvePersistenceIdentity(ctxWithProfile({ name: 'alpha', dir: PROFILE_DIR, home: PROFILE_HOME }));
  const b = resolvePersistenceIdentity(ctxWithProfile({ name: 'beta', dir: PROFILE_DIR, home: PROFILE_HOME }));
  assert.notEqual(a.stateFile, b.stateFile);
  assert.equal(path.basename(a.stateFile), 'root-state-alpha.json');
  assert.equal(path.basename(b.stateFile), 'root-state-beta.json');
});

test('2a safeProfileName：非法字符替换、空值兜底、超长截断', () => {
  assert.equal(safeProfileName('main'), 'main');
  assert.equal(safeProfileName('a/b\\c'), 'a_b_c');
  assert.equal(safeProfileName('a:b*c?'), 'a_b_c_');
  assert.equal(safeProfileName('..hidden'), '_hidden');
  assert.equal(safeProfileName(''), 'profile');
  assert.equal(safeProfileName(null), 'profile');
  assert.equal(safeProfileName('x'.repeat(120)).length, 80);
});

test('2a 诊断行：ok / fail-closed 两种格式', () => {
  const ok = identityDiagnostic(resolvePersistenceIdentity(ctxWithProfile({
    name: 'main', dir: PROFILE_DIR, home: PROFILE_HOME,
  })));
  assert.equal(
    ok,
    `persistence-identity: source=profileContext name=main dir=${PROFILE_DIR} home=present anchor=home ` +
    `path=${path.join(PROFILE_HOME, 'context-governance', 'root-state-main.json')}`,
  );
  assert.match(identityDiagnostic(resolvePersistenceIdentity({})), /^persistence-identity: persistence-identity-unavailable reason=profileContext-unavailable$/);
  assert.match(identityDiagnostic(null), /reason=unknown$/);
});

// ---------------------------------------------------------------- state file

test('2a 状态文件：write→read 往返；缺文件/坏 JSON/版本不符/相对根都返回 null', async () => {
  const dir = await tempDir('cg-2a-state-');
  try {
    const file = path.join(dir, 'nested', 'root-state.json');
    assert.equal(readRootState(file), null, '缺文件应为 null');
    assert.equal(writeRootState(file, { root: dir, inferredFromCwd: dir, profile: 'main', inferredAt: '2026-10-26T00:00:00.000Z' }), true);
    const state = readRootState(file);
    assert.equal(state.root, path.resolve(dir));
    assert.equal(state.source, 'inferred');
    assert.equal(state.inferredAt, '2026-10-26T00:00:00.000Z');
    assert.equal(state.inferredFromCwd, path.resolve(dir));
    assert.equal(state.instance.profile, 'main');
    assert.equal(state.configRoot, null);

    await fs.writeFile(file, '{bad json', 'utf8');
    assert.equal(readRootState(file), null);
    await fs.writeFile(file, JSON.stringify({ version: 2, root: dir }), 'utf8');
    assert.equal(readRootState(file), null);
    await fs.writeFile(file, JSON.stringify({ version: 1, root: 'relative\\root' }), 'utf8');
    assert.equal(readRootState(file), null);
    await fs.writeFile(file, JSON.stringify({ version: 1, root: '' }), 'utf8');
    assert.equal(readRootState(file), null);
    await fs.writeFile(file, JSON.stringify({ version: 1, root: dir, source: 'config' }), 'utf8');
    assert.equal(readRootState(file), null, 'source 非 inferred = 坏值');
    await fs.writeFile(file, JSON.stringify({ version: 1, root: dir, inferredFromCwd: 'relative' }), 'utf8');
    assert.equal(readRootState(file), null, 'inferredFromCwd 非绝对 = 坏值');
    await fs.writeFile(file, JSON.stringify({ version: 1, root: dir, instance: 'oops' }), 'utf8');
    assert.equal(readRootState(file), null, 'instance 非对象 = 坏值');
    await fs.writeFile(file, JSON.stringify({ version: 1, root: dir, configRoot: 'relative' }), 'utf8');
    assert.equal(readRootState(file), null, 'configRoot 非绝对 = 坏值');
    await fs.writeFile(file, JSON.stringify({ version: 1, root: dir, unknownField: 1 }), 'utf8');
    assert.equal(readRootState(file).root, path.resolve(dir), '未知字段容忍');
    await fs.writeFile(file, 'null', 'utf8');
    assert.equal(readRootState(file), null);
    assert.equal(readRootState(''), null);
    assert.equal(readRootState(null), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a 审计：四个新事件在册、字段可落盘，根变化/推断来源可复核', async () => {
  const { AUDIT_EVENTS, AUDIT_FIELD_WHITELIST, AuditLog } = await import('../src/audit.js');
  for (const event of ['persistence-identity', 'project-root-changed', 'inferred-fresh', 'no-project-root']) {
    assert.equal(AUDIT_EVENTS.includes(event), true, `${event} 必须在 AUDIT_EVENTS`);
  }
  for (const field of ['root', 'name', 'dir', 'home', 'anchor', 'path', 'from', 'to', 'inferredFromCwd']) {
    assert.equal(AUDIT_FIELD_WHITELIST[field], 'text', `${field} 必须是 text 白名单字段`);
  }
  const dir = await tempDir('cg-2a-audit-');
  try {
    const file = path.join(dir, 'audit.jsonl');
    const log = new AuditLog({ file });
    assert.equal(log.append('persistence-identity', {
      source: 'profileContext', name: 'prof', dir: PROFILE_DIR, home: 'present', anchor: 'home',
      path: 'C:\\s.json', reason: null,
    }), true);
    assert.equal(log.append('project-root-changed', { from: 'C:\\old', to: 'C:\\new', source: 'config' }), true);
    assert.equal(log.append('inferred-fresh', {
      root: 'C:\\new', path: 'C:\\s.json', inferredFromCwd: 'C:\\new\\src', reason: 'state-write-failed',
    }), true);
    assert.equal(log.append('no-project-root', {
      sessionId: 'session-1', sessionShortId: 'session-', reason: 'no-project-root',
    }), true);
    const entries = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.length, 4);
    assert.equal(entries[0].event, 'persistence-identity');
    assert.equal(entries[0].dir, PROFILE_DIR);
    assert.equal(entries[0].reason, undefined, 'null 文本字段被丢弃而不是写 null');
    assert.equal(entries[1].from, 'C:\\old');
    assert.equal(entries[1].to, 'C:\\new');
    assert.equal(entries[2].inferredFromCwd, 'C:\\new\\src');
    assert.equal(entries[3].reason, 'no-project-root');
    assert.equal(entries[3].sessionShortId, 'session-');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('2a 状态文件：非法入参拒绝且不抛错', () => {
  assert.equal(writeRootState('', { root: os.tmpdir() }), false);
  assert.equal(writeRootState(path.join(os.tmpdir(), 'x.json'), { root: 'relative' }), false);
  assert.equal(writeRootState(path.join(os.tmpdir(), 'x.json'), {}), false);
  assert.equal(writeRootState(path.join(os.tmpdir(), 'x.json'), null), false);
});

// ---------------------------------------------------------------- inference

test('2a 推断：从深层 cwd 上溯到最近的含 .git 祖先（realpath + 盘符归一）', async () => {
  const dir = await tempDir('cg-2a-infer-');
  try {
    const repo = path.join(dir, 'repo');
    const deep = path.join(repo, 'packages', 'a', 'src');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(deep, { recursive: true });
    assert.equal(inferRootFromCwd(deep), normalizeRootPath(repo));
    assert.equal(inferRootFromCwd(repo), normalizeRootPath(repo));
    assert.equal(inferRootFromCwd(`  ${deep}  `), normalizeRootPath(repo), '应修剪空白');
    if (process.platform === 'win32') {
      assert.match(normalizeRootPath(repo), /^[A-Z]:\\/, '盘符归一为大写');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a 推断：worktree 形态（.git 是文件）也算根', async () => {
  const dir = await tempDir('cg-2a-worktree-');
  try {
    const repo = path.join(dir, 'repo');
    const deep = path.join(repo, 'sub');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(repo, '.git'), 'gitdir: C:\\elsewhere\n', 'utf8');
    assert.equal(inferRootFromCwd(deep), normalizeRootPath(repo));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a 推断：结果落在 DSH home 内 → null（不把 DSH 自己当项目根）', async () => {
  const dir = await tempDir('cg-2a-home-');
  try {
    const home = path.join(dir, 'home');
    const inside = path.join(home, 'repo', 'sub');
    await fs.mkdir(path.join(home, 'repo', '.git'), { recursive: true });
    await fs.mkdir(inside, { recursive: true });
    assert.equal(inferRootFromCwd(inside, { exclude: home }), null);
    assert.equal(inferRootFromCwd(inside), normalizeRootPath(path.join(home, 'repo')), '不传 exclude 时按普通 git 仓');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a 推断：空/非字符串返回 null（no-project-root 输入面）', () => {
  for (const cwd of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(inferRootFromCwd(cwd), null);
  }
});

test('2a 路径归一：samePath 大小写按平台；normalizeRootPath 拒绝非法', () => {
  assert.equal(samePath('C:\\A\\b', 'c:\\a\\b'), process.platform === 'win32');
  assert.equal(samePath('C:\\A', 'C:\\A\\sub'), false);
  assert.equal(normalizeRootPath(''), null);
  assert.equal(normalizeRootPath(null), null);
  assert.equal(normalizeRootPath(42), null);
});

test('2a 并发：独占发布只成功一个，后到者读回既有根', async () => {
  const dir = await tempDir('cg-2a-race-');
  try {
    const file = path.join(dir, 'state', 'root-state.json');
    const first = persistInferredRoot(file, { root: dir, inferredFromCwd: dir, profile: 'main' });
    assert.equal(first.ok, true);
    assert.equal(first.existed, false);
    assert.equal(first.root, path.resolve(dir));
    const second = persistInferredRoot(file, { root: path.join(dir, 'other'), inferredFromCwd: dir, profile: 'main' });
    assert.equal(second.ok, true);
    assert.equal(second.existed, true);
    assert.equal(second.root, path.resolve(dir), '后到者必须读回既有根，不覆盖');
    assert.equal(readRootState(file).root, path.resolve(dir));
    const leftover = (await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftover, [], '不残留 tmp 文件');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a sessionCwd：优先 header.cwd，退回 session.cwd', () => {
  assert.equal(sessionCwd({ header: { cwd: ' C:\\a ' } }), 'C:\\a');
  assert.equal(sessionCwd({ cwd: 'C:\\b' }), 'C:\\b');
  assert.equal(sessionCwd({ header: { cwd: '' }, cwd: 'C:\\c' }), 'C:\\c');
  assert.equal(sessionCwd({}), '');
  assert.equal(sessionCwd(null), '');
});

// ---------------------------------------------------------------- status lines

function statusCommandFor({ rootInfo = null, identity = null } = {}) {
  return createStatusCommand({
    store: null,
    policy: null,
    audit: null,
    getRootInfo: () => rootInfo,
    getPersistenceIdentity: () => identity,
  });
}

async function statusText(options) {
  const result = await statusCommandFor(options).handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  return result.text;
}

test('2a status：根未知 → unknown (no-project-root) + 身份诊断行', async () => {
  const identity = resolvePersistenceIdentity(ctxWithProfile({ name: 'main', dir: PROFILE_DIR, home: PROFILE_HOME }));
  const text = await statusText({
    rootInfo: { root: null, source: 'none', identity, stateFile: identity.stateFile, persistedRoot: null },
    identity,
  });
  assert.match(text, /^project-root: unknown \(no-project-root\)$/m);
  assert.match(text, /^persistence-identity: source=profileContext name=main dir=.* home=present anchor=home path=.*$/m);
});

test('2a status：推断根标 inferred-fresh，持久化根标 persisted', async () => {
  const inferred = await statusText({
    rootInfo: { root: 'C:\\work\\proj', source: 'inferred', identity: null, stateFile: 'C:\\s.json', persistedRoot: null },
    identity: null,
  });
  assert.match(inferred, /^project-root: C:\\work\\proj \(source=inferred, inferred-fresh\)$/m);

  const persistFailed = await statusText({
    rootInfo: {
      root: 'C:\\work\\proj', source: 'inferred', identity: null, stateFile: 'C:\\s.json', persistedRoot: null, statePersisted: false,
    },
    identity: null,
  });
  assert.match(persistFailed, /^project-root: C:\\work\\proj \(source=inferred, inferred-fresh, state-write-failed\)$/m);

  const persisted = await statusText({
    rootInfo: { root: 'C:\\work\\proj', source: 'persisted', identity: null, stateFile: 'C:\\s.json', persistedRoot: 'C:\\work\\proj' },
    identity: null,
  });
  assert.match(persisted, /^project-root: C:\\work\\proj \(source=persisted\)$/m);
});

test('2a status：显式配置改根 → changed-from 可见；回落持久化根同样可见；身份不可用 → fail-closed 行', async () => {
  const configText = await statusText({
    rootInfo: {
      root: 'C:\\work\\new', source: 'config', identity: null, stateFile: 'C:\\s.json',
      persistedRoot: 'C:\\work\\old', changedFrom: 'C:\\work\\old',
    },
    identity: null,
  });
  assert.match(configText, /^project-root: C:\\work\\new \(source=config, changed-from=C:\\work\\old\)$/m);

  const fallbackText = await statusText({
    rootInfo: {
      root: 'C:\\work\\old', source: 'persisted', identity: null, stateFile: 'C:\\s.json',
      persistedRoot: 'C:\\work\\old', changedFrom: 'C:\\work\\new',
    },
    identity: null,
  });
  assert.match(fallbackText, /^project-root: C:\\work\\old \(source=persisted, changed-from=C:\\work\\new\)$/m);

  const unavailable = { ok: false, reason: 'profileContext-unavailable' };
  const text = await statusText({
    rootInfo: { root: null, source: 'none', identity: unavailable, stateFile: null, persistedRoot: null },
    identity: unavailable,
  });
  assert.match(text, /^persistence-identity: persistence-identity-unavailable reason=profileContext-unavailable$/m);
});

test('2a status：未注入 getter 时不多出根行（向后兼容）', async () => {
  const result = await createStatusCommand({ store: null, policy: null, audit: null }).handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  assert.doesNotMatch(result.text, /^project-root:/m);
  assert.doesNotMatch(result.text, /^persistence-identity:/m);
});

// ---------------------------------------------------------------- apply 集成

function makeApplyContext({ profile, profileGet, commands, handlers, cleanups, logs }) {
  const ctx = {
    tools: { register: () => {} },
    commands: { register: (definition) => commands.push(definition) },
    get(name) {
      if (name === 'profileContext') {
        return typeof profileGet === 'function' ? profileGet() : profile;
      }
      if (name === 'commands') return ctx.commands;
      return undefined;
    },
    effect: (factory) => cleanups.push(factory),
    on: (event, cb) => {
      const entry = { event, cb };
      handlers.push(entry);
      return () => {
        const index = handlers.indexOf(entry);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
      error: (message) => logs.error.push(String(message)),
    },
  };
  return ctx;
}

function fireSessionEvent(handlers, session) {
  for (const handler of handlers.slice()) {
    if (handler.event === 'session/event') handler.cb(session, { type: 'turn/end' });
  }
}

async function until(check, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function closeContext(cleanups) {
  for (const factory of cleanups.splice(0).reverse()) {
    try {
      const cleanup = factory();
      if (typeof cleanup === 'function') await cleanup();
    } catch {
      /* 清理失败不遮蔽断言结果 */
    }
  }
}

test('2a apply：未配置 → 根未知（最小 status 可用），首个带 cwd 事件推断并持久化', async () => {
  const dir = await tempDir('cg-2a-apply-');
  const home = path.join(dir, 'home');
  const profile = { name: 'prof', dir: path.join(dir, 'profile'), home };
  const repo = path.join(dir, 'repo');
  const deep = path.join(repo, 'src');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(deep, { recursive: true });
  const diagFile = path.join(dir, 'diag.log');
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  try {
    await apply(
      makeApplyContext({ profile, commands, handlers, cleanups, logs }),
      { diagnostics: { logFile: diagFile }, compression: { enabled: false }, project: 'test-project' },
    );
    assert.equal(commands.length, 1, '根未知时先注册最小 status');
    assert.equal(handlers.some((handler) => handler.cb.name === 'firstInferenceRootWatcher'), true, '根未知时应挂首次推断 watcher');
    const minimalStatus = await commands[0].handler({ rawInput: 'status' });
    assert.match(minimalStatus.text, /^project-root: unknown \(no-project-root\)$/m);
    assert.match(minimalStatus.text, /^persistence-identity: source=profileContext name=prof dir=.* home=present anchor=home path=.*$/m);
    await assert.rejects(fs.access(stateFile), '推断前不得写状态文件');

    fireSessionEvent(handlers, { id: 'sess-1', header: { cwd: deep } });
    const attached = await until(() => commands.length >= 2 && fs.access(stateFile).then(() => true, () => false));
    assert.equal(attached, true, '应在首个带 cwd 的事件后挂载并写状态');

    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.version, 2);
    assert.equal(state.primaryRoot, normalizeRootPath(repo));
    const entry = state.roots[state.primaryRootId];
    assert.equal(entry.root, normalizeRootPath(repo));
    assert.equal(entry.inferredFromCwd, path.resolve(deep));
    assert.equal(entry.origin, 'inferred');
    assert.equal(typeof entry.inferredAt, 'string');

    const status = await commands.at(-1).handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(`^project-root: ${normalizeRootPath(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(source=inferred, inferred-fresh\\)$`, 'm'));
    assert.match(status.text, /memory: project=test-project/);

    const diag = await fs.readFile(diagFile, 'utf8');
    assert.match(diag, /persistence-identity: source=profileContext name=prof/);
    assert.match(diag, /persistence: root=unknown \(awaiting first inference\)/);
  } finally {
    await closeContext(cleanups);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a apply：已有持久化状态 → 直接按 persisted 启动，不重新推断', async () => {
  const dir = await tempDir('cg-2a-persisted-');
  const home = path.join(dir, 'home');
  const profile = { name: 'prof', dir: path.join(dir, 'profile'), home };
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  assert.equal(writeRootState(stateFile, { root: repo, inferredAt: '2026-10-25T00:00:00.000Z' }), true);
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  try {
    await apply(
      makeApplyContext({ profile, commands, handlers, cleanups, logs }),
      { compression: { enabled: false }, project: 'test-project' },
    );
    assert.equal(commands.length, 1, '已有根时直接注册正式 status');
    const status = await commands[0].handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(`^project-root: ${normalizeRootPath(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(source=persisted\\)$`, 'm'));
    assert.equal(handlers.filter((handler) => handler.cb.name === 'firstInferenceRootWatcher').length, 0, '根已确定时不得再挂首次推断 watcher');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.version, 2, '重启后 v2 状态沿用');
    assert.equal(state.roots[state.primaryRootId].inferredAt, '2026-10-25T00:00:00.000Z', '沿用持久化推断时间，不应重写');
  } finally {
    await closeContext(cleanups);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a apply：显式配置根赢过持久化根 → status changed-from，持久化 root 不被改写（只写 configRoot 镜像）', async () => {
  const dir = await tempDir('cg-2a-config-');
  const home = path.join(dir, 'home');
  const profile = { name: 'prof', dir: path.join(dir, 'profile'), home };
  const oldRoot = path.join(dir, 'old');
  const newRoot = path.join(dir, 'new');
  await fs.mkdir(oldRoot, { recursive: true });
  await fs.mkdir(newRoot, { recursive: true });
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  assert.equal(writeRootState(stateFile, { root: oldRoot }), true);
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  try {
    await apply(
      makeApplyContext({ profile, commands, handlers, cleanups, logs }),
      { projectRoot: newRoot, compression: { enabled: false }, project: 'test-project' },
    );
    const status = await commands[0].handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(
      `^project-root: ${path.resolve(newRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(source=config, changed-from=${path.resolve(oldRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`,
      'm',
    ));
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.primaryRoot, path.resolve(oldRoot), 'config 不得改写持久化主根（移除配置后要回落到它）');
    assert.equal(state.roots[state.primaryRootId].root, path.resolve(oldRoot));
    assert.equal(state.configRoot, path.resolve(newRoot), 'config 覆盖留镜像，供回落审计');
  } finally {
    await closeContext(cleanups);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a apply：config 移除后回落到持久化根 → changed-from 可见并清掉镜像', async () => {
  const dir = await tempDir('cg-2a-fallback-');
  const home = path.join(dir, 'home');
  const profile = { name: 'prof', dir: path.join(dir, 'profile'), home };
  const persistedRoot = path.join(dir, 'persisted');
  const previousConfigRoot = path.join(dir, 'config-root');
  await fs.mkdir(persistedRoot, { recursive: true });
  await fs.mkdir(previousConfigRoot, { recursive: true });
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  assert.equal(writeRootState(stateFile, {
    root: persistedRoot,
    inferredFromCwd: path.join(persistedRoot, 'src'),
    profile: 'prof',
    configRoot: previousConfigRoot,
  }), true);
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  try {
    await apply(
      makeApplyContext({ profile, commands, handlers, cleanups, logs }),
      { compression: { enabled: false }, project: 'test-project' },
    );
    const status = await commands[0].handler({ rawInput: 'status' });
    assert.match(status.text, new RegExp(
      `^project-root: ${path.resolve(persistedRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ` +
      `\\(source=persisted, changed-from=${path.resolve(previousConfigRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`,
      'm',
    ));
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.primaryRoot, path.resolve(persistedRoot));
    assert.equal(state.configRoot, null, '回落后期镜必须清掉，避免每次启动重复审计');
  } finally {
    await closeContext(cleanups);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a apply：两段采样——先非 git 会话（no-project-root，不写盘）后本区会话（inferred-fresh）', async () => {
  const dir = await tempDir('cg-2a-twophase-');
  const home = path.join(dir, 'home');
  const profile = { name: 'prof', dir: path.join(dir, 'profile'), home };
  const repo = path.join(dir, 'repo');
  const deep = path.join(repo, 'src');
  const nogit = path.join(dir, 'nogit');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(deep, { recursive: true });
  await fs.mkdir(nogit, { recursive: true });
  const diagFile = path.join(dir, 'diag.log');
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  try {
    assert.equal(inferRootFromCwd(nogit), null, '前置：nogit 目录不得落在任何 git 仓内');
    await apply(
      makeApplyContext({ profile, commands, handlers, cleanups, logs }),
      { diagnostics: { logFile: diagFile }, compression: { enabled: false }, project: 'test-project' },
    );
    // 第一段：非 git 会话（模拟 00 的 G:\DS-HARNESS）→ no-project-root，根未知、不写盘。
    fireSessionEvent(handlers, { id: 'sess-nogit', header: { cwd: nogit } });
    const failedSeen = await until(() => logs.warn.some((line) => line.includes('no-project-root')));
    assert.equal(failedSeen, true, `应留 no-project-root 警告，实际 warn=${JSON.stringify(logs.warn)}`);
    await assert.rejects(fs.access(stateFile), '第一段失败不得写状态文件');
    assert.equal(commands.length, 1, '第一段失败不得挂载 runtime');
    assert.match(await fs.readFile(diagFile, 'utf8'), /persistence: no-project-root/);

    // 第二段：本区 git 会话 → 推断成功 + 落盘 + 完整 runtime。
    fireSessionEvent(handlers, { id: 'sess-repo', header: { cwd: deep } });
    const attached = await until(() => commands.length >= 2 && fs.access(stateFile).then(() => true, () => false));
    assert.equal(attached, true, '第二段应推断成功并落盘');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(state.version, 2);
    assert.equal(state.primaryRoot, normalizeRootPath(repo));
    assert.equal(state.roots[state.primaryRootId].inferredFromCwd, path.resolve(deep));
    const status = await commands.at(-1).handler({ rawInput: 'status' });
    assert.match(status.text, /^project-root: .*\(source=inferred, inferred-fresh\)$/m);
    const diag = await fs.readFile(diagFile, 'utf8');
    assert.match(diag, /persistence: no-project-root/);
    assert.match(diag, /persistence-identity: source=profileContext name=prof/);
  } finally {
    await closeContext(cleanups);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a apply：推断失败（cwd 缺失）→ no-project-root 警告，根保持未知、不写盘', async () => {
  const dir = await tempDir('cg-2a-noroot-');
  const home = path.join(dir, 'home');
  const profile = { name: 'prof', dir: path.join(dir, 'profile'), home };
  const diagFile = path.join(dir, 'diag.log');
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  const stateFile = path.join(home, 'context-governance', 'root-state-prof.json');
  try {
    await apply(
      makeApplyContext({ profile, commands, handlers, cleanups, logs }),
      { diagnostics: { logFile: diagFile }, compression: { enabled: false }, project: 'test-project' },
    );
    fireSessionEvent(handlers, { id: 'sess-no-cwd' });
    const warned = await until(() => logs.warn.some((line) => line.includes('no-project-root')));
    assert.equal(warned, true, `应留 no-project-root 警告，实际 warn=${JSON.stringify(logs.warn)}`);
    assert.equal(commands.length, 1, '推断失败不得挂载运行时');
    await assert.rejects(fs.access(stateFile), '推断失败不得写状态文件');
    const status = await commands[0].handler({ rawInput: 'status' });
    assert.match(status.text, /^project-root: unknown \(no-project-root\)$/m);
    const diag = await fs.readFile(diagFile, 'utf8');
    assert.match(diag, /persistence: no-project-root/);
  } finally {
    await closeContext(cleanups);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('2a apply：身份不可用 → fail-closed（不推断、不写盘、status 明示）', async () => {
  const dir = await tempDir('cg-2a-noidentity-');
  const profileGet = () => undefined;
  const commands = [];
  const handlers = [];
  const cleanups = [];
  const logs = { info: [], warn: [], error: [] };
  try {
    await apply(
      makeApplyContext({ profile: null, profileGet, commands, handlers, cleanups, logs }),
      { compression: { enabled: false }, project: 'test-project' },
    );
    assert.equal(commands.length, 1);
    const status = await commands[0].handler({ rawInput: 'status' });
    assert.match(status.text, /^persistence-identity: persistence-identity-unavailable reason=profileContext-unavailable$/m);
    assert.match(status.text, /^project-root: unknown \(no-project-root\)$/m);
    assert.equal(handlers.filter((handler) => handler.cb.name === 'firstInferenceRootWatcher').length, 0, '身份不可用时不得挂推断 watcher');
    assert.equal(logs.warn.some((line) => line.includes('first inference disabled')), true);
  } finally {
    await closeContext(cleanups);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
