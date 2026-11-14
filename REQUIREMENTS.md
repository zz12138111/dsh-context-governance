# DSH 插件开发 · 需求

> 由「需求」会话维护；用户直接提需求也可以。一条需求一个编号 `REQ-YYYYMMDD-NN`。
> 每条要能让开发直接开工：目标 / 边界 / 验收标准 / 依赖 / 优先级。

## 需求模板

```
## REQ-YYYYMMDD-01 插件名 —— 一句话目标
- 背景/痛点：
- 目标（可验收）：
- 边界（不做什么）：
- 验收标准：① … ② … ③ …
- 依赖/风险：
- 优先级：P0/P1/P2
- 状态：待评估 / 已排期 / 开发中 / 待审核 / 已交付（· 待复核 / · 已复核） / 已验收 / 挂起
```

---

## REQ-20261025-01 上下文治理插件 M1 —— 压缩前后不断线

- **依据**：`docs/上下文治理插件-架构说明-v1.1.md`
- **背景/痛点**：长会话压缩后，任务状态、决策、批次进度容易丢失；已定的事被重问；换会话或定时唤醒接不上。M1 先解决“不断线”，不追求省 token。
- **目标（可验收）**：
  1. 单插件、对宿主零硬依赖；**经官方跨 isolate 访问器（`agentPresets.serviceFor(agent,'compaction')`）取用宿主当前 active 压缩引擎并主动触发压缩**（provider 级）：宿主原装 `compaction-basic` 与 context-zip redirect **两种后端形态下同一条取用路径均成立**——运行时只有一个 active engine，不是双引擎（见验收 ⑤）。
  2. 压缩、换会话、唤醒后，任务态（目标、待办、最近决定、关键约束）能自动恢复。
  3. 压缩保护按 S4=B：压缩前先把受保护内容写进记忆（标题+指针）；压缩结束（`compaction/end` 发布后首个 microtask、下一次模型调用前）从记忆回注；自动压缩下 5 类受保护内容 0 丢失；手动压缩允许原文丢失，但必须有记忆指针、audit 显式告警、回注后能看出最后一句。
  4. 回注只放记忆 ID/状态/指针，详情留记忆，不产生第二段摘要。
  5. 失败显式、可回退，不静默降级。
- **边界（不做什么）**：
  - 不接 billion-context（ACP）；
  - 不做工具输出折叠（原放 M1.1，2026-10-25 取消，改为宿主 prune 观测）；
  - 不做工具隐藏、用户脚本、数据库/向量检索、宽版本兼容、领域包；
  - 不改 DSH、不接管会话、不保存原始对话；
  - M1 不做 LLM 自动抽取，只做“模型显式写入 + 已有结构化状态同步”。
- **验收标准**：
  - ① **会话接续**：新会话/唤醒注入小 header（目标、待办、最近决定、关键约束），有 token 预算；不拉整段历史。
  - ② **记忆写作**：模型调用记忆写入工具后，条目包含 `id/type/status/project/source/writer/confidence`；高风险项为 `proposed`；来源可追溯。
  - ③ **压缩保护（S4=B）**：压缩前把受保护内容写进记忆（标题+指针）；压缩结束（`compaction/end` 发布后首个 microtask、同一 tick、下一次模型调用前）从记忆回注；字面“checkpoint 后、end 前”需替换压缩 provider，M1 不做。自动压缩：5 类受保护内容（最新用户消息/规则注入/工具配对/批次 STATE/回滚点映射）0 丢失；手动压缩：允许原文丢失（宿主仅保留最后 1 个 surface 节点，治理层无否决权），但必须满足记忆有指针、audit 有显式告警、回注后调用方能看出“最后一句是什么”；任何“写不进/注不进”必须有 audit，不允许静默。
  - ④ **回注行为**：只含 ID + 状态 + 指针；摘要可读时按覆盖判断是否补一行标题；摘要不可读时仅 ID+状态；摘要与记忆冲突时记忆赢；详情可通过记忆工具找回。
  - ⑤ **双后端（provider 级）**（2026-10-26 口径升级：M1 结项按当时「事件级」已结，本条自 1.0 起按 provider 级执行）：**根 scope `ctx.get('compaction')` 与 `agent.ctx.get('compaction')` 不可得属宿主设计**（`isolate.compaction=true`；`DEC-20261025-48` 不改 isolate）；取用走**官方跨 isolate 访问器 `agentPresets.serviceFor(agent,'compaction')`**，返回当前 active engine（默认 desktop = `ContextZipEngine`，redirect 接管 `compaction-basic`；无 redirect = `BasicCompactionEngine`）。**两种后端形态共用同一条取用路径**，取到后调 `compactNow` 触发压缩；**不自造引擎、不替换后端、不接管 provider 选择**；没装 context-zip 时自动用宿主默认。`REQ-20261025-03` 结案的是「根 scope `get.compaction` 不可得」，**不等于「取不到引擎」**；桌面默认部署的真机触发见 0.2.2 验收。
  - ⑥ **失败与降级**：记忆写失败 → 重试一次，仍失败跳过本次压缩并告警；压缩失败 → 回退宿主默认；配置非法 → 插件不加载、DSH 正常；摘要/范围/产物都不可见 → 该后端只读。
  - ⑦ **状态与审计**：状态命令（暂名 `/cg status`）显示后端、能力、记忆条数、上次压缩、上次回注、降级项；审计含后端、压缩前后、成本归属（字段见下）、回注被吞/重复、失败。

**成本归属字段（A：M1 定义，只做 Token 归属，不做货币成本）**

- **主键**：`compactionId`（一个压缩周期一条记录）。
- **维度**：`sessionId`、`project`、`backend`、`model`（`provider/model`）、`trigger`（auto/manual）、`occurredAt`。
- **数值**：`tokensBefore`、`tokensAfter`、`tokensShadowed`、`tokensSummary`、`tokensInjected`、`injectedEntries`、`tokensDropped`。
- **口径**：`backendUsage`（压缩事件 usage）；`backendCostSource` / `governanceCostSource`（`measured` / `estimated` / `unknown`）；`estimateMethod`；`auditVersion`。
- **对齐宿主**：`tokensBefore/After` 用宿主 `tokenMeter`（**估算，chars/4，系统性偏低**）或压缩事件；`backendUsage`/`tokensSummary` 用压缩事件 usage（**实测**）；`tokensInjected` 优先用宿主 tokenMeter，取不到则按字符估算并标 `estimated`；`tokensDropped` 来自 `reinjection-shadowed`；**实测（`usage`）与估算（`tokenMeter`/chars-4）分开存、不混算**。M1.2 起每个数值带 `*Source`（`tokenMeter`/`usage`/`none`）。
- **说明**：M1 只记 token 归属，不记金额；金额可由路由单价另行换算。
- **前置门禁（不是验收项）**：
  - **E1**：至少达到“状态级”感知；
  - **E2**：选出默认回注形态；
  - 两项通过才进 M1 验收。
- **验收场景（建议）**：
  - S1：长任务中产生决定 + 未完成待办 → 压缩 → 下一轮继续，不重问；
  - S2：批次进度（如 511/958）→ 压缩 → 接着跑；
  - S3：偏好（如命名规则）→ 新会话同项目 → header 带上；
  - S4：受保护 5 类（最新用户消息/规则注入/工具配对/批次 STATE/回滚点映射）自动压缩 0 丢失；回注时序 = `compaction/end` 发布后首个 microtask（同一 tick、下一次模型调用前）；字面“checkpoint 后、end 前”需替换压缩 provider，M1 不做；手动压缩按 S4=B：预写记忆指针、audit 显式告警、回注能看出最后一句；写不进/注不进必须 audit。
  - S5：摘要不可读 → 只回注 ID+状态；
  - S6：后端不可用 / 配置非法 → 回退或插件不加载，DSH 正常。
- **依赖/风险**：
  - DSH 当前版本（`0.2.1-rc.3`）、context-zip 当前版本、Schemastery；
  - E1/E2 可能发现 context-zip 只有状态级感知或摘要不可读，按降级阶梯处理；
  - 记忆单写者只保证进程内，跨进程不承诺。
- **优先级**：P0
- **状态**：**已结项**（M1 主体 v0.1.10；后续 0.1.11–0.1.14 为探测/成本/判据修正，均属 M1 收尾，不改本单范围）

### 任务拆解

见 `TASKS/REQ-20261025-01-M1-拆解.md`。

**T9 已被 T8-2 吸收，不再待排期**：T8-1 已修 ROB-01/06；T8-2 已实现成本归属（A 口径，`compaction-cost` 审计，token 实测/估算分列，不记金额）。M1 成本归属无待办；若后续做跨周期聚合/货币成本，另立 M2 增强，不复用 T9。

**结项说明（2026-10-25，事实口径）**：M1 以 **v0.1.10** 结项；0.1.11 修成本实测（`tokenMeter` 延迟获取 + `usage` 兜底 + `*Source`）、0.1.12 加宿主 prune 观测、0.1.13/0.1.14 修 batch 判据。**已知边界**：① provider 路径不可得（`ctx.compaction` 本 scope 未提供，`strict=false → undefined`）；② 手动压缩吞最新用户消息（宿主行为，S4=B 已接住）；③ 金额不可得；④ `tokenMeter` 是 chars/4 估算，样本低估约 28%，只能当估算来源。

---

## REQ-20261025-02 上下文治理插件 M1.1 —— 宿主 prune 观测（已收口）

- **依据**：`docs/上下文治理插件-架构说明-v1.1.md` §16.3；M1 `REQ-20261025-01`；`docs/M1-可行性复查-20261025.md`；账本 `DEC-20261025-37` / `ART-20261025-19`
- **优先级**：P1
- **状态**：**已收口**（2026-10-25 用户拍板 T2=A），T2′ 出 **0.1.12**（`0.1.11` 冻结为 M1.2，两份复核基线分开钉 hash）；**0.1.12 = T2′ + 0.1.11 复核 6 条 P3**。原「工具输出折叠 + 批量测量」范围**取消**，只保留宿主 prune 观测。
- **范围变更（2026-10-25）**：
  - **保留**：T1 门禁结论（F1/F2/B1/B2）、宿主 pruner 差异表、实验脚本与证据（`analysis/t1/`）。
  - **取消**：早折（自建 seam / 折叠格式 / `[cg-fold]`）、spill 落盘与原生 `read` 回读、`fold.*` 配置、批量测量与隐藏 A/B、T6 全量测量。
  - **改为**：只观测宿主 pruner 折了哪些工具、省了多少 token，并接入成本视图。
  - **原因**：宿主 `tool-result-pruner` 已在压缩点覆盖全部 >8192；红线工具 `pwsh`+`read` 占工具输出 **71.0%** 且永不折；白名单可折上限仅约 **15.3%**，其中最大一块 `web_fetch` 折后易触发重抓，净收益未证（B1 也未测出）。
- **背景/痛点**：M1 解决“不断线”；M1.1 原本想省“进入量”，但实测证明大头在宿主已折、或我们红线不折的部分。真正缺的是**可见性**：宿主折了哪些工具、省了多少 token，目前无人记账。
- **目标（可验收，收口版）**：
  1. 观测宿主 prune：每次 `compaction/prune` 留可归因记录（工具名、阴影范围、`shadowedTokenCount`、关联替换事件）。
  2. 接进成本视图：`compaction-cost` 增加本轮 `tokensPruned` / `pruneCount` / `pruneTools`，`/cg status` 可查。
  3. 不改变任何模型可见内容：不折、不改 content、不写 spill。
  4. 不干扰 M1 的 S4、回注、审计、降级。
- **边界（不做什么）**：
  - **不折叠任何工具结果**（含白名单）、**不写 spill**、**不新增 `cg_read`**；
  - 不动宿主 pruner 配置（阈值/头尾保持默认），不替换、不禁用；
  - 不做批量测量与隐藏 A/B；不承诺收益；
  - 生产代码零折叠：T1 折叠实验代码只留 `analysis/t1/`，**不进 `packages/`、不进发布包、不提供开关**；
  - 不接 ACP、不做数据库、不做宽兼容。
- **门禁结论（2026-10-25，已通过，不再重跑）**：
  - **F1 = 通过**：折叠能在“模型下一次请求消费前”生效。两条路径均实测——① `tools/post-execute` 内容替换（grep 49,932 字符 → 入史即折，spill 74,075 B；web_fetch 7 例）；② 宿主 `session.append` 替换 + `compaction/prune` 影子定价（8 例 `read` 19,153→5,159；下一次请求 prompt 791,339→24,006）。原“进入历史前”字面口径作废（会把宿主官方协议误判为失败）。
  - **F2 = 通过**：tokenGuard 只管 `pwsh`、不重叠；五类 marker 均跳过；`fold-probe` 21/21。
  - **B1 = 产出**：`analysis/t1/data/b1-baseline.json`（步/回合、调用/步、prompt token）。
  - **B2 = 产出**：8 维差异表，结论“复用宿主协议、不自研”；但宿主已在压缩点全折，对齐时机增量≈0 → 收口。
- **观测口径（实现约束）**：
  - 事件：宿主 `compaction/prune`（`shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`）+ 紧随的替换 `tool/result`（`sourceEventSeqs` 引用原事件）。
  - 归因：用替换事件的 `callId` 反查 `tool/call` 得工具名；反查不到记 `unknown`，**不猜**。
  - 归属周期：上次 `compaction/end` 之后、本次 `compaction/summary` 之前的 prune 计入本周期（`cycle=current`）；其余记 `outside`，只进会话累计。
  - 只记：`seq`、`shadowedStart/End`、`shadowedTokenCount`、`tool`、`replacementSeq`；**不记内容、不记路径**。
  - 去重：同一 `shadowedRange` 只记一次。
  - 成本聚合：`tokensPruned`（`measured`）+ `pruneCount` + `pruneTools`（top5 `name:count`），`auditVersion=cost-v1.2`（只增字段，不改 v1.1 语义）。
- **配置默认值**：**不新增** `fold.*` / `batch.*` 配置项；既有 `reinjection.*`、审计轮转等 M1 配置不变。
- **验收标准（收口版）**：
  - ① **观测生效**：每条宿主 prune 产生 `prune-observed` 审计，字段齐全、无内容/路径。
  - ② **成本接入**：本周期 `compaction-cost` 带 `tokensPruned` / `pruneCount` / `pruneTools`，`auditVersion=cost-v1.2`。
  - ③ **状态可查**：`/cg status` 含 `pruned=<tokens> tools=<top5>`；无 prune 时 `pruned=0`，不报错。
  - ④ **零副作用**：仓库与发布包内不存在 fold / spill / `[cg-fold]` / `fold.*`；不存在“默认关闭的折叠开关”。
  - ⑤ **不伪造**：无 pruner 环境时 `pruneCount=0` 且 `tokensPruned=null`（`unknown`），不估算。
  - ⑥ **M1 不回退**：S1–S6 回归通过；S4 手动压缩仍有 `protection-write` → `reinjection` → `compaction-cost`。
  - ⑦ **测试**：prune 归因、周期归属、去重、无 pruner 环境、脱敏五类用例。
  - ⑧ **P3 六项落地**：`stop()` 按 Fiber 正确处理（测试用真实形状）；`auditVersion` 读方兼容 `cost-v1.*`；T5/T8 文档与实现一致；延迟写行为有文档。
- **并入 0.1.12 的复核项（6 条，来自 0.1.11 复核：0 阻断 / 0 P2 / 9 P3）**：
  1. **P3-1 `ctx.inject` 清理失效**：`ctx.inject` 返回的是 cordis `Fiber` 类，不是 dispose 函数；`stop()` 里 `#meterDispose?.()` 会抛 TypeError 被吞（父 fiber 兜底，无实际危害）。按 Fiber 正确释放、或显式不释放并写明；测试用真实形状，不许 fake 函数掩盖。
  2. **P3-6 `auditVersion` 前缀匹配**：读方由精确 `cost-v1` 改为前缀匹配（`cost-v1` 兼容 `cost-v1.1`/`cost-v1.2`），文档同步。
  3. **P3-2 文档同步（T5）**：`docs/T5-状态命令与审计.md` 补 `/cg status last-cost` 与 `cost-v1.1`。
  4. **P3-3 文档同步（T8）**：`docs/T8-回注自愈与成本归属.md` 的 `cost-v1` 改 `cost-v1.1`。
  5. **P3-4 延迟写说明**：成本行延迟写 → `last-cost` 短暂旧值、audit 顺序变化；文档写清现象与预期。
  6. **P3-5 延迟写说明（after usage）**：首条 after 消息无 usage 时不再继续等；文档写清 `tokensAfter` 可能为 `null` 的时机。
  - **不进 0.1.12（留作证据局限）**：tokenGuard 源码行号不可复核、`baseline.mjs` 无时间闸、其余小项。
- **依赖/风险**：
  - 依赖宿主 pruner 事件形状（`compaction/prune` + `sourceEventSeqs`）；形状变化时降级为“只记 range/token、工具名 `unknown`”。
  - `compaction/prune` 是日志事件，插件只能观测不能干预——与“不做折叠”一致。
  - 若日后重启 B：须先有 spill + 权限 + TTL，再谈折叠，不复用实验代码。

### 任务拆解

见 `TASKS/REQ-20261025-02-M1.1-拆解.md`（收口版）；M1.1 已收口（T2=A），只留 T2′「prune 观测与成本接入」。

---

## REQ-20261025-03 上下文治理插件 M1.2 —— 探测修正与成本实测

- **依据**：M1 `REQ-20261025-01` 成本归属字段；`docs/M1-回顾与M2候选.md`；2026-10-25 可行性复查（宿主 asar 代码 + 真机会话日志）。
- **优先级**：P1
- **状态**：**已交付**（0.1.11 离线完成 **177/177**，`auditVersion=cost-v1.1`；已并入 0.1.12 交付。原：已排期（待 00 派开发；与 M1.1 T1 并行，不互斥））
- **背景/痛点**：M1 真机上 `tokensBefore/After` 恒 `null`、能力行 `compaction=absent`，此前按“宿主限制”接受。复查后分成两类：
  1. **确为插件侧问题**：`ctx.tokenMeter` 在 apply 时读一次并缓存（`runtime.js:189-195`），没走 `ctx.inject(['tokenMeter'], …)`；服务晚注册就永久为 `null`。宿主 `@deepseek-ai/dsh-token-meter` 由 `dsh-base` 默认挂载，确实存在。
  2. **不是探测时机问题，且已定性（2026-10-25 真机结案）**：`capability@apply`（20:34:54）与 `capability@ready`（20:35:54）两行都是 `compaction=throws`、`get.compaction=absent`；后续 `get.compaction(strict=false)` 在 `@apply`（13:18:10Z）与 `@ready`（13:18:23Z）**均返回 `undefined`** → **本部署插件 scope 根本没有提供 `compaction` 服务**（若“有 impl 未 active”会返回 `obj`）。**根因已定位**：preset 组 `isolate.compaction: true`（`dsh-web-app/presets/standard.patch.yml`），压缩服务被隔离在 preset scope。结论：插件不依赖它，压缩观测走 `session/event`；**「回注时点修正」在该部署下不可行**，只能走事件时序推断（现方案）。另：`get.tokenMeter=obj` 稳定，M1.2 延迟获取路径无问题。
  3. 兜底证据：真机会话日志中 `assistant/message` 1199/1199 带 `usage`（样本 `inputTokens=20662 / cacheReadTokens=2432 / totalTokens=23321`），压缩前后水位可实测。
- **目标（可验收）**：
  1. **成本实测**：`tokensBefore/After` 优先 `ctx.tokenMeter`（延迟注入或按需取，成功后缓存），失败退回 `assistant/message.usage`，仍取不到才 `null` + `unknown`。
  2. **探测修正**：能力探测由“apply 一次”改为「apply 记 `capability@apply` + 首个会话事件后补 `capability@ready`」两行审计，不得因时序把可用服务记成 absent。
  3. **口径可追**：新增 `tokensBeforeSource` / `tokensAfterSource`（`tokenMeter` / `usage` / `none`），`auditVersion` 升 `cost-v1.1`；**只增字段、不改已有字段语义**，旧解析器仍可用。
  4. **provider 结论（已结案，2026-10-25）**：本部署下 `get.compaction(strict=false)=undefined`（`@apply` 13:18:10Z / `@ready` 13:18:23Z 一致）→ **该 scope 未提供 `compaction` 服务**。因此 **「回注时点修正」在该部署下不可行**，只能走事件时序推断（现方案）——**这是结论，不是待查项**。本轮不改压缩后端、不替换 provider；若未来宿主或部署方式变化，重新探测即可，但不再作为 M2 的前置期待。
