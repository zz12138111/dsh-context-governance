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
  - batch 进度形态多样（`8000/1500`、`511/958`、百分比）：**只认“数字/数字”的明确比例**，其余 `skip`；不猜格式。
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
  - ② **正例（带关键字）**：`批次 8000/1500` → 正确判 `pass` 或 `fail`，不能一律 skip。
  - ③ **反例（无关键字，设计意图）**：用户消息只有 `8000/1500`、**无**批次关键字 → 必须 `skip`，**不得判 pass 或 fail**。这条是设计意图，不是缺陷，报告要写明。
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
