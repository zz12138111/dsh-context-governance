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
- 状态：待评估 / 已排期 / 开发中 / 待审核 / 已验收 / 挂起
```

---

## REQ-20261025-01 上下文治理插件 M1 —— 压缩前后不断线

- **依据**：`docs/上下文治理插件-架构说明-v1.1.md`
- **背景/痛点**：长会话压缩后，任务状态、决策、批次进度容易丢失；已定的事被重问；换会话或定时唤醒接不上。M1 先解决“不断线”，不追求省 token。
- **目标（可验收）**：
  1. 单插件、对宿主零硬依赖；对宿主默认与 context-zip 两种后端保持**事件级契约一致**（provider 层在本 scope 不可得，见验收 ⑤）。
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
  - ⑤ **双后端（事件级）**：两种后端共用同一事件契约；真机实测为 **context-zip**（redirect 接管 `compaction-basic`），宿主默认未单独跑；**provider 路径不可用**（本插件 scope `get.compaction(strict=false) → undefined`，见 `REQ-20261025-03` 结案），因此不替换用户现有配置、也不参与 provider 选择；没装 context-zip 时自动用宿主默认。
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
- **状态**：已排期（待 00 派开发；与 M1.1 T1 并行，不互斥）
- **背景/痛点**：M1 真机上 `tokensBefore/After` 恒 `null`、能力行 `compaction=absent`，此前按“宿主限制”接受。复查后分成两类：
  1. **确为插件侧问题**：`ctx.tokenMeter` 在 apply 时读一次并缓存（`runtime.js:189-195`），没走 `ctx.inject(['tokenMeter'], …)`；服务晚注册就永久为 `null`。宿主 `@deepseek-ai/dsh-token-meter` 由 `dsh-base` 默认挂载，确实存在。
  2. **不是探测时机问题，且已定性（2026-10-25 真机结案）**：`capability@apply`（20:34:54）与 `capability@ready`（20:35:54）两行都是 `compaction=throws`、`get.compaction=absent`；后续 `get.compaction(strict=false)` 在 `@apply`（13:18:10Z）与 `@ready`（13:18:23Z）**均返回 `undefined`** → **本部署插件 scope 根本没有提供 `compaction` 服务**（若“有 impl 未 active”会返回 `obj`）。**根因已定位**：preset 组 `isolate.compaction: true`（`dsh-web-app/presets/standard.patch.yml`），压缩服务被隔离在 preset scope。结论：插件不依赖它，压缩观测走 `session/event`；**「回注时点修正」在该部署下不可行**，只能走事件时序推断（现方案）。另：`get.tokenMeter=obj` 稳定，M1.2 延迟获取路径无问题。
  3. 兜底证据：真机会话日志中 `assistant/message` 1199/1199 带 `usage`（样本 `inputTokens=20662 / cacheReadTokens=2432 / totalTokens=23321`），压缩前后水位可实测。
- **目标（可验收）**：
  1. **成本实测**：`tokensBefore/After` 优先 `ctx.tokenMeter`（延迟注入或按需取，成功后缓存），失败退回 `assistant/message.usage`，仍取不到才 `null` + `unknown`。
  2. **探测修正**：能力探测由“apply 一次”改为「apply 记 `capability@apply` + 首个会话事件后补 `capability@ready`」两行审计，不得因时序把可用服务记成 absent。
  3. **口径可追**：新增 `tokensBeforeSource` / `tokensAfterSource`（`tokenMeter` / `usage` / `none`），`auditVersion` 升 `cost-v1.1`；**只增字段、不改已有字段语义**，旧解析器仍可用。
  4. **provider 结论（已结案，2026-10-25）**：本部署下 `get.compaction(strict=false)=undefined`（`@apply` 13:18:10Z / `@ready` 13:18:23Z 一致）→ **该 scope 未提供 `compaction` 服务**。因此 **「回注时点修正」在该部署下不可行**，只能走事件时序推断（现方案）——**这是结论，不是待查项**。本轮不改压缩后端、不替换 provider；若未来宿主或部署方式变化，重新探测即可，但不再作为 M2 的前置期待。
- **影响与定案（2026-10-25，`DEC-20261025-48`）**：**不改 `isolate.compaction`**（宿主 preset 作用域隔离，属设计行为）。理由：宿主压缩行为/压力阈值/审计时序均不变；`cordis provide` 同 scope key 重复注册会抛错（`@local/dsh-computer-use/presets/cordis.patch.yml` 有两处 compaction 组）；插件侧 `get.compaction` 变 `obj` 会使 mode 由 `event-level` 变 `full`（保护失败会进 `degraded-protection`）；收益≈0。**「回注时点修正」不可行，不再作为 M2 前置期待；M2 不依赖 provider。** 如需验证 provider 路径，只允许在**隔离 profile 实验**里进行，标注为实验、不在主线。
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
- **状态**：已排期（待 00 派开发）
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
- **状态**：已排期（待 00 派开发）
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
- **状态**：已排期（待 00 派开发）
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
- **状态**：已排期（00 已直派开发，此单用于账本一致）
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
- **状态**：已排期（00 已直派开发，此单用于账本一致）
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
- **状态**：已排期（**首批只派 0.2.0 策略层 + G1 门禁**，等 00 投递）
- **版本**：0.2.0（策略层）→ **0.2.1（窗口/校验层，不执行压缩）** → 0.2.2（提前压执行）→ 0.2.3（成本账本）
- **背景/痛点**：M1 解决“不断线”；M2 解决“**什么时候压可控、压了值不值能算**”。用户原始诉求是**提前压缩、去掉过时信息**。宿主原生触发点 ≈67.85%（preset `0.8 + 65536`，patch 层无效），我们只在它之前动手，**不包装宿主决策点**。

### 目标（可验收）

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
| `compact.cooldownMin` | 两次压缩最小间隔 | `10` 分钟 | ≥1 | 是 |
| `compact.minDeltaTokens` | 距上次压缩至少新增 token | `20000` | ≥0 | 是 |
| `compact.estimateSafety` | 估算放大系数（专家项） | `1.35` | `1.0–1.6` | **否**（仅配置） |
| `compact.lowThresholdAck` | 允许 `<0.30` | `false` | bool | 否 |
| `cost.remainingTurns` | 账本剩余轮次覆盖 | `null`（历史平均） | null 或 ≥0 | 是 |

`compact.at > native` → 拒绝并提示“M2 不支持推迟”。`estimateSafety` 仅从配置文件读，注释式风险提示。

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

项目文件 `<project>/.cg-policy.json` 是**仓库可控输入，按不可信处理**：

- **P-A：禁止项目层设置 `compact.lowThresholdAck`**——出现即拒绝整层（该确认只允许在会话层由用户本人显式操作）；
- **P-A：`compact.estimateSafety` 不开放给项目层**——仅插件配置文件可设，项目层出现即拒（单列，不进项目白名单）；
- **P-C：项目层 `compact.at` 下限 `0.45`**——低于即拒绝该层；上限仍为动态 `native`；
- **拒绝语义**：**整层拒绝**（不逐键降级）+ `policy-invalid` 审计（`source=project`、拒绝键、原因），并回退到下一层生效；
- **可见性**：`/cg status` 必须显示“被拒的层与原因”，不能只写 audit（用户只看 status）；
- **不采用 B**：不加 `policy.allowProjectLayer` 开关，安全口径默认生效、不依赖用户手动开启；
- 恶意项目文件不得造成：阈值低于 0.45、自盖 `<0.30` 确认、静默降级。

### 窗口 W 的选取与校验口径（G4 结论，`DEC-20261025-65`）

> 事实：`contextPressure` 投影是 **per-session**，`native` 与策略是**进程级**；换模型/路由会更新窗口，`request/context` 不带 `contextWindow` 时会**删除旧值**。

**① 选取**：`native` 与 `/cg status` 的窗口用 **runtime 已有的 `#lastSession`（最近观察到的本项目会话）**；`window=` 后必须带 **session 短 id**（如 `window=1M (session 58a2e845)`）。多模型/多会话不取“最小窗口”做展示，展示用当前会话，校验用保守值（见③）。

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
- **0.2.2（提前压执行，前置 G2/G3 运行时验证）**：到点主动压一次（`early-forced` 审计、事件流完整）；`effective ≥ native−0.02` 不抢；失败不伤宿主；`early-aborted` 静默；长 turn 不打断；手动 `/cg compact now` 两步确认（冷却期 `--force`）；参数越界被拒。
- **0.2.3（成本账本）**：聚合 = 逐条求和；两实测数 + 假设行置顶的估算；`backend` 用 `cost-v1.4` 枚举（含 `none`）；未知保持 unknown；`/cg cost` 可查。
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

