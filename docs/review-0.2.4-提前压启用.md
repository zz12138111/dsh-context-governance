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

## 4. 待复核（下一批）

- **T1**（`5f83d10`：armed 三通道接线）尚未出正式复核记录；T3 用例已覆盖其状态/命令面，但默认值与项目层忽略需单独签；
- **T2**（`7d432be`：首触提示与失败口径）刚到，未复核；
- T5/T6 未到。

## 5. 结论

- T3 **通过**；T4 **有条件通过**（判定链可证、真机不可证）。1.0 门禁“回退可证”在补完 §3 的真机证据前，只能写“单测可证”，不能写“已演练”。
- 建议把 §3 并入 T5 隔离轮一次完成；完成后我出复验结论。
