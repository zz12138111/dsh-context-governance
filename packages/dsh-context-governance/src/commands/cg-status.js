/**
 * `/cg status`（T5）。
 *
 * 只读展示：后端/能力、治理模式与降级项、记忆计数、上次压缩/回注、写盘 p50/p95、审计文件。
 * 命令注册与输出都走宿主公开接口；本文件不 import 任何 `@deepseek-ai/*` 包，便于单测。
 */

import { resolveBackendFields } from '../compress/adapters.js';
import {
  CONFIG_ONLY_KEYS,
  SESSION_KEYS,
  collectInvalid,
  computePressure,
  formatInvalid,
  layerChain,
  policyTable,
  summarizePolicy,
  summarizePressure,
  summarizeWindow,
  validateLayer,
} from '../policy.js';

export const CG_COMMAND_NAME = 'cg';
export const CG_COMMAND_DEFINITION_ID = 'dsh-context-governance/cg';

function costLine(status) {
  const cost = status?.lastCost ?? null;
  if (cost === null) return 'last-cost: none';
  const pruned = cost.tokensPruned === null || cost.tokensPruned === undefined
    ? (cost.pruneCount > 0 ? 'unknown' : '0')
    : cost.tokensPruned;
  const tools = Array.isArray(cost.pruneTools) && cost.pruneTools.length > 0
    ? cost.pruneTools.join(',')
    : '-';
  return `last-cost: before=${cost.tokensBefore ?? '-'}(${cost.tokensBeforeSource ?? 'none'}) ` +
    `after=${cost.tokensAfter ?? '-'}(${cost.tokensAfterSource ?? 'none'}) ` +
    `trigger=${cost.trigger ?? '-'} pruned=${pruned} tools=${tools}`;
}

function formatSession(overrides, rejectedKeys = null) {
  const keys = Object.keys(overrides ?? {});
  if (keys.length === 0) return 'none';
  const render = (value) => (value === null ? 'null' : value === true ? 'on' : value === false ? 'off' : value);
  return keys.map((key) => {
    const label = `${key}=${render(overrides[key])}`;
    return rejectedKeys !== null && rejectedKeys.has(key) ? `${label}(rejected)` : label;
  }).join(', ');
}

/** 会话层里被运行时拒绝的键（P3-2：display 要标 rejected，恢复后自然消失）。 */
function rejectedSessionKeys(resolved) {
  const keys = new Set();
  for (const item of resolved?.invalid ?? []) {
    if (item?.source !== 'session' || item?.key !== 'compact.at') continue;
    if (item.reason === 'over-native-runtime' || item.reason === 'native-uncomputable') keys.add('compact.at');
  }
  return keys;
}

function formatEarlyStatus(earlyStatus) {
  if (earlyStatus === null || earlyStatus === undefined) return 'last-early: none';
  const event = String(earlyStatus.event ?? '').replace(/^early-/, '');
  const reason = typeof earlyStatus.reason === 'string' && earlyStatus.reason !== '' ? ` (${earlyStatus.reason})` : '';
  const effective = Number.isFinite(earlyStatus.effective) ? ` effective=${Number(earlyStatus.effective).toFixed(3)}` : '';
  const at = typeof earlyStatus.time === 'string' ? ` at=${earlyStatus.time}` : '';
  return `last-early: ${event}${reason}${effective}${at}`;
}

