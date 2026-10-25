/**
 * G4 probe (REQ-20261025-09) — read-only, isolated profile only.
 * 只记可用性/类型与 projection 状态（数值字段），不记录消息内容，不改变产品行为。
 */
import fs from 'node:fs';

const LOG = 'D:/DS-PROJECT/DSH插件开发/.tmp/g4-probe.log';

function line(text) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`); } catch { /* ignore */ }
}

function describe(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return typeof value;
}

function safeGet(ctx, name) {
  try {
    return ctx.get(name);
  } catch (error) {
    return `throws:${String(error?.message ?? error).slice(0, 80)}`;
  }
}

function summarizeState(state) {
  if (state === undefined) return 'undefined';
  if (state === null) return 'null';
  if (typeof state !== 'object') return String(state).slice(0, 80);
  const picked = {};
  for (const key of ['pressureTokens', 'projectedTokens', 'contextWindow', 'surfaceTokens', 'sampledSurfaceTokens']) {
    if (state[key] !== undefined) picked[key] = state[key];
  }
  return JSON.stringify(picked);
}

let loggedApply = false;
function probeAll(ctx, label) {
  line(`${label} pid=${process.pid}`);
  for (const service of ['sessionProjections', 'sessions', 'agents', 'tokenMeter']) {
    const value = safeGet(ctx, service);
    line(`get.${service}=${typeof value === 'string' && value.startsWith('throws') ? value : describe(value)}`);
  }
  const projections = safeGet(ctx, 'sessionProjections');
  if (projections !== null && projections !== undefined && typeof projections === 'object') {
    line(`sessionProjections keys=${Object.keys(projections).slice(0, 12).join(',')} ` +
      `stateOf=${describe(projections.stateOf)} register=${describe(projections.register)} ` +
      `list=${describe(projections.list)} has=${describe(projections.has)}`);
    for (const method of ['list', 'keys', 'definitions']) {
      if (typeof projections[method] !== 'function') continue;
      try {
        const result = projections[method]();
        line(`sessionProjections.${method}()=${JSON.stringify(result).slice(0, 400)}`);
      } catch (error) {
        line(`sessionProjections.${method}() throws ${String(error?.message ?? error).slice(0, 100)}`);
      }
    }
  }
  loggedApply = true;
}

export const name = 'g4-probe';

export function apply(ctx) {
  line(`apply pid=${process.pid}`);
  probeAll(ctx, 'apply');
  setTimeout(() => probeAll(ctx, 'after-2s'), 2000);
  if (typeof ctx.on === 'function') {
    let seen = 0;
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'assistant/message' && event?.type !== 'request/context' && event?.type !== 'turn/end') return;
      if (seen >= 6) return;
      seen += 1;
      const projections = safeGet(ctx, 'sessionProjections');
      if (projections === null || typeof projections?.stateOf !== 'function') {
        line(`event ${event.type} seq=${event.seq} stateOf=absent`);
        return;
      }
      try {
        const pressure = projections.stateOf(session, 'contextPressure');
        const usage = projections.stateOf(session, 'tokenUsage');
        line(`event ${event.type} seq=${event.seq} session=${session?.id} ` +
          `contextPressure=${summarizeState(pressure)} tokenUsage=${summarizeState(usage)}`);
      } catch (error) {
        line(`event ${event.type} seq=${event.seq} stateOf throws ${String(error?.message ?? error).slice(0, 120)}`);
      }
      if (event.type === 'request/context') {
        line(`request/context data=${JSON.stringify(event.data).slice(0, 300)}`);
      }
    });
  }
}
