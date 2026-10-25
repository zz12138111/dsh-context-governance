# DSH 插件开发 · 当前状态

> 只放"现在还活着"的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-25 22:4x（**0.1.14 已加载**：batch 同消息绑定 + 日期排除 + 正文比例保留，196/196；真机 `get.compaction(strict=false)=undefined` 已实测结案；0.1.12 手动压缩验证 `cost-v1.2`）

## 在办

| 会话 | 当前任务 | 状态 |
|---|---|---|
| 需求 | M1.1 T2′ 完成（0.1.12）；M1.2 冻结 0.1.11；0.1.13 已出单并离线完成；0.1.14 已出单并**开发已交付**（batch 比例同源修正：P2 + P3① + P3②，依 `DEC-20261025-46`）；M2 待真实压缩验证后评估 | 0.1.14 待复核 |
| 开发 | **0.1.14 已加载**（batch 同消息绑定 + 日期排除 + 正文比例保留；junction 指向源码，21:18 重启生效，非开发执行）；0.1.12 已完成首次真实手动压缩验证；未 push | 待审核 |
| 审核打包 | 0.1.12 复核已出：0 阻断 / 0 P2 / 6 P3；0.1.13 复核已出（0 阻断）；**0.1.14 待复核** | 待复核 |

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
- **测试**：全量 **196/196 通过**（`node --test "test/*.test.mjs"`；0.1.13 为 189；**0.1.14 新增 7 条**：`2/6`/`183/183`/仅`8000/1500` 三种 skip+reason、`批次 8000/1500` 正例、`2026/10` 日期排除、`{511/958}` 保留、`protection-skip(no-batch-semantics)` 审计且无 `manual-compaction-loss`）。
- **真机**：已安装（deps 14 / bundles 17 / redirect 0.1.0-context-zip / junction 已建）。v0.1.6 已验证工具/感知/审计；**v0.1.14 已于 21:18 重启加载**（`governance capability@apply version=0.1.14`、`get.compaction(strict=false)=undefined`）；v0.1.12 于 20:46 首次真实手动压缩验证 `auditVersion=cost-v1.2`（`tokensBefore=407146`/`tokensAfter=3525`、`tokensPruned=null`、`pruneCount=0`——手动 `compactNow` 不调 pruner）；**`prune-observed` 正路径仍未验**，需自动压力/溢出压缩。
- **T6/T7/T8**：均离线完成；真机验收项列在“下一步”。
- **T8/T9**：T8-1 修 ROB-01/06；T8-2 实现 `compaction-cost`（A 口径）；**T9 已被 T8-2 吸收，不再排期**。

## 已知风险（当前无代码风险）

- T8-1 已修复 ROB-01/06：回注失败不再永久停写，改为“每次失败审计 + 连续 N 次降级一个周期 + 下一周期自愈”，`reinjection-recovered` 可审计。
- M1.1 早折已取消；若日后重启，须先有 spill + 权限 + TTL，再谈折叠。

## 已知偏差（已接受）

T4 回注时点：checkpoint→end 之间不可实现，改为 end 后首个 microtask（同 tick、下一轮前）；用户已接受，`DEC-PLUGIN-20261025-09`。

M1 成本“前后水位未知”原按降级接受，2026-10-25 复查为插件侧可修（tokenMeter 读取时机），已由 M1.2 修（v0.1.11，离线 183/183）。**`ctx.compaction` 已结案（2026-10-25）**：`get.compaction(strict=false)` 在 `@apply` 13:18:10Z / `@ready` 13:18:23Z **均 `undefined`** → 本部署插件 scope **未提供**该服务（有 impl 未 active 会返回 `obj`）；**根因 = agent preset 用 `cordis:group` + `isolate: { compaction: true, toolResultPruner: true }` 把服务隔离在 preset 组内**（`@local/dsh-computer-use/presets/cordis.patch.yml`，三套 preset 一致；见 DEC-32），不是挂载时机；插件不依赖它（走 `session/event`），**「回注时点修正」在该部署下不可行**，只能走事件时序推断（现方案），不再是待查项。能力探测只看 `get.X` 列；裸属性 `throws` 不代表服务异常（反例：`tokenMeter=throws` 同时 `get.tokenMeter=obj`）。

## 等待用户/外部

