# dsh-context-governance 1.0.1 发布说明

> **发布形态**：仅 GitHub（tag `v1.0.1`），不发布到 npm。
> 上一版 `v1.0.0` 仍是回滚点；`v0.2.1` 为历史兼容 tag，保留可见、不推荐新装。
> 版本 `1.0.1`，全量测试 **520/520**（`node --test "test/*.test.mjs"`）。

## 一句话

提前压之后那条"到底压成没压成"的账，1.0.0 里经常永远停在 `unknown`；1.0.1 让它在**审计链内可闭合**：先等本 cycle 的报告（最长 60s，不阻塞对话），超窗写 `unknown` + 诊断，报告晚到再按同会话同 cycle 追加一条回填；待回填登记会落盘，**插件重载/热重启后**若宿主仍派发该报告即可补上。

## 解决什么

宿主把压缩事件派发给插件的延迟不是固定值：桌面真机 4 轮实测 force → 报告 **15.3s / 24.9s / 22.8s / 87.6s**。固定短等待必然漏，1.0.0 又是 `compactNow` 返回后立即读报告，通常什么都读不到，只能写 `unknown`。

## 变更

| 项 | 内容 |
|---|---|
| S1 | `compactNow` 返回后等**本 cycle** 的报告再写 `early-forced`；拿不到写 `unknown`，不抄上一轮 |
| S1.1 | 等待上限 500ms → 3000ms；未命中留 `early-report-wait`（`timeout`/`mismatch`/`error` + `waitedMs`） |
| S1.2 | 上限提到 **60000ms**（实测派发延迟可达数十秒） |
| S1.3 | 报告晚到 → `onReportReady` 监听，追加 `early-forced-reconciled`（迟到回填） |
| 1.0.1 | 待回填登记**落盘**（最小版）：插件重载/热重启后可读回，报告仍会派发即可补账 |
| 审计 | 白名单补 `compactionShortId` / `reconcileDelayMs` / `waitedMs`；`early-report-wait`、`early-forced-reconciled` 进正式事件清单 |

约束没变：生产压缩路径、引擎注入/包装、`isolate.compaction` 全部未动；`early-forced` 主记录**不回改、不伪造**，没有 fresh 报告时仍写 `unknown`。

## 新审计事件

### `early-report-wait`

等报告**未命中**时的诊断行（命中不写）：

| 字段 | 含义 |
|---|---|
| `sessionId` / `cycle` | 会话与保护 cycle（`early-<uuid>`） |
| `reason` | `timeout`（窗内无候选）/ `mismatch`（窗内有新报告，但不是本会话本 cycle）/ `error`（等待本身抛错） |
| `waitedMs` | 实际等待毫秒 |

### `early-forced-reconciled`

报告在等待窗之后才就绪时的回填行。**只追加、不改写 `early-forced`**；仅当主记录 `compaction=unknown` 时登记，`sessionId` + `cycle` 双匹配才写，同一 cycle 至多一条。

| 字段 | 含义 |
|---|---|
| `compactionId` / `compactionShortId` | 宿主 compaction id 与其实前 8 位 |
| `compaction` / `protection` / `failures` / `reinjected` | 取自报告原文 |
| `reconcileDelayMs` | 从 `early-forced` 写入到回填的毫秒 |
| `source` | `late-report` |

## 闭合判据（人工/脚本判定，产品不判定）

1. `early-forced.accepted=true`；
2. 同 cycle 存在 `early-forced-reconciled`，且 `compaction=committed`、`compactionId` 非空；
3. 该 id 前 8 位与同会话 `compaction-loss`、`compaction-cost` 一致。

三条同时成立才算闭合；只有第 1 条 = **未闭合**。`protection` 只如实回填 `failures`，**不作闭合条件**。

## 待回填登记持久化（最小版）

- **文件**：`<持久化身份目录>/pending-reconcile-<profile>[-<rootId>].json`，与 `root-state-<profile>.json` 同目录（自定义 `dir` 时是该目录下 `context-governance/root-state.json`），**多根各一份**。
- **内容**：只有 `{cycle, sessionId, writtenAt}`——不存正文、不存摘要、不存审计对象。
- **裁剪**：读回与运行期同一口径，TTL **15 分钟**、上限 **16 条**；过期/超限按未闭合处理（不猜、不补写）。
- **写入**：tmp + rename 原子写；读/写/损坏/不可写只 warn 一行，空表或内存表继续，**不抛错、不阻塞 turn**。
- **不加 `early-reconcile-restored` 事件**：读回只影响"以后还能不能补一条 reconciled"，闭合判定只看 reconciled 行是否存在，加事件只是每次重启多一行噪声，不增加证据力。

> **能补与不能补（措辞红线）**：插件**重载 / 热重启**后可读回登记，报告若仍会派发即可补 `early-forced-reconciled`。**宿主进程重启**时本次压缩本身已中断、该报告不会再派发，读回的条目只会按 TTL（15 分钟）过期，最终按未闭合处理——这是诚实行为，但**不得写成"宿主重启后一定补上 / 重启也能闭合"**。

## 已知限制 / 后续（1.0.2 候选）

- 常规聊天里提前压触发仍少；完整闭合链仍需一份**同会话 `/cg status` 原文**作为人工证据。
- 迟到回填只在进程内等到 `onReportReady` 或从落盘表恢复；重启后恢复条目的审计写入器用本根 audit（无 per-session 句柄）。
- **`writeReconcileStore` 未走 `checkWriteTarget`**：当前路径只由持久化身份推导（不可逃逸到身份目录之外），1.0.2 补显式 target 断言。
- **多进程同根后写覆盖**：落盘表是整个文件重写，多进程同根并发时后写者覆盖，可能丢条目（观察项，1.0.2 处理）。
- **措辞红线**：本版 notes 已按"插件重载可读回、宿主重启不保证"表述，后续版本文档沿用同一口径。

## 升级 / 回滚

- 升级：替换插件目录 → 重启 DSH；`cordis.patch.yml` 与配置口径不变，**无状态迁移**。
- 回滚：`git checkout v1.0.0 -- packages/dsh-context-governance` 后重启。本版不改数据结构，回滚不丢已写审计；回滚后新增的 `pending-reconcile-*.json` 可留可删（不参与 1.0.0 逻辑）。

## 验证

- 全量：`node --test "test/*.test.mjs"` → **520/520 pass**（0 fail / 0 skip）。
- 包面：`npm pack` → **37 文件 / 0 test / 0 本机绝对路径**。
