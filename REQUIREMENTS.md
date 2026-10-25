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

- **依据**：`docs/上下文治理插件-架构说明-v1.0.md`
- **背景/痛点**：长会话压缩后，任务状态、决策、批次进度容易丢失；已定的事被重问；换会话或定时唤醒接不上。M1 先解决“不断线”，不追求省 token。
- **目标（可验收）**：
  1. 单插件、对宿主零硬依赖；支持宿主默认与 context-zip 两种压缩后端。
  2. 压缩、换会话、唤醒后，任务态（目标、待办、最近决定、关键约束）能自动恢复。
  3. 压缩保护按 S4=B：压缩前先把受保护内容写进记忆（标题+指针）；压缩结束（`compaction/end` 发布后首个 microtask、下一次模型调用前）从记忆回注；自动压缩下 5 类受保护内容 0 丢失；手动压缩允许原文丢失，但必须有记忆指针、audit 显式告警、回注后能看出最后一句。
  4. 回注只放记忆 ID/状态/指针，详情留记忆，不产生第二段摘要。
  5. 失败显式、可回退，不静默降级。
- **边界（不做什么）**：
  - 不接 billion-context（ACP）；
  - 不做工具输出折叠（放 M1.1）；
  - 不做工具隐藏、用户脚本、数据库/向量检索、宽版本兼容、领域包；
  - 不改 DSH、不接管会话、不保存原始对话；
  - M1 不做 LLM 自动抽取，只做“模型显式写入 + 已有结构化状态同步”。
- **验收标准**：
  - ① **会话接续**：新会话/唤醒注入小 header（目标、待办、最近决定、关键约束），有 token 预算；不拉整段历史。
  - ② **记忆写作**：模型调用记忆写入工具后，条目包含 `id/type/status/project/source/writer/confidence`；高风险项为 `proposed`；来源可追溯。
  - ③ **压缩保护（S4=B）**：压缩前把受保护内容写进记忆（标题+指针）；压缩结束（`compaction/end` 发布后首个 microtask、同一 tick、下一次模型调用前）从记忆回注；字面“checkpoint 后、end 前”需替换压缩 provider，M1 不做。自动压缩：5 类受保护内容（最新用户消息/规则注入/工具配对/批次 STATE/回滚点映射）0 丢失；手动压缩：允许原文丢失（宿主仅保留最后 1 个 surface 节点，治理层无否决权），但必须满足记忆有指针、audit 有显式告警、回注后调用方能看出“最后一句是什么”；任何“写不进/注不进”必须有 audit，不允许静默。
  - ④ **回注行为**：只含 ID + 状态 + 指针；摘要可读时按覆盖判断是否补一行标题；摘要不可读时仅 ID+状态；摘要与记忆冲突时记忆赢；详情可通过记忆工具找回。
  - ⑤ **双后端**：宿主默认与 context-zip 各跑一遍；不替换用户现有 context-zip 配置；没装 context-zip 时自动用宿主默认。
  - ⑥ **失败与降级**：记忆写失败 → 重试一次，仍失败跳过本次压缩并告警；压缩失败 → 回退宿主默认；配置非法 → 插件不加载、DSH 正常；摘要/范围/产物都不可见 → 该后端只读。
  - ⑦ **状态与审计**：状态命令（暂名 `/cg status`）显示后端、能力、记忆条数、上次压缩、上次回注、降级项；审计含后端、压缩前后、成本归属（字段见下）、回注被吞/重复、失败。

**成本归属字段（A：M1 定义，只做 Token 归属，不做货币成本）**

- **主键**：`compactionId`（一个压缩周期一条记录）。
- **维度**：`sessionId`、`project`、`backend`、`model`（`provider/model`）、`trigger`（auto/manual）、`occurredAt`。
- **数值**：`tokensBefore`、`tokensAfter`、`tokensShadowed`、`tokensSummary`、`tokensInjected`、`injectedEntries`、`tokensDropped`。
- **口径**：`backendUsage`（压缩事件 usage）；`backendCostSource` / `governanceCostSource`（`measured` / `estimated` / `unknown`）；`estimateMethod`；`auditVersion`。
- **对齐宿主**：`tokensBefore/After` 用宿主 tokenMeter/压缩事件；`backendUsage`/`tokensSummary` 用压缩事件 usage；`tokensInjected` 优先用宿主 tokenMeter，取不到则按字符估算并标 `estimated`；`tokensDropped` 来自 `reinjection-shadowed`；实测与估算分开存，不混算。
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
  - DSH 当前版本（`0.2.1-rc.2`）、context-zip 当前版本、Schemastery；
  - E1/E2 可能发现 context-zip 只有状态级感知或摘要不可读，按降级阶梯处理；
  - 记忆单写者只保证进程内，跨进程不承诺。
- **优先级**：P0
- **状态**：已排期

### 任务拆解

见 `TASKS/REQ-20261025-01-M1-拆解.md`。

