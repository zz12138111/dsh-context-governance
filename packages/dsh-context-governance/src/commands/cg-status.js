/**
 * `/cg status`（T5）。
 *
 * 只读展示：后端/能力、治理模式与降级项、记忆计数、上次压缩/回注、写盘 p50/p95、审计文件。
 * 命令注册与输出都走宿主公开接口；本文件不 import 任何 `@deepseek-ai/*` 包，便于单测。
 */

export const CG_COMMAND_NAME = 'cg';
export const CG_COMMAND_DEFINITION_ID = 'dsh-context-governance/cg';

function statusText({ store, guard, audit, now }) {
  const lines = [];
  const status = guard?.status ?? null;
  lines.push('context-governance status');
  lines.push(`time: ${now().toISOString()}`);
  if (status === null) {
    lines.push('compression: disabled (observer not mounted)');
  } else {
    const adapter = status.adapter;
    lines.push(
      `compression: mode=${status.mode} adapter=${adapter.kind} ` +
      `perception=${status.perception} event-api=${status.eventApi ? 'on' : 'off'} ` +
      `events=${status.stats.events}${status.stats.events === 0 ? '(no session/event observed yet)' : ''} ` +
      `summary=${adapter.summary.readability}/${adapter.summary.style} ` +
      `host=${adapter.versions.host} backend=${adapter.versions.backend}`,
    );
    lines.push(
      `capabilities: control=${adapter.control} hooks=${adapter.hooks.before}/${adapter.hooks.after} ` +
      `protectionRole=${adapter.protectionRole ?? 'validator'}`,
    );
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
        `ok=${last.ok === true} shadowed=${last.shadowedSeqs?.length ?? 0} ` +
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
export function createStatusCommand({ store = null, guard = null, getGuard = null, audit = null, now = () => new Date() } = {}) {
  const currentGuard = () => (typeof getGuard === 'function' ? getGuard() : guard);
  return {
    definitionId: CG_COMMAND_DEFINITION_ID,
    name: CG_COMMAND_NAME,
    description: '上下文治理状态：后端/能力、记忆、上次压缩与回注、写盘 p50/p95、审计',
    input: { hint: 'status' },
    handler: async (invocation = {}) => {
      const raw = String(invocation.rawInput ?? '').trim();
      if (raw !== '' && raw !== 'status') {
        return {
          kind: 'error',
          text: 'Usage: /cg status   (未指定参数时等价于 /cg status)',
        };
      }
      try {
        return {
          kind: 'success',
          text: statusText({ store, guard: currentGuard(), audit, now }),
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
