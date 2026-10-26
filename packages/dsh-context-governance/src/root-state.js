/**
 * 持久化身份 + 根状态文件（v1 兼容 + v2 多根）。
 *
 * 身份来源唯一 = `ctx.get('profileContext')`（宿主启动数据）。
 * 不读 DSH_HOME/DSH_PROFILE（已实证宿主 PEB 无这些变量）。
 *
 * v1（单根，保留给回滚/旧测试）：
 *   {version:1, root, source:'inferred', inferredAt, inferredFromCwd, instance:{profile}, configRoot?}
 * v2（P1 多根）：
 *   {version:2, profile, roots:{<rootId>:{root,rootId,name,project,origin,...}},
 *    primaryRootId, primaryRoot, configRoot?, migratedFrom?, migratedAt?}
 *
 * 本文件只写用户级 `context-governance/`；根内写入由 `roots/paths.js` 守卫。
 */
import fs from 'node:fs';
import path from 'node:path';

import { isWithin, normalizeRootPath, platformFold, rootIdOf, rootNameOf, samePath } from './roots/identity.js';
import { safeProfileName } from './roots/paths.js';

const STATE_DIR = 'context-governance';
const STATE_VERSION = 1;
export const STATE_VERSION_V2 = 2;

// 兼容出口：2a 的调用方/测试仍从 root-state 导入这些纯函数。
export { normalizeRootPath, samePath, isWithin, safeProfileName };
export { inferRootFromCwd } from './roots/identity.js';

/** 解析持久化身份（只读，不写盘）。 */
export function resolvePersistenceIdentity(ctx) {
  let pc = null;
  try {
    pc = typeof ctx?.get === 'function' ? ctx.get('profileContext') : null;
  } catch {
    pc = null;
  }
  if (pc === null || typeof pc !== 'object' || Array.isArray(pc)) {
    return { ok: false, reason: 'profileContext-unavailable' };
  }
  const name = pc.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, reason: 'profile-name-invalid' };
  }
  const dir = pc.dir;
  if (typeof dir !== 'string' || dir.trim() === '' || !path.isAbsolute(dir)) {
    return { ok: false, reason: 'profile-dir-invalid' };
  }
  const home = pc.home;
  const homeValid = typeof home === 'string' && home.trim() !== '' && path.isAbsolute(home);
  if (homeValid) {
    return {
      ok: true,
      name: name.trim(),
      dir: path.resolve(dir),
      home: path.resolve(home),
      anchor: 'home',
      stateFile: path.join(path.resolve(home), STATE_DIR, `root-state-${safeProfileName(name)}.json`),
    };
  }
  return {
    ok: true,
    name: name.trim(),
    dir: path.resolve(dir),
    home: null,
    anchor: 'dir',
    stateFile: path.join(path.resolve(dir), STATE_DIR, 'root-state.json'),
  };
}

// ---------------------------------------------------------------------------
// v1（保留：迁移输入 + 回滚形态）
// ---------------------------------------------------------------------------

function v1Document({ root, inferredAt, inferredFromCwd, profile, configRoot } = {}) {
  const inferredAtValue = inferredAt === null
    ? null
    : (typeof inferredAt === 'string' && inferredAt !== '' ? inferredAt : new Date().toISOString());
  const document = {
    version: STATE_VERSION,
    root: path.resolve(root),
    source: 'inferred',
    inferredAt: inferredAtValue,
    inferredFromCwd: typeof inferredFromCwd === 'string' && inferredFromCwd !== ''
      ? path.resolve(inferredFromCwd)
      : null,
    instance: { profile: typeof profile === 'string' && profile !== '' ? profile : null },
  };
  if (typeof configRoot === 'string' && configRoot !== '') document.configRoot = path.resolve(configRoot);
  return document;
}

