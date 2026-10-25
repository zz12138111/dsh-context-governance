# DSH 插件开发 · 当前状态

> 只放"现在还活着"的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-25（**0.1.13 离线完成**：batch 判据收窄 + `get.compaction(strict=false)` 归因，189/189；0.1.12 已于 20:34:54 加载，20:46 首次真实手动压缩已验证 `cost-v1.2`）

## 在办

| 会话 | 当前任务 | 状态 |
|---|---|---|
| 需求 | M1.1 T2′ 完成（0.1.12）；M1.2 冻结 0.1.11；0.1.13 已出单并离线完成；**0.1.14 已出单**（batch 比例同源修正：P2 + P3① + P3②）；M2 待真实压缩验证后评估 | 已出单 |
| 开发 | **0.1.13 离线完成**（batch 判据收窄 + strict=false 归因）；0.1.12 已加载并完成首次真实手动压缩验证；未安装/未重启/未 push | 待审核 |
| 审核打包 | 0.1.12 复核已出：0 阻断 / 0 P2 / 6 P3；**0.1.13 待复核** | 待复核 |

## 进度

- **T1（E1/E2）**：通过。事件级感知、摘要可读、无拦截型前钩子。
- **T2（记忆）**：完成。`packages/dsh-context-governance/`；`mem_write`/`mem_query`。
- **T3（压缩适配与保护）**：离线完成。适配器/自检/保护校验/降级/观测循环；文档 `docs/T3-压缩适配与保护.md`；审计 `analysis/t3/`。
- **T4（压缩前固化与回注）**：离线完成（S4=B）。5 类保护项同步 journal、end 后 microtask 回注、失败降级、audit；文档 `docs/T4-压缩前固化与回注.md`。
- **T5（状态命令与审计）**：离线完成。`/cg status`（后端/能力/记忆/上次压缩与回注/p50p95/审计）；审计字段白名单 + 脱敏；文档 `docs/T5-状态命令与审计.md`。
- **T6（失败与降级）**：离线完成（v0.1.4）。审计 8 MiB 轮转（可配）、五类只读判据 + 恢复探测、事件流中断/卸载留痕、所有失败只 log/audit 不抛宿主；文档 `docs/T6-失败与降级.md`。
- **T7（验收场景）**：离线完成（v0.1.5）。S1–S6 全部用例 + S4 A/M/I/F/AUD/R；真实**自动+手动**压缩双样本脱敏回放；只读人工脚本 `docs/T7-只读降级人工验证.md`；覆盖表 `docs/T7-验收场景-S1-S6.md`。
- **T8（回注自愈 + 成本归属）**：离线完成。ROB-01/06 改为“每次失败留审计、连续 N 次才降级、降级仍可回注、下一周期自愈”；新增 `compaction-cost` 审计（REQUIREMENTS A 字段，token 实测/估算分列，不记金额）；三轮复核后 fixture 改结构白名单、commands 晚挂载重试、shadowedRange 兜底；四轮复核接入 `reinjection.maxFailures` 配置、成本 `backend` 维度与口径修正；文档 `docs/T8-回注自愈与成本归属.md`、`docs/T8-复核三轮修复.md`。
- **M1.2（探测修正与成本实测，v0.1.11）**：离线完成。能力探测改 `capability@apply` + 首个会话事件后 `capability@ready`（诊断 + audit，只记类型）；`tokenMeter` 不走硬 inject，改为可选注入 + 按需获取（成功才缓存）；`assistant/message.usage` 兜底，新增 `tokensBefore/AfterSource`（tokenMeter/usage/none）与可选 parts，`auditVersion=cost-v1.1`（只增字段）；`/cg status` 显示 `last-cost`；`ctx.compaction` 真机更正为“**本部署插件 scope 不可见**”（`@apply`/`@ready` 均 `get.compaction=absent`），插件不依赖它。记录 `analysis/t1/M1.2-探测修正与成本实测.md`。
- **M1.1 T1（门禁）**：**通过**。F1 能（`tools/post-execute` 在 `tool/result` append 前替换；宿主 pruner 的 replace+shadow 也被下一请求消费）；F2 能（tokenGuard 默认只 `pwsh`；跳过 `[token-guard]`/`[cg-fold]`/spill notice/pruner 痕迹）；B1 已采（87 回合/1,819 步/2,218 调用；开发会话名单内候选 0，宿主 pruner 已折 8 条 `read`）；B2 差异表已出——T2 应「复用宿主协议 + 只做增量」。记录 `analysis/t1/T1-门禁记录.md`。
- **M1.1 收口（2026-10-25，T2=A）**：B2 显示宿主 pruner 在压缩点已覆盖全部 >8k；49 会话统计白名单可折上限仅 15.3%，红线 `pwsh`+`read` 占 71.0% → **不做早折、不做 spill、不做批量测量**；M1.1 改为只做 **T2′ prune 观测与成本接入**（`compaction-cost` 增 `tokensPruned`/`pruneCount`/`pruneTools`，`auditVersion=cost-v1.2`）；**0.1.12 = T2′ + 0.1.11 复核 6 条 P3**。范围变更已改单：`REQUIREMENTS.md` REQ-20261025-02、`TASKS/REQ-20261025-02-M1.1-拆解.md`；账本 `DEC-20261025-37`/`ART-20261025-19`、`DEC-20261025-38`/`ART-20261025-20`。
- **M1.1 T2′（v0.1.12）**：离线完成，只读观测宿主 `compaction/prune`：`prune-observed`（工具名按替换 `callId` 反查 `tool/call`，未知记 `unknown`；同 `shadowedRange` 去重；`cycle=current/outside`）；`compaction-cost` 增 `tokensPruned`(measured/null)/`pruneCount`/`pruneTools`(top5)，`auditVersion=cost-v1.2`；`/cg status [last-cost]` 显示 `pruned=<tokens> tools=<top5>`。生产代码零折叠/spill，T1 实验只在 `analysis/t1/`。记录 `analysis/t2prime/T2prime-交付记录.md`。
- **0.1.12 P3 收口（6 条）**：P3-1 `ctx.inject` 返回 Fiber → `stop()` 调 `fiber.dispose()`（修实现）；P3-2 T5 文档同步 `last-cost`；P3-3 T8 文档 `cost-v1.2`；P3-4/5 文档写明成本行延迟；P3-6 读方按 `cost-v1` 前缀匹配 + 测试。另 3 条（tokenGuard 源码不可复核、baseline 时间闸、其余小项）不改。
- **测试**：全量 **189/189 通过**（`node --test "test/*.test.mjs"`；T2′ 5 条 prune + P3-1 Fiber 1 条；**0.1.13 新增 6 条**：JSON 反例 skip、`8000/1500` 正例、关键字-only skip+reason、日期/助手正文、strict=false 三态、`protection-skip` 审计落盘）。
- **真机**：已安装（deps 14 / bundles 17 / redirect 0.1.0-context-zip / junction 已建）。v0.1.6 已验证工具/感知/审计；**v0.1.12 已于 20:34:54 加载**，20:46 首次真实手动压缩已验证 `auditVersion=cost-v1.2`（`tokensBefore=407146`/`tokensAfter=3525`、`tokensPruned=null`、`pruneCount=0`——手动 `compactNow` 不调 pruner）；**`prune-observed` 正路径仍未验**，需自动压力/溢出压缩（0.1.13 未安装，等审后统一重启）。
- **T6/T7/T8**：均离线完成；真机验收项列在“下一步”。
- **T8/T9**：T8-1 修 ROB-01/06；T8-2 实现 `compaction-cost`（A 口径）；**T9 已被 T8-2 吸收，不再排期**。

