# DSH 插件开发 · 当前状态

> 只放"现在还活着"的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-25 22:4x（**0.1.14 已加载**：batch 同消息绑定 + 日期排除 + 正文比例保留，196/196；真机 `get.compaction(strict=false)=undefined` 已实测结案；0.1.12 手动压缩验证 `cost-v1.2`）

## 在办

| 会话 | 当前任务 | 状态 |
|---|---|---|
| 需求 | M2 首批 REQ-20261025-09 已出正式单（含 0.2.0 验收与项目层 A+C 口径，`cc33a2a`）；等 0.2.0 复核结论 | 待复核 |
| 开发 | **0.2.0 已交付**（策略层/项目层/压力四段/`/cg set`/文档；234/234，`e6d859b` + docs）；未 push、未安装未重启 | 待审核 |
| 审核打包 | 0.1.x 复核链已出至 0.1.18（0 阻断）；**0.2.0 待复核**（含 DEC-20261025-60 六项与 62 A+C 对照） | 待复核 |

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
- **测试**：全量 **234/234 通过**（`node --test "test/*.test.mjs"`；0.1.14 为 196；0.1.15 202；0.1.17 205；0.1.16 204；0.1.18 218；**0.2.0 收口 +16**：经 apply 集成①/①b、项目层 A+C 三拒、路径逃逸/64KB、`/cg set`×3、压力四段×3、guard.pressure、层级链、computePressure×2）。
- **真机**：已安装（deps 14 / bundles 17 / redirect 0.1.0-context-zip / junction 已建）。v0.1.6 已验证工具/感知/审计；**v0.1.14 已于 21:18 重启加载**（`governance capability@apply version=0.1.14`、`get.compaction(strict=false)=undefined`）；v0.1.12 于 20:46 首次真实手动压缩验证 `auditVersion=cost-v1.2`（`tokensBefore=407146`/`tokensAfter=3525`、`tokensPruned=null`、`pruneCount=0`——手动 `compactNow` 不调 pruner）；**`prune-observed` 正路径仍未验**，需自动压力/溢出压缩。
- **T6/T7/T8**：均离线完成；真机验收项列在“下一步”。
- **M1.3 原生后端验证（REQ-20261025-06，2026-10-25）**：隔离 profile `native-test`（web 模板、无 context-zip/redirect，端口 18765，已停）实跑——**D1-1 不通过**（原生下 `adapter=none`，根因 preset `isolate`；功能不受影响）；**D1-2/D1-4 通过**；**D1-3 手动链路通过、自动压力未触发**（≈678K tokens，记 backlog 等自然触发）；D1-5 隔离证据齐全。**0.1.15 已修**（`inferBackendFromStyles`：free-form→`host-basic (inferred)`、five-section→`context-zip (inferred)`、混合→`mixed (unverified)`；只进 `/cg status`/`adapter-inferred` 审计/`compaction-cost.backend`，新增 `backendInferred`，`auditVersion=cost-v1.3`；功能路径不读推断）；隔离实例复验 `/cg status` 显示 `adapter=none inferred=host-basic (inferred)`，全量 **202/202**。报告 `analysis/req-20261025-06/`；未安装/未重启桌面、未 push。
- **M2 首批（REQ-20261025-09）**：**G1 通过**（agent 级 `agentPresets.serviceFor(agent,'compaction')=object`；`agentPresets` 约 2s 晚挂载；根级 `ctx.get('compaction')` absent 不阻塞；G2/G3 部分待 0.2.1）。**0.2.0 已交付**（`8275fb4`→`c6563d1`→`9a380ea`→`87134cd`→`e6d859b`）：四层合成、`/cg policy show`、`/cg set`、`/cg status` 的 policy/policy-invalid/policy-session/pressure 行、压力四段（只展示）、项目文件 A+C 加固；审核六项全修。**0.2.0 复核已出**（`docs/review-context-governance-0.2.0.md`：0 阻断/0 P2/9 P3），**P3 九条已闭环**（`analysis/req-20261025-09/P3-闭环记录.md`；全量 **240/240**）。**G4 已定并落档**（`e12d08a`：`DEC-PLUGIN-20261025-40`，窗口来源 = 宿主 `contextPressure.contextWindow`，真机 1,048,576 → native≈0.6934；配置仅回退；`DEC-20261025-66` 细化 `#lastSession`/中途重算/删除置 unknown/conservative=min/双显）。未安装/未重启/未 push。报告 `0.2.0-交付报告.md`、样例 `samples-0.2.0.txt`、G4 `G4-窗口来源结论.md`。
- **0.1.18（发布前收口）**：`/cg status` 改用 `backend-kind=`（实测 none 显示 none，与成本行同一 `resolveBackendFields`；推断时附 `backend-label=`）；控制字符闸改用 `git ls-files`（tracked **163 files / 0 violations**）；文档补 AGENTS.md 第 4 处（0x0C 吃 `feat/` 的 f）；全量测试见下；未安装/未重启/未 push。
- **0.1.17（REQ-20261025-07 P3 收口）**：`backend`/`backendKind` 枚举补 `none`（实测 none 不折叠；unknown 才 unknown；mixed 仍 unknown+label），`auditVersion` 仍 `cost-v1.4`；控制字符闸扩到仓库根（排除 `.tmp`/`node_modules`/`.git`，`AGENTS.md` 0x0C 已清，扫描 **174 files / 0 violations**）；全量 **205/205**；未安装/未重启/未 push。
- **0.1.16（REQ-20261025-07）**：README 控制字符（0x08/0x07）已清 + 防复发测试（包内文本禁 C0/DEL，自证注入→fail）；`compaction-cost` 拆 `backend`(枚举)/`backendKind`/`backendLabel`/`backendInferred`，`auditVersion=cost-v1.4`；`/cg status` 用 `backend-label=`；全量 **204/204**；未安装/未重启/未 push。
- **T8/T9**：T8-1 修 ROB-01/06；T8-2 实现 `compaction-cost`（A 口径）；**T9 已被 T8-2 吸收，不再排期**。