- **影响与定案（2026-10-25，`DEC-20261025-48`）**：**不改 `isolate.compaction`**（宿主 preset 作用域隔离，属设计行为）。理由：宿主压缩行为/压力阈值/审计时序均不变；`cordis provide` 同 scope key 重复注册会抛错（`@local/dsh-computer-use/presets/cordis.patch.yml` 有两处 compaction 组）；插件侧 `get.compaction` 变 `obj` 会使 mode 由 `event-level` 变 `full`（保护失败会进 `degraded-protection`）；收益≈0。**「回注时点修正」不可行，不再作为 M2 前置期待。** ~~M2 不依赖 provider~~ → **2026-10-26 口径升级（用户批准）**：M2 提前压**依赖** `agentPresets.serviceFor(agent,'compaction')` 取 active engine（官方跨 isolate 访问器）；`isolate` 仍不改，取用**不经过根 scope**；隔离 profile 只用于验证，不替代桌面真机。
- **边界（不做什么）**：
  - 不改回注逻辑、不改记忆、不做折叠（折叠已于 2026-10-25 取消）；
  - 不接 ACP、不做货币成本、不做跨周期聚合（留 M2）；
  - 不安装/不重启/不改已装插件与 profile；实验用隔离 profile 或只读方式，需要安装/重启先报 00 + 用户批准；
  - 不猜：取不到就 `null` + `unknown`，不许拿估算冒充实测。
- **口径定义**（写进文档）：
  - `tokensBefore` = 压缩前**最后一次模型调用**的上下文侧用量 = `inputTokens + cacheReadTokens + cacheWriteTokens`（取 checkpoint 之前最后一条 `assistant/message`）；
  - `tokensAfter` = `compaction/end` 之后**第一条** `assistant/message` 的同口径值；
  - 原始分量可选记 `tokensBeforeParts` / `tokensAfterParts`（input/cacheRead/cacheWrite），只放数字。
- **验收标准**：
  - ① 真机（或隔离 profile）上至少一条 `compaction-cost` 的 `tokensBefore/After` 非 null，且 `*Source` 与实际路径一致；
  - ② tokenMeter 不可用时 usage 兜底生效并标 `usage`；
  - ③ 两者都不可用时仍为 `null` + `none`，不伪造；
  - ④ 审计出现 `capability@apply` 与 `capability@ready` 两行，结论如实（本部署 `get.compaction=absent` 是正确结果，不算缺陷）；
  - ⑤ 单测覆盖：延迟注入生效、usage 兜底、全缺、来源字段、无正文/路径泄漏；
  - ⑥ 给出 `ctx.compaction` 可用性结论与证据路径（**已结案：`undefined` → 该 scope 未提供服务**）；口径记清——`get.X` 才是可用性信号，`X=throws` 只是访问路径表现（`tokenMeter=throws` 而 `get.tokenMeter=obj` 即反例）。
- **依赖/风险**：
  - 依赖本版 cordis 的服务注入语义（`ctx.inject` 已在本插件用于 `commands`）；若延迟注入不可用，退化为“按需读取 + 缓存成功值”；
  - `assistant/message.usage` 是每次调用的用量，不是“省下的 token”；只做水位，不冒充节省量；
  - 真机验证需一次重启（用户执行，开发不执行）。
- **成本归属字段**：沿用 M1 的 A 口径，字段不删不改；本单只补来源与实测路径。

### 任务拆解

见 `TASKS/REQ-20261025-03-M1.2-拆解.md`。

---

## REQ-20261025-04 上下文治理插件 0.1.13 —— batch 假阳性修复 + `get.compaction` 归因

- **依据**：0.1.12 复核 §11；用户 2026-10-25 拍板范围（只两件，不扩）；cordis `ctx.get(name, false)` strict=false 语义
- **优先级**：P1
- **状态**：**已交付**（0.1.13，**189/189**；复核 P2=1 已由 0.1.14 闭环（见 `REQ-20261025-05`），batch 判据另被 0.1.14 同源约束取代。原：已排期（待 00 派开发））
- **版本**：0.1.13；`auditVersion` 维持 `cost-v1.2`（本单不改口径）
- **背景/痛点**：
  1. **batch 识别是假阳性**：`protection.js` 用宽正则 `/批次|batch/i` + 日期比例判定，本次“通过”是因为命中了审计 JSON dump 里的 `"batch"` 字段，取不到 `x/y` → `ratios=[]` → `ratiosCovered([])` 恒为 true（`protection.js:396`）→ **空泛 pass**。等于没真正校验批次进度。
  2. **`get.compaction` 归因不足**：现在只知道 absent，分不清“有 impl 但未 active”还是“本 scope 未提供”。
- **目标（可验收）**：
  1. batch 识别**只从用户/助手消息正文**取进度数字；排除 `tool/*` 结果与 JSON 字段 `batch`；`ratios=[]` 判 **`skip`**，不得判 `pass`。
  2. 能力探测加 `ctx.get('compaction', false)`（strict=false）：`obj` = 有 impl 但未 active（可能被 redirect/未装载）；`undefined` = 本 scope 未提供；结论写进报告与文档。
- **边界（不做什么）**：
  - 不改折叠、不改回注、不改记忆；
  - 不改 `auditVersion`（维持 `cost-v1.2`）；
  - tokenMeter `chars/4` 估算**只文档化**，不改代码；
  - 不动 usage 兜底/延迟写路径（等真机自然触发）；
  - 不处理 0.1.12 的 6 条新 P3（继续 backlog）；
  - 不安装/不重启/不改 profile/不 push。
- **验收标准**：
  - ① **batch 收窄**：只在用户/助手消息正文取数；带 `x/y` 比例的样本能正确比对（真机样本或单测均可）。
  - ② **假阳性回归**：构造一条含 `"batch"` JSON 字段的 tool 结果，证明不再被当成批次进度；`ratios=[]` 时判 `skip`。
  - ③ **归因**：`ctx.get('compaction', false)` 的 `obj` / `undefined` 两种结论写清，报告与文档各一处；不支持 strict=false 时记 `unknown`，不猜。
  - ④ **不回归**：全量测试通过；S4/回注/成本路径不受影响。
- **依赖/风险**：
  - `ctx.get(name, false)` 需本版 cordis 支持；不支持则 `unknown`。
  - batch 进度形态多样（`8000/1500`、`511/958`、百分比）：**只认“数字/数字”的明确比例**，其余 `skip`；不猜格式。（**注**：此条为 0.1.13 历史口径，后续已被 `DEC-20261025-73` 收紧为“须带语义单位或 `[batch]`”，见 `REQ-20261025-10`。）
  - 收窄后可能从“假通过”变“真 skip”，属预期行为变化，需在报告里明确写出。

### 任务拆解

见 `TASKS/REQ-20261025-04-0.1.13-拆解.md`。

---

## REQ-20261025-05 上下文治理插件 0.1.14 —— batch 比例识别的同源修正

- **依据**：0.1.13 真实压缩验证与复核（P2、P3①、P3②）；用户 2026-10-25 拍板范围 A。
- **优先级**：P1
- **状态**：**已交付 · 已复核**（0.1.14，**196/196**；复核 P1=0 / P2=0 / P3=4，见 `docs/review-context-governance-0.1.14.md`。原：已排期（待 00 派开发））
- **版本**：0.1.14；`auditVersion` 维持 `cost-v1.2`
- **背景/痛点**（同一处判据的三个来源问题）：
  1. **P2（主）**：0.1.13 收窄后，`2/6`、`183/183` 这类**收口/测试计数**被当成批次进度 → 判 `fail`，写进 `manual-compaction-loss` **假阳性**（真机 `seq=11453 ratios=["2/6"] → fail`）。而 0.1.12 的 `ratios=[] → pass` 是另一个极端（空泛通过）。
  2. **P3①**：`YYYY/MM`（如 `2026/10`）单独出现会被当比例。
  3. **P3②**：`stripStructuredPayload` 会把 `{511/958}` 这类**正文里的比例**一并吞掉，候选丢失。
- **目标（可验收）**：
  1. **P2 严格同消息绑定（依 `DEC-20261025-46`）**：候选来源 = `user/message` 与 `assistant/message` 的**正文**；**无论 user 还是 assistant，都必须同一条消息内出现批次语义关键字**（`批次` / `进度` / `progress` / `batch`）才成为候选；**无关键字 → `skip(reason=no-batch-semantics)`**，不得判 pass/fail；跨消息拼凑不算。
  2. **P3① 日期排除**：`YYYY/MM` 形式中，**首段为 19xx/20xx、次段为 1–12** 时不算比例。
  3. **P3② 正文保留**：`stripStructuredPayload` **只剥“像 JSON 的 `{…}`/`[…]`”（含引号或冒号）**；`{511/958}` 这类正文内容保留，比例候选不丢。
- **边界（不做什么）**：
  - 不改折叠/回注/记忆；不改 `auditVersion`；
  - **不纳入 P3③**（助手正文噪声，随 P2 收敛即可）；
  - **不纳入 P3④**（`protection-0.1.12.js` 441 行源码副本会漂移 → 改为复核脚本按 commit 取源码，不在本单）；
  - **不纳入 P3⑤**（probe 名嵌 `=` 干扰切分）；
  - 不安装/不重启/不改 profile/不 push。
- **判据原则**：**宁可 `skip`，不可 `fail`**。`fail` 会触发 `manual-compaction-loss` 告警，误报代价高于漏报；无把握一律 `skip` 并写原因。
- **验收标准（硬要求：真实快照 A/B 复现，四例逐一给结果）**：
  - ① **A/B 两例都不得判 fail**：`0.1.12 seq=11479 ratios=[] → pass` 与 `0.1.13 seq=11453 ratios=["2/6"] → fail`，在 0.1.14 下**都不得再判 `fail`**，且**都不得写 `manual-compaction-loss`**。
  - ② **正例（已被 `DEC-20261025-73` 取代）**：原定「`批次 8000/1500`（无单位）→ 正确判 pass/fail」**作废**。新口径：比例须带语义单位（`项`/`条`/`个`/`文件`/`任务`/`完成`）或显式 `[batch]` 才算候选；正例改为「`批次 8000/1500 项完成`」或「`[batch] 8000/1500`」。原因：`8000/1500` 与测试数 `205/205` 形态不可区分。
  - ③ **反例（设计意图，扩展）**：用户消息只有 `8000/1500`、**无**批次关键字 → `skip`；**即使有关键字但无单位**（如「批次 8000/1500」）→ 也不成候选，`skip`。不得判 pass/fail。
  - ④ **日期**：`2026/10`（19xx/20xx + 1–12）不作为比例。
  - ⑤ **正文比例**：`{511/958}` 式正文候选被保留（不被 `stripStructuredPayload` 吞）。
  - ⑥ **可回溯**：`skip` 必带原因（如 `no-batch-semantics` / `date-like-ratio` / `no-ratio-in-user-messages`）。
  - ⑦ **不回归**：全量测试通过；S4/回注/成本路径不受影响。
  - ⑧ **报告**：给出上述样本 before/after 三列对照（0.1.12 / 0.1.13 / 0.1.14）。
- **依赖/风险**：
  - 真实快照取自 0.1.12/0.1.13 的审计与会话记录，**回放需隔离**，不碰本机安装态。
  - 规则继续收窄可能仍误伤（如技术计数 `a/b`）——按“宁可 skip 不可 fail”处理，不追求零 skip。

### 任务拆解

见 `TASKS/REQ-20261025-05-0.1.14-拆解.md`。

---

## REQ-20261025-06 上下文治理插件 M1.3 —— 原生后端验证（D1）

- **依据**：架构 v1.1 §6.3；`REQ-20261025-01` 验收 ⑤；E1/E2 记录（47 会话 / 16 次真实压缩：五段式 10、自由 6）；用户 2026-10-25 决策（允许新建隔离实例）。
- **优先级**：P1
- **状态**：**已交付 · 已复核**（0.1.15，**202/202**；D1-1 识别缺陷由 0.1.15 修并复核通过，复核 P1=0 / P2=0 / P3=5，见 `docs/review-context-governance-0.1.15.md`；D1-3 自动压缩未跑到 → backlog，不阻塞。原：已排期（待 00 派开发））
- **版本**：**D1-1 定为识别缺陷 → 出 0.1.15**（只改识别/展示与成本归因标注，不动功能路径）；D1-3 不补验，记 backlog。
- **验证结果（2026-10-25，`ART-20261025-44`）**：
  - **D1-5 隔离性：通过**（profile `native-test`、端口 18765、数据隔离 `.tmp/native-test-ws/`；桌面未动；实例已停）；
  - **D1-2 摘要形态：通过**（原生摘要 9,193 字符、五段标题命中 0 → `readable + free-form`；回注实际 seq=82 为“标题+指针+最后一句”）；
  - **D1-4 手动压缩：通过**（S4=B 三件套齐）；
  - **D1-1 后端识别：不通过**——`detectAdapter()` 只看 `ctx.compaction`，被 preset `isolate` 隔离 → **有无 redirect 都是 `none`**；功能未受影响，但识别/展示/成本 `backend` 归因失真；
  - **D1-3 自动压缩：未跑到**（隔离实例只到 ~70K，压力需 ≈678K 才触发）。
- **背景/痛点**：真机安装后只验过 **context-zip redirect** 接管的那条路径；**原生 `compaction-basic`（无 redirect）从未真机验证**。而真机 `adapter=none/unknown` 说明识别逻辑可能没覆盖原生形态；原生摘要是**自由文本**（非五段式），而我们的覆盖判断与回注形态是按五段式设计的。E1/E2 记录里那 6 次“自由摘要”大概率就是原生样本，可先离线回放。
- **目标（可验收）**：
  1. **离线回放**：从历史会话中定位 6 次自由摘要事件，用现有适配器逻辑回放，判定“原生后端能否被识别、摘要是否 readable、回注走哪条分支”。
  2. **隔离 profile 实机**：在**不带 context-zip redirect** 的隔离 profile 实例里，跑一轮自动压缩 + 一轮手动 `/compact`，验证 5 类保护项、回注、成本字段。
  3. **结论**：明确原生后端是“可用 / 需修适配器 / 不可用”；给出证据路径。
- **验证项**：
  - **D1-1 后端识别（不通过 → 0.1.15 修复）**：首次 `compaction/summary` 后按 `classifySummaryText` 做**事件形态推断**——free-form → `host-basic`，five-section → `context-zip`，两者都不像 → `unknown`；同一会话出现两种形态 → `mixed/unverified`。**修复硬约束**：
    1. 所有输出一律标 **`inferred`**（`/cg status`、审计、`compaction-cost.backend` 三处），不得冒充实测；
    2. **不得据此做任何行为分支**——保护、回注、降级、成本计算仍按事件级与既有来源字段，不读推断结果；
    3. 判不出来保持 `unknown`，不硬猜；
    4. 推断只影响“显示与归因”，不影响功能。
  - **D1-2 摘要可读性与形态**：自由摘要判 readable；回注走“标题 + 指针”而非五段式专属分支。
  - **D1-3 自动压缩（未跑到 → backlog，不补验）**：`compact.at` 压力需 ≈678K；隔离实例只到 ~70K。**用户 2026-10-25 决定：等真实自动压缩自然触发时补验**，不作为 M1.3 收口阻塞项；该次触发同时应验 `prune-observed` 正路径（overflow/压力路径会调 `pruneSession`）。
  - **D1-4 手动压缩链路**：`/compact` 后满足 S4=B（记忆指针 + `manual-compaction-loss` 告警 + 回注可见最后一句）。
  - **D1-5 隔离性**：全程不改用户 desktop profile、不卸载/禁用 context-zip、不写用户安装态。
- **边界（不做什么）**：
  - 不改桌面 profile、不卸载 context-zip、不动用户安装态；
  - **只允许新建隔离 profile 实例**（用户已决策允许）：独立 profile 名、独立端口、独立工作目录；用完清理或保留但不得占用桌面实例资源；
  - 不改回注逻辑与折叠（若验证发现缺陷，先报需求再改）；
  - 不接 ACP、不改 `isolate`、不推远端。
- **验收标准**：
  - ① 0.1.15：`classifySummaryText` 推断接入 `detectAdapter` 的展示/归因路径，**三处标 `inferred`**；free-form/five-section/unknown/mixed 四类都有单测；断言功能路径不读推断结果；
  - ② 隔离实例上 D1-1 复验：原生摘要出现后 `adapter` 变为 `host-basic (inferred)`，不再恒 `none`；
  - ③ D1-2/D1-4 已通过（结论保留，不重跑）；D1-3 记 backlog（等自然触发），不阻塞；
  - ④ 全量测试通过；M1 的 S1–S6 不回归；
  - ⑤ 不改变任何功能行为、不安装、不重启桌面实例。
- **依赖/风险**：
  - 起隔离实例需要端口与资源，须与桌面实例错开；用后清理；
  - 自动压缩需要压力触发（可用小窗口模型/构造长上下文，或用 `/compact` 代替自动）；
  - 原生手动压缩同样吞最新用户消息（S4=B 不变，不是缺陷）。

### 任务拆解

见 `TASKS/REQ-20261025-06-原生后端验证-拆解.md`。

---

## REQ-20261025-07 上下文治理插件 0.1.16 —— 控制字符修复 + 成本 backend 字段拆分

- **依据**：0.1.15 复核 P3（`caea83f` 已推）；用户 2026-10-25 决策范围 A（`DEC-20261025-51`）。
- **优先级**：P1
- **状态**：**已交付 · 已复核**（0.1.16，**204/204**；复核 P1=0 / P2=0 / P3=4，见 `docs/review-context-governance-0.1.16.md`。原：已排期（00 已直派开发，此单用于账本一致））
- **版本**：0.1.16；`auditVersion` 升 **`cost-v1.4`**
- **背景/痛点**：
  1. **P3-1 控制字符**：`packages/dsh-context-governance/README.md` 含控制字符（0x08 `\b`、0x07 `\a` 被转义），文本文件不应出现，影响渲染与 diff。
  2. **P3-2 `backend` 语义被污染**：0.1.15 为标注推断，把展示串写进了 `compaction-cost.backend`（形如 `host-basic (inferred)`），破坏枚举语义——M2 账本若按 `backend` 聚合会解析错。
- **目标（可验收）**：
  1. 清除 README 控制字符，零功能变更。
  2. `compaction-cost` **拆三字段**：
     - `backendKind`：枚举（`host-basic` / `context-zip` / `unknown`）；
     - `backendLabel`：展示串（可含 ` (inferred)` 等后缀）；
     - `backendInferred`：布尔；
     - **`backend` 恢复只写枚举**（兼容 0.1.14 语义），`auditVersion=cost-v1.4`。
  3. 加**防复发测试**：扫描包内文本文件（`.md/.js/.mjs/.json/.yml`），禁止控制字符（允许 `\n`、`\t`、`\r`）。
- **边界（不做什么）**：
  - 不改功能逻辑（识别、保护、回注、压缩一律不动）；
  - 不安装/不重启/不改 profile/不 push；
  - **不纳入** backlog：P3-3（`#observedStyles` 跨会话累积）、P3-4（证据缺 `apply version=0.1.15` 行）、P3-5（`adapter-inferred` 重复行）。
