# 0.2.4 提前压启用 · T3/T4 复核记录

> 复核人：审核打包会话（`cs_DNciCVhuZD`）· 2026-10-26
> 基线：HEAD `7d432be`（含 T2；T3=`77b6227`，T4=`e585895`），独立 worktree 全量 **323/323**。
> 口径：只报证据与结论；`docs/review-1.0-发布口径-检查项.md` §4（P-1~P-5）继续适用。

## 1. T3（`77b6227`）—— 通过

| 判据 | 结论 | 证据 |
|---|---|---|
| `early=` 五态可读 | **通过** | `summarizePolicy`：`on (default|config|session)` / `off (default|config|session)` / `off (policy:<来源>)`；`early=false` 时 `off (policy:research)` 优先 |
| `last-early:` 行 | **通过** | `formatEarlyStatus`：`event/reason/effective/at`；无决策 `last-early: none`；skipped/forced/aborted/failed 都更新 |
| 项目层被拒可见 | **通过** | `policy-invalid: 1 (project/compact.early.armed:project-excluded)`；单测覆盖 |
| 来源不伪装 | **通过** | `armedSource` 来自 `resolvePolicy` 的 per-key source（builtin→default、plugin→config、session 原样） |

备注：`getArmed` 在 index 里每次调用 `policyState.resolve()`（`:526-528`），**会话层变更立即生效**；配置文件层不热重载，见 §2。

## 2. T4（`e585895`）—— **有条件通过（证据等级不足，需补真机）**

三层「0 触发」证据：

| 层 | 证据 | 等级 |
|---|---|---|
| ① 会话 `disarm` | 命令单测（写 sessionLayer + `early-disarmed` 审计）+ `resolvePolicy` → `earlyArmed=false/source=session`，wiring `compactNow` 调用 **0** | 单测/集成，**无真机** |
| ② 配置 `armed=false` | `validateLayer(plugin)` + `resolvePolicy` → `off (config)`，wiring 调用 **0** | 离线“加载路径”，**无真机** |
| ③ research `compact.early=false` | `resolvePolicy(profile=research)` → `early=false`（armed 仍 true），wiring 调用 **0** | 单测/集成，**无真机** |

**问题**：三层都没有「真机运行时」证据——但**机制是统一的**（`getArmed → policyState.resolve()`），所以单测能证明判定链，不证明“真机命令/配置在宿主进程里确实停用”。

### 2.1 对你三个问题的回答

1. **层②“加载后生效”的离线替代是否可接受？**
   **可接受，但语义必须写准**：配置在 `apply` 时读入（`buildPolicyState`），**不热重载**；所以“重载后生效”应写成「**下次启动生效**」。离线 `validateLayer→resolvePolicy` 恰好就是启动时的加载路径，替代成立；不能用它宣称“改配置无需重启”。
2. **三层回退是否实际只有两层真机证据？**
   **一层都没有真机证据**（三层全是单测/集成）。差别只在①涉及命令面、②③涉及配置解析。1.0 门禁写“回退可证”时，必须区分「判定链可证（已有）」和「真机停用可证（尚无）」。
3. **真机重载是否并入 T5 隔离 profile 那一轮？**
   **建议并入，且作为 R-2 门禁的一部分**。一次隔离实例窗口可同时产出：
   - 真实提前压 1 次（R-2：`early-forced` + `compaction-cost` + status 原文）；
   - `①` 真机 `/cg compact disarm` 后下一 `turn/end` 0 触发；
   - `②` 改配置 `armed=false` → **重启隔离实例** → `off (config)`；
   - `③` 用 `research` profile 启动 → `off (policy:research)`。
   这样“回退可证”从“单测可证”升级为“真机可证”，且不碰桌面。

## 3. 需补的真机证据清单（并入 T5 隔离轮）

1. `early=on (default)` 首屏状态原文；
2. 真实触发一次（R-2）→ `early-forced` + `compaction-cost` + `/cg status` 原文落盘；
3. disarm 后同会话下一 turn：`early-forced` 0 条、`compactNow` 0 次（用隔离日志/计数佐证）；
4. 改 `compact.early.armed=false` → 重启隔离实例 → `early=off (config)`；
5. `research` profile → `early=off (policy:research)`；
6. 全程不触碰 `desktop`、不重启桌面 DSH。

### 3.1 T5 构造参数（用户已定 `at=0.35`）——口径核对

- **代码允许**：`AT_MIN = 0.2`、`PROJECT_AT_MIN = 0.45`（仅项目层）；`<0.30` 才需 `compact.lowThresholdAck`。**`at=0.35` 在插件/会话层合法、无需 ack**；约 `0.35 × 1,048,576 ≈ 367,002` tokens，与任务单描述一致。
- **但 1.0 定义里「`compact.at` 下限 0.45」的写法不准确**：0.45 只是**项目层**下限；策略/配置/会话层下限是 0.30（<0.30 需 ack），硬地板 0.2。发布说明与定义应改为「默认 0.60；插件/配置/会话层 ≥0.30（<0.30 需 `lowThresholdAck`）；项目层 ≥0.45」——否则 T5 用 0.35 会与自家文档冲突。
- 复核 T5 时我会同时验：`/cg status` 的 `compact.at` 显示为 0.35（source=config）且无 `below-min`/`low-threshold-unacked` 的 `policy-invalid`。

