/* ARCHIVED-C34（2026-11-15，用户批 0214ae5：C34 作废、C35 新增）\n   本文件保留作历史/回归参考，不再作为验收判据；C35 见 verify-c35-host-heal.mjs。\n   禁止按本文件结果判实现。 */
/**
 * 测试角色 · D-MGMT-021 回归：payload 形状 + 压缩 marker 合法性 + 重建不得伪造 turn
 *
 * 背景：开发定位 `src/compress/protection.js:422-424`（调用点 `src/compress/runtime.js:2290-2296`）
 * 在 `compaction/end` 后重建保护面时，`system/message` 只传 `{ message }`，缺宿主必填 `turn`/`step`，
 * 被宿主 v4 编码器拒绝（`system/message turn must be a non-negative safe integer`），
 * 错误被 `append` 的 try/catch 吞进 `rebuilt.failures`，所以不落盘、重启才愈。
 *
 * 本探针独立于开发的自述，直接用**宿主真实的 v4 编码器**验证 8 条：
 *   CODE-A  `{message}`                     → 必须抛 turn 文案（治理当前形态）
 *   CODE-B  `{turn,step,message}`           → 必须通过（宿主 agent-loop 形态）
 *   CODE-C  `{turn,message}` 缺 step        → 必须抛 step 文案
 *   CODE-D  `{turn:null,step,message}`      → 必须抛 turn 文案
 *   CODE-E  `compaction/start|end turn:null` → 必须通过（压缩 marker 合法，不是病根）
 *   CODE-F  `user/message` 裸载荷           → 必须通过（非对称：只有 system/message 需要 turn/step）
 *   INT-A   保护面重建（system 规则）→ 送进 append 的载荷必须能被宿主编码器接受
 *   INT-B   session 给不出合法 turn/step 时 → 不得 append，且 failures 必须留可识别的跳过原因
 *           （审核定稿名：审计事件 `surface-rebuild-skipped`，reason=`no-open-step`）
 *   INT-C   保护面重建（user 最新消息）→ 仍应成功（不因 A 的修复把 user 侧一起掐死）
 *
 * 运行：node tests\probe-1.1.0\verify-021-payload.mjs
 * 退出码：任一 FAIL → 1（当前版本因 D-MGMT-021 未修，INT-A/INT-B 预期 FAIL）
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const results = [];
function check(id, ok, detail) { results.push({ id, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`); }

// ── 解析宿主真实 v4 编码器（与开发 probe 同一份 node_modules） ──
const probeAnchor = path.join(ROOT, '.tmp', 'probe', 'probe-021.mjs');
const requireFromProbe = createRequire(probeAnchor);
const codecEntry = requireFromProbe.resolve('@deepseek-ai/dsh-session-format-v3-to-v4');
const { releasedV4SessionFormatCodec: codec } = await import(pathToFileURL(codecEntry).href);
const { rebuildProtectionSurface } = await import(
  pathToFileURL(path.join(ROOT, 'packages', 'dsh-context-governance', 'src', 'compress', 'protection.js')).href
);

const TURN_ERR = 'system/message turn must be a non-negative safe integer';
const STEP_ERR = 'system/message step must be a non-negative safe integer';
const message = {
  role: 'system',
  id: 'sys-rule-1',
  content: [{ type: 'text', text: 'protected rule' }],
  source: { kind: 'system-prompt' },
};
const encode = (type, data) => codec.encodeEvent({ type, seq: 7, time: 1790000000000, data, surfaceOp: 'append' });
function throwsWith(fn, expected) {
  try { fn(); return { thrown: null }; } catch (error) { return { thrown: String(error?.message ?? error) }; }
}

// ── CODE：payload 形状 ──
{
  const a = throwsWith(() => encode('system/message', { message }));
  check('CODE-A-message-only-throws-turn', a.thrown === TURN_ERR, `thrown=${JSON.stringify(a.thrown)}`);

  const b = throwsWith(() => encode('system/message', { turn: 3, step: 1, message }));
  check('CODE-B-turn-step-message-ok', b.thrown === null, `thrown=${JSON.stringify(b.thrown)}`);

  const c = throwsWith(() => encode('system/message', { turn: 3, message }));
  check('CODE-C-missing-step-throws-step', c.thrown === STEP_ERR, `thrown=${JSON.stringify(c.thrown)}`);

  const d = throwsWith(() => encode('system/message', { turn: null, step: 1, message }));
  check('CODE-D-null-turn-throws-turn', d.thrown === TURN_ERR, `thrown=${JSON.stringify(d.thrown)}`);

  const markerStart = throwsWith(() => encode('compaction/start', { compactionId: 'c-1', sourceCommandId: 'early-auto', turn: null }));
  const markerEnd = throwsWith(() => encode('compaction/end', { compactionId: 'c-1', sourceCommandId: 'early-auto', turn: null }));
  check('CODE-E-compaction-marker-null-turn-ok', markerStart.thrown === null && markerEnd.thrown === null,
    `start=${JSON.stringify(markerStart.thrown)} end=${JSON.stringify(markerEnd.thrown)}`);

  const userBare = throwsWith(() => encode('user/message', { role: 'user', id: 'u-1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }));
  check('CODE-F-user-message-bare-ok', userBare.thrown === null, `thrown=${JSON.stringify(userBare.thrown)}`);
}

// ── INT：保护面重建过宿主编码器 ──
function makeSession({ turn = undefined, step = undefined } = {}) {
  const appended = [];
  const session = {
    appended,
    surface: { nodes: [] },
    // 宿主侧上下文（修复后应由 session 提供；当前实现不读它）
    compaction: { turn, step },
  };
  session.append = (type, payload, options) => {
    // 严格模拟宿主：先过 v4 编码器，抛错就抛（插件自己的 try/catch 会吞成 failures）
    codec.encodeEvent({ type, seq: 100 + appended.length, time: 1790000000000, data: payload, surfaceOp: options?.surfaceOp ?? 'append' });
    appended.push({ type, payload });
    return { seq: 100 + appended.length - 1 };
  };
  return session;
}
const ruleSnapshot = () => ({
  nodes: [5, 6],
  latestUser: null,
  rules: [{ seq: 5, type: 'system/message', kind: 'system-prompt', source: { kind: 'system-prompt' }, text: 'protected rule' }],
});
const opts = { shadowedSeqs: [5], postSurfaceNodes: [], compactionId: 'c-1' };

{
  // v3b：system 形态规则不 append，只记 skipped（压缩事务内恒无 open step）
  const session = makeSession({ turn: 7, step: 1 });
  const rebuilt = rebuildProtectionSurface(session, ruleSnapshot(), opts);
  const sysAppended = session.appended.filter((item) => item.type === 'system/message');
  const skipped = Array.isArray(rebuilt.skipped) ? rebuilt.skipped : [];
  const fieldOk = skipped.length === 1
    && skipped[0].ruleSeq === 5
    && skipped[0].kind === 'system-prompt'
    && skipped[0].reason === 'no-open-step';
  check('INT-A-system-rule-skipped-not-appended', sysAppended.length === 0 && fieldOk
    && !rebuilt.failures.some((reason) => /append-threw/i.test(reason)),
    `appended=${JSON.stringify(sysAppended)} skipped=${JSON.stringify(skipped)} failures=${JSON.stringify(rebuilt.failures)}`);
}

{
  // 即使拿得到 turn/step 也不得 append（压缩事务内无 open step）；不得伪造 turn:null，不得靠宿主抛错吞
  const session = makeSession({ turn: null, step: null });
  const rebuilt = rebuildProtectionSurface(session, ruleSnapshot(), opts);
  const appendedSys = session.appended.filter((item) => item.type === 'system/message');
  const forgedNull = appendedSys.some((item) => item.payload?.turn === null);
  const skipped = Array.isArray(rebuilt.skipped) ? rebuilt.skipped : [];
  const explained = skipped.some((entry) => entry.reason === 'no-open-step');
  const swallowedCodecThrow = rebuilt.failures.some((reason) => /append-threw/i.test(reason));
  check('INT-B-no-turn-skips-with-reason', appendedSys.length === 0 && !forgedNull && explained && !swallowedCodecThrow,
    `appended=${JSON.stringify(appendedSys)} forgedNull=${forgedNull} skipped=${JSON.stringify(skipped)} swallowedCodecThrow=${swallowedCodecThrow} failures=${JSON.stringify(rebuilt.failures)}`);
}

{
  const session = makeSession({ turn: 7, step: 1 });
  const snapshot = {
    nodes: [5, 6],
    latestUser: { seq: 6, text: 'latest human message', source: { kind: 'user' } },
    rules: [],
  };
  const rebuilt = rebuildProtectionSurface(session, snapshot, { shadowedSeqs: [6], postSurfaceNodes: [], compactionId: 'c-1' });
  check('INT-C-user-message-rebuild-still-works', rebuilt.latestUser !== null,
    `rebuilt=${JSON.stringify(rebuilt)}`);
}

{
  // C34：中段（非 head）system 规则被 shadow —— 真实数据（53ece2c2 comp@74576→71577；8b7b552a comp@4611→1502/4463）
  const session = makeSession({ turn: 7, step: 1 });
  const snapshot = {
    nodes: [5, 6, 7],
    latestUser: null,
    rules: [
      { seq: 5, type: 'system/message', kind: 'system-prompt', source: { kind: 'system-prompt' }, text: 'head rule' },
      { seq: 7, type: 'system/message', kind: 'system-prompt', source: { kind: 'system-prompt' }, text: 'mid-surface rule' },
    ],
  };
  const rebuilt = rebuildProtectionSurface(session, snapshot, { shadowedSeqs: [5, 6, 7], postSurfaceNodes: [], compactionId: 'c-1' });
  const appendedSys = session.appended.filter((item) => item.type === 'system/message');
  const skipped = Array.isArray(rebuilt.skipped) ? rebuilt.skipped : [];
  const seqs = skipped.map((entry) => entry.ruleSeq).sort((a, b) => a - b);
  const fieldsOk = skipped.every((entry) => entry.reason === 'no-open-step' && typeof entry.kind === 'string');
  check('INT-D-mid-surface-system-rule-skips-not-forges',
    appendedSys.length === 0 && skipped.length >= 2 && JSON.stringify(seqs) === '[5,7]' && fieldsOk,
    `appended=${JSON.stringify(appendedSys)} skipped=${JSON.stringify(skipped)} failures=${JSON.stringify(rebuilt.failures)}`);
}

{
  // L2：空正文规则仍走 rule-payload-missing，不 append、不记 skipped
  const session = makeSession({ turn: 7, step: 1 });
  const snapshot = { nodes: [5], latestUser: null, rules: [{ seq: 5, type: 'system/message', kind: 'system-prompt', source: { kind: 'system-prompt' }, text: '' }] };
  const rebuilt = rebuildProtectionSurface(session, snapshot, opts);
  const skipped = Array.isArray(rebuilt.skipped) ? rebuilt.skipped : [];
  check('INT-E-empty-rule-still-payload-missing',
    session.appended.length === 0 && skipped.length === 0 && rebuilt.failures.includes('rule-payload-missing'),
    `appended=${JSON.stringify(session.appended)} skipped=${JSON.stringify(skipped)} failures=${JSON.stringify(rebuilt.failures)}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nC33-021 TOTAL ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) { console.log(`FAILED: ${failed.map((item) => item.id).join(', ')}`); process.exitCode = 1; }