### 依赖/风险

- **依赖 `cost-v1.4` 基线**：0.1.16 已推；**建议等 0.1.17（枚举补 `none`）落定后再开始 0.2.2**；
- 提前压依赖 preset 引擎可见（G1），`ctx.compaction` 仍不可得（已结案，不期待）；
- 每压一次都是一次摘要调用，“更早压”= 更多摘要成本，文档必须写明；
- 与 `dsh-context` 不重复做图表，只做策略账本。

### 任务拆解

见 `TASKS/REQ-20261025-09-M2-拆解.md`（首批 T0 门禁 + T1/T2 策略层）。

---

## REQ-20261025-10 上下文治理插件 M3 —— 1.0 收尾（动作校验 + 新会话接续 + 发布就绪）

- **依据**：`docs/M3-需求草案-v0.4.md`（外部评审三轮通过）；`DEC-20261025-69`（**D-R1 = B**）；架构 v1.1 §7.2/§14；M1/M2 已交付能力。
- **优先级**：P0
- **状态**：已排期（待 00 派活，首批建议 0.3.1 header，因其不依赖门禁）
- **版本**：0.3.0（动作校验，依赖 G-M3-1）→ 0.3.1（header 默认开）→ 0.3.2（评测 + 发布就绪）→ **1.0.0**
- **定位**：补齐架构四支柱中唯一缺失的“校验”，并把“新会话接续”做成默认无感，达到 **1.0 = 功能基础齐备**。

