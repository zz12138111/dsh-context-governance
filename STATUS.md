# DSH 插件开发 · 当前状态

> 只放"现在还活着"的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-25（M1 结项；M1.1 T1 门禁通过、B2 已出；M1.2 离线完成 v0.1.11；等重启）

## 在办

| 会话 | 当前任务 | 状态 |
|---|---|---|
| 需求 | M1.1 T1 通过但 B2 显示宿主 pruner 已覆盖大部分，**T2 范围待需求拍板**；M1.2 已出单；M2 待 M1.1 完成后评估 | 待决策 |
| 开发 | M1.1 T1（F1/F2/B1/B2）完成；M1.2 离线完成（v0.1.11）；等用户重启验收 | 等重启 |
| 审核打包 | 待命（T6/T7 后独立复核） | idle |

## 进度

- **T1（E1/E2）**：通过。事件级感知、摘要可读、无拦截型前钩子。
- **T2（记忆）**：完成。`packages/dsh-context-governance/`；`mem_write`/`mem_query`。
- **T3（压缩适配与保护）**：离线完成。适配器/自检/保护校验/降级/观测循环；文档 `docs/T3-压缩适配与保护.md`；审计 `analysis/t3/`。
- **T4（压缩前固化与回注）**：离线完成（S4=B）。5 类保护项同步 journal、end 后 microtask 回注、失败降级、audit；文档 `docs/T4-压缩前固化与回注.md`。
- **T5（状态命令与审计）**：离线完成。`/cg status`（后端/能力/记忆/上次压缩与回注/p50p95/审计）；审计字段白名单 + 脱敏；文档 `docs/T5-状态命令与审计.md`。
- **T6（失败与降级）**：离线完成（v0.1.4）。审计 8 MiB 轮转（可配）、五类只读判据 + 恢复探测、事件流中断/卸载留痕、所有失败只 log/audit 不抛宿主；文档 `docs/T6-失败与降级.md`。
- **T7（验收场景）**：离线完成（v0.1.5）。S1–S6 全部用例 + S4 A/M/I/F/AUD/R；真实**自动+手动**压缩双样本脱敏回放；只读人工脚本 `docs/T7-只读降级人工验证.md`；覆盖表 `docs/T7-验收场景-S1-S6.md`。
- **T8（回注自愈 + 成本归属）**：离线完成。ROB-01/06 改为“每次失败留审计、连续 N 次才降级、降级仍可回注、下一周期自愈”；新增 `compaction-cost` 审计（REQUIREMENTS A 字段，token 实测/估算分列，不记金额）；三轮复核后 fixture 改结构白名单、commands 晚挂载重试、shadowedRange 兜底；四轮复核接入 `reinjection.maxFailures` 配置、成本 `backend` 维度与口径修正；文档 `docs/T8-回注自愈与成本归属.md`、`docs/T8-复核三轮修复.md`。
- **M1.2（探测修正与成本实测，v0.1.11）**：离线完成。能力探测改 `capability@apply` + 首个会话事件后 `capability@ready`（诊断 + audit，只记类型）；`tokenMeter` 不走硬 inject，改为可选注入 + 按需获取（成功才缓存）；`assistant/message.usage` 兜底，新增 `tokensBefore/AfterSource`（tokenMeter/usage/none）与可选 parts，`auditVersion=cost-v1.1`（只增字段）；`/cg status` 显示 `last-cost`；`ctx.compaction` 结论为“可获取（ready 时）”。记录 `analysis/t1/M1.2-探测修正与成本实测.md`。
- **M1.1 T1（门禁）**：**通过**。F1 能（`tools/post-execute` 在 `tool/result` append 前替换；宿主 pruner 的 replace+shadow 也被下一请求消费）；F2 能（tokenGuard 默认只 `pwsh`；跳过 `[token-guard]`/`[cg-fold]`/spill notice/pruner 痕迹）；B1 已采（87 回合/1,819 步/2,218 调用；开发会话名单内候选 0，宿主 pruner 已折 8 条 `read`）；B2 差异表已出——T2 应「复用宿主协议 + 只做增量」，但触发/参数/是否保留早折**需需求先拍板**。记录 `analysis/t1/T1-门禁记录.md`。
- **测试**：全量 **177/177 通过**（`node --test "test/*.test.mjs"`；M1.2 新增 7 条，T8 成本断言更新为 `cost-v1.1`）。
- **真机**：已安装（deps 14 / bundles 17 / redirect 0.1.0-context-zip / junction 已建）。v0.1.6 已验证工具/感知/审计；**v0.1.11 待用户重启验收**（`version=0.1.11`、`capability@apply/@ready`、`cost-v1.1` 非 null、`last-cost`、审计轮转、只读脚本；S3 默认关）。
- **T6/T7/T8**：均离线完成；真机验收项列在“下一步”。
- **T8/T9**：T8-1 修 ROB-01/06；T8-2 实现 `compaction-cost`（A 口径）；**T9 已被 T8-2 吸收，不再排期**。