## 4. 待复核（下一批）

- **T1**（`5f83d10`：armed 三通道接线）尚未出正式复核记录；T3 用例已覆盖其状态/命令面，但默认值与项目层忽略需单独签；
- **T2**（`7d432be`：首触提示与失败口径）刚到，未复核；
- T5/T6 未到。

## 5. 结论

- T3 **通过**；T4 **有条件通过**（判定链可证、真机不可证）。1.0 门禁“回退可证”在补完 §3 的真机证据前，只能写“单测可证”，不能写“已演练”。
- 建议把 §3 并入 T5 隔离轮一次完成；完成后我出复验结论。

## 6. T5 真机 / T4 三层真机复验（2026-10-26，`acb89ca` / `0625ab6`）

### 6.1 T5（R-2）—— 通过（带环境注记）

- 原始审计（`.tmp/native-test-ws/.../audit.jsonl`）核对无误：
  - `early-forced`：`accepted=true, compaction="committed", protection="failed", failures=[latest-user-message,rule-injection,rollback-point], reinjected=true, delayMs=50, effective=0.4, threshold=0.35, native=0.6934, compactionId=5f6f8f5b…`；
  - `compaction-cost`：`before=162863 / after=2779`（均 `tokenMeter`）、`trigger="manual"`、`backend=host-basic`、`auditVersion=cost-v1.4`；
  - 保护+回注：`protection-write count=3` → `materialized moved=3` → `reinjection count=3 seq=153`；
  - `/cg status` 原文落盘 `0.2.4-T5-status.txt`：`early=on (default)`、`last-early: forced effective=0.400`。
- **判点 1（protection=failed + reinjected=true + compaction=committed）**：符合我们已采纳的口径——`shouldEscalateEarly` 只看 `compaction==='failed' || reinjected===false`，此组合**不升级、不重试、不算压缩失败**；`early-forced` 仍写 `accepted=true`。三态口径（ok/failed/null）在真实场景成立。
- **判点 2（trigger=manual）**：代码 `runtime.js:1573/1585` 用 `event.data?.sourceCommandId != null` 判 manual；插件的提前压显式传 `'early-auto'`，因此被标 `manual`。**解释成立**：`manual` = 走宿主 `compactNow` API，不代表用户手动压缩。发布物不得据此写“用户手动压过”。
- **环境注记（不阻塞）**：该隔离实例 status 显示 `adapter=none`、`self-check-failed(error)`、`no-compaction-service(warning)`——因为该 profile 未向插件暴露 `compaction` token，插件走事件级观察；压缩/保护/回注均正常。发布说明不应把 adapter 字段当“后端能力已识别”的证据。

### 6.2 T4 三层真机 —— ① ② 真机可证；③ 证据被压力混淆

| 层 | 证据 | 判定 |
|---|---|---|
| ① 会话 disarm | 审计 `early-disarmed 19:00:19.967Z`；此后压力 `0.427 ≥ at=0.35` 仍无新 `early-*`/`compaction-cost`（我核过 audit：disarm 后仅该条 `early-disarmed`） | **真机可证** |
| ② 配置 `armed=false` | 重启隔离实例 → `early=off (config)`；`/cg set compact.at=0.35` + 448K 历史 → `effective=0.427` 仍 0 触发、`last-early: none` | **真机可证**（且验证了“配置需重启生效”） |
| ③ research | `early=off (policy:research)` ✔；但 `at` 回到默认 **0.60**，压力 `0.427 < 0.60` → **0 触发本身不能证明 policy 优先**（被 at 混淆） | **状态可证、0 触发证据不足** |

**收尾核对**：18767 已无监听 ✓；`native-test/cordis.patch.yml` 内容为原始配置（无 `armed` 注入）✓；桌面未动 ✓。

**“回退可证”升级结论**：可从“单测可证”升级为「**① ② 真机演练可证；③ 状态可证（0 触发待补）**」。要写成完整“三层真机已演练”，需补一次 `research` + `compact.at=0.35`（同压力）的 0 触发证据；该补验很便宜（同 profile 重启一次）。

## 7. 结论修订

- R-2：**通过**（host-basic 隔离实例，真实提前压 1 次）；证据环境为 host-basic，生产 context-zip 未覆盖（见 `docs/兼容矩阵-1.0.md`）。
- T4：① ② 真机通过；③ 补一次 `at=0.35` 的 research 运行后，可整体写“三层真机演练可证”。
- trigger=manual 语义已确认，发布物按“宿主 manual API，不代表用户操作”表述。
