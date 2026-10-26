/**
 * 2a 单根模型：持久化身份、状态文件读写（含并发独占）、首次推断。
 *
 * 身份来源唯一 = `ctx.get('profileContext')`（宿主启动数据）。
 * 不读 DSH_HOME/DSH_PROFILE（已实证宿主 PEB 无这些变量）。
 *
 * 状态文件字段（需求 §11.1）：{version, root, source:'inferred', inferredAt,
 * inferredFromCwd, instance:{profile}}；`configRoot` 是本实现为“配置移除后回落”
 * 审计额外记录的镜像字段，**不参与根选择**（根仍按 配置 > 持久化 > 推断）。
 */
import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = 'context-governance';
const STATE_VERSION = 1;

/** profile 名安全化：只留字母数字 . _ -，避免路径分隔符与保留字符。 */
export function safeProfileName(name) {
  const cleaned = String(name ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned === '' ? 'profile' : cleaned.slice(0, 80);
}

/**
 * 解析持久化身份（只读，不写盘）。
 * @param {object} ctx 插件 ctx
 * @returns {{ok:boolean, reason?:string, name?:string, dir?:string, home?:string|null,
 *   anchor?:'home'|'dir', stateFile?:string}}
 */
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

/** 绝对路径归一：realpath（存在时）+ Windows 盘符大写；非法返回 null。 */
export function normalizeRootPath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  let resolved;
  try {
    resolved = path.resolve(candidate.trim());
    if (fs.existsSync(resolved)) resolved = fs.realpathSync.native(resolved);
  } catch {
    return null;
  }
  if (!path.isAbsolute(resolved)) return null;
  if (process.platform === 'win32' && /^[a-z]:/.test(resolved)) {
    resolved = `${resolved[0].toUpperCase()}${resolved.slice(1)}`;
  }
  return resolved;
}

/** 路径相等（Windows 大小写不敏感）。 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** child 是否等于 parent 或位于 parent 之下（大小写按平台归一）。 */
function isWithin(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  const a = path.resolve(parent).toLowerCase();
  const b = path.resolve(child).toLowerCase();
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
}

function stateDocument({ root, inferredAt, inferredFromCwd, profile, configRoot } = {}) {
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

/**
 * 读取持久化根；文件缺失/损坏/版本不符/字段非法返回 null（不抛错）。
 * 未知字段容忍；坏值（类型错）按损坏处理。
 */
export function readRootState(stateFile) {
  if (typeof stateFile !== 'string' || stateFile === '') return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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
  } catch {
    return null;
  }
}

/** 原子写根状态（tmp + rename）；失败返回 false，不抛错。会覆盖已有文件。 */
export function writeRootState(stateFile, options = {}) {
  const { root, inferredAt, inferredFromCwd, profile, configRoot } = options ?? {};
  if (typeof stateFile !== 'string' || stateFile === '') return false;
  if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) return false;
  const target = path.resolve(stateFile);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(stateDocument({ root, inferredAt, inferredFromCwd, profile, configRoot }), null, 2), 'utf8');
    fs.renameSync(temp, target);
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

/**
 * 首次推断落盘：独占发布（tmp + link），已存在则不覆盖并读回既有根。
 * 需求 §11.1-8：两会话/两进程同时首次推断，只允许一个写成功，另一个读回同一根。
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
    const document = stateDocument({ root, inferredFromCwd, profile });
    fs.writeFileSync(temp, JSON.stringify(document, null, 2), 'utf8');
    try {
      // link 是原子“仅当不存在时创建”：跨进程只有一方成功。
      fs.linkSync(temp, target);
      return { ok: true, existed: false, root: document.root };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = readRootState(target);
        return { ok: true, existed: true, root: existing === null ? null : existing.root };
      }
      // 不支持硬链接的文件系统（部分网络盘/FAT）：退化为 tmp+rename 原子发布。
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

/** 会话 cwd：优先 `session.header.cwd`（宿主真实字段），退回 `session.cwd`；没有返回 ''。 */
export function sessionCwd(session) {
  const header = session?.header;
  if (header !== null && typeof header === 'object' && typeof header.cwd === 'string' && header.cwd.trim() !== '') {
    return header.cwd.trim();
  }
  if (typeof session?.cwd === 'string' && session.cwd.trim() !== '') return session.cwd.trim();
  return '';
}

/**
 * 按会话 cwd 上溯最近的含 `.git` 祖先；找不到/结果落在 DSH home 内返回 null。
 * 结果经 realpath + 盘符归一，保证跨会话/跨启动同一根字符串一致。
 * @param {string} cwd
 * @param {{exclude?: string|null}} [options] exclude=DSH home（不允许把 DSH 自己的目录当项目根）
 */
export function inferRootFromCwd(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const exclude = typeof options?.exclude === 'string' && options.exclude.trim() !== ''
    ? options.exclude.trim()
    : null;
  let current;
  try {
    current = path.resolve(cwd.trim());
  } catch {
    return null;
  }
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      // worktree / submodule 的 `.git` 是文件；按“存在”判定，不要求目录。
      if (fs.existsSync(path.join(current, '.git'))) {
        const root = normalizeRootPath(current);
        if (root === null) return null;
        if (exclude !== null && isWithin(exclude, root)) return null;
        return root;
      }
    } catch {
      /* 不是 git 根，继续上溯 */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** 诊断行（只含字段与路径，不 dump 整个 profileContext）。 */
export function identityDiagnostic(identity) {
  if (identity?.ok !== true) {
    return `persistence-identity: persistence-identity-unavailable reason=${identity?.reason ?? 'unknown'}`;
  }
  return `persistence-identity: source=profileContext name=${identity.name} dir=${identity.dir} ` +
    `home=${identity.home === null ? 'absent' : 'present'} anchor=${identity.anchor} path=${identity.stateFile}`;
}