**T9 已被 T8-2 吸收，不再待排期**：T8-1 已修 ROB-01/06；T8-2 已实现成本归属（A 口径，`compaction-cost` 审计，token 实测/估算分列，不记金额）。M1 成本归属无待办；若后续做跨周期聚合/货币成本，另立 M2 增强，不复用 T9。

---

## REQ-20261025-02 上下文治理插件 M1.1 —— 工具输出折叠与批量测量

- **依据**：`docs/上下文治理插件-架构说明-v1.0.md` §16.3；M1 `REQ-20261025-01`
- **优先级**：P1
- **状态**：已排期（M1 已结项，已推 00 派开发）
- **背景/痛点**：M1 解决“不断线”，不解决“进入量”。工具结果是最大的一块；用“头尾 + 落盘指针”换体积，同时测量批量调用空间，不承诺收益。
- **目标（可验收）**：
  1. 超过保守阈值的工具结果折叠为“头 + 省略标记 + 尾 + 指针”，完整内容可按指针用原生 `read` 回读。
  2. 折叠不丢信息；验收场景能找回原文。
  3. 不干扰 M1 的 S4、回注、审计、降级。
  4. 批量只测量；内部可留隐藏 A/B，不默认改变行为、不承诺收益。
- **边界（不做什么）**：
  - **绝不折叠 `pwsh`、绝不折叠 `read`**（硬约束）；
  - 不做工具隐藏/白名单变更；
  - 不做语义摘要/改写，只折叠；
  - 不新增读取工具，使用原生 `read`；
  - 不强制批量、不新增“批量工具”；
  - 不接 ACP、不做数据库、不做宽兼容。
- **前置门禁（硬门禁）**：
  - **F1 折叠 seam（2026-10-25 修订，替代原“进入历史前”字面口径）**：替换必须让**模型下一次请求看到折叠后的内容**——判定看“模型看到什么”，不看“替换发生在哪个函数里”。允许使用宿主既有机制：`session.append` 替换事件 + `compaction/prune` 影子定价（宿主 `@deepseek-ai/dsh-compaction-tool-result-pruner` 即用此协议，`dsh-base` 默认挂载）。只有在“模型下一次仍看到全文、折叠只体现在审计/日志”时才算失败 → **停项、不发版**；不接受“仅审计”降级。
    - 修订理由：原字面口径会把宿主官方 replace+shadow 协议判成失败，而该协议在真机已证明有效（同一会话内 `compaction/prune` 事件 8/8 出现）。
  - **F2 冲突检查**：已带 `[token-guard]` 或 `[cg-fold]` 标记的结果跳过；**已被宿主 tool-result-pruner 折叠的结果也跳过**（其替换版紧跟 `compaction/prune` 影子事件，或以 `sourceEventSeqs` 引用原事件），不叠加。
  - **B1 批量基线**：先只读采集步/回合、调用/步、prompt token，作为测量基线。
- **行为**：
  - **触发**：结果长度 ≥ `fold.minChars`（默认 8000），工具在名单内，未被折叠过，不是最近 `keepRecent`（默认 3）条。
  - **名单**：`grep`、`web_fetch`、`dsh_browser_content`、`cross_session_read`、`job_output`、`history_search`；**不含 `pwsh`、`read`**；可配置。
  - **折叠格式（固定）**：
    ```
    [cg-fold] tool=grep chars=48213 kept=1500+1500 omitted=45213
    <头 1500 字符>
    …[省略 45213 字符，完整内容见指针]…
    <尾 1500 字符>
    [cg-fold] full: <spill 路径>（用原生 read 按 offset/limit 读取）
    ```
    中间必须出现“省略 N 字符”（N = 原文长度 − 头 − 尾），用于引导模型回读。
  - **落盘**：`~/.dsh/context-governance/spill/<session>/`；不进 git、不进记忆；TTL 7 天、总量默认 256MB、启动/每日清理；权限收紧。
  - **回读**：只用原生 `read` + offset/limit；不新增 `cg_read`。
  - **不折叠**：最近 N 条、图片/二进制、已折叠、tokenGuard 已折、S4 保护内容的唯一副本。
  - **失败**：写 spill/替换失败 → 保留原文、audit、显式告警；不静默。
  - **批量**：只测量；内部隐藏 A/B 可开，但默认不改变行为、不承诺收益。
- **配置默认值**：`fold.enabled=true`（保守）；`minChars=8000`；`headChars=tailChars=1500`；`keepRecent=3`；`ttlDays=7`；`maxMB=256`；`batch.measure=true`；`batch.hiddenAb=internal`。
- **验收标准**：
  - ① **F1 通过**：模型下一次请求看到折叠后内容（允许宿主 replace+shadow 协议）；仅“模型仍看全文、只留审计” → 停项、不发版。
  - ② **折叠生效**：名单内 ≥`minChars` 的结果折叠；中间有“省略 N 字符”与指针。
  - ③ **可回读**：原生 `read` 可按指针找回原文；回读成功率有记录。
  - ④ **硬排除**：`pwsh`、`read` 永不折叠；tokenGuard/已折叠结果不叠加。
  - ⑤ **不误折**：最近 N 条、S4 保护内容不被误折。
  - ⑥ **失败显式**：写 spill/替换失败保留原文并 audit。
  - ⑦ **M1 不回退**：S4、回注、审计、降级路径不受影响。
  - ⑧ **可测量**：折叠次数、节省字符/token、spill 占用、回读成功率；批量基线报告（步/回合、调用/步、token 对比）。
  - ⑨ **安全**：spill 不进 git/记忆，TTL 清理，敏感风险有文档。