- **验收标准**：
  - ① README 无控制字符，全文可正常显示；
  - ② 防复发测试覆盖包内文本文件，命中即 fail（给出被扫文件数与命中数）；
  - ③ 审计样例齐全：`backend:"host-basic"`、`backendKind:"host-basic"`、`backendLabel:"host-basic (inferred)"`、`backendInferred:true`、`auditVersion:"cost-v1.4"`；无观察时 `kind=unknown`/`label=unknown`/`inferred=false`；
  - ④ **兼容性**：`backend` 在四种形态（host-basic / context-zip / unknown / mixed）下恒为枚举，**不含括号与空格**；
  - ⑤ `/cg status` 展示仍可读（用 `backendLabel`）；
  - ⑥ 全量测试通过；M1 的 S1–S6 不回归；T5/T8 文档同步。
- **依赖/风险**：
  - 下游读取方需同时认 `backendKind` 与 `backend`；`cost-v1.3 → v1.4` 只增字段、**`backend` 恢复原语义**；
  - 拆分后旧解析器读 `backend` 仍可用，读展示串的需改读 `backendLabel`。

### 任务拆解

见 `TASKS/REQ-20261025-07-0.1.16-拆解.md`。

---

## REQ-20261025-08 上下文治理插件 0.1.17 —— 枚举补 `none` + 控制字符闸扩到仓库根

- **依据**：0.1.16 复核 P3（`446efe2` 已推）；用户 2026-10-25 决策范围 A（`DEC-20261025-52`）。
- **优先级**：P1
- **状态**：**已交付 · 已复核**（0.1.17，**205/205**；复核 P1=0 / P2=0 / P3=3，见 `docs/review-context-governance-0.1.17.md`；其后 **0.1.18 发布前收口**（`/cg status` 改 `backend-kind=`、控制字符闸改 `git ls-files`，**206/206**）复核 0/P2=0/P3=4，未单独立单。原：已排期（00 已直派开发，此单用于账本一致））
- **版本**：0.1.17；`auditVersion` **维持 `cost-v1.4`**（只补枚举值，不改字段结构）
- **背景/痛点**：
  1. **P3-2 枚举缺 `none`**：真机常态就是 `adapter=none`，现在被折叠进 `unknown`，导致成本审计堆积假 unknown，M2 账本按 backend 聚合时会失真。
  2. **P3-1 闸范围不足**：控制字符检查只扫包内，仓库根不在范围内；`AGENTS.md` 仍有 `0x0C`（@2907）。
- **目标（可验收）**：
  1. `backendKind` / `backend` 枚举增加 **`none`**；**实测 `none` 原样写入 `none`**，不再折叠成 `unknown`。
  2. `mixed` 仍归 `unknown`，`backendLabel="mixed (unverified)"`，**不加 `inferenceKind`**（记 backlog）。
  3. 控制字符闸扩到**仓库根**（含 `AGENTS.md`），排除 `.tmp/`、`node_modules/`、`.git/`；清掉 `AGENTS.md` 的 `0x0C@2907`。
- **边界（不做什么）**：
  - 不改功能逻辑（识别、保护、回注、压缩不动）；
  - 不改 `auditVersion`（维持 `cost-v1.4`）；
  - 不安装/不重启/不改 profile/不 push；
  - **不纳入** backlog：P3-3（`mixed` 语义细化）、P3-4（闸入口形态）。
- **验收标准**：
  - ① 枚举**完整**：`host-basic` / `context-zip` / **`none`** / `unknown`；四种形态下 `backend === backendKind` 且**不含括号与空格**；
  - ② **实测 none**：注入 `none` 实测 → `backend="none"`、`backendKind="none"`、`backendInferred=false`、`backendLabel` 不含 `(inferred)`；
  - ③ **mixed**：`backend="unknown"`、`backendKind="unknown"`、`backendLabel="mixed (unverified)"`、`backendInferred=true`；
  - ④ **无观察**：三个字段均为 `unknown`、`inferred=false`（不回归上单口径）；
  - ⑤ **控制字符闸**：扫描范围含仓库根与 `AGENTS.md`，排除 `.tmp/`、`node_modules/`、`.git/`；`AGENTS.md` 无控制字符；**自证**（临时注入 → 看到 fail → 还原）；
  - ⑥ 文档写明枚举含 `none`（T5/T8 同步）；
  - ⑦ 全量测试通过；S1–S6 不回归。
- **依赖/风险**：
  - `none` 进入枚举后，下游若把 `none` 当“未知”处理需同步（文档标注）；
  - `mixed` 仍映射 `unknown`，语义细化留 backlog。

### 任务拆解

见 `TASKS/REQ-20261025-08-0.1.17-拆解.md`。

---

## REQ-20261025-09 上下文治理插件 M2 —— 压缩策略与成本账本

- **依据**：`docs/M2-需求草案-v0.6.md`（**终审通过**，含附录 A“推迟不做”ADR）；`docs/M2-使用说明-草案-v0.3.md`；架构 v1.1 §6/§8/§14；`DEC-20261025-51`/`DEC-20261025-52`（`cost-v1.4` 基线）。
- **优先级**：P0
- **状态**：**0.2.0 / 0.2.1 已交付 · 已复核**（0.2.1 复核 P1=0 / P2=0 / P3=0 + 真机 `source=projection(backfilled)` / `native=0.6934` + `tag v0.2.1`）；**0.2.2 已交付 · 已复核**（已推远端 `94417c7`；四步 + 第 5 步 `turn/end` 接线 `c79feb0`，复核修复 `5309b3f`（失败事件不抄旧报告）/ `0bcc8b1`（无新报告 `protection=null`），复核通过 `94417c7` / `c2ded44`；**311/311**，2026-10-26 02:41 现采；**`armed` 仍写死 `false`**（`src/index.js:527` 传 `getArmed: () => false`），无配置/命令可打开——**启用方案 = 1.0 门禁 R-2**：任务单 `TASKS/REQ-20261025-09-提前压启用-拆解.md`（**0.2.4**）已出；**用户 2026-10-26 拍板默认开**（覆盖定义 v1 的「建议默认关」），口径与理由变更见 `docs/1.0-状态定义-v1.md` §1.1；项目层出现该键一律不生效（忽略该键 + `policy-invalid`，不清空整层））；**G2/G3 真机已完成**（`analysis/req-20261025-09/G2-G3-真机验证报告.md`）；**0.2.3 账本暂缓至 1.1**（`DEC-20261025-79`）；**P2-4 第 3 条（写入侧 `supersede` 去重）用户 2026-10-26 拍板后置 1.1**（理由：身份键 + 写文件与改状态原子性 + 误 supersede 真实记忆风险，估 1–1.5 天，1.0 不值得；已知限制见 `docs/1.0-状态定义-v1.md` §2.2.1；**不为此新开单**）；第 5 条（历史清理）并入重启窗口（**需用户批**）
- **版本**：0.2.0（策略层）→ **0.2.1（窗口/校验层，不执行压缩）** → **0.2.2（提前压执行 + `turn/end` 接线，已交付 · 已复核；`armed` 未开）** → **0.2.4（提前压启用，已排期；`0.2.3` 预留账本、暂缓 1.1）** → 1.0.0
- **背景/痛点**：M1 解决“不断线”；M2 解决“**什么时候压可控、压了值不值能算**”。用户原始诉求是**提前压缩、去掉过时信息**。宿主原生触发点 ≈67.85%（preset `0.8 + 65536`，patch 层无效），我们只在它之前动手，**不包装宿主决策点**。

### 目标（可验收）

> **定位（用户 2026-10-26 拍板 B：全局纳管；1.0 发布已延期）**：插件是**全局上下文治理层**——**纳管所有可判定根的工作区会话**（记忆、校验、压缩、审计完整覆盖），**不是单项目工具**；无 `.git` 祖先的 cwd **不属于工作区**，按 3A 豁免完全不碰。**该目标是 1.0 目标、当前处于开发中、尚未达成**（**当前进度：P1 骨架；全纳管为三段目标**，见「多根通用性」第 14 条）；D8「多项目纳管」是其核心部分，不再后置 1.1。**1.0 发布与否由用户另行拍板**（用户原话：「基本功能没做完怎么叫 1.0 发布」）。

1. **提前压默认开**：`compact.at` 语义为**真实占窗口比例**，默认 `0.60`；到点后于安全时机调 `compactNow`。
2. **四层配置 + 可解释**：内置 → 插件配置 → 项目 `.cg-policy.json` → 会话 `/cg set`；`/cg status` 打印合成链与 `native`。
3. **不抢宿主**：`effective = max(measured, estimated×estimateSafety)`；`effective ≥ native−0.02` 时不主动压。
4. **成本账本**：按会话/项目/天/模型聚合；两实测数 + 带假设行的估算；`auditVersion` 用 `cost-v1.4` 及以后。
5. **可关闭**：`compact.early=false`（如 `research` profile）时完全不干预，宿主照常在 native 点压；记忆/保护/回注仍工作。

### 非目标

- **不做推迟/抑制**（不包装 `compactIfNeeded`，见 v0.6 附录 A）；
- 不造引擎、不换摘要后端、不接管 provider、不改 preset 平面；
- 不做 UI 图表、不做货币成本、不做跨机同步；
- 不改 pruner/折叠/spill；不做行为推断自动打标。

### 参数（初版）

| 参数 | 含义 | 默认 | 范围 | `/cg set` |
|---|---|---|---|---|
| `compact.at` | 真实占窗口比例到多少就压 | `0.60` | `0.20` ~ dynamic native | 是 |
| `compact.early` | 允许提前压 | `true` | bool | 是 |
| `compact.early.armed` | 允许**真实执行**提前压（0.2.4 启用方案；项目层出现不生效） | `true`（来源 `default`） | bool | **否（用 `/cg compact arm\|disarm`）** |
| `compact.cooldownMin` | 两次压缩最小间隔 | `10` 分钟 | ≥1 | 是 |
| `compact.minDeltaTokens` | 距上次压缩至少新增 token | `20000` | ≥0 | 是 |
| `compact.estimateSafety` | 估算放大系数（专家项） | `1.35` | `1.0–1.6` | **否**（仅配置） |
| `compact.lowThresholdAck` | 允许 `<0.30` | `false` | bool | 否 |
| `cost.remainingTurns` | 账本剩余轮次覆盖 | `null`（历史平均） | null 或 ≥0 | 是 |

`compact.at > native` → 拒绝并提示“M2 不支持推迟”。`estimateSafety` 仅从配置文件读，注释式风险提示。

### 补录与补定义（2026-10-26 回填，不改已有条款）

> 来源：需求文档明确性判定清单（缺失 A5/B5/C5/D4/E1/E2/E4；含糊/歧义 C4/D2/E3/E5）。**本小节只补录派生文档已生效条目与补定义，不修改上面任何目标/参数/边界**；查不到原文的标「待定」。

**补定义**

1. **C4 术语**：「四层」指**配置作用域**（内置 / 插件配置 / 项目 / 会话）；`profile`（`batch`/`coding`/`review`/`research`）是层间的**标签层**，**不属于四层**——合成顺序见 `docs/M2-需求草案-v0.6.md:177`「显式层（会话 > 项目 > 插件）> 标签层（profile/偏好）> 内置默认」。
2. **E3 空窗语义**：`(native−0.02, native]` **不是可用区间**——`at ≥ native−0.02` 一律拒绝（`policy-invalid(above-effective-window)`）；运行时 `native` 收缩导致生效值落入该区间 → 该层自动失效（`window-shrunk`），`/cg status` **不得显示 `early=on`**。
3. **D2 可退通道最低级别**：**至少会话级**——`/cg compact disarm` 只影响当前会话、立即生效、会话结束回默认（`docs/1.0-状态定义-v1.md:66`；用户 2026-10-26 拍「会话级实现」）。
4. **E5 回退层级**：会话级（即时）→ 配置级（`compact.early.armed=false`，加载/重启生效）→ 策略级（`compact.early=false`，profile）→ 失败兜底回宿主默认（不静默降级）；与 M1 原则（上 `:30`）「失败显式、可回退」一致。

**补录（派生文档已生效条目）**

| # | 条目 | 原文 / 来源 | 状态 |
|---|---|---|---|
| A5 | 会话级止损命令 | `/cg compact arm` / `/cg compact disarm`（**名称以实现为准**——`TASKS:42` 原话「建议命名，开发可改」）；`docs/1.0-状态定义-v1.md:66` | 已录（见补定义 D2） |
| B5 | 会话层可设键 | **实现实采** `SESSION_KEYS`（`policy.js:26`）：`compact.at` / `compact.early` / `compact.cooldownMin` / `compact.minDeltaTokens` / `cost.remainingTurns` / `header.enabled`；`cg-status.js:290` 对非 `SESSION_KEYS` 按「未知键」拒绝。M2 参数表另写 `reinject.maxChars`/`maxLines` 为「是」，但**实现未支持**（不在 `SESSION_KEYS`）；`compact.estimateSafety` / `compact.lowThresholdAck` 仅配置文件 | 已录（按实现实采更正） |
| C5 | profile 打标入口 | **已定（需求侧判定 D7）**：入口形态**由实现定**（命令 / 会话元数据 / 配置键均可），需求只约束效果——按会话隔离、`/cg status` 显示本会话 profile 与来源、设置立即生效（草案 `R-PROFILE-2`，草案未生效、用户可推翻） | **已定（需求侧）** |
| D4 | 配置级关闭 | `compact.early.armed=false`（加载后全局）；与会话级（A5）、策略级（`compact.early=false`）构成三层（见补定义 E5） | 已录 |
| E1 | `compact.early.armed` 参数 | 默认 `true`、来源 `default`；项目层出现一律不生效（忽略 + `policy-invalid`，不清空整层）（`docs/1.0-状态定义-v1.md:39,65`） | 已录（参数表已加行） |
| E2 | 「本项目」判定 | **已定（2026-10-26 用户拍板 B：全局纳管）**：**每个会话按自身项目根判定**（不再有「单一本项目」/「外部会话」）；无 `.git` 祖先 = `no-project-root`（完全不碰，见 3A 豁免）。根来源沿用 D9=A | **已定（每会话根）** |
| E4 | 默认值调整规则 | **已定（用户 2026-10-26 拍 A）**：任何**内置默认值**变更须记 **`DECISIONS` 编号 + Release notes 一句话**；适用面见下「默认值变更规则」 | **已定** |

**补录条款（主单自表述；语义与派生草案一致，不引草案）**

1. **R-SCOPE（全局纳管；用户 2026-10-26 拍板 B）**
   - **插件纳管所有可判定根的工作区会话**：每个会话按**自身项目根**纳入记忆、保护/回注、压缩策略、审计与成本账本；**无 `.git` 祖先的 cwd 不属于工作区**（按 3A 豁免完全不碰）；**不存在「外部会话」概念**（`foreign-session` 枚举删除）。
   - **无根会话**（cwd 无 `.git` 祖先，`no-project-root`）**完全不碰**：不观测、不记账、不保护、不写记忆（与 3A 豁免一致）；**总闸/项目层禁用**（`out-of-scope`）照旧不干预。
   - **不得存在「被压缩但无保护、无回注、无成本」的纳管会话**。
   - 凡观测到真实压缩（含宿主原生压缩），成本账本必须有对应记录；取不到数值写 `null` 并标 `unknown`，**不得整行缺失**；该类记录**只含压缩事实与用量**。
2. **R-AUDIT（审计枚举）**：`early-forced.compaction` 只能取**本次触发**的事实结果，枚举 `committed` / `skipped` / `failed` / `unknown`；**无 fresh report 时必须写 `unknown`**，不得沿用上一轮报告、不得用默认值补位；`unknown` 不得被 `/cg status` 或账本渲染为成功。
3. **R-MEMROOT（多根模型；用户 2026-10-26 拍板 B）**
   - **每会话按自身项目根**：cwd 上溯含 `.git` 的最近祖先；**无根 → `no-project-root`，完全不碰**（见 R-SCOPE）。
   - **记忆根按项目根隔离**：各工作区在**自己的根下**写 `memory/governance/`（授权边界见下），**不得跨根读写**。
   - **根来源（configRoot 强制合并）**：`projectRoot` **非空**时，其下会话的根 = `projectRoot`（`source=config`），**嵌套 `.git` 不另立根**——**已知限制：显式配置根内多根隔离不完整**（P1 / P4 文档须披露）；`configRoot` 外会话按自身 cwd 独立成根；`projectRoot` **为空**时按最近 `.git`（文件或目录）多根推断；首见推断并持久化（D9=A），**重启沿用、不重推**；**不再存在「单项目模式」**。
   - 根变化（配置变更 / 持久化状态丢失 / 换机）必须在 `/cg status` 与审计可见（`project-root-changed` / `inferred-fresh`）；**重启后根不得静默改变**。
   - 已写入的记忆**不迁移、不删除**，留在原根路径；**卸载保留各根 memory、回滚不回写旧根**（见「多根通用性」第 11 条）。

**默认值变更规则（用户 2026-10-26 拍 A）**

- **适用面（「默认值」= 插件内置层的默认，不是用户自己配的值）**：`compact.at` / `compact.early` / `compact.early.armed` / `compact.cooldownMin` / `compact.minDeltaTokens` / `compact.estimateSafety` / `compact.lowThresholdAck` / `cost.remainingTurns` / `header.enabled` / `logFile` / `projectRoot` / `memoryRoot` 等内置默认值。
- **变更要求**：① 记 **`DECISIONS` 编号**（开发账本）；② **Release notes 写一句用户可见变化**（改了什么、影响谁）。**不记录不得改默认**。
- **不适用**：用户自己设置的配置值（会话 / 插件配置 / 项目层）不需要记 `DECISIONS`。

**多根通用性（用户 2026-10-26 拍板；收敛 23 条通用性缺口）**

1. **根发现（A）**：纳管根集合 = **已出现会话的根并集**，**不主动扫描磁盘**；`/cg roots` 可查看当前根清单。
2. **子会话（A）**：subagent / 子会话**纳管压缩与审计，不写记忆**（不建记忆写路径、不注入 header）。**根归属：父根已知 → 继承父根（不新增根）；父根未知 → 按自身 cwd 推断；仍无法判定 → 3A 豁免**。
3. **跨根查询（A）**：`mem_query` **默认只查本会话根**；**跨根查询 1.0 不做**（后续能力，**明确不做**，不留空）。
4. **根限额（A）**：**不设硬上限**；根数超阈值（默认 16）**只告警、不拒绝**。
5. **窗口口径**：`#lastSession` 取**本会话所属根内**最近会话，**跨根不混用**；**无窗口事件的会话（headless / CLI）→ `native=unknown`，不提前压**。
6. **项目层配置**：**每个纳管根各自读取** `<root>/.cg-policy.json`，互不影响。
7. **聚合维度**：记忆/账本聚合使用**根标识（路径 hash）**；`project` 字段**仅作展示名**、不用于区分（避免同名目录撞名）。
8. **header**：按**当前会话根**取记忆；子会话按第 2 条（不写记忆、不注入）。
9. **根判定**：`.git` **文件或目录**均可作根；符号链接按 **realpath** 判根；Windows 路径**大小写归一**后比较；UNC 可判根则纳管，否则 `no-project-root`；**空 cwd 的非子会话 → `no-project-root`（fail-closed，完全不碰）**。
10. **状态与审计**：`/cg status` 增「全部纳管根」视图（根列表 + 各根记忆条数 / 审计末行）；审计按根存储，**跨根聚合只读**；根状态按 **profile** 隔离（`root-state-<profile>.json`）。
11. **卸载 / 回滚**：卸载**保留各根 memory**；回滚**不回写旧根**（旧根数据只读保留）。
12. **多 profile**：每个 profile **各自安装、各自根状态**，不跨 profile 共享根状态。
13. **验收（负向，多根后必须验）**：① A 根会话**不影响** B 根（记忆/审计/策略）；② 删除根状态文件 → 重新推断且可见（`inferred-fresh`）；③ 同根两会话并发写记忆 → 锁提示 / 串行，**不丢写**。
14. **分层交付（用户 2026-10-26 拍板 A）**：**全纳管是 1.0 目标，分三层交付**——**P1 = 可判定根登记 + 主根纳管骨架**（其他根**已登记、未纳管**；**P1 不宣称全纳管**）；**P2 = 多根记忆与审计**（每根各自 `memory/governance/`）；**P3 = 全会话保护/回注**。**完成 P3 后才可对外宣称「全纳管」**。
15. **P1 `unmanaged` 诊断行（可选实现，四条限定）**：允许每根**最多一次**（或根状态变化时一次）`root-unmanaged` 诊断行；字段仅 `root` / `rootId` / `reason` / `count`；**不写 `sessionId`（全 id / 短 id 都不写）、不写正文**；root audit **按根汇总一条**（同根多会话只累计 `count`）；放**用户级 root audit**，**不写进任何根内 `audit.jsonl`**；该行只表示「跳过」，不代表已纳管。
16. **功能闭环判据**：**P1 + P2 + P3 全部完成，且多根负向验收（第 13 条）全过 = 功能闭环**。~~当前不满足（只到 P1 骨架）~~ → **2026-10-26 已满足**：P1/P2/P3 已签 + gap16 真机证据经审核裁定 ①②③ 有效（附加严格项不作否决）；证据包 `analysis/req-20261025-12/P4-drill-20261026-200123/gap16/`——`RESULT.md` sha256 `4A50DDFCB67861C7480ADFCD8F0A85741E2E17AC77983A6A0843FF28CB10D345`、`EVIDENCE-SHA256.txt` sha256 `98439AF955E899018715BBFD90DE1C4489955329DDE85BB7FDB7FC33702AB9B1`（26,425 B / 194 文件全匹配）；启动预算 **9/10**（8 有效 + 1 中止 0 证据）。
17. **`mem_write` 根归属**：**默认写入本会话所属根**；**跨根写入一律拒绝**（不提供跨根写参数）——与第 3 条 `mem_query` 默认只查本会话根对称。
18. **多进程同根**：**不做跨进程合并**；同根第二个进程以**只读 / 锁提示**方式运行，**不双写**。
19. **便携 / 移动盘**：移动盘或换机**视为新根**；旧状态留原路径、**不迁移**。