## 已知风险（当前无代码风险）

- T8-1 已修复 ROB-01/06：回注失败不再永久停写，改为“每次失败审计 + 连续 N 次降级一个周期 + 下一周期自愈”，`reinjection-recovered` 可审计。
- M1.1 早折已取消；若日后重启，须先有 spill + 权限 + TTL，再谈折叠。

## 已知偏差（已接受）

T4 回注时点：checkpoint→end 之间不可实现，改为 end 后首个 microtask（同 tick、下一轮前）；用户已接受，`DEC-PLUGIN-20261025-09`。

M1 成本“前后水位未知”原按降级接受，2026-10-25 复查为插件侧可修（tokenMeter 读取时机），已由 M1.2 修（v0.1.11，离线 183/183）。**`ctx.compaction` 真机纠正（2026-10-25 20:34/20:35）**：`capability@apply` 与 `capability@ready` 的 `get.compaction` **均为 absent** → 本部署插件 scope 拿不到 `ctx.compaction`；插件不依赖它（压缩观测走 `session/event` 的 `compaction/start|summary|end`），**“回注时点可修”的 P1 前提不成立**。能力探测只看 `get.X` 列；裸属性 `throws` 不代表服务异常（反例：`tokenMeter=throws` 同时 `get.tokenMeter=obj`）。