/** 校验 v1 文档（不抛错）；坏值返回 null。 */
export function validateV1Document(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.version !== STATE_VERSION) return null;
  if (parsed.source !== undefined && parsed.source !== 'inferred') return null;
  const root = parsed.root;
  if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) return null;
  if (parsed.inferredAt !== undefined && parsed.inferredAt !== null && typeof parsed.inferredAt !== 'string') return null;
  if (parsed.inferredFromCwd !== undefined && parsed.inferredFromCwd !== null
    && (typeof parsed.inferredFromCwd !== 'string' || !path.isAbsolute(parsed.inferredFromCwd))) return null;
  if (parsed.configRoot !== undefined && parsed.configRoot !== null
    && (typeof parsed.configRoot !== 'string' || !path.isAbsolute(parsed.configRoot))) return null;
  if (parsed.instance !== undefined && (parsed.instance === null || typeof parsed.instance !== 'object'
    || Array.isArray(parsed.instance))) return null;
  const instanceProfile = parsed.instance?.profile;
  if (instanceProfile !== undefined && instanceProfile !== null && typeof instanceProfile !== 'string') return null;
  return {
    root: path.resolve(root),
    source: 'inferred',
    inferredAt: typeof parsed.inferredAt === 'string' ? parsed.inferredAt : null,
    inferredFromCwd: typeof parsed.inferredFromCwd === 'string' ? path.resolve(parsed.inferredFromCwd) : null,
    configRoot: typeof parsed.configRoot === 'string' ? path.resolve(parsed.configRoot) : null,
    instance: { profile: typeof instanceProfile === 'string' ? instanceProfile : null },
  };
}

/** 读取 v1 持久化根；文件缺失/损坏/版本不符/字段非法返回 null（不抛错）。 */
export function readRootState(stateFile) {
  if (typeof stateFile !== 'string' || stateFile === '') return null;
  try {
    return validateV1Document(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } catch {
    return null;
  }
}

/** 原子写 v1（tmp + rename）；失败返回 false，不抛错。会覆盖已有文件。 */
export function writeRootState(stateFile, options = {}) {
  const { root, inferredAt, inferredFromCwd, profile, configRoot } = options ?? {};
  if (typeof stateFile !== 'string' || stateFile === '') return false;
  if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) return false;
  const target = path.resolve(stateFile);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(v1Document({ root, inferredAt, inferredFromCwd, profile, configRoot }), null, 2), 'utf8');
    fs.renameSync(temp, target);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/**
 * v1 首次推断落盘：独占发布（tmp + link），已存在则不覆盖并读回既有根。
 * @returns {{ok:boolean, existed:boolean, root:string|null}}
 */