**授权边界（用户 2026-10-26 拍板；固定子目录白名单 + 每类数据用途限制）**：插件只可在以下**两类固定位置**创建 / 写入自己的运行数据：

| # | 位置 | 允许的数据 | 禁止 |
|---|---|---|---|
| ① | **用户级** `<profile home>/context-governance/` | 根状态、根审计、诊断日志（默认 `<home>/context-governance/logs/governance.log`） | — |
| ② | **各纳管根内** `<root>/memory/governance/` | 记忆、根内审计 | 诊断日志（见下） |

**不得**在工作区根内创建其他文件；**不得修改、移动、删除**任何已有项目文件。硬性约束：
- **写入侧 containment（每次写入都校验）**：写前对**实际目标文件路径**做 **realpath + `..` + 符号链接 / junction + UNC + 盘符大小写归一** 校验；**校验对象是实际写入路径**（必须落在上述两处内），不只是配置解析结果；
- **fail-closed**：目标落在白名单外 / `memoryRoot` 为绝对或逃逸 → **拒绝并告警，不回退到别处写**（该根 fail-closed / 不纳入）；
- **模型固定**：白名单只增不减、每类数据用途写死；未来新增缓存 / 临时数据 = **只加一项白名单**，不改模型。

**`logFile` 严格两处（用户 2026-10-26 拍板）**：`diagnostics.logFile` 只允许 ① `<home>/context-governance/`（含默认 `<home>/context-governance/logs/governance.log`）或 ② `<root>/memory/governance/`；**`<root>/logs/` 不允许**。**白名单外 → `CONFIG` 拒绝 + 插件不加载该 profile（显式失败，不静默禁用）**；**迁移到 `<home>/context-governance/logs/governance.log` 才可用**；**多根下只有用户级路径安全**（根内路径只能 per-root sink，每根一份）。**破坏性变更**：现有 `D:\DS-PROJECT\DSH插件开发\logs\governance.log` 会被拒，须在 P1 / P4 文档披露。

**豁免（用户 2026-10-26 拍 3A，拍板 B 后扩展）**：`no-project-root`（未知 cwd，无 `.git` 祖先）会话**完全不碰**——不建立 store / guard / 审计，不观测压缩、不记账、不保护、不写记忆；仅保留**根推断 watcher**。若未来需要「孤儿账本」，**单独立项**。

**R-DOC（用户可见入口；用户 2026-10-26 拍 4A）**：新增**用户可见命令/入口**（如 `/cg profile`）必须在 **help 与 README** 中列出，实现负责同步；**新入口不得只存在于代码里**。

**发布根来源（用户 2026-10-26 拍 D9=A）**

1. **发布物 0 绝对路径**：发布物（包 / 配置 / 文档 / 示例）**不得包含本机绝对路径**；`projectRoot` / `memoryRoot` / `logFile` 在包内必须为**空或相对值**。
2. **`/cg status` 显示本会话根与来源 + 全部纳管根视图**：多根模型下显示**本会话**的项目根与来源（`config` / `persisted` / `inferred`）；**无根时显示 `project-root: unknown (no-project-root)`**；同时提供**全部纳管根视图**（根列表 + 各根记忆条数 / 审计末行，见「多根通用性」第 10 条）。
3. **D9 决策记录**：发布包默认 `projectRoot` 为**空**；首次需要时按会话 cwd 上溯 `.git` 推断并持久化，**重启沿用、不重推**；该结论须写入 **Release notes 与安装文档**。
4. **P2 关闭**：D9=A 下不存在「未配置启动引导」需求（未配置即默认形态），原 P2 卡**随本决定关闭**。

### 会话特点与偏好

- profile 显式打标、**按会话**（非按用户/项目）：`batch` 0.45 / `coding` 0.60 / `review` 0.55 / `research` **`early=false`**。
- 偏好：`type=preference` 且 `status=active` 才影响默认值；`proposed` 不生效。
- 合成顺序：显式层（会话 > 项目 > 插件）> 标签层（profile/偏好）> 内置默认。

### 安全机制

1. **fail-open**：我们不在宿主调用链上，任何失败只意味着“没提前压”，宿主仍在 native 点压；失败一律审计。
2. **宿主优先**：调用前四重检查——无进行中压缩；距上次 > cooldown；`effective < native−0.02`；cooldown 与 `minDeltaTokens` 双达标。
3. **调用后复检**：返回“宿主已完成/已在进行”→ `early-aborted(host-compacted)`，静默不重试。
4. **长 turn 不打断**：只在安全时机（`turn/end` 等）检查；压力过 native 由宿主处理，记 `early-skipped(turn-in-progress)`。
5. **防抖**：时间 + 增量双冷却。

### 前置门禁（只读，先出报告）

| 门禁 | 要回答 | 前置版本 | 失败后果 |
|---|---|---|---|
| **G1** | 本 scope 能否取到 `agentPresets` 与 preset 引擎（`serviceFor(agent,'compaction')`） | 0.2.2 | 提前压降级为**仅 `/cg compact now` 手动** |
| **G2** | `compactNow` 在哪些时机可安全调用；失败形态；事件流完整性 | 0.2.2 | 同上，且默认时机调整 |
| **G3** | 各时机 `measure()` 是否反映当前上下文；`effective` 口径可落地 | 0.2.2 | 口径重定后才能进 0.2.2 |
| **G4** | 上下文窗口 `W` / 输出预留 `O` / `native` 数值来源 | **0.2.1（已定，`DEC-20261025-65`）** | 已解：`sessionProjections.contextPressure` 路径；口径见下节 |

> **G1 已翻盘通过（agent 级 `serviceFor`）**；**0.2.1 只做窗口/校验层，不需要 G2/G3**；G2/G3 的运行时验证随 **0.2.2** 做。

**任一失败都要先报用户与 00，再改范围，不得自行降级。**

### 项目层安全口径（2026-10-25 定，P2 潜在问题）

项目文件 `<root>/.cg-policy.json` 是**仓库可控输入，按不可信处理**；**每个纳管根各自读取自己的文件，互不影响**（见「多根通用性」第 6 条）：

- **P-A：禁止项目层设置 `compact.lowThresholdAck`**——出现即拒绝整层（该确认只允许在会话层由用户本人显式操作）；
- **P-A：`compact.estimateSafety` 不开放给项目层**——仅插件配置文件可设，项目层出现即拒（单列，不进项目白名单）；
- **P-C：项目层 `compact.at` 下限 `0.45`**——低于即拒绝该层；上限仍为动态 `native`；
- **拒绝语义**：**整层拒绝**（不逐键降级）+ `policy-invalid` 审计（`source=project`、拒绝键、原因），并回退到下一层生效；
  - **例外（`compact.early.armed`，2026-10-26 审核 §4.6 定论）**：项目层出现该键（无论 `true`/`false`）**只忽略该键** + `policy-invalid`，**不清空整层**、同层其它合法键照常生效；既不能开也不能关。理由：避免恶意仓库用一个越权键使整层合法配置失效（拒绝服务）。
- **可见性**：`/cg status` 必须显示“被拒的层与原因”，不能只写 audit（用户只看 status）；
- **不采用 B**：不加 `policy.allowProjectLayer` 开关，安全口径默认生效、不依赖用户手动开启；
- 恶意项目文件不得造成：阈值低于 0.45、自盖 `<0.30` 确认、静默降级。

### 窗口 W 的选取与校验口径（G4 结论，`DEC-20261025-65`）

> 事实：`contextPressure` 投影是 **per-session**，`native` 与策略是**进程级**；换模型/路由会更新窗口，`request/context` 不带 `contextWindow` 时会**删除旧值**。

**① 选取**：`native` 与 `/cg status` 的窗口用 **runtime 已有的 `#lastSession`（**本会话所属根内**最近会话；跨根不混用，见「多根通用性」第 5 条）**；`window=` 后必须带 **session 短 id**（如 `window=1M (session 58a2e845)`）。多模型/多会话不取“最小窗口”做展示，展示用当前会话，校验用保守值（见③）。

**② 中途变化与消失**：
- 允许**中途更新**：每收到一次新的窗口观察（`request/context` / 投影变化）即**立刻重算** `native`、压力四段与 `at ≤ native` 校验，**不锁到下次 apply**；
- `request/context` 不带 `contextWindow` → **删除旧值并置 `unknown`**，`native` 不可算；状态显示 `window=unknown (removed by request/context)`，**不得沿用旧值**；
- 重新观察到窗口后自动恢复，并记录 `windowSource + observedAt`。

**③ 校验与显示同源**：
- **校验一律用保守值**：`conservativeWindow = min(当前进程已观察到的所有窗口)`；无观察 → `unknown`；
- 无观察时允许设置 `compact.at`，但标注“**未经校验**”；运行时一旦观察到 `at > native` → 拒绝该层 + 审计，不静默降级；
- `/cg status` 同时显示两值：`window current=<#lastSession> (session id) | conservative=<min>`，避免出现“显示允许 0.68、apply 却拒绝”的矛盾；
- 若 current 与 conservative 不一致，状态行必须明示“校验按 conservative”。

**④ 公式退化（`W ≤ O + 65536`）——`DEC-20261025-68`：选 A，拒绝而非造数**：
- 当 `floor(min(W×0.8, W−O−65536)) ≤ 0` 时，`native = unknown (degenerate)`；**禁止用常数 `0.6785` 冒充**；
- 该值无法校验 `at ≤ native`：**设置 `compact.at` 的层一律拒绝**（含会话层），审计 `policy-invalid(reason=native-uncomputable)`；
- 已生效的继承值标 `unverified-degenerate`；**0.2.2 提前压不得触发**（`effective < native` 无法成立）；
- `/cg status` 显示 `native=unknown (degenerate: W=128k O=256k)`；
- 若 W 后续恢复正常 → 自动恢复可校验状态；
- **用例改写**：128k 窗口 + `at=0.6` → **被拒**（不是降级）；这条优先于“1M+128k 双会话”中的退化为准。

**⑤ 验收（追加）**：
- 状态行含 `current`/`conservative`/session 短 id/来源与时间；
- “1M + 128k 双会话”用例：`compact.at=0.6` 在保守值下**被拒**，且状态显示与校验结论一致；
- **退化用例**：`W=128k`、`O=256k` → `native=unknown (degenerate)`、`at` 层被拒、状态可见；
- 模拟 `request/context` 删除窗口 → 状态变 `unknown`，不沿用旧值。


### 验收（分段）

- **0.2.0**：四层覆盖正确——**项目层经 `apply` 真实生效**（`buildPolicyState` 接线，不许内联重建），并有**经 apply 的集成测试**；非法配置与**被拒的项目层**都可在 `/cg status` 直接看到原因，不只写审计；`/cg status` 合成链与 `native` 正确；`/cg policy show` 可用；`research` 显示 `early=off`；项目层安全口径（P-A/P-C）有单测覆盖（`lowThresholdAck`/`estimateSafety`/`at<0.45` 三类拒绝）；全量测试通过、S1–S6 不回归。
- **0.2.1（窗口/校验层，本次范围拆分）：本版不触发任何压缩**——只做窗口记录、动态 `native`（与 status/压力分母同源）、`conservative` 校验、status 双显与三条窗口测试；**并随本版修复 P3 九条（见下）**。验收：`windowState` 含 `current(#lastSession)/conservative(observed[])/observedAt`；`request/context` 缺失删除旧值并置 `unknown`（不沿用）；同源解析函数被 status 与压力分母共用；无观察时允许设 `at` 但标“未经校验”，运行时 `at>native` 拒绝该层 + 审计；`/cg status` 双显并标“校验按 conservative”；1M+128k 双会话用例与“删除窗口”用例通过；**代码检索与单测证明本版无任何压缩触发路径**。
- **0.2.2（提前压执行，已排期，`DEC-20261025-79`）**：前置 G2/G3 **在真机窗口做**——插件运行在宿主进程内、本身持有凭据，`compactNow` 是宿主内调用，**不需要 headless、不受 T0 的“拿不到凭据”限制**。验收：**桌面默认部署（非隔离 profile）到点主动压 ≥1 次**（`early-forced` + `compaction-cost` 用量 + `/cg status` 原文）。**桌面默认已有 3 次（0.2.2 代码，`memory/governance/audit.jsonl`，2026-10-25）：19:15:58.373Z（无 id）、19:18:38.184Z `f3408fb6…`、19:27:40.656Z `d835e71c…`，后两次 `committed` + `reinjected=true`，**但这 3 次没有当时 `/cg status` 快照，不能算完整三条**；1.0.0 代码另有 2 次 `accepted=true` + `compaction=unknown`（2026-10-26 15:46:50.705Z / 16:05:35.019Z，B-2「无 fresh report 不写 committed」的刻意行为，**不是未压**）。**R-AUDIT（`:456`）优先，不得为凑 `committed` 编造结果**——**S1.3（迟到报告回填；2026-10-27 定，固定超时已被 4 轮桌面真机否掉：force→报告 15.3s/24.9s/22.8s/87.6s，等待窗加到 60000ms 仍 timeout）**：`compactNow` 返回后即时写 `early-forced`——本 cycle 报告在窗内（`EARLY_REPORT_WAIT_MS=60000ms`）就取用，超窗写 `unknown` + `early-report-wait`；**报告晚到时按同 session+cycle 追加 `early-forced-reconciled`**（`compactionId`/`compaction`/`protection`/`reinjected`/`failures` 取自报告，附 `reconcileDelayMs`；**只在主记录 `compaction=unknown` 时登记、同一 cycle 至多一条、不改写主记录**）。**闭合判据（替代「同一行写全」）**：① `early-forced.accepted=true`；② 同 cycle 有 `early-forced-reconciled` 且 `compaction=committed`、`compactionId` 非空；③ 该 id 前 8 位与同会话 `compaction-loss`、`compaction-cost` 一致；④ 三条同时成立才判闭合，只有①判**未闭合**（跨进程重启丢登记按未闭合，**不得当「压过了」**）。**`protection` 只如实回填 `failures`、不作闭合条件**（第 4 轮实测 `protection=failed`（rollback-point）+ committed + reinjected，按既有口径不判压缩失败，见 `:79`）。隔离两次（host-basic `acb89ca` / context-zip `bc12050`，audit committed + cost 同 id + status id 对得上）只作环境证据。`effective ≥ native−0.02` 不抢；失败不伤宿主；`early-aborted` 静默；长 turn 不打断；手动 `/cg compact now` 两步确认（冷却期 `--force`）；参数越界被拒。**已知缺口（1.0）**：未回填登记不跨进程（进程退出/重启丢待回填，跨重启报告对不上账）；1.0 发布须写明，**1.0.1 做最小持久化登记**（落地位置须走授权边界 `:492`），不得长期靠缺口。**闭合判定由审计链人工/脚本执行——产品（含 `/cg status`）不自动判定闭合/未闭合**。
- ~~**0.2.3（成本账本）**：~~ **暂缓至 1.1**（`DEC-20261025-79`）。**暂缓理由**：① G2/G3 运行时验证成本高、优先保 0.2.2 与 1.0 收口；② 账本属“看得见”的增强，不影响“提前压/不断线”的主价值；③ `cost-v1.4` 字段已稳定，延后不影响数据可用性。原验收标准保留备查：聚合 = 逐条求和；两实测数 + 假设行置顶的估算；`backend` 用 `cost-v1.4` 枚举（含 `none`）；未知保持 unknown；`/cg cost` 可查。
- **状态展示可解释性（用户 2026-10-26 批准新增；审核 2026-10-27 建议列 R6；用户 2026-10-27 拍板：放 1.0.2，不进 1.0.1）**：`/cg status` 必须**分列「adapter（provider 观测面）」与「engine（实际可达性）」**——`adapter=none` / `self-check-failed` 只说明根/agent scope 的 `ctx.get('compaction')` 不可得（宿主 `isolate.compaction` 设计行为），**不得渲染为 disabled / unavailable / “压缩不可用”**；`engine=` 经 `agentPresets.serviceFor` 取到 active engine = `available`、取不到 = `unavailable`；guard 未挂载写「未挂载（等待本会话首个事件）」，**不写 disabled**。验收：① 两字段分列；② `adapter=none` 出现“压缩不可用”字样 = 不通过；③ 未挂载文案；④ 四态矩阵 + 真机原文；⑤ 回归测试。反例（真实发生）：`analysis/req-20261025-12/drills/contextzip-R2-status.txt` 同屏出现 `adapter=none`、`conflicts: no-compaction-service(warning), self-check-failed(error)` 与 `last-early: forced`、`last-compaction: committed` 并存，被用户判为“到阈值也压不了”——**属文本误导，不是用户误读**。**归属：实现（只读探测），不碰 early/guard 行为**。
- **总回归**：M1 的 S1–S6；生产代码无折叠、**无引擎包装**。

### 0.2.1 附带修复：P3 九条（`DEC-20261025-64`，随 0.2.1 一起复核、一起推）

> 优先修前两条；其余七条同批处理。每条都要“修 + 可复现证据/单测”。

| # | 问题 | 修法/验收 |
|---|---|---|
| **P3-8**（存量，0.1.6 起） | `src/audit.js:257` `#ensureFile()` 把 `#sizeBytes` 置 0 → `/cg status` 的 `audit size` 只是**本进程写入量**（真机 1379 vs 实际 14990），**轮转按它判断**（单文件可超上限至“既有 + 8 MiB”），`rotations` 也是进程内计数 | 修 `#ensureFile`（初始化 `#sizeBytes` 为文件实际大小）+ 补“历史文件已存在”单测；验收：进程重启后 `audit size` 反映真实文件大小，轮转按真实大小触发 |
| **P3-1**（用户误导） | `docs/M2-使用说明-草案-v0.1/v0.2`（v0.3 已修） 写“每个会话”“本会话改成 50% 就压”，并列了**不存在的** `/cg cost`、`/cg compact now`（0.2.0 未实现） | **需求侧已修**（见 `docs/M2-使用说明-草案-v0.3.md` 顶部版本标注与命令表）；开发侧在 0.2.1/0.2.2 交付时同步更新命令表 |
| P3-2 | 无关的 `/cg set` 被挡且报 `at=undefined` | 只校验被设置的键；错误信息带键名与来源层 |
| P3-3 | 压力行不打印 `windowTokens` | `/cg status` 压力行补 `windowTokens`（来自 G4 结论） |
| P3-4 | containment 词法层（junction/symlink 残余风险） | 文档写明局限 + 能判则判；不承诺完全防住 |
| P3-5 | 报告写 `list` 实现，实际没有 | 报告改口径或补实现，二选一，不许文档与代码不一致 |
| P3-6 | 重复键提示两条、实际后写胜 | 只提示一次，并写明“后写覆盖” |
| P3-7 | 改 `.cg-policy.json` 需重启，T5/README 未写 | 文档补“改项目文件需重启生效” |
| P3-9 | `samples-0.2.0.txt` 与代码矛盾、不可复现 | 用可复现脚本重生成，或删除该样本 |

