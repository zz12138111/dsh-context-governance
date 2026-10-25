/**
 * T0 gate probe (REQ-20261025-09) — read-only, isolated profile only.
 * 延迟到服务就绪后再探测；只记类型/可用性，不记录内容，不改变产品行为。
 */
import fs from 'node:fs';

const LOG = 'D:/DS-PROJECT/DSH插件开发/.tmp/gate-probe.log';

function line(text) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`); } catch { /* ignore */ }
}

function describe(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return typeof value;
}

function safe(get, name) {
  try {
    return describe(get(name));
  } catch {
    return 'throws';
  }
}

function probeAll(ctx, label) {
  line(`${label} pid=${process.pid}`);
  for (const service of ['agentPresets', 'agents', 'llm', 'tokenMeter', 'compaction', 'sessions', 'session']) {
    line(`get.${service}=${safe((n) => ctx.get(n), service)}`);
  }
  for (const [name, probe] of [
    ['agentPresets', (value) => value && `serviceFor=${describe(value.serviceFor)} keys=${Object.keys(value).slice(0, 12).join(',')}`],
    ['agents', (value) => value && `list=${describe(value.list)} get=${describe(value.get)} keys=${Object.keys(value).slice(0, 12).join(',')}`],
    ['llm', (value) => value && `resolveModelInfo=${describe(value.resolveModelInfo)} keys=${Object.keys(value).slice(0, 12).join(',')}`],
  ]) {
    try {
      const value = ctx.get(name);
      if (value !== undefined && value !== null) line(`${name}: ${probe(value)}`);
    } catch { /* ignore */ }
  }
}

export const name = 'gate-probe';

export function apply(ctx) {
  line(`apply pid=${process.pid}`);
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessions'], () => {
      probeAll(ctx, 'after-inject:sessions');
      if (typeof ctx.on === 'function') {
        ctx.on('session/event', (session, event) => {
          if (event?.type === 'turn/end') probeAll(ctx, `at-turn-end session=${session?.id}`);
        });
      }
    });
  }
  setTimeout(() => probeAll(ctx, 'after-2s'), 2000);
}