export function persistInferredRoot(stateFile, options = {}) {
  const { root, inferredFromCwd, profile } = options ?? {};
  if (typeof stateFile !== 'string' || stateFile === '' || typeof root !== 'string'
    || root.trim() === '' || !path.isAbsolute(root)) {
    return { ok: false, existed: false, root: null };
  }
  const target = path.resolve(stateFile);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const document = v1Document({ root, inferredFromCwd, profile });
    fs.writeFileSync(temp, JSON.stringify(document, null, 2), 'utf8');
    try {
      fs.linkSync(temp, target);
      return { ok: true, existed: false, root: document.root };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = readRootState(target);
        return { ok: true, existed: true, root: existing === null ? null : existing.root };
      }
      const existing = readRootState(target);
      if (existing !== null) return { ok: true, existed: true, root: existing.root };
      fs.renameSync(temp, target);
      return { ok: true, existed: false, root: document.root };
    }
  } catch {
    return { ok: false, existed: false, root: null };
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// v2（P1 多根）
// ---------------------------------------------------------------------------

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function emptyV2State(profile = null) {
  return {
    version: STATE_VERSION_V2,
    profile: typeof profile === 'string' && profile !== '' ? profile : null,
    roots: {},
    primaryRootId: null,
    primaryRoot: null,
    configRoot: null,
  };
}

/** 构造一个 v2 条目（不做碰撞延长；registry 负责）。 */
export function makeV2Entry({
  root,
  origin = 'inferred',
  inferredAt = null,
  inferredFromCwd = null,
  firstSeenAt = null,
  lastSeenAt = null,
  project = null,
  hashFn = undefined,
  now = new Date(),
} = {}) {
  const canonical = normalizeRootPath(root);
  if (canonical === null) return null;
  const stamp = now.toISOString();
  const rootId = rootIdOf(canonical, { hashFn });
  if (rootId === '') return null;
  const name = rootNameOf(canonical);
  return {
    rootId,
    root: canonical,
    name,
    project: typeof project === 'string' && project !== '' ? project : name,
    origin: origin === 'config' ? 'config' : 'inferred',
    inferredAt: origin === 'config' ? (inferredAt ?? null) : (inferredAt ?? stamp),
    inferredFromCwd: typeof inferredFromCwd === 'string' && inferredFromCwd !== '' ? path.resolve(inferredFromCwd) : null,
    firstSeenAt: firstSeenAt ?? stamp,
    lastSeenAt: lastSeenAt ?? stamp,
    state: 'active',
    failClosedReason: null,
  };
}

/** 校验单个 v2 条目；rootId 必须由 root 重算并相等。 */
export function validateV2Entry(raw, { hashFn = undefined } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'entry-not-object' };
  }
  const canonical = normalizeRootPath(raw.root);
  if (canonical === null) return { ok: false, reason: 'root-invalid' };
  if (typeof raw.rootId !== 'string' || !/^[0-9a-f]+$/i.test(raw.rootId)) {
    return { ok: false, reason: 'root-id-invalid' };
  }
  const expected = rootIdOf(canonical, { length: raw.rootId.length, hashFn });
  if (expected === '' || expected !== raw.rootId.toLowerCase()) {
    return { ok: false, reason: 'root-id-mismatch' };
  }
  const origin = raw.origin === 'config' ? 'config' : (raw.origin === 'inferred' ? 'inferred' : null);
  if (origin === null) return { ok: false, reason: 'origin-invalid' };
  const state = raw.state === 'fail-closed' ? 'fail-closed' : (raw.state === 'active' ? 'active' : null);
  if (state === null) return { ok: false, reason: 'state-invalid' };
  const inferredAt = raw.inferredAt === null || raw.inferredAt === undefined
    ? (origin === 'config' ? null : null)
    : (typeof raw.inferredAt === 'string' ? raw.inferredAt : null);
  if (raw.inferredAt !== undefined && raw.inferredAt !== null && typeof raw.inferredAt !== 'string') {
    return { ok: false, reason: 'inferred-at-invalid' };
  }
  if (raw.inferredFromCwd !== undefined && raw.inferredFromCwd !== null
    && (typeof raw.inferredFromCwd !== 'string' || !path.isAbsolute(raw.inferredFromCwd))) {
    return { ok: false, reason: 'inferred-from-cwd-invalid' };
  }
  if (typeof raw.firstSeenAt !== 'string' || typeof raw.lastSeenAt !== 'string') {
    return { ok: false, reason: 'seen-at-invalid' };
  }
  if (raw.failClosedReason !== undefined && raw.failClosedReason !== null
    && typeof raw.failClosedReason !== 'string') {
    return { ok: false, reason: 'fail-closed-reason-invalid' };
  }
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : rootNameOf(canonical);
  const project = typeof raw.project === 'string' && raw.project !== '' ? raw.project : name;
  return {
    ok: true,
    entry: {
      rootId: expected,
      root: canonical,
      name,
      project,
      origin,
      inferredAt,
      inferredFromCwd: typeof raw.inferredFromCwd === 'string' ? path.resolve(raw.inferredFromCwd) : null,
      firstSeenAt: raw.firstSeenAt,
      lastSeenAt: raw.lastSeenAt,
      state,
      failClosedReason: typeof raw.failClosedReason === 'string' ? raw.failClosedReason : null,
    },
  };
}