## 已知风险（当前无代码风险）

- T8-1 已修复 ROB-01/06：回注失败不再永久停写，改为“每次失败审计 + 连续 N 次降级一个周期 + 下一周期自愈”，`reinjection-recovered` 可审计。
- M1.1 早折已取消；若日后重启，须先有 spill + 权限 + TTL，再谈折叠。

## 已知偏差（已接受）

T4 回注时点：checkpoint→end 之间不可实现，改为 end 后首个 microtask（同 tick、下一轮前）；用户已接受，`DEC-PLUGIN-20261025-09`。

M1 成本“前后水位未知”原按降级接受，2026-10-25 复查为插件侧可修（tokenMeter 读取时机），已由 M1.2 修（v0.1.11，离线 183/183）。**`ctx.compaction` 已结案（2026-10-25）**：`get.compaction(strict=false)` 在 `@apply` 13:18:10Z / `@ready` 13:18:23Z **均 `undefined`** → 本部署插件 scope **未提供**该服务（有 impl 未 active 会返回 `obj`）；**根因 = agent preset 用 `cordis:group` + `isolate: { compaction: true, toolResultPruner: true }` 把服务隔离在 preset 组内**（本机可见的 `@local/dsh-computer-use/presets/cordis.patch.yml` 三套 custom preset 均带；`standard` 的 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 同口径，见 DEC-32），不是挂载时机；插件不依赖它（走 `session/event`），**「回注时点修正」在该部署下不可行**，只能走事件时序推断（现方案），不再是待查项。**定案（`DEC-20261025-48`）：不改隔离**——宿主压缩/阈值/审计时序不变；`cordis provide` 同 scope 重复注册会抛错（`@local/dsh-computer-use` 有两处 compaction 组）；mode 会由 `event-level` 变 `full` 且保护失败进 `degraded-protection`；收益≈0。M2 不依赖 provider。能力探测只看 `get.X` 列；裸属性 `throws` 不代表服务异常（反例：`tokenMeter=throws` 同时 `get.tokenMeter=obj`）。