function statusText({ store, guard, audit, now, policy = null, earlyStatus = null }) {
  const lines = [];
  const status = guard?.status ?? null;
  lines.push('context-governance status');
  lines.push(`time: ${now().toISOString()}`);
  // 策略链与观察器无关：观察器没挂时也要能看到生效阈值与被拒的层。
  let resolvedPolicy = null;
  if (policy !== null && typeof policy.resolve === 'function') {
    resolvedPolicy = policy.resolve();
    lines.push(`policy: ${summarizePolicy(resolvedPolicy)}`);
    // 0.2.1（DEC-20261025-66）：current / conservative / 来源 / 时间；不一致时明示校验口径。
    if (resolvedPolicy.window !== undefined) lines.push(summarizeWindow(resolvedPolicy.window));
    const rejected = collectInvalid(policy, resolvedPolicy);
    if (rejected.length > 0) lines.push(`policy-invalid: ${rejected.length} (${formatInvalid(rejected)})`);
    const overrides = formatSession(policy.sessionLayer?.values, rejectedSessionKeys(resolvedPolicy));
    if (overrides !== 'none') lines.push(`policy-session: ${overrides}`);
  }
  lines.push(formatEarlyStatus(earlyStatus));
  if (status === null) {
    lines.push('compression: disabled (observer not mounted)');
  } else {
    const adapter = status.adapter;
    const backendFields = resolveBackendFields(adapter);
    const backendSuffix = backendFields.backendLabel === backendFields.backendKind
      ? ''
      : ` backend-label=${backendFields.backendLabel}`;
    lines.push(
      `compression: mode=${status.mode} adapter=${adapter.kind} backend-kind=${backendFields.backendKind}${backendSuffix} ` +
      `perception=${status.perception} event-api=${status.eventApi ? 'on' : 'off'} ` +
      `events=${status.stats.events}${status.stats.events === 0 ? '(no session/event observed yet)' : ''} ` +
      `summary=${adapter.summary.readability}/${adapter.summary.style} ` +
      `host=${adapter.versions.host} backend=${adapter.versions.backend}`,
    );
    lines.push(
      `capabilities: control=${adapter.control} hooks=${adapter.hooks.before}/${adapter.hooks.after} ` +
      `protectionRole=${adapter.protectionRole ?? 'validator'}`,
    );
    // 0.2.0 压力四段：只展示（不据此压缩）；safety 系数只从配置文件读。
    lines.push(summarizePressure(
      computePressure({
        measuredTokens: status.pressure?.measuredTokens ?? null,
        estimatedTokens: status.pressure?.estimatedTokens ?? null,
        windowTokens: resolvedPolicy?.window?.currentTokens ?? policy?.windowTokens,
        estimateSafety: resolvedPolicy?.values?.['compact.estimateSafety'],
      }),
      {
        at: resolvedPolicy?.values?.['compact.at'] ?? null,
        sessionId: resolvedPolicy?.window?.currentSessionId ?? null,
        windowSource: resolvedPolicy?.window?.currentSource ?? null,
      },
    ));
    if (status.degradedReasons.length > 0) lines.push(`degraded: ${status.degradedReasons.join(', ')}`);
    else lines.push('degraded: none');
    if (status.conflicts.length > 0) {
      lines.push(`conflicts: ${status.conflicts.map((conflict) => `${conflict.code}(${conflict.severity})`).join(', ')}`);
    } else lines.push('conflicts: none');
    const latency = status.writeLatency ?? { count: 0, p50Ms: null, p95Ms: null, maxMs: null, minMs: null };
    lines.push(
      `write-latency: n=${latency.count} p50=${latency.p50Ms === null ? '-' : `${latency.p50Ms}ms`} ` +
      `p95=${latency.p95Ms === null ? '-' : `${latency.p95Ms}ms`} max=${latency.maxMs === null ? '-' : `${latency.maxMs}ms`}`,
    );
    const last = status.lastReport;
    if (last === null) lines.push('last-compaction: none');
    else {
      lines.push(
        `last-compaction: id=${String(last.compactionId ?? '?').slice(0, 8)} manual=${last.manual === true} ` +
        `compaction=${last.compaction ?? (last.skipped === true ? 'skipped' : 'committed')} ` +
        `protection=${last.protection ?? (last.ok === false ? 'failed' : 'ok')} ` +
        `shadowed=${last.shadowedSeqs?.length ?? 0} ` +
        `checkpoint=${last.checkpointSeq ?? '-'} failures=${last.failures?.map((failure) => failure.name).join(',') || 'none'}`,
      );
      const reinjection = last.reinjection;
      if (reinjection === undefined) lines.push('last-reinjection: not-recorded');
      else {
        lines.push(
          `last-reinjection: status=${reinjection.status} seq=${reinjection.seq ?? '-'} ` +
          `lines=${reinjection.lines ?? '-'}`,
        );
      }
    }
    const reinjectionState = status.protection.reinjectionSuspended
      ? `suspended(${status.protection.reinjectionFailureStreak ?? 0}/${status.protection.maxReinjectionFailures ?? '-'})`
      : `enabled(streak=${status.protection.reinjectionFailureStreak ?? 0},maxFailures=${status.protection.maxReinjectionFailures ?? '-'})`;
    const cost = status.lastCost ?? null;
    lines.push(cost === null ? 'last-cost: none' : costLine(status));
    lines.push(
      `protection: writes=${status.stats.protectionWrites} writeFailures=${status.stats.protectionWriteFailures} ` +
      `reinjections=${status.stats.reinjections} injectionFailures=${status.stats.reinjectionFailures} ` +
      `pendingJournals=${status.protection.pendingJournals} reinjection=${reinjectionState}` +
      `${status.protection.readOnly ? ` read-only=${status.protection.readOnlyReason ?? 'unknown'}` : ''}`,
    );
    if (status.stats.auditWriteFailures > 0 || status.stats.auditSkippedReadOnly > 0) {
      lines.push(
        `audit-health: writeFailures=${status.stats.auditWriteFailures} ` +
        `skippedReadOnly=${status.stats.auditSkippedReadOnly}`,
      );
    }
    if (status.scope !== undefined) {
      lines.push(
        `scope: project=${status.scope.projectRoot || '-'} only-project=${status.scope.onlyProject ? 'on' : 'off'} ` +
        `capture-title=${status.scope.captureTitle === false ? 'off' : 'on'} ` +
        `ignored-foreign=${status.scope.ignoredForeignEvents}/${status.scope.ignoredForeignSessions} ` +
        `unattributed=${status.scope.unattributedEvents}`,
      );
    }
  }
  if (store !== null) {
    const counts = store.status.counts;
    lines.push(
      `memory: project=${store.status.project} root=${store.status.rootDir} ` +
      `active=${counts.active} proposed=${counts.proposed} total=${store.allEntries().length} ` +
      `pendingJournals=${store.protectionPending}`,
    );
    if (store.status.readOnlyReason !== null) lines.push(`memory-readonly: ${store.status.readOnlyReason}`);
    if (store.status.warnings.length > 0) lines.push(`memory-warnings: ${store.status.warnings.length}`);
  } else {
    lines.push('memory: unavailable');
  }
  if (audit !== null) {
    const failures = audit.entries()
      .filter((entry) => /failed|loss|drift|interrupted|abandoned/.test(entry.event))
      .slice(-5)
      .map((entry) => entry.event);
    lines.push(
      `audit: file=${audit.file ?? '-'} max=${audit.maxBytes ?? '-'} size=${audit.sizeBytes ?? '-'} ` +
      `rotations=${audit.rotations ?? 0} recentFailures=${failures.join(',') || 'none'} (this-process)`,
    );
  } else {
    lines.push('audit: unavailable');
  }
  return lines.join('\n');
}