- **真插件安装**：已完成结构安装（junction 指向源码，改完重启即生效）；开发不重启。
- M1.1：T2′ 已离线完成（v0.1.12）；**审核复核已出（0 阻断/0 P2/6 P3）**；真机已于 20:34:54 加载、20:46 首次真实手动压缩验证 `cost-v1.2`。
- 0.1.13（REQ-20261025-04）：开发已交付（189/189，报告 `analysis/req-20261025-04/`）；0.1.14 已覆盖其 batch 判据（不改 `get.compaction` 归因）。
- 0.1.14（REQ-20261025-05）：开发已交付（196/196，报告 `analysis/req-20261025-05/`，含真实快照 A/B 三列对照）；**已于 21:18 重启加载**，待审核复核。
- M1.2：离线完成（0.1.11 冻结）；已并入 0.1.12（已重启加载）。
- **M1 收尾（2026-10-25）**：架构升至 **v1.1**（事实回写：preset 阈值≈67.85%/patch 无效、`tokenMeter`=chars/4 估算、`ctx.compaction` 本 scope 不可得、工具输出折叠取消）；`REQ-20261025-01` 改结项口径（双后端=事件级、成本 source 写明、rc.3、结项说明+四条边界）；v1.0 标历史。
- **M2 需求草案 v0.6**：`docs/M2-需求草案-v0.6.md`（`research` 默认 `compact.early=false`；`estimateSafety` 改注释式警告；`/cg cost` 假设行置顶；新增“可关闭”验收）；**使用说明草案 v0.2** `docs/M2-使用说明-草案-v0.2.md`（新增“压完还是觉得贵”FAQ、长 turn 表述、research 说明）；v0.1–v0.5 保留作对照；**待评审复核**。
- 暂存：GitHub 发布用的仓库地址与账号（发布前需要）。

## 阻塞

- 无（v0.1.14 已加载；0.1.14 待审；只读演练需人工制造不可写根，开发不自行改动安装态）

## 下一步

1. 0.1.12 真机：20:46 首次真实手动压缩已验证 `cost-v1.2`（`tokensBefore/After` 非 null、`tokensPruned=null`/`pruneCount=0`）与 `/cg status` 的 `pruned=0 tools=-`；**`prune-observed` 只有自动压力/溢出压缩才出现**（宿主 `compactNow` 不调 pruner，与审核结论一致），等自然触发或审核离线回放，不催用户压缩。
2. 用户按 `docs/T7-只读降级人工验证.md` 跑一次只读演练（制造不可写根 → read-only → 恢复）。
3. S3 header 默认关闭；要启用需用户拍板改 `memoryHeader.enabled`。
4. 审核打包独立复核 **0.1.14**（batch 同消息绑定 + 日期排除 + 正文比例保留；真实快照 A/B）；0.1.12/0.1.13 复核已出（0 阻断），00 转用户验收。
5. T2′ 已实现；审核复核时**必须核对“生产代码无折叠”**（`packages/` 内无 fold/spill/`[cg-fold]`/`fold.*`；证据 `analysis/t2prime/zero-fold-grep.txt`）。
6. **`ctx.compaction` 已结案**：`get.compaction(strict=false)` 在 `@apply`(13:18:10Z) 与 `@ready`(13:18:23Z) 均 `undefined` → 本部署未提供该服务 → **「回注时点修正」不可行**，不再作为 P1 待查前提；`get.tokenMeter=obj` 稳定，M1.2 延迟获取无问题。M2 待 M1.2 验收后评估。
7. **0.1.13（`REQ-20261025-04`）**：batch 假阳性真修（只看用户/助手消息、`ratios=[]` → `skip`、补 `x/y` 回归）+ `get.compaction` strict=false 归因；不改折叠/回注、`auditVersion` 维持 `cost-v1.2`。**已交付 + 复核已出（0 阻断）**（189/189；报告 `analysis/req-20261025-04/`）；其 batch 判据已被 0.1.14 取代。
8. **0.1.14（`REQ-20261025-05`）**：batch 比例**同源修正**——P2 严格同消息绑定（`user`/`assistant` 正文都须带 `批次|进度|progress|batch` 关键字，无关键字 → `skip(no-batch-semantics)`，依 `DEC-20261025-46`）、P3① `YYYY/MM`（19xx/20xx + 1–12）排除、P3② 正文比例不被 `stripStructuredPayload` 吞（只剥含引号/冒号的 JSON 块）；验收四例逐一 + 三列对照（含“无关键字 → 必须 skip”反例）。P3③/④/⑤ 不纳入。**开发已交付**（196/196；报告 `analysis/req-20261025-05/`，真实快照 `snapshot-11509.json` + `replay-real.mjs`）；**已于 21:18 重启加载**，待审核复核；未 push。