## 等待用户/外部

- **真插件安装**：已完成结构安装（junction 指向源码，改完重启即生效）；开发不重启。
- M1.1：T2′ 已离线完成（v0.1.12）；**审核复核已出（0 阻断/0 P2/6 P3）**；真机已于 20:34:54 加载、20:46 首次真实手动压缩验证 `cost-v1.2`。
- 0.1.13（REQ-20261025-04）：开发已交付（189/189，报告 `analysis/req-20261025-04/`），待审核复核；未安装/未重启。
- M1.2：离线完成（0.1.11 冻结）；已并入 0.1.12（已重启加载）。
- M2：真实压缩验证后评估。
- 暂存：GitHub 发布用的仓库地址与账号（发布前需要）。

## 阻塞

- 无（v0.1.12 已加载并完成首次真实手动压缩验证；0.1.13 待审；只读演练需人工制造不可写根，开发不自行改动安装态）

## 下一步

1. 0.1.12 真机：20:46 首次真实手动压缩已验证 `cost-v1.2`（`tokensBefore/After` 非 null、`tokensPruned=null`/`pruneCount=0`）与 `/cg status` 的 `pruned=0 tools=-`；**`prune-observed` 只有自动压力/溢出压缩才出现**（宿主 `compactNow` 不调 pruner，与审核结论一致），等自然触发或审核离线回放，不催用户压缩。
2. 用户按 `docs/T7-只读降级人工验证.md` 跑一次只读演练（制造不可写根 → read-only → 恢复）。
3. S3 header 默认关闭；要启用需用户拍板改 `memoryHeader.enabled`。
4. 审核打包独立复核 **0.1.13**（batch 判据收窄 + `get.compaction` 归因）；0.1.12 复核已出（0 阻断/0 P2/6 P3），00 转用户验收。
5. T2′ 已实现；审核复核时**必须核对“生产代码无折叠”**（`packages/` 内无 fold/spill/`[cg-fold]`/`fold.*`；证据 `analysis/t2prime/zero-fold-grep.txt`）。
6. 重启验收后：`ctx.compaction` 在本部署仍不可得（apply/ready 的 `get.compaction` 均 absent），**不再按“可得”评估回注时点**；0.1.13 已实现 `ctx.get('compaction', false)`（`obj`=有 impl 未 active / `undefined`=本 scope 未提供 / 不支持=`unknown`），真机取值待重启后 `capability@apply` 行确认，再决定 P1 是否具备前提。M2 待 M1.2 验收后评估。
7. **0.1.13（`REQ-20261025-04`）**：batch 假阳性真修（只看用户/助手消息、`ratios=[]` → `skip`、补 `x/y` 回归）+ `get.compaction` strict=false 归因；不改折叠/回注、`auditVersion` 维持 `cost-v1.2`。**开发已交付**（189/189；报告 `analysis/req-20261025-04/`），待审核复核；未安装/未重启/未 push。
8. **0.1.14（`REQ-20261025-05`）**：batch 比例**同源修正**——P2 比例须同消息带批次语义（默认只取 `user/message`）、P3① `YYYY/MM` 排除、P3② 正文比例不被 `stripStructuredPayload` 吞；判据原则**宁可 skip 不可 fail**；验收必须真实快照 A/B（`0.1.12 seq=11479`、`0.1.13 seq=11453` 两例均不得再 fail）。P3③/④/⑤ 不纳入。