**验收补充**：P3 九条逐条给“修/不修 + 证据”；P3-8 必须有“历史文件已存在”的单测；P3-1 的文档修正要在 `/cg status` 命令表中与实现一致。

### 1.0.2 候选（2026-10-27 用户批准入候选；不进 1.0.1）

1. **`reconcile-store` 写入侧 containment 断言**：`writeReconcileStore` 目前只 `path.resolve` + 拼接，未走 `:500`「每次写入都校验实际写入路径」（`src/roots/containment.js#checkWriteTarget`）；实际路径不可逃逸（`<home>/context-governance/` + `safeProfileName` 只留 `[A-Za-z0-9._-]`）。1.0.2 补断言（防御性，不改变现有行为）。
2. **多进程同根 pending-reconcile 覆盖（观察项）**：`pending-reconcile-<profile>[-<rootId>].json` 为后写覆盖，第二进程写会丢第一进程的待回填条目；`:489` 第 18 条只要求「只读 / 锁提示」，当前**连提示都没有**。1.0.2 补检测或写明限制。
3. **发布措辞红线**：**不得写「宿主重启后一定补上」**。只可写「**插件重载/热重启可补**；宿主**进程**重启时压缩本身中断、报告不再到，读回条目按 TTL 过期计未闭合」。用户 2026-10-27 已单独转审核，按此写 release notes。
4. **R6 `/cg status` 分列 adapter / engine**：内容与验收见 `:595`（用户 2026-10-27 拍板放 1.0.2）。
5. **桌面真机闭合样本（验证待补，非代码）**：需桌面重启加载 1.0.1 后**再灌一次上下文**（实测约 20 万 tokens/轮）让压力进入窗口，产出 `early-forced`（`unknown`）+ `early-forced-reconciled` 的**真机行**；当前桌面**没有任何 `early-forced-reconciled` 真机行**，闭合链只有隔离/历史证据。用户 2026-10-27 拍**不再做第 5 轮桌面真机验证** → 不在 1.0.1 内做，留后续。
6. **同会话 `/cg status` 原文（闭合判据③的人工证据）**：判据③要求「该 id 前 8 位与同会话 `compaction-loss`、`compaction-cost` 一致」，需**同会话当时的 `/cg status` 原文**作人工核对；1.0.1 未落该快照（历史 3 次桌面 `committed` 同样缺 status 快照）。做第 5 条真机验证时一并落盘。

### 依赖/风险

- **依赖 `cost-v1.4` 基线**：0.1.16 已推；**建议等 0.1.17（枚举补 `none`）落定后再开始 0.2.2**；
- 提前压依赖 preset 引擎可见（G1）；`ctx.compaction` 在根/agent scope 不可得属设计（不期待），**但 `agentPresets.serviceFor(agent,'compaction')` 可取到当前 active engine**（官方跨 isolate 访问器；`DEC-20261025-48` 不改 isolate）；
- 每压一次都是一次摘要调用，“更早压”= 更多摘要成本，文档必须写明；
- 与 `dsh-context` 不重复做图表，只做策略账本。

### 任务拆解

见 `TASKS/REQ-20261025-09-M2-拆解.md`（首批 T0 门禁 + T1/T2 策略层）。

---

## REQ-20261025-10 上下文治理插件 M3 —— 1.0 收尾（动作校验 + 新会话接续 + 发布就绪）

- **依据**：`docs/M3-需求草案-v0.4.md`（外部评审三轮通过）；`DEC-20261025-69`（**D-R1 = B**）；架构 v1.1 §7.2/§14；M1/M2 已交付能力。
- **优先级**：P0
- **状态**：**进行中**（T0 门禁 = 证据不足 → **动作校验不做**，`DEC-20261025-76`；**0.3.1 header 已默认开并上机**，283/283，P2-4 第 3/5 条：第 3 条（写入侧去重/supersede）**用户 2026-10-26 拍板后置 1.1**（已知限制见 `docs/1.0-状态定义-v1.md` §2.2.1）；第 5 条（历史清理）并入重启窗口（**需用户批**）；**评测已拆至 `REQ-20261025-11` 并完成（带限定）**；**0.3.2（README/T5 默认开口径 + `export-package` 打包脚本 + 两个维护脚本）已交付 · 已复核**，见 `docs/review-context-governance-0.3.2.md`；**1.0 状态定义（默认值/开关/完成边界）见 `docs/1.0-状态定义-v1.md`**）
- **版本**：**无 0.3.0（动作校验不做）**；0.3.1（header 默认开，已上机）→ 0.3.2（评测 + 发布就绪）→ **1.0.0**
- **定位**：补齐架构四支柱中唯一缺失的“校验”，并把“新会话接续”做成默认无感，达到 **1.0 = 功能基础齐备**。

### 红线

1. **公开动作需另行批准**：仓库公开、镜像/Release 发布一律走正式流程，**需求/开发/审核均不得自行执行**；
2. 不改 preset、不接管 provider、不装第二个压缩引擎；
3. 不安装/不重启 DSH（真机验证由用户执行）；
4. 不 push（远端操作由审核在复核通过后执行）。

### 目标（可验收）

1. **动作校验：本版不做**（`DEC-20261025-76`）——T0 证据不足（接口在，但拿不到“真实调用被拦下 + 载荷可读”的运行时证据），按“不能拦就不做”，**不搞全量确认式降级**；设计存档见下方，未来宿主可验证时再立项。
2. **新会话无感接续**：header **默认开**；有规则文件时只带动态状态；配额与预算受限；可关闭。
3. **“不重问”评测**：**已拆出 → `REQ-20261025-11`**（证据类，需模型/用户参与）。
4. **可发布**：**已拆出 → `REQ-20261025-12`**（发布工程类，审核打包 + 用户批准）。

### 组成

#### 动作校验（§7.2）——**本版不做（设计存档，`DEC-20261025-76`）**

> **T0 结论**：**已证**——`pre-execute` waterfall 可注册、`ctx.tools.guard(fn)` 返回 disposer、`tools.restrict` 存在、宿主文档明确“guard = 同步硬拒绝 / 需 await 时返回 ask”；**未证**——拿不到“一次真实调用被拦下 + 载荷可读”的运行时证据（凭据是 OAuth token 非 API key，GUI/headless 两条路都被环境限制挡住）。**结论：按“不能拦就不做”，0.3.0 取消，不搞全量确认式降级。** 以下规格留作未来立项的设计存档。


| # | 检查项 | 触发 | 行为 |
|---|---|---|---|
| **C1** | 高危删除/移动前必须有回滚点 | 仅 `rm -rf`/递归/通配，**且目标不在白名单** | 拦截，要求备份路径或 commit |
| **C2** | 写操作不得越出工作区 | `realpath` 解析后不在工作区根下 | 拒绝，提示真实路径 |
| **C3** | git 危险动作 | `push --force`、`filter-branch`、改 remote、tag 发布 | 直接拒绝 |

- **白名单**：内置约 25 项（构建产物/测试覆盖/缓存虚拟环境/日志/编辑器杂项）+ 项目**不可**追加；追加只允许**插件配置/会话层**，且**只做并集（Union）**、禁止删除/覆盖内置项；项目层出现 `checks.whitelist` → **整层拒绝** + `policy-invalid`。
- 配置只引用检查项，不写脚本；交互复用宿主权限/审批。
- **门禁 G-M3-1**：pre-execute 能否拦截/否决；**不能 → 不提供该功能**。

#### S3 header 默认开

- 默认开（内置层）；两形态：**有规则文件**（`AGENTS.md`/`CLAUDE.md` 等）→ 只放 进度/待办/决定/锚点；**无规则文件** → 加偏好 1 行并标“非硬规则”。
- **配额**：待办 2 · 进度 2 · 决定 2 · 锚点 1 · 偏好 1（仅完整形态）；类内按时间倒序，空位让给待办/决定；**≤8 行 / ≤800 字符**。
- **包裹格式**：
  ```
  [CG-MEMORY · state-only · budget 8 lines]
  - D1 决定：… (dec-012)
  [Note: If this state conflicts with AGENTS.md, follow AGENTS.md]
  ```
- **六护栏**：预算；只取 `active` 且超 **14 天**（上限 30、可配）标 `[Old]` **仍注入**排末尾；**按当前会话根取记忆**；空记忆/无项目**零注入**；冲突声明；可关闭（`/cg header off`/项目/插件）；审计 `header-injected`；**子会话不注入**（见「多根通用性」第 2 条）。
- **子会话默认不注入**。

#### “不重问”评测（非功能）——**已拆出 → `REQ-20261025-11`**

> 拆单理由：证据类，需模型/用户参与，验收口径与发布工程不同。

#### 发布就绪（D-R1 = B，已定）——**已拆出 → `REQ-20261025-12`**

> 拆单理由：发布工程类，由审核打包 + 用户批准，验收口径是“可发布”不是“功能可用”。

#### 记忆写入的进度识别口径（`DEC-20261025-73`，随 M3 落地）

**规则**：一条消息里的“数字/数字”比例，**必须带语义单位**（`项`/`条`/`个`/`文件`/`任务`/`完成`）**或**显式 `[batch]` 标记，才可作为批次进度候选。

**作废变更**：`REQ-20261025-05`（0.1.14）的“无单位比例也算”正例**作废**——`批次 8000/1500` 不再入选。原因：`8000/1500` 与测试数 `205/205` 形态不可区分，只能靠单位区分。

**用户可见的变化（要写进文档）**：
- ❌ 旧写法：`批次 8000/1500` → **不再被记录**；
- ✅ 新写法：`8000/1500 项完成` 或 `[batch] 8000/1500`；
- 已写入的历史条目**保持原样、不回写**。

**验收**：
- 正例：`批次 8000/1500 项完成`、`[batch] 8000/1500` → 正确判定；
- 反例：`批次 8000/1500`（有关键字、无单位）→ `skip`（`no-unit`）；`205/205 测试通过` → `skip`；
- 文档：用户文档（使用说明）在 0.3.x 交付时同步这条写法变化。

### 前置门禁

| 门禁 | 要回答 | 失败后果 |
|---|---|---|
| **G-M3-1** | pre-execute 能否拦截/否决 | **已结：证据不足 → 动作校验不做**（`DEC-20261025-76`），记“等宿主支持” |
| **G-M3-2** | 规则文件判定（文件存在 vs 宿主注入事件） | 用文件存在并写局限 |
| **G-M3-3** | header 注入点与 system prompt 的先后关系 | 换注入点或缩为 3 行 |

### 验收标准

1. 动作校验：**不提供**——文档与 `/cg status` 不得谎称有保护；设计存档保留；
2. header：两形态、配额/预算、`[Old]` 排末尾、子会话不注入、关闭与空记忆零注入、审计可查；
3. 总回归：M1 的 S1–S6、M2 的策略/账本不回退。
4. **评测 → `REQ-20261025-11`；发布 → `REQ-20261025-12`**（本单不再验收这两项）。

### 里程碑

| 版本 | 内容 | 前置 | 状态 |
|---|---|---|---|
| ~~0.3.0~~ | ~~动作校验~~ | G-M3-1 | **取消**（`DEC-20261025-76`：证据不足，不降级） |
| 0.3.1 | header 默认开 + P2-4 修复 | G-M3-2/G-M3-3 | **已上机**（283/283；header 已默认开；P2-4 第 3 条后置 1.1、第 5 条并入重启窗口需用户批） |
| 0.3.2 | README/T5「默认开」口径 + `export-package` 打包脚本 + 两个维护脚本 | — | **已交付 · 已复核**（评测与发布就绪已拆出 → `REQ-20261025-11` / `REQ-20261025-12`；见 `docs/review-context-governance-0.3.2.md`） |
| **1.0.0** | 发布（D-R1=B） | `REQ-20261025-12` 通过 + 用户验收 | 未开始 |

### 1.1 候选（已在评审定序）

1. **记忆纠错回路（优先）**：`/cg mem edit <id>` 或直接编辑 `MEMORY.md` 的快捷入口——错误记忆会带偏所有会话；
2. `[Old]` 与活跃批次关联判定（仅影响排序）。

> 1.1 的其他想法（header 可配置、模型请求压缩等）**仅是讨论草稿，不进主单、未定序**；见 `docs/1.1-候选-草案.md`，待外部评审后再提。

### 任务拆解

见 `TASKS/REQ-20261025-10-M3-拆解.md`。

---

## REQ-20261025-11 上下文治理插件 M3.1 —— “不重问”评测（证据类）

- **依据**：由 `REQ-20261025-10` 拆出（`DEC-20261025-78` 拆分口径）；M1 的 S1/S2 遗留证据缺口。
- **优先级**：P1
- **状态**：**已完成（带限定）**——T3 三场景 **3/3**（决定 / 待办 / 进度；`header-injected count=3 / lines=3 / tokensInjected=69`，三个会话均引用 `MEM-20261026-1014/1015/1016`、**未重问**、未调 `mem_query`）。**限定（必须随结论一起引用）**：**未触发真实压缩**（用“新会话仅凭记忆启动”近似压缩后状态）、**`mem_query` 兜底未测**；1.0 发布说明**不得**写“压缩后接续已验证”。复核记录 `docs/review-T3-G2-G3-2026-10-26.md`。原：已排期（等 header/提前压稳定后执行）
- **目标（可验收）**：
  1. 至少 **3 个场景**（决定 / 待办 / 进度各一），在**真实压缩发生之后**提问“只有项目记忆里才有”的内容；
  2. 记录模型行为：是 `mem_query` / 直接引用记忆，还是**重问用户**；
  3. 给出判定表与结论；不通过时定位是 header 文案、回注内容还是记忆本身的问题。
- **边界**：
  - **不改功能**（评测不是开发任务）；发现问题转对应单；
  - 不使用未脱敏的真实会话内容做公开证据；样本脱敏后落 `analysis/`；
  - 不制造真实压缩压力（用正常会话触发，或隔离 profile）。
- **验收标准**：三份记录（场景/提问/行为/结论）+ 一份汇总判定；清楚回答“压缩后模型是否真的用了记忆”。
- **依赖**：header 已默认开（0.3.1 已上机）；提前压/压缩链路可用。

### 任务拆解

见 `TASKS/REQ-20261025-11-评测-拆解.md`。

---

## REQ-20261025-12 上下文治理插件 1.0 发布就绪（发布工程类）

- **依据**：`REQ-20261025-10` 拆出；`DEC-20261025-69`（**D-R1 = B**）。
- **优先级**：P0（1.0 的发布门）
- **状态**：**1.0 发布已延期（用户 2026-10-26 拍板：基本功能未完成）；本单转为「发布准备」，发布事件由用户另行拍板**。部分开工（干净包脚本 `6ce6e8b`、敏感扫描窄白名单 + `memory-cleanup` `28f749e` 已复核，见 `docs/review-context-governance-0.3.2.md`；**CI 接入 / 兼容矩阵 / 安装-卸载-回滚三条演练 / Release notes + checklist 未做**；无任何公开动作）。**指针**：**0.1.18 发布前收口（206/206，复核 0/P2=0/P3=4）无独立单，记在 `REQ-20261025-08` 状态行尾巴**。**1.0 门禁与提前压默认状态见 `docs/1.0-状态定义-v1.md`**
- **目标（可验收）**：
  1. **干净包导出**：以 tag 为基线用 `git archive` 导出 → 解压 → 跑合规扫描（`--strict`），产出**文件清单 + 哈希**；
  2. **敏感扫描接入 CI**：gitleaks/trufflehog（引入需批准），不可 `--no-verify` 绕过；本地无依赖兜底扫描保留；
  3. **兼容矩阵**：DSH 0.2.x、压缩后端（原生 / context-zip）、已知不支持项（ACP、第三方闸门、动作校验）；
  4. **安装/卸载/回滚**：三条路径各演练一次并留记录；卸载后行为恢复；
  5. **Release notes + 已知限制清单**（含 D1-3、prune 正路径、**P2-4 第 3 条 `supersede` 去重的具体影响（见 `docs/1.0-状态定义-v1.md` §2.2.1）**、第 5 条待窗口、动作校验收敛为“不做”）；
  6. **tag 流程**：**1.0 必须打新 tag**（`v0.2.1` 指向 `f585434`，HEAD 已前移，不能沿用）；tag/Release 由用户批准后执行。
- **红线**：
  - **D-R1 = B**：私有仓库保留完整历史与 issue/PR；对外只发 Release 包或只读镜像；
  - **公开动作需另行批准**（发布/镜像/仓库公开走正式流程）；
  - **本单只准备、不执行**；且**准备的产物（Release notes / checklist / 干净包）也不得在公开渠道预发布**——不得先写成 GitHub Release draft、公开 gist、公开仓库文件等任何公网可见形态，一律留在本地/私有渠道待批准；
  - 不改写历史（禁 `filter-branch`）。
- **验收标准**：① 干净包**文件清单 + SHA256**（以 **tag** 为基线，非 HEAD）；② 敏感扫描 **0 blocker**（2 条 review 为文档示意串、非真实凭据，人工确认；info 级本机路径/会话 id 在发布物脱敏或排除 `analysis/`）；③ 兼容矩阵覆盖**四维**（DSH 版本 / 压缩后端 / Node / OS）+ 明确不支持项；④ 安装/卸载/回滚**三条演练各留记录**且判据见下；⑤ CI 扫描绿（或**用户批准的等价替代**并记录理由）；⑥ Release notes 含评测限定与「动作校验不做」；⑦ checklist 全勾 + 审核打包签署；⑧ 用户批准发布。
- **依赖**：`REQ-20261025-10`（header）与 `REQ-20261025-11`（评测）完成或明确接受遗留。

### 验收判据细化（2026-10-26 需求补，供审核直接照验）

**A. 兼容矩阵必须覆盖**（执行载体：`docs/兼容矩阵-1.0.md`，审核草稿）

| 维度 | 必列 | 备注 |
|---|---|---|
| DSH 宿主 | 实测 **0.2.1-rc.3**；`engines.dsh` **维持 `>=0.2.1-rc.2 <0.2.2-0`（不放宽）** | 审核定：engines 是安全契约——**0.2.2 未验、不支持，宿主升级后插件拒载**；宁可明确拒载，不静默运行在未验宿主上 |
| 压缩后端 | 原生 `compaction-basic`、`context-zip` | **context-zip × 0.2.1-rc.3 补跑并入 T5 隔离轮**；未跑则矩阵写明未验；ACP/第三方闸门标「不支持」 |
| Node | `engines.node`（现 `≥22.19.0`）+ 本机实测（24.21.0） | 不要求用户独立安装 |
| OS | **Windows**（本机 Win11 实测） | macOS/Linux 标「未验」 |
| 功能行 | 记忆 / 保护回注 / 策略 / 窗口校验 / header 默认开 / **提前压默认开** | 动作校验、折叠、成本账本（1.1）标「不提供/暂缓」 |

**发布前必须收口**：`package.json` 版本 `0.2.1 → 1.0.0`；context-zip 复跑结果并入矩阵（未跑则写明未验）；engines 口径已定**不放宽**（0.2.2 拒载，见上）。

**B. 三条演练判据**（执行载体：`docs/发布演练-安装卸载回滚.md`；每条记录：命令 + 输出片段 + `state.before/after`）

| 演练 | 通过判据 |
|---|---|
| **安装** | `dependencies +1`、`bundles +1`、junction 解析正常；`/cg status` **版本=1.0.0**；无 `registration failed` / `perception=none` |
| **卸载** | profile 回到 `state.before`；`/cg status` 不存在（或返回 usage）；宿主按原生阈值压缩（`0.6934`/`0.6785` 口径）；**插件源码目录完整**、记忆目录保留（用户数据不删） |
| **回滚** | 装回 `v0.2.1` → `/cg status` 版本=0.2.1；记忆/header 正常；无版本/契约错误 |