## 已知风险（当前无代码风险；有 1 个待决策）

- T8-1 已修复 ROB-01/06：回注失败不再永久停写，改为“每次失败审计 + 连续 N 次降级一个周期 + 下一周期自愈”，`reinjection-recovered` 可审计。
- M1.1 T2 收益未证：B1 开发/审核会话名单内候选 0；宿主 pruner 已在压缩点折 `read`（8 条）。T2 若对齐宿主时机则增量≈0；若早折则需需求接受“收益未证”。

## 已知偏差（已接受）

T4 回注时点：checkpoint→end 之间不可实现，改为 end 后首个 microtask（同 tick、下一轮前）；用户已接受，`DEC-PLUGIN-20261025-09`。

M1 成本“前后水位未知”原按降级接受，2026-10-25 复查为插件侧可修（tokenMeter 读取时机），已由 M1.2 修（v0.1.11，离线 177/177）；`ctx.compaction` 结论为“可获取（ready 时）”，真机 `capability@ready` 待重启确认；若确认，回注时点偏差有复查机会。

## 等待用户/外部

- **真插件安装**：已完成结构安装（junction 指向源码，改完重启即生效）；开发不重启。
- M1.1：T1 门禁通过；**B2 差异表显示宿主 pruner 已覆盖大部分（8 条 `read` 在压缩点被折），T2 是否保留“早折”/如何对齐参数需需求决策**；未接到决策前不开 T2。
- M1.2：离线完成（v0.1.11）；需用户重启后验收 `capability@ready` 与 `cost-v1.1` 非 null。
- M2：M1.1 完成后评估。
- 暂存：GitHub 发布用的仓库地址与账号（发布前需要）。

## 阻塞

- 无（v0.1.11 重启验证由用户执行；只读演练需人工制造不可写根，开发不自行改动安装态）

## 下一步

1. 用户一次性重启 → 校验 `version=0.1.11`、`perception=event event-api=on`、`capability@apply/@ready`、`events=N` 随真实压缩增长、`compaction-cost` 的 `auditVersion=cost-v1.1` 且 `tokensBefore/After` 非 null、`/cg status` 的 `last-cost`、审计轮转。
2. 用户按 `docs/T7-只读降级人工验证.md` 跑一次只读演练（制造不可写根 → read-only → 恢复）。
3. S3 header 默认关闭；要启用需用户拍板改 `memoryHeader.enabled`。
4. 00 转用户验收 → 审核打包独立复核。
5. M1.1 T1 已过；**需求先决定 T2 范围**（宿主 pruner 已覆盖大部分：停项 / 复用协议+增量 / 是否保留早折）；未决策前开发不开 T2。
6. M1.2 重启验收后：若 `ctx.compaction` 可得 → 评估修回注时点（P1）；M2 待 M1.1 完成后评估。