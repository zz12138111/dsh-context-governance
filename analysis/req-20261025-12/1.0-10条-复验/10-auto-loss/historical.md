# #10 历史自动压缩样本回查（`ca9c9bb8` 等）

- 范围：`memory/governance/audit.jsonl`（本机真机审计，共 2 个 `trigger:"auto"` 的 `compaction-cost` 样本）
  与 `logs/governance.log`（诊断行）。只读回查，不改历史数据。
- 结论口径：**必须三选一（发生丢失 / 未发生 / 无法判定+原因）**；仅凭
  `protection-write` / `protection-materialized` / `reinjection` 计数**不能**判「未发生」——
  这些只证明“写过/回过”，不证明逐项校验 0 丢失。
- 回查时间：2026-10-26；插件 1.0 修复前历史（loss 事件缺失正是本批缺陷本体）。

## 样本 1：`ca9c9bb8-664d-4a19-9e3f-dc5c044be3dd` —— **无法判定**

| 项 | 值 |
|---|---|
| sessionId | `session-5d1121ed-99fa-431f-9607-2312a173ecbf` |
| 触发类型 | **auto**（`manual:false`，`trigger:"auto"`） |
| 保护项命中 | `protection-write` count=4，kinds=`latest-user,rules,batch,rollback`，ids=`MEM-20261026-1000..1003` |
| 物化 | `protection-materialized` moved=4 |
| 回注 | `reinjection` count=4，seq=11651 |
| 成本 | `compaction-cost` tokensBefore=549567 / tokensAfter=3535 / tokensDropped=0 |
| 逐项校验报告 | **无**（auto 模式当时不写 loss；无 `verifyProtection` 报告/checks 记录） |
| 结论 | **无法判定** |

**依据行号**：`audit.jsonl:60`（protection-write）、`:61`（protection-materialized）、
`:63`（reinjection）、`:64`（compaction-cost）。本周期无 `compaction-loss`/
`manual-compaction-loss`/`protection-skip` 行。

**为什么不是「未发生」**：
1. 当时 auto 模式不写 loss（`state.manual===true` 才写），校验失败与否**没有落审计**；
2. `protection-write count=4` / `materialized moved=4` / `reinjection count=4` 只证明“写过/物化/回过”，
   不能证明逐项校验全部通过；
3. 保护 journal 已清理，无法事后重放 `verifyProtection`；该周期也无 report/checks 级记录。
   故只能「无法判定（原因：auto 模式当时无 loss 事件、无逐项校验报告；计数只证明写入/回注发生）」。

## 样本 2：`292d1e97-182e-4c3d-9a9b-2e592ac120aa` —— **发生丢失**

| 项 | 值 |
|---|---|
| sessionId | `session-58a2e845-cec5-4229-afa9-7f09a0fc0207` |
| 触发类型 | **auto**（`manual:false`，`trigger:"auto"`） |
| 保护项命中 | `protection-write` count=4，kinds=`latest-user,rules,batch,rollback`，ids=`MEM-20261026-1025..1028`；`protection-skip` count=1，reason=`no-ratio-in-user-messages`，names=`batch-list` |
| 物化 | `protection-materialized` moved=4 |
| 回注 | `reinjection` count=4，seq=31521 |
| 成本 | `compaction-cost` tokensBefore=604824 / tokensAfter=3588 / tokensDropped=0 |
| loss 审计行 | **无**（本周期缺 loss 行 = 本批缺陷本体） |
| 失败证据 | diagnostics：`compaction protection failed (3): latest-user-message,rule-injection,rollback-point compactionId=292d1e97-182e-4c3d-9a9b-2e592ac120aa` |
| 结论 | **发生丢失** |

**依据行号**：`audit.jsonl:312`（protection-write）、`:313`（materialization）、`:315`（protection-skip）、
`:316`（reinjection）、`:317`（compaction-cost）；`logs/governance.log:54`（failures 诊断，**带同一
compactionId**，与 audit 行并读）。

**定级依据**：诊断行给出了具体失败项 `latest-user-message/rule-injection/rollback-point`，
且 compactionId 与 audit 同周期一致；audit 中**没有**对应的 loss 行（正是 #10 缺陷）。
`reinjection count=4` 不能反证“未丢”——同一时期的手动样本 `d835e71c` 同样是 failures 3→4 项、
但 `reinjection count=4`，证明回注发生与保护失败可并存。

## 汇总

| 样本 | 触发 | 保护项命中 | 结论 |
|---|---|---|---|
| `ca9c9bb8-664d-4a19-9e3f-dc5c044be3dd` | auto | write4 / materialized4 / reinjection4 / 无校验报告 | **无法判定**（原因如上） |
| `292d1e97-182e-4c3d-9a9b-2e592ac120aa` | auto | write4 / skip batch-list / failures 3 / 无 loss 行 | **发生丢失** |

说明：audit 中其余 loss 行均为 `manual:true`（手动样本，如 `d941a656`、`d835e71c`），不属本次
“自动压缩样本”范围；本表只覆盖 `trigger:"auto"` 的 2 条 `compaction-cost`。