- **依赖/风险**：
  - F1 是硬门禁，失败即停；不做降级版。
  - **与宿主 tool-result-pruner 重叠（2026-10-25 发现）**：`dsh-base` 默认挂载 `@deepseek-ai/dsh-compaction-tool-result-pruner`，>8192 字符的工具结果在**压缩触发时**已被替换为「头 4096 + `middle pruned` + 尾 1024」，原文留会话日志。T2 优先复用其替换协议与 `compaction/prune` 影子定价，**不自研替换协议**；差异价值只保留“早于压力触发、工具名单（绝不折 `pwsh`/`read`）、spill 指针可原生 `read` 回读、审计”。先出差异表，再定 T2 范围。
  - 与 tokenGuard 重叠，必须跳过已折结果。
  - spill 可能含敏感内容；回读依赖原生 `read` 的路径权限。
  - 折叠过度会导致反复回读，净节省可能为负；用 B1 基线测。

### 任务拆解

见 `TASKS/REQ-20261025-02-M1.1-拆解.md`；M1 已结项，已推 00 派开发。

---

## REQ-20261025-03 上下文治理插件 M1.2 —— 探测修正与成本实测

- **依据**：M1 `REQ-20261025-01` 成本归属字段；`docs/M1-回顾与M2候选.md`；2026-10-25 可行性复查（宿主 asar 代码 + 真机会话日志）。
- **优先级**：P1
- **状态**：已排期（待 00 派开发；与 M1.1 T1 并行，不互斥）
- **背景/痛点**：M1 真机上 `tokensBefore/After` 恒 `null`、能力行 `compaction=absent`，此前按“宿主限制”接受。复查发现两处都是**插件侧时序问题**：
  1. `ctx.tokenMeter` 在 apply 时读一次并缓存（`runtime.js:189-195`），没走 `ctx.inject(['tokenMeter'], …)`；服务晚注册就永久为 `null`。宿主 `@deepseek-ai/dsh-token-meter` 由 `dsh-base` 默认挂载，确实存在。
  2. `ctx.compaction` 在 apply 时探测为 absent，但 `compaction-basic` 已在本机 profile 配置（`thresholdRatio: 0.65`）且压缩事件真实发生 → 服务存在，只是探测太早。
  3. 兜底证据：真机会话日志中 `assistant/message` 1199/1199 带 `usage`（样本 `inputTokens=20662 / cacheReadTokens=2432 / totalTokens=23321`），压缩前后水位可实测。
- **目标（可验收）**：
  1. **成本实测**：`tokensBefore/After` 优先 `ctx.tokenMeter`（延迟注入或按需取，成功后缓存），失败退回 `assistant/message.usage`，仍取不到才 `null` + `unknown`。
  2. **探测修正**：能力探测由“apply 一次”改为「apply 记 `capability@apply` + 首个会话事件后补 `capability@ready`」两行审计，不得因时序把可用服务记成 absent。
  3. **口径可追**：新增 `tokensBeforeSource` / `tokensAfterSource`（`tokenMeter` / `usage` / `none`），`auditVersion` 升 `cost-v1.1`；**只增字段、不改已有字段语义**，旧解析器仍可用。
  4. **provider 结论**：同一轮给出 `ctx.compaction` 是否可获取的只读结论（可/不可 + 证据路径），供 P1 决策「回注时点是否可修」；**本轮不改压缩后端、不替换 provider**。
- **边界（不做什么）**：
  - 不改回注逻辑、不改记忆、不改折叠（折叠归 M1.1）；
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
  - ④ 审计出现 `capability@ready` 行，且不再出现“服务存在却被记 absent”；
  - ⑤ 单测覆盖：延迟注入生效、usage 兜底、全缺、来源字段、无正文/路径泄漏；
  - ⑥ 给出 `ctx.compaction` 可用性结论与证据路径。
- **依赖/风险**：
  - 依赖本版 cordis 的服务注入语义（`ctx.inject` 已在本插件用于 `commands`）；若延迟注入不可用，退化为“按需读取 + 缓存成功值”；
  - `assistant/message.usage` 是每次调用的用量，不是“省下的 token”；只做水位，不冒充节省量；
  - 真机验证需一次重启（用户执行，开发不执行）。
- **成本归属字段**：沿用 M1 的 A 口径，字段不删不改；本单只补来源与实测路径。

### 任务拆解

见 `TASKS/REQ-20261025-03-M1.2-拆解.md`。