/**
 * 构造命令定义（宿主 `ctx.commands.register` 形状）。
 *
 * @param {{store?:object|null, guard?:object|null, getGuard?:() => object|null, audit?:object|null, now?:() => Date}} options
 */
export function createStatusCommand({ store = null, guard = null, getGuard = null, audit = null, policy = null, now = () => new Date(), logger = null, getEarlyStatus = null } = {}) {
  const currentGuard = () => (typeof getGuard === 'function' ? getGuard() : guard);

  const parseBoolean = (text) => {
    const lowered = String(text).trim().toLowerCase();
    if (['on', 'true', '1', 'yes'].includes(lowered)) return { value: true };
    if (['off', 'false', '0', 'no'].includes(lowered)) return { value: false };
    return { error: `需要 on/off（收到 ${text}）` };
  };
  const parseValue = (key, text) => {
    if (key === 'compact.early') return parseBoolean(text);
    if (key === 'cost.remainingTurns') {
      if (String(text).trim().toLowerCase() === 'null') return { value: null };
      const number = Number(text);
      if (!Number.isInteger(number) || number < 0) return { error: `需要 ≥0 整数或 null（收到 ${text}）` };
      return { value: number };
    }
    if (String(text).trim() === '') return { error: '缺少值' };
    const number = Number(text);
    if (!Number.isFinite(number)) return { error: `需要数字（收到 ${text}）` };
    return { value: number };
  };
  const sessionText = (sessionValues) => formatSession(sessionValues);
  /** `/cg set key=value [key=value…] | /cg set reset`：会话层覆盖（最高优先级）。 */
  const handleSet = (argText) => {
    if (policy === null || typeof policy.resolve !== 'function' || policy.sessionLayer === undefined) {
      return { kind: 'error', text: '[context-governance] session layer is unavailable (policy not wired)' };
    }
    const sessionValues = policy.sessionLayer.values;
    if (argText === '' || argText === 'show' || argText === 'list') {
      return {
        kind: 'success',
        text: [
          'context-governance set',
          `session: ${sessionText(sessionValues)}`,
          'usage: /cg set compact.at=0.55 | /cg set compact.early=off | /cg set reset',
          '（estimateSafety / lowThresholdAck 只能改配置文件；会话覆盖在重启后失效）',
        ].join('\n'),
      };
    }
    if (argText === 'reset' || argText === 'clear') {
      const count = Object.keys(sessionValues).length;
      for (const key of Object.keys(sessionValues)) delete sessionValues[key];
      audit?.append?.('policy-set', { source: 'session', key: '*', value: 'reset' });
      return { kind: 'success', text: `context-governance set\ncleared: ${count} session override(s)` };
    }
    // 解析 `key=value` 或 `key value` 两种写法。
    const tokens = argText.split(/\s+/).filter((token) => token !== '');
    const pairs = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.includes('=')) {
        const at = token.indexOf('=');
        pairs.push([token.slice(0, at), token.slice(at + 1)]);
      } else {
        const next = tokens[index + 1];
        if (next === undefined || next.includes('=')) return { kind: 'error', text: `context-governance set: ${token} 缺少值` };
        pairs.push([token, next]);
        index += 1;
      }
    }
    if (pairs.length === 0) {
      return { kind: 'error', text: 'context-governance set: 缺少参数（示例 /cg set compact.at=0.55）' };
    }
    // P3-6：一条命令里同一键出现两次时后写会静默胜出，直接拒绝，避免“报两条、实际一条”。
    const duplicated = pairs.map(([key]) => key).find((key, index, keys) => keys.indexOf(key) !== index);
    if (duplicated !== undefined) {
      return { kind: 'error', text: `context-governance set: 重复键 ${duplicated}（一条命令里每个键只能设一次）` };
    }
    const next = { ...sessionValues };
    for (const [key, rawValue] of pairs) {
      if (key === 'compact.early.armed') {
        return {
          kind: 'error',
          text: 'context-governance set: armed 不能经 /cg set 修改；会话内用 /cg compact arm|disarm，全局用配置 compact.early.armed',
        };
      }
      if (CONFIG_ONLY_KEYS.includes(key)) {
        return {
          kind: 'error',
          text: `context-governance set: ${key} 只能在配置文件改（安全参数不随会话覆盖；改完需重启）`,
        };
      }
      if (!SESSION_KEYS.includes(key)) {
        return { kind: 'error', text: `context-governance set: 未知键 ${key}（可设：${SESSION_KEYS.join(', ')}）` };
      }
      const parsed = parseValue(key, rawValue);
      if (parsed.error !== undefined) return { kind: 'error', text: `context-governance set: ${key} ${parsed.error}` };
      // 0.2.1（DEC-66 ③ / DEC-68 A）：校验用保守窗口算出的 native；退化/不可计算 → 拒绝设置。
      const validationNative = typeof policy.validationNative === 'function' ? policy.validationNative() : policy.native;
      if (key === 'compact.at' && validationNative === null) {
        // P3-11（口径 A）：设置被拒也是“配置被拒”事件——审计 + warn + 状态可见三处一致。
        // P2-3：只记 transient（每 episode 去重；窗口恢复时由 policy.resolve 清空），不写进 policyState.invalid。
        const entry = {
          source: 'session',
          key: 'compact.at',
          reason: 'native-uncomputable',
          detail: '退化窗口下拒绝 /cg set compact.at',
        };
        const added = typeof policy.rejectSessionSet === 'function'
          ? policy.rejectSessionSet(entry)
          : !(policy.sessionRejections?.() ?? []).some((item) =>
            item.source === 'session' && item.key === 'compact.at' && item.reason === 'native-uncomputable');
        if (added === true) {
          audit?.append?.('policy-invalid', { source: 'session', reason: 'native-uncomputable', code: 'compact.at' });
          logger?.warn?.(
            '[context-governance] rejected /cg set compact.at: native-uncomputable（窗口退化，native 不可计算）',
          );
        }
        return {
          kind: 'error',
          text: 'context-governance set: compact.at 无法校验：窗口退化（native 不可计算，reason=native-uncomputable）；' +
            '等窗口恢复正常后再设',
        };
      }
      const checked = validateLayer({ [key]: parsed.value }, { source: 'session', native: validationNative, sessionLayer: true });
      if (checked.invalid.length > 0) {
        const item = checked.invalid[0];
        const detail = item.detail === undefined ? '' : `（${item.detail}）`;
        return { kind: 'error', text: `context-governance set: ${key}=${rawValue} 被拒绝: ${item.reason}${detail}` };
      }
      next[key] = parsed.value;
    }
    // 先写会话层再整体求解：<0.30 未确认会被 resolve 回退，此时撤销并明确报错。
    const previous = { ...sessionValues };
    for (const key of Object.keys(sessionValues)) delete sessionValues[key];
    Object.assign(sessionValues, next);
    const resolved = policy.resolve();
    // P3-2：只判本次会话层引入的未确认（配置层本来就 0.25 时，不该连 /cg set compact.early 都挡住）。
    const blocking = resolved.invalid.find(
      (item) => item.reason === 'low-threshold-unacked' && item.source === 'session',
    );
    if (blocking !== undefined) {
      for (const key of Object.keys(sessionValues)) delete sessionValues[key];
      Object.assign(sessionValues, previous);
      const atValue = next['compact.at'] ?? previous['compact.at'];
      return {
        kind: 'error',
        text: `context-governance set: compact.at=${atValue} 低于 0.30，` +
          '需在配置文件设 compact.lowThresholdAck=true 后重启（该确认不随会话覆盖）',
      };
    }
    for (const [key, rawValue] of pairs) {
      audit?.append?.('policy-set', { source: 'session', key, value: String(rawValue) });
    }
    return {
      kind: 'success',
      text: [
        'context-governance set',
        `applied: ${pairs.map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `session: ${sessionText(sessionValues)}`,
        `policy: ${summarizePolicy(resolved)}`,
      ].join('\n'),
    };
  };

  return {
    definitionId: CG_COMMAND_DEFINITION_ID,
    name: CG_COMMAND_NAME,
    description: '上下文治理状态：后端/能力、策略链、记忆、上次压缩与回注、prune 成本、写盘 p50/p95、审计',
    input: { hint: 'status | status last-cost | policy show | set <key>=<value> | set reset | header on|off' },
    handler: async (invocation = {}) => {
      const raw = String(invocation.rawInput ?? '').trim();
      if (raw === 'header' || raw.startsWith('header ')) {
        if (policy === null || policy.sessionLayer === undefined) {
          return { kind: 'error', text: '[context-governance] session layer is unavailable (policy not wired)' };
        }
        const sessionValues = policy.sessionLayer.values;
        const arg = raw.slice('header'.length).trim();
        if (arg === '' || arg === 'status') {
          const enabled = sessionValues['header.enabled'] !== false;
          return {
            kind: 'success',
            text: `context-governance header\nheader: ${enabled ? 'on' : 'off'} (source=${sessionValues['header.enabled'] === undefined ? 'config' : 'session'})`,
          };
        }
        if (arg === 'on' || arg === 'off') {
          sessionValues['header.enabled'] = arg === 'on';
          audit?.append?.('policy-set', { source: 'session', key: 'header.enabled', value: arg });
          return { kind: 'success', text: `context-governance header\nheader: ${arg} (source=session)` };
        }
        return { kind: 'error', text: 'Usage: /cg header [status|on|off]' };
      }
      if (raw === 'compact' || raw.startsWith('compact ')) {
        if (policy === null || policy.sessionLayer === undefined) {
          return { kind: 'error', text: '[context-governance] session layer is unavailable (policy not wired)' };
        }
        const sessionValues = policy.sessionLayer.values;
        const arg = raw.slice('compact'.length).trim();
        if (arg === '' || arg === 'status') {
          const resolved = typeof policy.resolve === 'function' ? policy.resolve() : null;
          const on = sessionValues['compact.early.armed'] ?? (resolved?.values?.['compact.early.armed'] === true);
          const source = sessionValues['compact.early.armed'] === undefined ? 'config/default' : 'session';
          return { kind: 'success', text: `context-governance compact\narmed: ${on ? 'on' : 'off'} (source=${source})` };
        }
        if (arg === 'arm' || arg === 'disarm') {
          sessionValues['compact.early.armed'] = arg === 'arm';
          const sessionId = invocation.sessionId ?? invocation.session?.id ?? null;
          audit?.append?.(arg === 'arm' ? 'early-armed' : 'early-disarmed', {
            source: 'session',
            sessionId,
          });
          return { kind: 'success', text: `context-governance compact\narmed: ${arg === 'arm' ? 'on' : 'off'} (source=session)` };
        }
        return { kind: 'error', text: 'Usage: /cg compact [status|arm|disarm]' };
      }
      if (raw === 'set' || raw.startsWith('set ') || raw === 'reset') {
        try {
          return handleSet(raw === 'reset' ? 'reset' : raw.slice(3).trim());
        } catch (error) {
          return {
            kind: 'error',
            text: `[context-governance] set failed: ${String(error?.message ?? error).slice(0, 300)}`,
          };
        }
      }
      if (raw === 'policy show' || raw === 'policy') {
        if (policy === null || typeof policy.resolve !== 'function') {
          return { kind: 'error', text: '[context-governance] policy is unavailable' };
        }
        const resolved = policy.resolve();
        const rejected = collectInvalid(policy, resolved);
        const lines = [
          'context-governance policy',
          summarizePolicy(resolved),
          `layers: ${layerChain(policy)}`,
          `session: ${formatSession(policy.sessionLayer?.values, rejectedSessionKeys(resolved))}`,
          ...policyTable(resolved),
          ...(rejected.length > 0
            ? ['invalid:', ...rejected.map((item) =>
              `${item.key} (source=${item.source}): ${item.reason}${item.detail === undefined ? '' : ` — ${item.detail}`}`)]
            : ['invalid: none']),
        ];
        return { kind: 'success', text: lines.join('\n') };
      }
      if (raw === 'last-cost') {
        try {
          return {
            kind: 'success',
            text: ['context-governance last-cost', costLine(currentGuard()?.status ?? null)].join('\n'),
          };
        } catch (error) {
          return {
            kind: 'error',
            text: `[context-governance] status failed: ${String(error?.message ?? error).slice(0, 300)}`,
          };
        }
      }
      if (raw !== '' && raw !== 'status') {
        return {
          kind: 'error',
          text: 'Usage: /cg status [last-cost] | /cg policy show | /cg set <key>=<value> | /cg set reset' +
            '   (未指定参数时等价于 /cg status)',
        };
      }
      try {
        return {
          kind: 'success',
          text: statusText({
            store,
            guard: currentGuard(),
            audit,
            now,
            policy,
            earlyStatus: typeof getEarlyStatus === 'function' ? getEarlyStatus() : null,
          }),
        };
      } catch (error) {
        return {
          kind: 'error',
          text: `[context-governance] status failed: ${String(error?.message ?? error).slice(0, 300)}`,
        };
      }
    },
  };
}

/**
 * 注册到宿主命令面；失败只返回结果，不抛错。
 * @param {object} ctx
 * @param {object} options
 */
export function registerStatusCommand(ctx, options = {}) {
  const definition = createStatusCommand(options);
  try {
    const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : ctx?.commands;
    if (typeof commands?.register !== 'function') {
      return { registered: false, reason: 'ctx.commands.register is unavailable' };
    }
    const dispose = commands.register(definition);
    return { registered: true, definition, dispose: typeof dispose === 'function' ? dispose : null };
  } catch (error) {
    return {
      registered: false,
      reason: String(error?.message ?? error).slice(0, 300),
      definition,
    };
  }
}