/** 校验 v2 文档；`roots` 不是对象返回 null（= 文件损坏）；坏条目逐条丢弃。 */
export function validateV2Document(parsed, { profile = null, hashFn = undefined } = {}) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.version !== STATE_VERSION_V2) return null;
  if (parsed.roots === null || typeof parsed.roots !== 'object' || Array.isArray(parsed.roots)) return null;
  const state = emptyV2State(typeof parsed.profile === 'string' && parsed.profile !== '' ? parsed.profile : profile);
  const invalid = [];
  for (const [key, value] of Object.entries(parsed.roots)) {
    const result = validateV2Entry(value, { hashFn });
    if (!result.ok) {
      invalid.push({ key, reason: result.reason });
      continue;
    }
    if (result.entry.rootId !== key.toLowerCase()) {
      invalid.push({ key, reason: 'root-key-mismatch' });
      continue;
    }
    if (state.roots[result.entry.rootId] !== undefined) {
      invalid.push({ key, reason: 'duplicate-root' });
      continue;
    }
    state.roots[result.entry.rootId] = result.entry;
  }
  if (typeof parsed.primaryRootId === 'string' && state.roots[parsed.primaryRootId] !== undefined) {
    const entry = state.roots[parsed.primaryRootId];
    state.primaryRootId = entry.rootId;
    state.primaryRoot = entry.root;
    if (typeof parsed.primaryRoot === 'string') {
      const declared = normalizeRootPath(parsed.primaryRoot);
      if (declared === null || !samePath(declared, entry.root)) {
        invalid.push({ key: 'primaryRoot', reason: 'primary-root-mismatch' });
      }
    }
  } else if (parsed.primaryRootId !== undefined && parsed.primaryRootId !== null) {
    invalid.push({ key: 'primaryRootId', reason: 'primary-root-missing' });
  }
  if (typeof parsed.configRoot === 'string' && path.isAbsolute(parsed.configRoot)) {
    state.configRoot = normalizeRootPath(parsed.configRoot);
  } else if (parsed.configRoot !== undefined && parsed.configRoot !== null) {
    invalid.push({ key: 'configRoot', reason: 'config-root-invalid' });
  }
  if (Number.isFinite(parsed.migratedFrom)) state.migratedFrom = parsed.migratedFrom;
  if (typeof parsed.migratedAt === 'string') state.migratedAt = parsed.migratedAt;
  return { state, invalid };
}