**C. CI 门禁规则**

- CI 扫描失败 = **阻止发布**；**不可 `--no-verify` 绕过**；
- 若仓库暂无法接入 CI：用本地 `compliance-scan --strict` 对干净包跑一次 + 留输出，在 checklist 写明「CI 未接入，本地扫描替代」并经**用户批准**——**不得静默跳过**；
- 引入第三方 Action/镜像仍需批准（红线）。

**D. 干净包与 tag**

- 以 **tag**（非 HEAD）`git archive` 导出；产出文件清单 + SHA256；
- 包内禁 `snapshot-*`、`*-test-*.jsonl`、`*cost-sample*`、备份目录；
- **1.0 必须新 tag**（建议 `v1.0.0`），不得沿用 `v0.2.1`；tag/Release 在用户批准后执行。

### 任务拆解

见 `TASKS/REQ-20261025-12-发布就绪-拆解.md`。

---

## 后续需求讨论（仅讨论 · 未排期 · 无 owner）

> 2026-10-27 用户决定：本类事项**放进后面的需求讨论**，不排期、不开工、不改代码。以下只记讨论要点与边界，**不是任务单**。

### D-设置页（上下文阈值可视化与调节）

- **状态**：**1.1 候选 · 待排期 · 无 owner**（2026-11-14 用户定：与 DSH 宿主升级**合入 1.1.0**；不属 1.0.x）。
- **要解决的两个体验问题**（不是“一定要滑块”）：
  1. **不直观**：看阈值只能靠 `/cg status` 或翻审计，用户不知道 `0.65` 意味着什么；
  2. **调节麻烦**：只能敲 `/cg set compact.at=…`，还要记取值下限、项目层/会话层、重启失效等约束。
- **形态不限定为 UI 控件**：**数字输入优先**（设置页里的数字字段即可），**滑块不是目标**；宿主将来给 range 控件再升级。
- **必须一起讨论/落进条目的内容**：
  1. **展示当前生效值 + 来源层**（builtin / profile / plugin / project / session），并区分**「本会话有效」与「重启失效」**（会话级 `/cg set` 只存进程内存，见 `src/commands/cg-status.js:407`）；
  2. **量纲提示**：`0.65` = **用掉窗口 65% 触发压缩**，**不是“窗口 65%”**——避免与 WorkBuddy 的 `context_window`（窗口申请值）混淆；
  3. **安全边界不因 UI 放开**：`<0.30` 需 `lowThresholdAck`、**项目层下限 0.45**、**项目层禁 `armed`**、会话级重启失效；
  4. **改动落在哪一层**（会话 / 项目 / 配置）要**可选且可见**，不能只改一个说不清哪层生效的值。
- **依赖/现状**：DSH 有官方设置面（`ctx.settings` + Schemastery `Volatile` 自动表单；实例 `dsh-context-compressor`）；当前插件**无 `Config` schema、无 `dsh.client`**（`src/index.js:9` 注释「Schemastery 表单留到 T3」）。
- **参考（结论已按“数字输入优先”收敛）**：`analysis/req-20261025-12/WorkBuddy-上下文长度-对比与UI滑块-建议-20261027.md`。
- **明确不做**：自写 client 卡片（要复刻 `clientBundle` 构建）、插件起本地 HTTP 设置页（引入端口/安全面）——等宿主能力或另议。

---

## REQ-20261114-01 上下文治理插件 1.0.3 —— 记忆"读得出"修复

> **来源**：用户 2026-11-14 定（记：`REQUIREMENTS.md` 本单）。版本路线：**记忆修复走 1.0.3**；**D2 用户面 + DSH 宿主升级合并到 1.1.0**（升级由 00 发起，需求侧只出适配清单）。
> **条款可判定性**：按 `ROLES/ROLE-DSH插件-需求.md` §11 逐条标档（A=可复跑/文件:行，B=观感/需用户，C=环境前置）；**缺档 = 没有验收标准**。
> **不写实现路线**：本单只写可观察结果与判定方法；函数名/文件名/参数留给开发。

### 背景（事实，非推断）

2026-11-14 清库时发现 12 条 `proposed` 条目形态一致：

1. **6 条 `criterion`**：同一句「规则在场：system-prompt、AGENTS.md、skill-catalog」重复 6 次——对应 **6 次不同压缩**（`evidence` 里的 compaction id 各不相同），说明去重按"事件"而非按"内容"；
2. **6 条 `anchor`**：标题被切断（如「回滚点：回滚」「rollback」，或尾部挂着未闭合的反引号）；
3. **12 条正文全空**，只有标题；
4. `proposed` 状态自 2026-10-27 挂到 11-14，**从未被确认、也从未自动过期**；
5. 处置：00 侧逐条看正文后全部 `expire`，索引即时刷为 `active 11 · proposed 0 · expired 12`（`G:\DS-HARNESS\memory\governance\MEMORY.md`）。

**与需求命题的关系**：这违反"**存得下、读得出**"里的后半句——库里有条目，但读出来是碎片。

### 目标（可验收）

> 验收基线：**5a/5b/5c 为 2026-11-14 用户批准口径（`DEC-20261114-08`）**；第二次真机窗口按此执行。

| # | 条款 | 档 | 判定方法（可观察） |
|---|---|---|---|
| 1 | **写入即校验**：正文为空、或标题在换行/分隔符/反引号处被切断的条目**不进入库**，且留一条审计行 | A | 构造一条正文空 + 一条标题截断的输入 → 库内条目数不变、审计新增 1 行（命令 + 输出行） |
| 2 | **`proposed` 无条件过期**：超过 N 天（默认 7，可配）自动作废，不依赖人工 | A | 把 N 调成 1 天并推进时间/或造过期条目 → 该条目变 `expired`，索引计数同步 |
| 3 | **同内容去重**：归一化后标题相同者，7 天内只保留 1 条 | A | 连续 2 次压缩产生同一标题 → 条目 +1（不是 +2） |
| 4 | **机器产物不得高置信**：自动提取的条目置信度 ≤0.5 且必须为 `proposed` | B | 抽查新条目字段值；"是否合理"由用户看 |
| 5a | **可读出**：`mem_write` 条目正文不得为空；`protection`（标题+指针型）允许正文为空，但**必须带可解析指针**（`source`/`evidence` 能定位到原文或 `文件:行`） | A（真机） | 取新条目读字段：正文非空；或指针按原样定位成功 |
| 5b | **不重复**：同一归一化标题 7 天内 ≤1 条（**不是**"每次压缩新增总数 ≤1"） | A（真机） | 两次真实压缩后按标题分组计数，同标题 ≤1 |
| 5c | **不截断**：标题不得在反引号/换行/分隔符处断开 | A（真机） | 新增条目逐条看，尾部无未闭合反引号、无半句 |

### 真机复检结果（2026-11-14 21:16/21:17，**不通过**）

**观察（00 提供，两次手动 `/compact`，`manual:true`，compactionId `2ad0ba4a…` / `202f3503…`）**：条目 **23→28（+5）**；新增 5 条**正文全空**（`detailLen=0`）；2 条 anchor 仍截断（`回滚点：G:\DS-HARNESS``` 、`…（见记忆`）；近似重复未合并。`confidence=0.5`、状态 `proposed`、产生于压缩中 → 新链路部分生效但没拦住。

**需求侧先修自己的判据（原 5 条写错了，责任在需求）**：

- 原「新增 ≤1 条」过严：真实目标是**同一事实不重复**，不是"一次压缩最多产 1 条" → 改为 **5b 同标题 7 天内 ≤1**；
- 原「正文非空」与 `protection` 的**"标题 + 指针"设计冲突**（T4 定义就是标题+指针） → 改为 **5a：`mem_write` 正文非空；`protection` 允许空正文但指针必须可解析**；
- 原表未单列"截断" → 增 **5c 不截断**。

**实现侧待核根因（技术归开发，需求只给方向，不裁定实现）**：

- 疑似旁路：准入只在 `src/tools/mem-tools.js:186` 的 `create` 之前；`protectSync → journal → materializeProtection`（`src/memory/store.js:472`）**直接 `#entries.set`，没有准入**；
- 疑似截断源：`src/compress/protection-memory.js:19-40` 的 `cutTitle` 只按长度/单一边界处理，未处理反引号/半句。

**结论与门**：**1.0.3 不发布、不 tag、不挂 waiver**；修复后重跑 `TEST-02`（送测单位已变）并**再开一次真机窗口**；修复必须带一条能复现 `protection` 路径的回归用例，否则同一洞会再漏。

### 真机样本复审（2026-11-14 21:2x，开发查到判据被污染）

> **⚠️ 更正（2026-11-14 21:3x，00 对证据后；责任在需求）**：本节"无效样本"裁定**撤回**。
> 实测 `createdAt = 2026-11-14T13:16:45.028Z / 13:17:30.874Z`（与两次压缩 `13:16:45.037Z` / `13:17:30.876Z` 同刻，证据 `G:\DS-HARNESS\logs\真机-证据-20261114.md`）→ **+5 发生在压缩时，不是启动时的遗留物化**；开发所述"1.0.1 遗留 journal（`createdAt 2026-10-28`）"与文件不符，我未自验即采信，判错。
> **#5 按"不通过"记账（`D-MGMT-011`）**，不标无效样本。下文"遗留物化"相关表述不再作判据，仅保留可复用的「真机预检」。判据 5a/5b/5c 属**验收基线变更**，**用户 2026-11-14 已批（`DEC-20261114-08`）**，第二次真机窗口按新判据执行；**本次真机按新判据复核仍不过**——5b（`MEM-20261114-1003` 与 `1006` 近似重复未合并）、5c（两条 anchor 标题仍带未闭合反引号），故 #5 维持不通过。

**新事实**：那 +5 条全部是 **1.0.1 遗留 pending journal**（`createdAt 2026-10-28T15:31:46.306Z`、confidence 0.9、无 detail、标题截断），在 **1.0.3 启动时**（`2026-11-14T13:12:58.777Z`，与 audit 同秒）被物化，随即被 TTL 转 expired；`topics` 中 `createdAt=2026-11-14` 的条目 = **0**。

**需求裁定**：

1. **本次真机 = 无效样本（invalid run）**，不作"不通过"结论——观测窗口混入了升级前的遗留物化，不是新写入路径的表现；
2. **判据 5 增加观测窗口定义**（原条款漏写，责任在需求）：
   - 基线取在「**安装并启动完成、首次压缩发生之前**」；
   - 新增条目统计**只认 `createdAt` 落在本次压缩窗口内**的条目；
   - **遗留 journal 的物化不算新增**（无论其状态）；
3. **遗留 journal 处置（选 B）**：**过期 journal 不物化、直接归档**——理由：目标命题是"读得出"，把 1.0.1 的碎 payload 物化进库再靠 TTL 清，等于"先脏后清"，与目标相反；已物化的 5 条保持 expired 即可；
4. **"两次压缩 0 新条目"必须查**（不是选项）：要么新链路真的没产出（需解释为什么 5 类受保护内容一条都没出），要么被准入/去重挡掉（需 audit 有对应行）。**没有结论不重跑真机**。

**门不变**：不发布、不 tag、不挂 waiver；工作树冻结，要改先报 00。

### 真机预检（2026-11-14 新增，防"空样本"）

C 的初步证据：启动后本项目根 `audit.jsonl` 只有 `capability@ready` 与 `early-skipped(below-threshold)`，**无任何 compaction 派生行**；全盘仅此一处被写 → 两次 `/compact` **插件可能根本没收到事件**（或发生在非纳管会话/根）。故真机窗口必须**先过预检再计数**：

1. **纳管确认**：`/cg status` 显示该会话所属根为纳管状态；`audit.jsonl` 有本次会话的 `capability@ready`；
2. **事件确认**：执行第一次 `/compact` 后，`audit.jsonl` **必须出现 compaction 派生行**（`protection-write` 或 `compaction-loss/cost`）；没有 → 立即停止，判"**样本无效**"，不进计数、不写"过/不过"；
3. **基线时点**：计数基线取在"安装+启动完成、首次压缩之前"，且只认 `createdAt` 落在压缩窗口内的条目；
4. **归属留档**：由 00 补两次 `/compact` 的会话与根归属（插件侧看不到宿主归属）。

> **C 定稿（2026-11-14，开发更正）**：两次 `/compact` 发生在 **G 根**（`G:\DS-HARNESS\memory\governance\`，主机会话 `session-2ebebd78…`）；他此前读的是 **D 根** audit，故误判"无 compaction 派生行"。**「插件没收到事件」的结论作废**，改为「事件已到、按根分目录，但落库内容不合格」。预检仍保留——用于确认"该会话所属根已纳管"，避免再看错根。
>
> 若预检第 2 条反复不达 → 那是"插件收不到 manual `/compact` 事件"的**能力缺口**，须单独登记（可进 1.0.3 的修复项，也可另案），但**在结论前不得重开真机窗口**。

### 参数与拍板（2026-11-14 用户定：1A / 2A / 3A / 4A）

| 项 | 结论 |
|---|---|
| ① TTL 窗口 | **7 天**（`proposed` 超期自动作废） |
| ② 去重口径 | **归一化标题 + 7 天内同哈希只留 1 条**（不限永久，避免吃掉"同题重申"） |
| ③ 发布方式 | **现在单独做 1.0.3**（不并进 1.1.0，不等宿主升级） |
| ④ 配置键 | **新增 1 个键组**：`memory.proposedTtlDays`（默认 7）、`memory.dedupWindowDays`（默认 7）；须进策略层文档与 `/cg status` 展示 |

> 探针②附带事实（影响范围）：`proposed` 有**两个来源**——① 压缩时 `protectSync` 生成的规则条目（`writer:'rule'`；`contract.js` 的 `ruleDirect` 只放行 `progress/fact`，其余落 proposed）；② 模型 `mem_write` 默认 proposed。**写入校验与 TTL 必须两处都覆盖**，只修一半不算完成。

### 边界（不做）

- 不换记忆供应商、不做"记忆与 AGENTS/角色卡深度结合"（用户 2026-11-14 判为伪需求：**注入在精不在多**）；
- 不改 header 的注入内容与预算；不改压缩引擎与阈值策略；
- 不重开 1.0.2 六条候选（11-11 已裁定关闭，**编号不复用**）；
- 不做语义抽取算法升级（本轮只做"准入 + 衰减 + 去重 + 口径"）。

### 前置事实探针（开工前，结论=None 不许开工）

1. 源码是否在盘：当前 `packages/dsh-context-governance` 为**空目录**，`git status` 显示 **111 个文件为未提交删除**（HEAD 中有 115 个 tracked）→ 先恢复并给出 `git status` 干净输出；
2. 自动提取的触发点与 `proposed` 判定在哪一步产生（给 `文件:行`）；
3. 现成是否已有 TTL/去重开关（有则改默认值，不新增键）。

### 门序口径裁定（2026-11-14，需求裁 A）

**送测单位 = `commit` + 源码版本，不是 zip。** 理由：门序本身是「先测后包」，若要求先出 zip，测试不过时包即为废件；且 zip 属审核阶段的发包面职责。

- 测试报告必须锚定 commit（如 `d88c766`）+ 宿主版本 + profile；
- **zip + SHA256 移到审核阶段**：审核出包后做**一致性核对**——包内文件 = 该 commit 内文件（不带工作树旧账），并把 SHA256 回报留档；
- 若包面与 commit 不一致 → 测试结论作废、重跑受影响条款；
- **版本号**：`d88c766` 内 `package.json` 仍为 `1.0.1`，出包前必须 bump 到目标版本并复跑全量，否则 tag 与包版本不符（判不过）。

> **更新（2026-11-14 已落卡，用户批 A）**：本条已不再是"本单口径"——开发卡 `:95`、测试卡 `:71-76`、审核卡 `:56` 已改（`DEC-20261114-05`）：门槛 **5 项→4 项**；`zip+SHA256` 成为**审核出包门槛**（含"包面=commit 逐文件核对，不一致则测试结论作废"）；送测门槛① 加「包树干净，送测当刻核验」；另加「**送测后至出包前冻结包内工作树**，要改先报 00」。

### 真机验证（2026-11-14 用户裁定：做，但等 1.0.3 稳定后再做）

- **结论**：第 5 条负向验收**要做真机**，不按 waiver 结案。**历史记录不改**：2026-11-14 第一次窗口按原判据「新增 ≤1 **且正文非空**」判**不通过**（+5、`detailLen=0`、2 条截断），该结论保留、不漂白；**第二次窗口按用户已批的 5a/5b/5c 执行**（5a 可读出＝title 可读且 `source`/`evidence` 可解析、**detail 允许为空**；5b 同标题 7 天内 ≤1；5c 标题不截断）——与 5a 对齐，2026-11-14 审核要求。
- **计数细则（用户 2026-11-14 裁定 A；审核要求补口径）**：
  1. **前向不加"新增总数 ≤1"**：前向判据只有 5a/5b/5c（`DEC-20261114-08`）。
  2. **"新增"只对第二次及以后的压缩成立**：首轮压缩从空根起，一次合法写入 N 条（离线证据 `0→4`）**不计入新增计数**。
  3. **复验读数必须给**「两次压缩**前后条目数** + 新增条目 **`title`/`detailLen` 清单**」，**不得只给总数**。
  4. 历史判据（2026-11-14 第一次窗口「新增 ≤1 + 正文非空」→ 不通过）不动。
  5. **写入侧要求（口径定稿，2026-11-14 第四次也最后一次）**：保护链路写入**只要求** 标题可读 + `source`/`evidence` 可解析；**`detail` 允许为空**（保护条目本就是"标题+指针"型）。生成侧若能补 `detail` 更好，但**不作拒写条件**；`5a` 的"detail 允许为空"就是写入侧允许的，不只是读数下界。
- **时机**：**排在测试与审核通过、候选包就绪之后**；在此之前不得以"离线 526/526"替代该条结论。
- **执行**：安装 1.0.3 + 重启桌面由 **00 执行**（红线 1：动本机已装插件须用户批准），用户在场；测试记 `C` 档环境前置证据；审核 tag 前仍独立复跑 A 类。
- **第二次窗口结果（2026-11-14 21:58，锚 `44d0059`，包 SHA256 `FD52A159…`）**：#5 = **过** —— 5a **3/3**、5b **0 重复**（`1007`/`1008` 同标题被去重未落库）、5c **3/3** `trunc=null`；条目 **29 → 31（+2）→ 32（+1）**，新增 `1005`/`1009`/`1010`，`detailLen` **186/18/3**；`BUG-2026-11-14-01` 关单（已修复·真机验证通过）；报告 `tests\TEST-2026-11-14-06.md`。**这是测试判定，验收仍归用户**；第一次窗口"不通过"记录不动。
- **未做之前的口径（已过时，留档）**：`TEST-` 报告该条写「阻断·待真机窗口」，**不写"过"、不写 waiver**。

### 需求签版与锚点（2026-11-14 裁定 A 落地：契约 = `7112f5a` 内容，最终 HEAD `44d0059`）

- **契约文本以 `7112f5a` 为准**：保护链路 `detail` 可空 + `create` 受限原语 + 写入门禁覆盖所有写入路径；**明确覆盖 `70cf8f0` 的签署**（该签署由需求撤回，理由：与用户已批 `5a` 冲突）。
- **最终 HEAD = `44d0059`**（`44d005934e2f1f9ce4c9a58634dca57750a6d191`）。**需求自验**：`git diff 7112f5a..44d0059 -- src docs` **输出为空**（逐字节一致）；`--stat` 仅 `packages/dsh-context-governance/test/memory-1.0.3.test.mjs` +12，内容为守卫硬化的断言（直写点恰 9 处 + 方法名单钉死 + 保护链路恰 2 处 + `materializeProtection` 不得直写），**不改契约**。故 `44d0059` 在本单**等效于 `7112f5a` 签版**，不再出第二份签署。
- **测试锚点**：`TEST-03` 与 1.0.3 全部复跑**必须锚 `44d0059`**；`70cf8f0` 旧锚作废（旧锚不能用于新树）。
- **历史链不 rewrite**（audit 可核）：`70cf8f0` → `7112f5a` → `3d2c85d`（revert 回 70cf8f0 口径）→ `d5e7fb0`（revert 撤销 `3d2c85d`，恢复 `7112f5a`）→ `44d0059`（test +12）。净内容即 `7112f5a`。
- **版本**：`44d0059` 的 `packages/dsh-context-governance/package.json` = `"version": "1.0.3"`（需求自验）。
- **工作树**：插件 `src/docs/test` 三目录 `git status` **干净**；仓库未提交项 57 条均属 `analysis/` 等旧账、与本单无关 → 包面仍按「**只取 commit 内文件逐文件核对**」执行。
- **流程义务（开发已认）**：契约文本任何改动**先发需求过目、签了再落**；交付语只写"已按需求签字文本落地"并引原文，不得自写"已签版已落"。
- **生效裁定（00 `DEC-20261114-15`，2026-11-14）**：契约回到**用户已批的 5a**（`detail` 允许空、`title` 可读 + `source`/`evidence` 可解析、`5b` 同标题 7 天内 ≤1、`5c` 标题不截断），**不索取用户新批**——`7112f5a` 就是 5a 的落地，`70cf8f0` 的"`detail` 非空"由需求自认撤回，**这是回到已批状态、不是新增授权**。门序放行：**审核按 `44d0059` 出包**（zip + 包面逐文件核对 + SHA256 留档）；**`tag`/`push`/Release 须真机 #5 通过后由用户批准**；**装本机由 00 执行**（用户在场）。

### #4 观察项判定与 5b 短键裁定（2026-11-14 需求裁定，取样自落盘文件）

**#4（B 档：`confidence=0.5` 的 rule 生成条目标题是否合理）判定：标题不合理，但不阻断 1.0.3。**

- 取样：`G:\DS-HARNESS\memory\governance\topics\*.md` 中 `confidence: 0.5` 共 **9 条**（需求自取，不引用测试数字）。
- 缺陷四类：① **自指无指针** `MEM-20261114-1010`「回滚点（指针见正文）」而 detail 仅「回滚点」；② **无区分度短标题** `MEM-20261114-1009`「回滚点」；③ **空信息占位** `MEM-20261114-1002`「批次进度：有批次标记」；④ **整段消息塞进标题** `MEM-20261114-1005`「最后用户消息：…」（超长）。`1003/1006` 为第一次窗口（`13:16/13:17`）的截断标题，已由 5c 覆盖，**不作新证据**。
- **不调 `confidence` 阈值**：降阈值会连带丢掉「规则在场」（`MEM-20261114-1001`）等有用条目，且阈值不解决"标题不达意"。
- **改生成侧**（下一版本候选：`1.0.4` 或并入 `1.1.0`，版本归用户定）：锚点标题必须内联指针、禁「（指针见正文）」自指；事实类标题限长、全文放 `detail`；无信息模板（「有批次标记」）不发。由开发给 `文件:行` + 最小改动，测试验标题；**1.0.3 冻结期内不动代码**。
- 依据：`5a` 只要求 title 可读 + `source`/`evidence` 可解析，上述 9 条**字面全过**；故 `#5`（过）与 `#4`（体验不合理）**分开记，不互相漂白**。
- **落地口径（需求签版，只在下一版本执行；1.0.3 期间仅登记）**——出处已由开发查明（`src/compress/protection-memory.js`），本次只签规则、不改代码：
  1. **禁自指占位**：兜底标题**不得**用「（指针见正文）」——`detail` 允许为空（5a），"见正文"可能指向空。统一指向**必有且可解析**的字段：`回滚点（见 source）`、`批次进度（见 source）`。出处 `:162`（正常兜底）与 `:43`+`:166`（截断兜底）**必须同一文案**，否则 5b 去重兜不住——`1009`≡`1010` 即此故。
  2. **空信息不发（精确定义）**：**既无 `statePath` 又无 `ratios`** 时才不生成批次条目（不写「有批次标记」这类占位）；**有 `statePath` 仍发 `批次 STATE：<path>`、有 `ratios` 仍发 `批次进度：<ratios>`**——两者都带信息，不得一刀切全砍。出处 `:135-153`。
  3. **用户消息标题限长 80**：在 `protection-memory.js:93` 就地 `slice(0, 80)`；**不改** `src/compress/protection.js:116/275` 的 200 预算（改它要新凭证、收益低）。
  4. **测试同批改**：`test/memory-1.0.3.test.mjs:271` 的 `assert.equal(anchor.title, '回滚点')` 随文案更新；`:257` 的 `startsWith('回滚点')` 保留。
  5. **不变量**：不动准入、不动 5b、**不降** `TITLE_PREFIX_MIN`、**不调** `confidence` 阈值；改后全量须仍 `535/535`（新增用例另计）。

