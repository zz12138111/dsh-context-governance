/**
 * C11②（实现②·保承诺）：plugin 层的**插件自持久化**。
 *
 * 背景：设置页表单字段 `policy.at` 在宿主 schema 里是 `.volatile()`（只投影、可编辑，但
 * 不保证跨进程持久）。承诺是「plugin 层保存后重启仍有效」，所以插件自己落一份用户级文件：
 *
 *   `~/.dsh/context-governance/plugin-policy.json`
 *   `{ "version": 1, "at": 0.6, "updatedAt": "…", "source": "plugin" }`
 *
 * 约束：
 * - 原子写（tmp + rename）、0600；目录同 A2（`~/.dsh/context-governance/`）；
 * - 损坏 / 未知版本 → 视为「无持久值」并写 `plugin-policy-load-failed`，**不抛错**、不影响启动；
 * - 只存 `compact.at` 一个数值，不含正文、路径、凭据；
 * - 读取按 `mtimeMs:size` 缓存，文件被外部改/删后下一次读即生效（不缓存旧值）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_POLICY_FILENAME = 'plugin-policy.json';
export const PLUGIN_POLICY_VERSION = 1;
export const PLUGIN_POLICY_SOURCE = 'plugin';

/** `<DSH home>/context-governance/plugin-policy.json`（home 为空 → null，调用方按不可用处理）。 */
export function pluginPolicyFile(home = '') {
  if (typeof home !== 'string' || home.trim() === '') return null;
  return path.join(home.trim(), 'context-governance', PLUGIN_POLICY_FILENAME);
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * @param {{file: string|null, now?: () => Date, audit?: (event: string, details: object) => void,
 *   logger?: { warn?: (line: string) => void }}} options
 */
export function createPluginPolicyStore({ file, now = () => new Date(), audit = null, logger = null } = {}) {
  const emit = (event, details) => {
    try {
      audit?.(event, details);
    } catch {
      /* 审计失败不影响策略读写 */
    }
  };
  let cache = { signature: null, value: null };

  const signatureOf = () => {
    if (typeof file !== 'string' || file === '') return 'unavailable';
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  };

  const load = () => {
    const signature = signatureOf();
    if (signature === cache.signature) return cache.value;
    let value = null;
    try {
      if (signature !== 'missing' && signature !== 'unavailable') {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw?.version !== PLUGIN_POLICY_VERSION || !Number.isFinite(raw?.at)) {
          emit('plugin-policy-load-failed', { reason: 'unknown-version-or-value', path: file });
        } else {
          value = {
            at: Number(raw.at),
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
            source: PLUGIN_POLICY_SOURCE,
          };
        }
      }
    } catch (error) {
      emit('plugin-policy-load-failed', { reason: String(error?.message ?? error).slice(0, 200), path: file });
      logger?.warn?.(`[context-governance] plugin-policy unreadable (${String(error?.message ?? error)}); treating as absent`);
    }
    cache = { signature, value };
    return value;
  };

  return {
    file,
    /** 持久值（无/损坏/越界 → null；不抛错）。 */
    read() {
      return load();
    },
    /** 写持久值；值不合法 → false 且不落盘。 */
    writeAt(at) {
      if (typeof file !== 'string' || file === '') return false;
      if (!Number.isFinite(at) || at < 0 || at > 1) return false;
      const payload = {
        version: PLUGIN_POLICY_VERSION,
        at: Number(at),
        updatedAt: now().toISOString(),
        source: PLUGIN_POLICY_SOURCE,
      };
      try {
        atomicWriteJson(file, payload);
        emit('plugin-policy-persisted', { at: payload.at });
        // 落盘后立刻失效缓存，下一次 read 必然读到新值（即使 mtime 粒度相同）。
        cache = { signature: null, value: null };
        return true;
      } catch (error) {
        logger?.warn?.(`[context-governance] plugin-policy write failed: ${String(error?.message ?? error)}`);
        return false;
      }
    },
    /** 仅当与持久值不同才写（避免每次读都刷盘/刷审计）。 */
    writeAtIfChanged(at) {
      if (!Number.isFinite(at)) return false;
      const current = load();
      if (current !== null && current.at === Number(at)) return false;
      return this.writeAt(at);
    },
    clear() {
      if (typeof file !== 'string' || file === '') return false;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        return false;
      }
      cache = { signature: null, value: null };
      return true;
    },
  };
}