function readStateFileRaw(stateFile) {
  try {
    return { kind: 'json', value: JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupt', reason: error?.code ?? 'parse-error' };
  }
}

/** 把损坏的状态文件改名为 `.corrupt-<UTC>.json`（保留证据，不删除）。 */
export function quarantineStateFile(stateFile, { now = new Date() } = {}) {
  const target = path.resolve(stateFile);
  const quarantined = target.replace(/\.json$/i, `.corrupt-${utcStamp(now)}.json`);
  try {
    fs.renameSync(target, quarantined);
    return quarantined;
  } catch {
    return null;
  }
}

/** 迁移前备份 v1：`root-state-X.v1.bak`；已存在则加时间戳，不覆盖旧备份。 */
export function backupV1StateFile(stateFile, { now = new Date() } = {}) {
  const source = path.resolve(stateFile);
  let target = source.replace(/\.json$/i, '.v1.bak');
  if (fs.existsSync(target)) target = source.replace(/\.json$/i, `.v1-${utcStamp(now)}.bak`);
  try {
    fs.copyFileSync(source, target);
    return target;
  } catch {
    return null;
  }
}

/** v2 清洗前留证：`root-state-X.v2-bad-<UTC>.json`（只在有条目损坏时）。 */
function backupV2Bad(stateFile, { now = new Date() } = {}) {
  const source = path.resolve(stateFile);
  const target = source.replace(/\.json$/i, `.v2-bad-${utcStamp(now)}.json`);
  try {
    fs.copyFileSync(source, target);
    return target;
  } catch {
    return null;
  }
}

/** 原子写 v2（tmp + rename）；失败返回 false。 */
export function writeStateV2(stateFile, state) {
  if (typeof stateFile !== 'string' || stateFile === '') return false;
  if (state === null || typeof state !== 'object' || state.version !== STATE_VERSION_V2
    || state.roots === null || typeof state.roots !== 'object' || Array.isArray(state.roots)) {
    return false;
  }
  const target = path.resolve(stateFile);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, target);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

function buildV2FromV1(v1, { now = new Date(), profile = null, hashFn = undefined } = {}) {
  const entry = makeV2Entry({
    root: v1.root,
    origin: 'inferred',
    inferredAt: v1.inferredAt,
    inferredFromCwd: v1.inferredFromCwd,
    firstSeenAt: v1.inferredAt ?? now.toISOString(),
    lastSeenAt: now.toISOString(),
    hashFn,
    now,
  });
  if (entry === null) return null;
  const state = emptyV2State(profile ?? v1.instance?.profile ?? null);
  state.roots[entry.rootId] = entry;
  state.primaryRootId = entry.rootId;
  state.primaryRoot = entry.root;
  state.configRoot = v1.configRoot ?? null;
  state.migratedFrom = STATE_VERSION;
  state.migratedAt = now.toISOString();
  return state;
}

/**
 * 读取状态文件（v2；v1 自动迁移；损坏隔离；未来版本只读）。
 *
 * @returns {{state:object, missing?:boolean, migrated?:boolean, backupPath?:string|null,
 *   corrupt?:boolean, corruptPath?:string|null, unsupported?:boolean, version?:number,
 *   invalidEntries?:Array<{key:string,reason:string}>, writable:boolean}}
 */
export function loadStateV2(stateFile, {
  now = new Date(),
  profile = null,
  repair = true,
  hashFn = undefined,
} = {}) {
  const empty = emptyV2State(profile);
  if (typeof stateFile !== 'string' || stateFile === '') {
    return { state: empty, missing: true, writable: false };
  }
  const raw = readStateFileRaw(stateFile);
  if (raw.kind === 'missing') return { state: empty, missing: true, writable: true };
  if (raw.kind === 'corrupt') {
    const corruptPath = repair ? quarantineStateFile(stateFile, { now }) : null;
    return { state: empty, corrupt: true, corruptPath, writable: repair && corruptPath !== null };
  }
  const value = raw.value;
  if (value !== null && typeof value === 'object' && Number.isFinite(value.version) && value.version > STATE_VERSION_V2) {
    return { state: empty, unsupported: true, version: value.version, writable: false };
  }
  if (value !== null && typeof value === 'object' && value.version === STATE_VERSION) {
    const v1 = validateV1Document(value);
    if (v1 === null) {
      const corruptPath = repair ? quarantineStateFile(stateFile, { now }) : null;
      return { state: empty, corrupt: true, corruptPath, writable: repair && corruptPath !== null };
    }
    const state = buildV2FromV1(v1, { now, profile, hashFn });
    if (state === null) {
      const corruptPath = repair ? quarantineStateFile(stateFile, { now }) : null;
      return { state: empty, corrupt: true, corruptPath, writable: repair && corruptPath !== null };
    }
    const backupPath = repair ? backupV1StateFile(stateFile, { now }) : null;
    const written = repair ? writeStateV2(stateFile, state) : false;
    return {
      state,
      migrated: true,
      backupPath,
      writable: repair ? written : true,
      invalidEntries: [],
    };
  }
  if (value !== null && typeof value === 'object' && value.version === STATE_VERSION_V2) {
    const validated = validateV2Document(value, { profile, hashFn });
    if (validated === null) {
      const corruptPath = repair ? quarantineStateFile(stateFile, { now }) : null;
      return { state: empty, corrupt: true, corruptPath, writable: repair && corruptPath !== null };
    }
    // 坏条目：非破坏性修复 —— 留证原文件后把清洗后的 v2 写回（只丢坏条目）。
    if (repair && validated.invalid.length > 0) {
      backupV2Bad(stateFile, { now });
      writeStateV2(stateFile, validated.state);
    }
    return { state: validated.state, invalidEntries: validated.invalid, writable: true };
  }
  const corruptPath = repair ? quarantineStateFile(stateFile, { now }) : null;
  return { state: empty, corrupt: true, corruptPath, writable: repair && corruptPath !== null };
}

/**
 * 合并写：读盘 → 以 incoming 的新根/主根/最近 seen 合并 → 原子写回。
 * 只用于磁盘已是 v2 的情况（registry 启动时已 load/migrate）。
 */
export function writeStateV2Merged(stateFile, incoming, { hashFn = undefined } = {}) {
  if (incoming === null || typeof incoming !== 'object' || incoming.version !== STATE_VERSION_V2) return false;
  const loaded = loadStateV2(stateFile, { repair: false, hashFn });
  if (loaded.unsupported === true) return false;
  if (loaded.corrupt === true) return false;
  if (loaded.missing === true) return writeStateV2(stateFile, incoming);
  const disk = loaded.state;
  for (const [rootId, entry] of Object.entries(incoming.roots)) {
    const existing = disk.roots[rootId];
    if (existing === undefined) {
      disk.roots[rootId] = entry;
      continue;
    }
    if (typeof entry.lastSeenAt === 'string' && typeof existing.lastSeenAt === 'string'
      && entry.lastSeenAt > existing.lastSeenAt) {
      existing.lastSeenAt = entry.lastSeenAt;
      existing.project = entry.project;
      existing.name = entry.name;
    }
    if (existing.state !== 'fail-closed' && entry.state === 'fail-closed') {
      existing.state = 'fail-closed';
      existing.failClosedReason = entry.failClosedReason;
    }
  }
  if (disk.primaryRootId === null && typeof incoming.primaryRootId === 'string'
    && disk.roots[incoming.primaryRootId] !== undefined) {
    disk.primaryRootId = incoming.primaryRootId;
    disk.primaryRoot = disk.roots[incoming.primaryRootId].root;
  }
  if (typeof incoming.configRoot === 'string' && incoming.configRoot !== '') disk.configRoot = incoming.configRoot;
  return writeStateV2(stateFile, disk);
}

/**
 * v2 首推独占发布：文件不存在才创建（tmp + link）；已存在则读回既有状态，不覆盖。
 * @returns {{ok:boolean, existed:boolean, state:object|null}}
 */
export function persistPrimaryV2(stateFile, {
  root,
  rootId = undefined,
  profile = null,
  inferredFromCwd = null,
  configRoot = null,
  project = null,
  now = new Date(),
  hashFn = undefined,
} = {}) {
  if (typeof stateFile !== 'string' || stateFile === '') return { ok: false, existed: false, state: null };
  const entry = makeV2Entry({
    root,
    origin: 'inferred',
    inferredFromCwd,
    project,
    hashFn,
    now,
  });
  if (entry === null) return { ok: false, existed: false, state: null };
  if (typeof rootId === 'string' && rootId !== '') entry.rootId = rootId;
  const state = emptyV2State(profile);
  state.roots[entry.rootId] = entry;
  state.primaryRootId = entry.rootId;
  state.primaryRoot = entry.root;
  state.configRoot = typeof configRoot === 'string' && configRoot !== '' ? normalizeRootPath(configRoot) : null;
  const target = path.resolve(stateFile);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    try {
      fs.linkSync(temp, target);
      return { ok: true, existed: false, state };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = loadStateV2(target, { repair: false, hashFn });
        return { ok: true, existed: true, state: existing.state };
      }
      if (fs.existsSync(target)) {
        const existing = loadStateV2(target, { repair: false, hashFn });
        return { ok: true, existed: true, state: existing.state };
      }
      fs.renameSync(temp, target);
      return { ok: true, existed: false, state };
    }
  } catch {
    return { ok: false, existed: false, state: null };
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 共享
// ---------------------------------------------------------------------------

/** 会话 cwd：优先 `session.header.cwd`（宿主真实字段），退回 `session.cwd`；没有返回 ''。 */
export function sessionCwd(session) {
  const header = session?.header;
  if (header !== null && typeof header === 'object' && typeof header.cwd === 'string' && header.cwd.trim() !== '') {
    return header.cwd.trim();
  }
  if (typeof session?.cwd === 'string' && session.cwd.trim() !== '') return session.cwd.trim();
  return '';
}

/** 诊断行（只含字段与路径，不 dump 整个 profileContext）。 */
export function identityDiagnostic(identity) {
  if (identity?.ok !== true) {
    return `persistence-identity: persistence-identity-unavailable reason=${identity?.reason ?? 'unknown'}`;
  }
  return `persistence-identity: source=profileContext name=${identity.name} dir=${identity.dir} ` +
    `home=${identity.home === null ? 'absent' : 'present'} anchor=${identity.anchor} path=${identity.stateFile}`;
}