**5b 短键边界裁定（测试问询：`1009`/`1010` 相隔 19 s、内容近同、因短键 <8 字未合并，是否违约）：不违约，且不收紧口径。**

- 5b 字面 = 「同一归一化标题 7 天内 ≤1」；两键 `回滚点`（3 字）与 `回滚点指针见正文`（8 字）**不同** → 未违反，`#5 = 过` 不受影响。
- **不把 `TITLE_PREFIX_MIN` 从 8 降到 3**：会把「回滚点」「进度」这类通用短键在 7 天内跨会话**误并**、误删真信息，风险 > 收益。
- 真因是**生成侧兜底文案不一致**（同会话、内容近同却产出两个键）→ 登下一版本候选（与 `#4` 同根），**本单不动代码、不改 5b**。

### 验收与回滚

- **旧账风险（00 2026-11-14 核实）**：仓库整体有 **55 条**未提交项（`AGENTS/DECISIONS/REQUIREMENTS/STATUS` 改动 + `analysis/` 等未跟踪目录），与本次事故无关、不在本单清理范围；但**发布前必须确认包面/产物只取 tag 内文件**，不得把工作树旧账带进 1.0.3。

- 证据按测试卡 §4 字段（`条款ID / 档位 / 判定方法 / 命令+输出行 / 结果 / 环境 / 未覆盖`）；A 类必须可复跑，B 类写「待用户验收」。
- 回滚：本单不改数据格式；如出现误删，回退版本即可，记忆条目保留在文件层可人工恢复。

### 版本语义（本单确认）

| 版本 | 内容 | 状态 |
|---|---|---|
| 1.0.1 | 已发布（`v1.0.1`） | 已发 |
| 1.0.2 | 六条候选 | **已关闭（2026-11-11 用户裁定），不复用编号、不发布** |
| **1.0.3** | 记忆"读得出"修复 | **已发布 `v1.0.3`@`9d62299`**（包 SHA256 `FD52A159…012034`） |
| **1.1.0** | **本单 `REQ-20261114-02`：宿主兼容放宽（0.2.2 线）+ #4 生成侧标题收口 + D2 压缩百分比数字输入**（D2 由用户 2026-11-14 当场并入） | 开发中（`4eaacc7` 那版**不含 D2、已作废**） |
| 1.2.0 | **待定，不预设内容**（原"D2 顺延 1.2.0"作废） | — |

---

## REQ-20261114-02 上下文治理插件 1.1.0 —— 宿主兼容放宽 + 生成侧标题收口 + D2 用户面

> **来源**：用户 2026-11-14 选 A（**先出 1.1.0：放宽 `engines` + 收 #4，再升宿主本体**），经 00 转达。**版本号由需求裁定：`1.1.0`。**
> **范围变更（2026-11-14 用户当场否决"D2 顺延"，原话「D2 合到 1.10 里面去，让需求重新出文档」）**：**D2 用户面（压缩百分比数字输入）并入本单 1.1.0**，不延后到 1.2.0。**本条覆盖此前任何"不含 D2 / D2 顺延 1.2.0"的表述。**
> **前置**：1.0.3 已发布（`v1.0.3`@`9d62299`；包面锚 `44d0059`；测试 `TEST-2026-11-14-06` 全过）。
> **条款可判定性**：按需求卡 §11 标档（A=可复跑/`文件:行`，B=观感/需用户，C=环境前置）；**缺档 = 没有验收标准**。

### 一、版本号裁定：`1.1.0`（不是 `1.0.4`）

1. **改的是对外兼容承诺**（`engines` 区间 + 自检矩阵），不是内部补丁——叫 `1.0.4` 会掩盖"可以升宿主了"这件事，也会让 `1.0.x` 里同时存在两套不同宿主承诺；
2. **用户既定路线**是 1.1.0 = 宿主升级适配，把适配塞进 patch 会让版本语义漂移；
3. **#4 单独发 patch 无发布价值**（改的是标题文案），并入 minor 省一轮门序；
4. **D2 用户面并入本单（2026-11-14 用户当场裁定）**：数字输入设置页随 1.1.0 一起交付；**不再保留"1.2.0 = D2"的占位**（`1.2.0` 另议，不预设内容）。用户要的是"能直接填压缩百分比"，不是再用 `/cg set` 记参数。

### 二、范围（**四件**；四件全完成才允许出包/打 tag）

#### ① 宿主兼容区间放宽（P0）

- `packages/dsh-context-governance/package.json:38` `engines.dsh` →
  `">=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.3 <0.3.0-0"`
- `src/compress/adapters.js:31` `DEFAULT_MATRIX.host` → 两项数组
  `['>=0.2.1-rc.2 <0.2.2-0', '>=0.2.2-rc.3 <0.3.0-0']`（`matrixStatus` 逐项 any-match，见 `:103-112`）
- **单一真源校验**：新增测试断言 `package.json.engines.dsh === DEFAULT_MATRIX.host.join(' || ')`，防两处漂移（COMPAT-03 教训：两区间不一致 → 自检 fail → 静默 `observe-only`）
- **为什么必须"双区间"而不是 `>=0.2.1-rc.2 <0.3.0-0`**：**npm/宿主侧的 `engines` 判定走 node-semver 规则**——带 prerelease 的版本，只有在同一 `[major,minor,patch]` 的比较符也带 prerelease 时才算满足；单段里没有 0.2.2 线的 prerelease 比较符，`0.2.2-rc.3` 会被判**不满足**（开发实测：`0.2.2-rc.3 > 0.2.2-0`，故 `<0.2.2-0` 也挡它）。这是技术原因，不是风格选择。
- **我们自己的 `satisfiesRange` 不套这条规则**（`:80-101` 只是逐 token 比较）：对 `>=0.2.1-rc.2 <0.3.0-0` 它其实**会**放过 `0.2.2-rc.3`。所以矩阵也必须写两项，否则"两处一致"只能靠人；一致性断言按 `join(' || ')` 字面比。
- **不跟随 `dsh-context@0.84.1` 的 `">=0.2.0-rc.2 || >=0.2.1-rc.2 || >=0.2.2-rc.1"`**：它的第二、三段**无上限**，等于把 0.3.0+/1.x 全放进来。我们是贴宿主压缩引擎与记忆路径的插件，未验宿主上跑等于静默降级/误判；`engines` 按本单口径维持**双侧有界**，不跟它对齐。**engines 组以本单字符串为准。**
- **下界取 `rc.3` 而非 `rc.1`**：`engines` 是安全契约，只声明**实测过**的版本；`0.2.2-rc.4+` 与 `0.2.2` 稳定版都自动落进区间（`0.2.2 ≥ 0.2.2-rc.3`），`rc.1/rc.2` 维持拒绝。
- **上界 `<0.3.0-0`**：挡住 0.3.0 线；注意 `0.3.0-0 < 0.3.0-rc.1`，所以 `<0.3.0-0` 连 `0.3.0-rc.x` 一并挡住。
- **同仓一致性**：`packages/cg-stub/package.json` 的 `engines.dsh` 是单段 `<0.3.0-0`，与本包不一致；**≤1 行改动就同批统一**，超过则登记不阻塞。
- **`satisfiesRange` 不支持 `||`**（据 `:80-101`：按空格切分、逐 token 全真才真）→ 引擎串里的 `||` **不得**喂给它；区间判定只走矩阵数组。若出错，按"矩阵掉一项"处理，不得改成放宽 `satisfiesRange`。
- **版本号**：`package.json:3` `"version"` → **`1.1.0`**；若有测试/常量断言插件版本（`readPackageVersion()` 派生），同批核对；`README`/`docs/兼容矩阵-1.0.md`/新建 `docs/1.1.0-发布说明-草稿.md` 同批更新，**不回收 1.0.x 历史文档**。

#### ② #4 生成侧标题收口（P1；口径已签，见 `:1006-1011`）

1. 统一兜底文案 **`回滚点（见 source）`**：`protection-memory.js:162`（正常兜底）与 `:43`+`:166`（5c 截断兜底）**必须同文案** → `1009`≡`1010`，5b 自然兜住；**禁「（指针见正文）」**（`detail` 允许为空，见 5a）；
2. 批次条目：**`statePath`/`ratios` 都空才不发**；有 `statePath` 发 `批次 STATE：<path>`，有 `ratios` 发 `批次进度：<ratios>`；
3. 用户消息标题：在 `protection-memory.js:92-97` 对**原始标题** `slice(0, 80)` 后再拼前缀；`detail` 走 `coverageText` **全文保留**；`protection.js:116/275` 的 200 预算**不动**；
4. 测试同步：`test/memory-1.0.3.test.mjs:271` 断言更新为 `回滚点（见 source）`，`:257` 的 `startsWith('回滚点')` 保留；
5. **不变量**：不动准入、不动 5b、**不降** `TITLE_PREFIX_MIN`、**不调** `confidence`。

#### ③ flake 取证（P2，不阻塞发布）

- 事实：`analysis/req-20261025-12/review-1.0.3-20261114.md:20` 记"更早 3 次全量跑各 1 例失败、**失败名未捕获**、此后未复现"，其后连续 10 次 `535/535`。
- 要求：**先取证再谈修**——全量跑 **30 轮**，逐轮留输出文件（失败 test 名 + 退出码 + 首错栈），禁止只写"未复现"；
- 若复现：定位并修，修法并入本单 A 档条款；
- 若 30 轮全绿：**关为观察项**（写"30 轮全绿 + 取证目录路径"），**不阻塞发布**；
- 禁止用"加重试/加 sleep"掩盖；若定位到时间依赖，必须给稳定化方案。

#### ④ D2 用户面：压缩百分比数字输入（P1，**用户明确要求，必须进本单**）

**目标（一句话）**：用户不记命令、不查参数，**在输入框附近直接填一个百分比数字**就能改"窗口用掉多少就压缩"。

> **入口形态定稿 = A（2026-11-14 00 定；用户唯一约束「要友好、别藏在设置页」）**：调查见 `analysis/req-20261114-02/D2-入口形态调查-20261114.md`（证据 `d2-evidence2/`）。
> - **主入口**：`conversation.composer.dock`（**输入框下方统计行**，现有 `activity`/`usage` 两条即是）注册一个条目，显示 **`压 65%`** 形态的当前有效百分比。
> - **展开**：点击 → `conversation.input.overlay` 气泡（以输入框为锚），内容 = ①百分比数字输入（预填当前值）②当前生效值 ③来源层 ④生效时点 ⑤"打开设置页"兜底链接。
> - **写入**：`configForms.get('dsh-context-governance').set('policy.at', ratio)`（plugin 层，配置 reload 后生效）；**拒绝理由必须与 `/cg set` 同源**（下限 20%、`<30%` 需 `lowThresholdAck`、项目层 45%、`native−0.02` 上限）；保存成功后气泡与 chip 同步刷新。
> - **兜底**：`20bf20d` 的 `settings.section` **保留不废**（同一份数据、同一写入口）。
> - **禁止**：不改 host 侧、不加新路由、不引打包器/依赖、不动 `package.json.files` 语义（除 A 已有内容）；**只改 `lib/client.js` + 测试/文档**。
> - **降级鲁棒**：快照取不到或 slot 不存在时，chip 显示 `压 —`、控制台不抛错、设置页仍可用。
> - **与 `/cg` 双向保留**：UI 写 **plugin 层**（profile patch，`config-reload` 后生效）；`/cg set` 写 **session 层**（即时、重启失效）；气泡/设置页都显示 `source` 层，两条路并存。
> - **选形已结束，按此实现；实现后我验 C8-C15，再报 00"可装"。**

> **形态裁定（2026-11-14，调查结论：`analysis/req-20261114-02/D2-UI能力调查-20261114.md`）**：
> - **可行路径 = 自建 client 半侧**：`package.json` 加 `dsh.client={platform:'web'}` + `exports["./client"]`，**手写** `lib/client.js`（`window.__ModuleLoader__.load({id,factory})` 格式，**不引入打包器**），注册进设置页槽位 **`settings.section`**；宿主半侧加 Schemastery `Config` 的 **`.volatile()`** 字段（**只有 volatile 字段可被设置表单编辑**）。
> - **"只声明配置、设置页自动出表单"不可行**：宿主有 `autoGenerate`，但 `dsh-settings` README 明说**没有已发布的客户端渲染它**——必须自带页面。
> - **"生效值/来源层"取数**：用宿主 `ctx.webServer.register` 加一条 **loopback GET**（与 `cost-meter`/`computer-use`/`notify-me` 同模式）；**不加则该判据降级为"显示 plugin 层值 + 提示看 `/cg status`"**，需我书面收窄。
> - **不需要**：打包器、独立端口、WebView。**必须避免**照抄第三方 `dsh.client.inject` 名单——本机 0.2.1-rc.3 未发布 `dsh-client-ui-slots`/`ui-primitives`，而 `cost-meter` 不写 inject 也能挂 `settings.section`。
> - **剩余风险**：手写 bundle **离线无法验真实渲染**（只能验语法/纯函数/渲染输出）；必须在窗口 R7 真机验；若要在出包前验，需用户批准"装 dev 包"一次（红线 1，不自行装）。

- **形态**：**数字输入框优先，不做滑块**（宿主将来给 range 控件再升级）；只暴露 **`compact.at`** 一个参数（其它键仍走 `/cg set` / 配置文件，本单不扩面板）。
- **量纲**：**UI 以百分比呈现（0–100）**——填 `55` = 窗口用掉 **55%** 就触发压缩；内部仍存比例 `0.55`（0–1），**换算只在 UI 层**，写入后各层/日志/审计里仍是 `0.55`。UI 上必须有量纲提示，防止被读成"窗口缩到 55%"。
- **必须显示**：**当前生效值 + 来源层**（`builtin`/`profile`/`plugin`/`project`/`session`），并标明**「本会话有效」**还是**「重启后失效」**（会话级 `/cg set` 只存进程内存，见 `src/commands/cg-status.js:407` 一带）。
- **校验复用现有规则，UI 不得另立口径**：绝对下限 `AT_MIN=0.20`；`<0.30` 需配置文件 `compact.lowThresholdAck=true`；项目层下限 `PROJECT_AT_MIN=0.45`；上限 = 动态 `native − 0.02`（`native` 不可计算时拒绝）；越界必须给**与 `/cg set` 一致的人话原因**，不许静默改值。
- **层可见**：UI 改的是**哪一层**（配置层/项目层/会话层，按实现取其一或可选）必须写在界面上；不允许"改了却说不清哪层生效"。
- **生效时点必须说清**：改完是**立即生效**还是**需重启**，界面明写；若需重启而没重启，`/cg status` 仍显示旧值属正常，不得当 bug。
- **安全参数不进 UI**：`compact.estimateSafety`、`compact.lowThresholdAck`、`armed` **不**在设置页放开（仍只能配置文件/命令改）。
- **不改默认值**：默认仍是 `compact.at=0.60`（无观察时回退 0.6785 不变）；UI 只提供用户主动改的入口。

### 三、不做（边界）

- 不做滑块、不做多参数面板、**不在 UI 里放开安全参数**（见 ④ 末两条）；不改压缩策略/阈值/预算/header 注入；
- **不改记忆契约 §12 判据**（5a/5b/5c、计数细则、`:974-994` 全部不动）；
- 不动 `#admitEntry` 准入与写入原语守卫；不重开 1.0.2 候选；不碰 dsh-mnemon；
- 不为"近似重复"去改 5b 或降 `TITLE_PREFIX_MIN`。