## 等待用户/外部

- **真插件安装**：已完成结构安装（junction 指向源码，改完重启即生效）；开发不重启。
- M1.1：T2′ 已离线完成（v0.1.12）；**审核复核已出（0 阻断/0 P2/6 P3）**；真机已于 20:34:54 加载、20:46 首次真实手动压缩验证 `cost-v1.2`。
- 0.1.13（REQ-20261025-04）：开发已交付（189/189，报告 `analysis/req-20261025-04/`）；0.1.14 已覆盖其 batch 判据（不改 `get.compaction` 归因）。
- 0.1.14（REQ-20261025-05）：开发已交付（196/196，报告 `analysis/req-20261025-05/`，含真实快照 A/B 三列对照）；**已于 21:18 重启加载**，待审核复核。
- **M1.3 原生后端验证（REQ-20261025-06）**：报告 `analysis/req-20261025-06/`；**D1-1 不通过、D1-2/D1-4 通过、D1-3 自动分支未触发**；隔离实例 `native-test` 已停（profile 保留可复验）。**0.1.15 已交付**（事件形态推断 inferred + `cost-v1.3`，202/202；隔离实例复验通过），待审核复核。
- M1.2：离线完成（0.1.11 冻结）；已并入 0.1.12（已重启加载）。
- **M1 收尾（2026-10-25）**：架构升至 **v1.1**（事实回写：preset 阈值≈67.85%/patch 无效、`tokenMeter`=chars/4 估算、`ctx.compaction` 本 scope 不可得、工具输出折叠取消）；`REQ-20261025-01` 改结项口径（双后端=事件级、成本 source 写明、rc.3、结项说明+四条边界）；v1.0 标历史。
- **M2 需求草案 v0.6**：`docs/M2-需求草案-v0.6.md`（`research` 默认 `compact.early=false`；`estimateSafety` 改注释式警告；`/cg cost` 假设行置顶；新增“可关闭”验收）；**使用说明草案 v0.3** `docs/M2-使用说明-草案-v0.3.md`（新增“压完还是觉得贵”FAQ、长 turn 表述、research 说明）；v0.1–v0.5 保留作对照；**待评审复核**。
- 暂存：GitHub 发布用的仓库地址与账号（发布前需要）。

## 阻塞

- 无（v0.1.14 已加载；0.1.14 待审；只读演练需人工制造不可写根，开发不自行改动安装态）

## 下一步

1. **审核复核 0.2.0**（`e6d859b` + 本轮 docs）：重点核对 ① 经 apply 的集成测试（真机链路等价）、② 项目层 A+C（整层拒绝/0.45 下限/路径与 64KB 闸）、压力四段只展示不压缩、`/cg set` 为**进程内**覆盖（0.2.0 不宣称按会话隔离）、`early=ready` 残留清零、本批未新增引擎引用（`src/` 仅存 M1 适配器探测 `compactNow`，`adapters.js` 未改）。
2. **G4（窗口/native 来源）**：0.2.1 动工前必须给一句结论（当前 0.2.0 用 `policy.windowTokens/reservedTokens` 配置值算 native；需求建议在 G3 里试 `sessionProjections.contextPressure`）。
3. **0.2.1 范围（未动工）**：`agentPresets.serviceFor(agent,'compaction')` 引擎接线、`early-channel`、冷却/增量门槛的实际判定；等 G4 + 0.2.0 复核通过。
4. **真机安装/重启 0.2.0**：桌面实例仍 0.1.18（junction 指向源码），按红线需 00+用户批准后由用户执行；重启后验证 `/cg status` 的 `policy:`/`pressure:` 行、`/cg set compact.at=…`、项目 `.cg-policy.json` 生效与 `policy-invalid:` 可见性。
5. 0.1.x 复核链已全部出结果（最新 `docs/review-context-governance-0.1.18.md`，0 阻断）；无遗留待复核版本。