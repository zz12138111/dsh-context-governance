// G2/G3 probe (REQ-20261025-09) — isolated profile only.
// 只记类型/数值/时长/错误名；不记录任何消息正文、不写记忆、不改产品行为。
import fs from 'node:fs';

const LOG = 'D:/DS-PROJECT/DSH插件开发/.tmp/g2-probe.log';

function line(text) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`); } catch { /* ignore */ }
}

function describe(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return typeof value;
}

function safeGet(ctx, name) {
  try { return ctx.get(name); } catch { return undefined; }
}

function measureOf(ctx, session) {
  const meter = safeGet(ctx, 'tokenMeter');
  if (meter === null || meter === undefined || typeof meter.measure !== 'function') return { ok: false, reason: 'no-meter' };
  try {
    const measurement = meter.measure(session);
    const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : null;
    if (nodes === null) return { ok: false, reason: 'no-nodes' };
    let sum = 0; let counted = 0;
    for (const node of nodes) {
      const value = Number.isFinite(node?.tokens) ? node.tokens : (Number.isFinite(node?.heuristicTokens) ? node.heuristicTokens : null);
      if (value === null) continue;
      sum += value; counted += 1;
    }
    return { ok: true, nodes: nodes.length, counted, sum };
  } catch (error) {
    return { ok: false, reason: `throws:${String(error?.message ?? error).slice(0, 60)}` };
  }
}

function projectState(ctx, session) {
  const projections = safeGet(ctx, 'sessionProjections');
  if (projections === null || projections === undefined || typeof projections.stateOf !== 'function') return 'absent';
  try {
    const state = projections.stateOf(session, 'contextPressure');
    if (state === null || state === undefined) return 'none';
    const picked = {};
    for (const key of ['pressureTokens', 'contextWindow', 'surfaceTokens', 'sampledSurfaceTokens']) {
      if (state[key] !== undefined) picked[key] = state[key];
    }
    return JSON.stringify(picked);
  } catch (error) {
    return `throws:${String(error?.message ?? error).slice(0, 60)}`;
  }
}

function agentFor(ctx, session) {
  const agents = safeGet(ctx, 'agents');
  if (agents === null || agents === undefined || typeof agents.list !== 'function') return null;
  try {
    const list = agents.list() ?? [];
    const id = session?.id ?? session?.session?.id;
    const found = list.find((agent) => agent?.session?.id === id || agent?.session?.session?.id === id);
    return found ?? list[0] ?? null;
  } catch {
    return null;
  }
}

function engineFor(ctx, agent) {
  const presets = safeGet(ctx, 'agentPresets');
  if (presets === null || presets === undefined || typeof presets.serviceFor !== 'function') return null;
  try {
    const engine = presets.serviceFor(agent, 'compaction');
    return engine !== null && typeof engine?.compactNow === 'function' ? engine : null;
  } catch {
    return null;
  }
}

const MODE = String(process.env.G2_PROBE_MODE ?? '');
const flags = { g2b: false, g2a: false, points: 0 };

async function callCompact(ctx, label, session, signal, sourceCommandId) {
  const agent = agentFor(ctx, session);
  if (agent === null) { line(`${label} no-agent`); return; }
  const engine = engineFor(ctx, agent);
  if (engine === null) { line(`${label} no-engine agentPresets=${describe(safeGet(ctx, 'agentPresets'))}`); return; }
  const started = Date.now();
  line(`${label} attempt signal=${signal === null || signal === undefined ? 'none' : 'set'} sid=${String(session?.id ?? '').slice(0, 24)}`);
  let error = null;
  try {
    await engine.compactNow(agent, signal ?? null, sourceCommandId);
    line(`${label} ok elapsed=${Date.now() - started}ms`);
  } catch (caught) {
    error = caught;
    line(`${label} rejected name=${String(caught?.name ?? '')} msg=${String(caught?.message ?? caught).slice(0, 120)} elapsed=${Date.now() - started}ms`);
  }
  return error;
}

async function g2a(ctx, session) {
  if (flags.g2a) return;
  flags.g2a = true;
  const error = await callCompact(ctx, 'G2A', session, new AbortController().signal, 'probe-g2a');
  if (error !== null && error !== undefined && (/busy/i.test(String(error?.message ?? '')) || /active work/i.test(String(error?.message ?? '')))) {
    line('G2A retry-after-500ms');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await callCompact(ctx, 'G2A-retry', session, new AbortController().signal, 'probe-g2a-retry');
  }
}

function g3(ctx, label, session, step) {
  flags.points += 1;
  const measure = measureOf(ctx, session);
  line(`G3 point=${label} step=${step ?? '-'} measure=${JSON.stringify(measure)} pressure=${projectState(ctx, session)}`);
}

export const name = 'g2-probe';

export function apply(ctx) {
  line(`apply pid=${process.pid} mode=${MODE || 'full'}`);
  for (const service of ['agents', 'agentPresets', 'tokenMeter', 'sessionProjections']) {
    line(`apply get.${service}=${describe(safeGet(ctx, service))}`);
  }
  if (typeof ctx.on !== 'function') { line('apply no-ctx.on'); return; }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const session = payload?.agent?.session ?? null;
    const step = payload?.step ?? null;
    if (session !== null) {
      g3(ctx, `pre-step:${step}`, session, step);
      if (flags.g2b === false && step === 1) {
        flags.g2b = true;
        if (MODE === 'b2') {
          // live signal：验证宿主对 turn 中调用的真实失败形态（3s 后 abort 兜底）
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 3000);
          setTimeout(() => { void callCompact(ctx, 'G2B2', session, controller.signal, 'probe-g2b2'); }, 0);
        } else {
          const controller = new AbortController();
          controller.abort();
          setTimeout(() => { void callCompact(ctx, 'G2B', session, controller.signal, 'probe-g2b'); }, 0);
        }
      }
    }
    return decision;
  });

  ctx.on('session/event', (session, event) => {
    const type = event?.type ?? '';
    const seq = event?.seq ?? '-';
    if (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end') {
      const detail = type === 'compaction/end' ? ` summaryId=${String(event?.data?.summaryId ?? '').slice(0, 12)}` : '';
      line(`event ${type} seq=${seq} sid=${String(session?.id ?? '').slice(0, 24)} sourceCommandId=${String(event?.data?.sourceCommandId ?? '')}${detail}`);
      if (type === 'compaction/end') {
        queueMicrotask(() => g3(ctx, 'compaction-end', session, '-'));
      }
      return;
    }
    if (type === 'turn/end') {
      const sid = String(session?.id ?? '').slice(0, 24);
      line(`turn/end seq=${seq} sid=${sid}`);
      g3(ctx, 'turn-end', session, '-');
      if (MODE !== 'b2') setTimeout(() => { void g2a(ctx, session); }, 50);
      return;
    }
    if (type === 'assistant/message') {
      const usage = event?.data?.usage?.tokens ?? '-';
      g3(ctx, 'assistant-message', session, usage);
    }
  });

  // 会话开始时也打点一次（apply 之后的首个事件）——用于确认探针在隔离实例中挂上。
  setTimeout(() => {
    line(`heartbeat agents=${describe(safeGet(ctx, 'agents'))} presets=${describe(safeGet(ctx, 'agentPresets'))} meter=${describe(safeGet(ctx, 'tokenMeter'))}`);
  }, 2500);
}