### 四、判据（验收句写死，测试/审核照抄）

| # | 条款 | 档 | 判定方法 | 通过标准 |
|---|---|---|---|---|
| **C1** | 区间单一真源 | A | 单测：读 `package.json` 与 `DEFAULT_MATRIX` | `engines.dsh === DEFAULT_MATRIX.host.join(' || ')`（含顺序） |
| **C2** | 区间语义 | A | `satisfiesRange` 参数化用例 | `0.2.1-rc.2/rc.3/rc.4/0.2.1` **in**；`0.2.2-rc.3/rc.4/0.2.2` **in**；`0.2.2-rc.1/rc.2`、`0.1.9`、`0.3.0-rc.1`、`0.3.0` **out** |
| **C3** | 自检不误伤 | A | `selectMode`/`selfCheck`（`selection.js:47` 同类断言） | 宿主 `0.2.2-rc.3`：`matrix.host='in'`、无 `host-version-out-of-matrix`、`mode ≠ observe-only`；宿主 `0.2.2-rc.1`：出该 error |
| **C4** | 宿主版本探测 | A | `detectHostVersion` fixtures + **版本源一致性** | 从 0.2.2-rc.3 形态的 asar/包读回 `0.2.2-rc.3`，失败落 `unknown`（不抛错）；**探测源必须与门禁源一致**（门禁用 app-boot 的 version，见探针 #6）：本机两者同为 `0.2.1-rc.3`，真机窗口须记录两值；若 0.2.2 线上两者不同，**以 app-boot（门禁源）为准**并补用例 |
| **C5** | #4 三项 | A | 单测 + 生成侧快照 | 兜底文案 `回滚点（见 source）`；`statePath`/`ratios` 都空不发、单有其一照发；用户消息标题 ≤87 字且 `detail` 含全文 |
| **C6** | 全量回归 | A | `node --test "test/*.test.mjs"` | 通过（**基线 `539/539`**（`4eaacc7` 那版，含 engines+#4 新增 4 条）+ D2 新增用例；数字以复跑为准） |
| **C7** | flake 取证 | A | 30 轮全量循环 + 留档 | 复现则修；30 轮全绿则关观察项（附取证目录） |
| **R1** | 真机加载 | C | 重启后**第一步先验插件是否加载**（`/cg` 命令是否存在），再跑 0.2.2-rc.3 装 1.1.0（00 执行、用户在场） | `/cg` 命令存在且 `/cg status` 的 host 行 = `0.2.2-rc.3`、矩阵 `in`、**非 `observe-only`**；**命令不存在 = 插件被静默跳过 → 直接判不过**（GUI 下跳过无声，见探针 #6） |
| **R2** | 真机 #5 | C | 两次真实压缩 | 5a/5b/5c 全过（沿用 `:974-994` 口径），必须给「前后条目数 + 新增 `title`/`detailLen` 清单」 |
| **R3** | 文案落地 | C/A | 真机窗口新增条目 | 无「（指针见正文）」、无「有批次标记」；用户消息标题 ≈≤87 字、`detail` 有全文 |
| **R4** | 记忆可读回 | C | 压缩后读盘/`/cg status` | 条目数正常增加、无 0 条/截断；旧条目仍可解析 |
| **R5** | 双插件共存不重复触发 | C | 真机窗口回归（`dsh-context@0.84.1` + 本插件同时在场） | 一次压缩只产生**一轮**保护写入/回注（按审计行计数：同 cycle 不出现双份 `memory-store-open`/`header-injected`）；升级前后各取一次基线对比 |
| **R6** | 单写者锁不误判 | C | 同 G 根多会话并发 | `memory-store-readonly writer-lock:<pid>` **属设计内**（只读不写、不抢锁），**不得记缺陷**；真机能写回那次须成功 |
| **B1** | 标题可读性主观 | B | 用户看真机窗口输出 | 用户判断（不计 A，不当阻断项） |
| **C8** | D2 显示生效值+来源层 | A | 渲染/组件单测 + 文案断言 | 界面同时给出**当前生效值**（比例与百分比可互相换算）与**来源层**（`builtin`/`profile`/`plugin`/`project`/`session`），并标「本会话有效」或「重启后失效」 |
| **C9** | D2 百分比换算与边界 | A | 单测（UI 层换算函数 + 校验） | `55 → 0.55`、`20 → 0.20` 通过；`19` 被拒；`<30` 且无 `lowThresholdAck` 被拒；项目层写 `<45` 被拒；`> native−0.02` 被拒；拒绝文案与 `/cg set` 一致 |
| **C10** | D2 不绕过安全边界 | A | 单测 + 写入口审查 | UI 写入必须经现有 `validateLayer` 同一路径；`compact.estimateSafety`/`compact.lowThresholdAck`/`armed` **在 UI 中不可写**；不存在"UI 特批"分支 |
| **C11** | D2 层与生效提示 | A | 文案断言 | 界面写明"改的是哪一层"与"立即生效/需重启"；缺任一句判不过 |
| **C12** | A 主入口（输入框下条目） | A | 注册形状单测 + 渲染文本 | `conversation.composer.dock` 注册项形状正确（唯一 id、order、返回 React 节点）；渲染文本为 `压 NN%`，**数值与快照 `at` 一致**；快照失败时渲染 `压 —` 且不抛错 |
| **C13** | A 气泡三行信息 | A | 渲染文本断言 | 气泡含「当前生效 / 来源层 / 生效时点」三行，值取自快照 `{at, source, effectiveAt}`，与 `/cg status` 口径一致；含"打开设置页"兜底链接 |
| **C14** | A 保存路径与拒绝 | A | 纯函数 + 单测 | 保存调 `configForms.get('dsh-context-governance').set('policy.at', ratio)`；`55→0.55`；越界（<20、<30 未 ack、项目层 <45、>native−0.02）**拒绝理由与 `/cg set` 同源**；成功后 chip/气泡刷新 |
| **C15** | A 降级鲁棒 | A | 单测 | slot 缺失/快照 4xx/`configForms` 不可用时：不抛错、chip 退化、设置页仍可用（不得整卡崩） |
| **R7** | D2 真机走查 | C | 用户在场，**在输入框下点 chip 改一次百分比**（例：60 → 55），并可再去设置页复核 | chip 与气泡显示改后生效值+来源层；`/cg status`/审计显示 `compact.at=0.55 (source=…)`；**留截图/原文**；若 chip 没出现→判不过（不是"环境问题"） |
| **R8** | D2 不伤压缩链路 | C | 改阈值后触发一次真实压缩 | 压缩正常执行、保护/回注不退化（审计无异常）、`/cg status` 无 `observe-only` |

> **窗口基线（开发实测，2026-11-14 提供）**：本机 desktop `desktopVersion=0.2.1-rc.3`（`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json`，node `24.21.0`）；已装 `dsh-context@0.84.1` + 治理 `1.0.3`；治理源码与 `44d0059` **SHA256 逐字节一致**（真机跑的就是返修版）；治理审计最新 `2026-11-14T14:21:32Z memory-store-open G根 count=2`；工具名无碰撞（治理 `mem_write`/`mem_query`）。**R5/R6 的"升级前后基线"就用这份。**

- **验收句（给测试/审核的原话）**：
  - 「`engines` 与矩阵同区间；`0.2.2-rc.3` 判 in、`0.2.2-rc.1` 判 out、`0.3.0-rc.1` 判 out。」
  - 「`0.2.2-rc.3` 真机上插件加载后 `/cg status` host=`0.2.2-rc.3`、矩阵 in、非 `observe-only`。」
  - 「两次真实压缩后：无『（指针见正文）』、无『有批次标记』、用户消息标题 ≤87 字；5a/5b/5c 全过并附 `title`/`detailLen` 清单。」
  - 「设置页能填压缩百分比（`55 → 0.55`），显示**当前生效值 + 来源层**与「本会话有效/重启后失效」；越界（`<20`、`<30` 未 ack、项目层 `<45`、`> native−0.02`）被拒并给与 `/cg set` 一致的原因。」
  - 「UI 里改不动 `estimateSafety`/`lowThresholdAck`/`armed`，且写入与 `/cg set` 走同一校验路径（无 UI 特批）。」

### 五、交付序

**四件全完成才允许出包/打 tag。** 需求单（本段）→ **开发实现 + 自测**（全量 + C1-C11）→ **需求验 C8-C11 定向用例** →（用户批的例外）**本机 UI 预验**（`tasks\GRANT-20261114-03`，00 装/回退，不升宿主）→ **测试独立复跑**（锚 commit + 宿主版本 + profile）→ **审核复核 + 打包**（包面 = commit 逐文件、SHA256 留档；`tag` 前用户批）→ 发布（`tag`/Release 用户批）→ **之后才升 DSH**（升完只做"简单可用性看一遍"）。

> **流程原则（用户 2026-11-14 追加，本单起强制）**：
> **「这种肯定别人做过类似的事，我们不要重复造轮子」**——任何技术方案**先查官方机制与已装插件先行者，再决定实现**；**调查结论必须落盘到 `analysis\`**，不得只凭推断动手。**样板 = `analysis/req-20261114-02/D2-UI能力调查-20261114.md`**（宿主 README/源码 + 5 个已装插件实证 + 最短路径 + 不可行项）。违反此原则的方案退回重查，不进入实现。

> **排期（用户 2026-11-14 批）**：**① 先验当前版本**（含 D2 的开发版 1.1.0 临时装本机看 UI）→ **② 1.1.0 稳定并发布** → **③ 再升 DSH**，升级后**只做"简单可用性看一遍"，不重复完整真机矩阵**。
> - **①的凭证**：`tasks\GRANT-20261114-03-D2开发版本机UI验收.md`——只允许 00 把**开发版 1.1.0（含 D2）**临时装进 profile 看真实渲染、重启一次、验完**立即回退 1.0.3**；**不升宿主、不 push/tag、不记作 R1-R8 证据**；前提是 D2 完成 + 开发自测过 + **需求验过 C8-C11 定向用例** + `version=1.1.0` 且 `lib/client.js` 存在。
> - **③的口径**：升级后的"简单可用性"= `/cg` 命令存在 + `/cg status` 正常 + 设置页能改并生效 + 审计正常；**R2 的完整 5a/5b/5c 矩阵不再重复**（以 `TEST-2026-11-14-06`@`44d0059` 的真机结果为准）。

> **D2 并入后的现状（2026-11-14 需求裁定 + 用户当场喊停升级）**：
> 1. 已出的 `dist\dsh-context-governance-1.1.0.zip`（锚 `4eaacc7`、SHA256 `BBB2F49E…`）**就地作废**——它不含 D2，不代表 1.1.0 交付物；**不得 `tag`/`push`/Release**。
> 2. **本体 `0.2.2-rc.3` 本轮不升**（用户 2026-11-14 两次明确：「不要升级，升级前先把 D2 做掉」）。升级任务已删、安装器**未运行**、exe 仍 `0.2.1-rc.3`；00 已把 profile 里那版**不含 D2 的 1.1.0 回退成 1.0.3**。**本单 §五 里"升级继续 / R1-R6 只作 engines 证据"的旧表述作废。**
> 3. **R1-R6 本轮不做**；含 D2 的 1.1.0 先走"①本机 UI 预验"（凭证 `GRANT-20261114-03`，**结果不作 R 证据，只作可用性结论**）；1.1.0 发布后升 DSH 时，窗口按上面"③的口径"**只做简单可用性，不重复完整矩阵**。
> 4. **回滚点**：`v1.0.3`@`9d62299`；预验期回退备份 `_backup\20261114-dsh-0.2.2-window\governance-1.0.3\`。
> 5. **当前判定基线**：本机宿主 `0.2.1-rc.3` + 治理 **1.0.3**（已回退），D2 在离线环境开发与验证；**不动宿主、不动已装插件**，直到 D2 自测过且需求验完 C8-C11。

**窗口物料（00 已备，2026-11-14 22:30；**本轮暂不使用**，重开窗口时再用；明细见 `G:\DS-HARNESS\tasks\TASK-20261114-02-本体升级-0.2.2-rc.3.md`）**：

| 项 | 值 |
|---|---|
| 0.2.2-rc.3 安装包 | `D:\DS-PROJECT\_shared\installers\deepseek-harness-0.2.2-rc.3-win-x64.exe`（299,595,752 B） |
| 校验 | SHA512(base64) `GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==`（与 `nightly.yml` 逐字节一致） |
| 回滚 installer | `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\installer.exe`（276 MB，`FileVersion 0.2.1-rc.3`） |
| 冒烟必看 | `/cg status` 存在；审计 `governance apply version=1.1.0`；`early-decision threshold=0.45` 有行；`plugin list` **无跳过** |

- **顺序不可颠倒**：**先装 1.1.0（在 0.2.1-rc.3 上仍兼容）→ 备份 profile → 再升本体**。反序会让 1.0.3/旧版在本窗被 engines 拒载、压缩与审计停摆、窗口数据断。
- **失败回滚路径**：`0.2.1-rc.3` installer 覆盖 → 重启 → 复核 `governance apply version=1.0.3` 恢复；回滚后本次窗口数据作废，重开窗。

### 六、风险与回滚

- **R-1 放宽放错**：真机出现 `observe-only` 或压缩异常 → **立刻回退区间到 1.0.3 口径**（单 commit revert），不挂 waiver；
- **R-2 0.2.2 线宿主行为变化**（asar 路径/版本格式/引擎访问器签名）：探测失败应当落 `unknown`（warn，不 fail），但 **R1 必须显式看到 `0.2.2-rc.3`**，不能用 warn 蒙过去；
- **R-3 #4 改文案影响去重**：`回滚点（见 source）` 会让原先未合并的 `1009`/`1010` 合并——**属预期**，不得反向把 5b 改成"近似合并"；
- **R-4 D2 的三类翻车点**（出包前必须逐条排除）：① **绕过校验**——UI 直接写 policy/store，跳开 `validateLayer`（判 C10 不过）；② **量纲错位**——把 `55` 写成 `55`（比例 55）或把 `0.55` 当百分比显示（判 C9 不过）；③ **生效时点误导**——需重启却提示已生效（判 C11 不过，且会引发"改了没反应"的误报）。D2 失败**不得**用"先发出去再修"处理，属用户可感知功能。
- **回滚点**：`v1.0.3`@`9d62299`；回滚 = `git revert` + 重装 1.0.3；**数据格式未改**，记忆条目在文件层可人工恢复。

### 七、前置探针（开工前必须给结论，缺一不开工）

1. 三处硬点准确位置并确认无遗漏：`package.json:38`、`adapters.js:31`（注释 `:26-27` 同改）、`selection.js` 相关文案；全仓 grep `0.2.1-rc.2` / `0.2.2-0` 给清单（已知 src 内只有 `adapters.js` 两处）；
2. **确认 `satisfiesRange` 确实不支持 `||`**（据 `:80-101` 判断），并说明双区间只通过矩阵数组生效；
3. 现有用例影响面清单：`compress-adapters.test.mjs:78-82`（区间断言）、`compress-selection.test.mjs:47/110`、`p3-early-window` 等是否被波及，逐条列"必须改/不改"；
4. 文档同步清单（只改当前生效的）：`packages/dsh-context-governance/README.md:8`、`docs/兼容矩阵-1.0.md:11`、发布说明（新建 `1.1.0` 版，不回收 1.0.x 历史文档）；
5. 真机窗口前置：0.2.2-rc.3 宿主包路径与安装方式由 00 准备；本单不自行升级宿主。
6. **"引擎门禁"要有证据，不能只推断** —— **已裁定：接受现有证据，P0 开工（2026-11-14 需求裁 A）**。证据由开发给出并满足下列三类，缺一类不许开工：
   - **代码路径**：`app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` `:271-278 getDshRuntimeVersion()`（取 app-boot 自身 version）、`:311-316 evaluatePluginCompatibility()`（未满足→返回 `engines.dsh` requirements）、`:1015-1051 loadProfileDirectory()`（不兼容 bundle 被 `throw`→`skippedBundles`，其 patch 层不加载）、`:537-538` 跳过行格式、`:333-335` 异常模板；安装路径另有 `dsh-plugin-manager/lib/index.js:1759/2076/2288` 抛 `incompatible-version`；
   - **真 semver 判定**：宿主用 `semver.satisfies(v, range, {includePrerelease:true})`（app-boot `:15`）；实测旧区间对 `0.2.2-rc.3/rc.4/0.2.2` 全 false，新签版区间全 true，`0.2.2-rc.1/rc.2`/`0.1.9`/`0.3.0-rc.1`/`0.3.0` 全 false（semver 7.8.5，本机 profile 的 node_modules）；
   - **当前宿主在跑同一路径**：本机 governance 就在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里、manifest 带 `dsh.bundle`，即走上面的跳过路径。
   - **风险记死**：桌面 GUI 下跳过**基本无声**（stderr 行由 CLI 打印）→ 这是"必须放宽"的理由，也是 **R1 要先验 `/cg` 命令是否存在**的理由。
   - **仍缺的真日志**（0.2.2-rc.3 宿主上的实际跳过行）**不阻塞 P0**，但**必须在 R1 补齐**：窗口日志里要能找到该跳过行（升级前）或确认无跳过（升级后）；补不到则 R1 不算过。
7. **#4 三项的改动面确认**：开发称只动 `protection-memory.js` + 一条测试；需逐条对应到 `文件:行`（`:162` / `:43`+`:166` / `:135-153` / `:92-97` / `test/memory-1.0.3.test.mjs:271`），并声明全量 `535` 不变（新增用例另计）。
8. **D2 宿主设置面机制（P1 开工前必须查清）**：本插件当前 **无 `Config` schema、无 `dsh.client`**（`src/index.js:9` 注释「Schemastery 表单留到 T3」）。请查明并给出**最小可用方案 + `文件:行`**：
   - 宿主设置页从哪读插件项（`ctx.settings`？Schemastery `Config`？`dsh.client` 前端资源？），哪些是 0.2.x 已支持的；
   - 需要新增哪些声明（`package.json` 的 `dsh` 字段/前端入口/静态资源），**对打包清单 `files` 的影响**（当前只发 `src/`+`README`+`cordis.patch.yml`，若加前端资源必须写清）；
   - 是否支持"显示当前生效值 + 来源层"（policy 链已有 `source` 信息，见 `/cg status` 实现），还是需要额外读 policy；
   - 不做前端框架自造：若宿主没有可用设置面，**先报我**，不要自建 WebView/独立页面。
9. **D2 写入层与生效时点**：查明 UI 写入的是哪一层（profile 插件配置 / 项目 `.cg-policy.json` / 会话），**是否需重启生效**；若只能写"需重启"的层，界面上必须明写（C11）。同时确认写入后 `/cg status` 的 `source` 会显示该层。
10. **D2 测试影响面**：新增 C8-C11 用例清单 + 现有用例是否被波及（例如 `/cg set` 校验函数被 UI 复用时，需保证错误文案不变）；全量基线当刻 `539/539`，改后数字以复跑为准。

> **开发回执（2026-11-14，探针 1-7 已交，事实与上述一致）**：三处硬点 = `package.json:38`、`adapters.js:26-27/31`（`matrixStatus :103-114`）；`selection.js` 无版本字面量不用改；`satisfiesRange` 确认不支持 `||`（token `||` → `compareSemver` null → false）；用例影响面"必须改 `compress-adapters.test.mjs:76-94`，`compress-selection.test.mjs:43-48` 等不改"；`cg-stub` 共 3 行（`package.json:36` + `README:22/137`）→ **登记不阻塞**（非产品包、不随 1.1.0 发布，下个版本统一）；#4 改动面逐条确认（`:162`、`:43`+`:166`、`:134-153`、`:92-97`、测试 `:271`），当刻全量 **535/535**。
>
> **窗口证据（R1 配套，写死）**：`/cg` 命令存在 + `/cg status` 原文 + **`dsh plugin list`（或 GUI 插件清单）原文/截图**三方留档——GUI 下插件被跳过是**无声**的，没有清单证据就不算"加载过"。