### 红线

1. **公开动作需另行批准**：仓库公开、镜像/Release 发布一律走正式流程，**需求/开发/审核均不得自行执行**；
2. 不改 preset、不接管 provider、不装第二个压缩引擎；
3. 不安装/不重启 DSH（真机验证由用户执行）；
4. 不 push（远端操作由审核在复核通过后执行）。

### 目标（可验收）

1. **动作校验可用**：C1/C2/C3 三条固定检查项，执行前拦截并要求确认；**G-M3-1 失败则 1.0 不提供该功能**（不做事后告警）。
2. **新会话无感接续**：header **默认开**；有规则文件时只带动态状态；配额与预算受限；可关闭。
3. **“不重问”有证据**：≥3 场景（决定/待办/进度）证明压缩后模型使用记忆。
4. **可发布**：按 **D-R1 = B** 落地；干净历史导出能力具备；仓库无未脱敏真实内容；文档与实现一致；兼容矩阵与回滚齐备。

### 组成

#### 动作校验（§7.2）

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
- **六护栏**：预算；只取 `active` 且超 **14 天**（上限 30、可配）标 `[Old]` **仍注入**排末尾；空记忆/无项目**零注入**；冲突声明；可关闭（`/cg header off`/项目/插件）；审计 `header-injected`。
- **子会话默认不注入**。

#### “不重问”评测（非功能）

≥3 场景（决定/待办/进度）压缩后提问，记录 `mem_query` vs 重问；产出评测记录。

#### 发布就绪（D-R1 = B，已定）

- **D-R1 = B（`DEC-20261025-69`）**：**私有仓库保留完整历史与 issue/PR；对外只发 Release 包或只读镜像；可逆（随时可改公开）；代价是公开侧看不到源码提交史**。
- **公开动作需另行批准**：镜像/Release 建立走正式发布流程，不在本单执行范围。
- **干净历史能力仍保留**（B 也要能导出干净包）：当前树可独立导出、无未脱敏真实内容；**不默认换仓**。
- **增量防护**：`.gitignore` 加 `analysis/**/snapshot-*`、`analysis/**/*-test-*.jsonl`、`analysis/**/*cost-sample*` 等。
- **敏感扫描**：**CI 硬门禁**（gitleaks/trufflehog，不可 `--no-verify` 绕过，引入需批准）+ 本地无依赖兜底扫描（只覆盖明确黑名单）。
- 文档定稿、兼容矩阵（DSH 0.2.x / 原生与 context-zip）、安装/卸载/回滚说明；打包由审核负责。

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
| **G-M3-1** | pre-execute 能否拦截/否决 | **不提供动作校验**（0.3.0 取消），记“等宿主支持” |
| **G-M3-2** | 规则文件判定（文件存在 vs 宿主注入事件） | 用文件存在并写局限 |
| **G-M3-3** | header 注入点与 system prompt 的先后关系 | 换注入点或缩为 3 行 |

### 验收标准

1. 动作校验：C1 白名单内不拦、白名单外拦；C2 相对/绝对路径都识破；C3 拒绝；项目层加 whitelist 被拒；不可拦截时功能不存在且文档不谎称；
2. header：两形态、配额/预算、`[Old]` 排末尾、子会话不注入、关闭与空记忆零注入、审计可查；
3. 评测：≥3 场景记录；
4. 发布：干净包可导出、无未脱敏内容、`.gitignore` 生效、CI 扫描通过、文档与实现一致、回滚步骤可用；
5. 总回归：M1 的 S1–S6、M2 的策略/账本不回退。

### 里程碑

| 版本 | 内容 | 前置 |
|---|---|---|
| 0.3.0 | 动作校验 | G-M3-1 |
| 0.3.1 | header 默认开 | G-M3-2/G-M3-3 |
| 0.3.2 | 评测 + 发布就绪 | 0.3.0/0.3.1 |
| **1.0.0** | 发布（D-R1=B：私有保留、对外另行发布） | 全部通过 + 用户验收 |

### 1.1 候选（已在评审定序）

1. **记忆纠错回路（优先）**：`/cg mem edit <id>` 或直接编辑 `MEMORY.md` 的快捷入口——错误记忆会带偏所有会话；
2. `[Old]` 与活跃批次关联判定（仅影响排序）。

### 任务拆解

见 `TASKS/REQ-20261025-10-M3-拆解.md`。
