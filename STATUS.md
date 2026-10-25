# DSH 插件开发 · 当前状态

> 只放"现在还活着"的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-25（M1 结项；M1.1 派单且 F1 口径已修订；M1.2「探测修正与成本实测」出单）

## 在办

| 会话 | 当前任务 | 状态 |
|---|---|---|
| 需求 | M1.1（REQ-20261025-02）已派、F1 口径已修订；M1.2（REQ-20261025-03）已出单待派；M2 待 M1.1 完成后评估 | 已排期 |
| 开发 | M1.1 T1 门禁进行中；M1.2 待接单（可与 T1 并行） | 进行中 |
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
- **M1.2（探测修正与成本实测，2026-10-25 出单）**：真机 `tokensBefore/After` 恒 `null`、能力行 `compaction=absent` 复查为**插件侧时序问题**——`ctx.tokenMeter` 在 apply 缓存 null（`runtime.js:189-195`）、能力探测早于服务注册；宿主 `dsh-token-meter`/`compaction-basic`/`tool-result-pruner` 均由 `dsh-base` 默认挂载。新增需求 `REQ-20261025-03`，与 M1.1 T1 并行。
- **测试**：全量**通过**（数量见 `node --test "test/*.test.mjs"` 输出；T8 新增成本 4 + 自愈 1，三轮复核新增 commands 晚挂载 + shadowedRange 兜底，四轮复核新增 reinjection 配置/空 usage/late-start trigger）。
- **真机**：已安装（deps 14 / bundles 17 / redirect 0.1.0-context-zip / junction 已建）。v0.1.6 已验证 `mem_write`/`mem_query` 注册、`perception=event`、能力行、`audit.jsonl`；v0.1.10 待下次重启验收（`version=<package.json>`、`events=N` 增长、`compaction-cost`、审计轮转、只读脚本；S3 默认关）。
- **T6/T7/T8**：均离线完成；真机验收项列在“下一步”。
- **T8/T9**：T8-1 修 ROB-01/06；T8-2 实现 `compaction-cost`（A 口径）；**T9 已被 T8-2 吸收，不再排期**。

## 已知风险（当前无）

- T8-1 已修复 ROB-01/06：回注失败不再永久停写，改为“每次失败审计 + 连续 N 次降级一个周期 + 下一周期自愈”，`reinjection-recovered` 可审计。

## 已知偏差（已接受）

T4 回注时点：checkpoint→end 之间不可实现，改为 end 后首个 microtask（同 tick、下一轮前）；用户已接受，`DEC-PLUGIN-20261025-09`。

M1 成本“前后水位未知”原按降级接受，2026-10-25 复查为插件侧可修（tokenMeter 读取时机），转 `REQ-20261025-03`；**若 M1.2 证实 `ctx.compaction` 可得，回注时点偏差有复查机会**。

## 等待用户/外部

- **真插件安装**：已完成结构安装（junction 指向源码，改完重启即生效）；开发不重启。
- M1.1：已推 00 派开发；**F1 口径已于 2026-10-25 修订**（判定“模型下一次看到折叠后内容”，允许宿主 replace+shadow 协议），并新增 B2「宿主 pruner 差异表」。
- M1.2（`REQ-20261025-03`）：已出单，待 00 派开发；可与 M1.1 T1 并行。
- M2：M1.1 完成后评估。
- 暂存：GitHub 发布用的仓库地址与账号（发布前需要）。

## 阻塞

- 无（v0.1.10 重启验证由用户执行；只读演练需人工制造不可写根，开发不自行改动安装态）

## 下一步

1. 用户一次性重启 → 校验 `version=<package.json>`、`perception=event event-api=on`、`events=N` 随真实压缩增长、`audit: … rotations=…`。
2. 用户按 `docs/T7-只读降级人工验证.md` 跑一次只读演练（制造不可写根 → read-only → 恢复）。
3. S3 header 默认关闭；要启用需用户拍板改 `memoryHeader.enabled`。
4. 00 转用户验收 → 审核打包独立复核（版本三处已收敛为一处）。
5. M1 已结项；开发做 M1.1 T1（F1/F2/B1/B2 门禁）；F1 判定“模型下一次看到折叠后内容”，仅“仍看全文、只留审计”才停项。
6. 00 派 M1.2（`REQ-20261025-03`）：能力探测延时修正 + tokenMeter 延迟获取 + usage 兜底 + `cost-v1.1` 来源字段；同时给出 `ctx.compaction` 可用性结论。
7. M1.2 结论回来后：若 `ctx.compaction` 可得 → 评估修回注时点（P1）；M2 待 M1.1 完成后评估（优先 A 成本聚合、B S3 开关）。