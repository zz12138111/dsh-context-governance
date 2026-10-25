# 复核基线 · dsh-context-governance 0.1.12（T2′ + cost-v1.2 + 0.1.11 六条 P3）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 20:3x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `a75ce82`（feat: v0.1.12，package.json 0.1.12） |
| 文档提交 | `85acc94`（docs-only：`cycle` 口径改 `current/outside`；`git diff a75ce82 85acc94 -- packages/` 为空） |
| 测试快照 | `.tmp/snapshot-0112/`（`git archive a75ce82`） |
| 全量测试 | **183/183 pass**（duration 1.61s） |
| 拓扑 | `7180313 → d5e6d54 → a75ce82 → 85acc94`（**直线**）；`origin/feat/context-governance-m1` 仍在 `7180313` |
| 宿主 | 0.2.1-rc.3；真机仍运行 0.1.10（本次未安装、未重启） |

> 0.1.11 基线（`01a7598`/`65ecfde`）未被改写；本报告只覆盖 0.1.12。

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**；**建议（P3）：6 条**（见 §7，其中 1 条沿用 0.1.10 的打包问题）
- T2′ 落在 `runtime.js` 的事件处理层：只读观测 + 审计行 + 成本聚合；未改压缩后端、回注、记忆、折叠（无折叠）。
- 0.1.11 的 6 条 P3 逐条落地，3 条按决定不改代码。

## 2. T2′：`prune-observed`（逐项核对）

实现位置：`runtime.js` `#observePrune` / `#completePrune` / `#auditPrune` / `#attachPrunesToState` / `#flushUnassignedOutside` / `#flushAllUnassignedOutside`。

| 要求 | 结果 | 证据 |
|---|---|---|
| 字段（sessionId/seq/shadowedStart/shadowedEnd/shadowedTokenCount/tool/replacementSeq/cycle） | ✅ | `#auditPrune` 八字段；`audit.js` 白名单逐个放行（`cycle:'id'`、`seq:'number'`、`shadowed*` 为 `nullable-number`） |
| `tool` 用替换事件 `callId` 反查 `tool/call`，查不到 `unknown` | ✅ | `#completePrune` 读 `message.source.callId ?? message.toolCallId`，不存在则保持 `unknown` |
| 同 `shadowedRange` 去重 | ✅ | `#pruneSeen` key = `sessionId:start:end`（无 range 时带 seq） |
| `cycle=current/outside` 语义 | ✅ **与需求/拆解一致** | `current` = 有活动周期且 `summaryEvent===null`（含“prune 先于 start，start 时归 current”）；summary 之后或 `turn/end` 时冲刷为 `outside`。文档口径已由 `85acc94` 从 `auto/manual/outside` 改为 `current/outside`，与实现一致 |
| 只读：不 append 替换、不写落盘文件 | ✅ | `session.append` 换成“调用即 throw”的 shim 后跑完整 prune 链路：**append 调用 0 次**；临时目录只有 `audit.jsonl`；`runtime.js` 无 fs 写入 |
| 不记正文/路径 | ✅ | 只读 `callId`/`seq`/`shadowed*`；审计文本断言无正文/路径 |

### 2.1 真实数据回放（我自己的脚本，不是 dev 测试）

从真机会话 `58a2e845`（开发，8 条真实 `compaction/prune`）抽出 prune + 替换事件，喂给 0.1.12 的 guard：

- 8 条 prune → **8 行 `prune-observed`**，`tool=read`、`tokens` = 4797/2315/2106/3928/2253/2163/3278/2805、`replacementSeq=prune.seq+1`、`cycle=current`；
- 再加一个完整周期后 `compaction-cost`：**`tokensPruned=23645`（= 8 个数之和）、`pruneCount=8`、`pruneTools=["read:8"]`、`auditVersion=cost-v1.2`**；
- 审计原始文本不含工具正文/路径；
- 孤儿 prune（无替换事件）→ `tool=unknown`、`replacementSeq=null`、`cycle=outside`（turn/end 冲刷）。

### 2.2 真实事件形状核对（代码假设是否成立）

- `compaction/prune.data` = `{shadowedRange:{start,end}, shadowedSeqs:[seq], shadowedTokenCount}`；
- 紧随的替换事件是 `tool/result`，**顶格** `sourceEventSeqs:[原seq]` + `surfaceOp:{op:'replace',startSeq,endSeq}`，`data.message.source.callId` 存在。

→ 与 `#isPruneReplacement`/`#completePrune` 的读取路径一致，不是“只在合成 fixture 里成立”。

## 3. 成本口径与 `/cg status`

| 要求 | 结果 | 证据 |
|---|---|---|
| 无 prune：`tokensPruned=null`、`pruneCount=0`、`pruneTools=[]` | ✅ | `#writeCost` 用 `prunedMeasured>0 ? sum : null`；测试 + 我的检查 |
| `pruneTools` top5 `name:count` | ✅ | 按 count 降序、同 count 按 name；实盘回放 `["read:8"]` |
| `auditVersion=cost-v1.2`，只增字段 | ✅ | 白名单新增 8 个键，v1.1 字段语义未改 |
| `/cg status` 与 `/cg status last-cost` 的 `pruned/tools` | ✅ | `costLine()` 统一渲染；无 prune `pruned=0 tools=-`；无成本 `last-cost: none`；`last-cost` 子命令单独可用 |
| 延迟写说明（P3-4/5）与实际一致 | ✅ | T8 §6.3 写明：meter 不可用时等 end 后首条 assistant usage（或 stop/新周期冲刷）；期间 last-cost 可能是上一周期值、cost 行可能晚于其它事件、按 `occurredAt`/`ts` 判断 |

## 4. 0.1.11 的六条 P3（逐条）

| # | 结果 | 证据 |
|---|---|---|
| **P3-1** | 已修实现 | 改为 `fiber.dispose()`（不再把返回值当函数调用），并吞掉返回 Promise 的 rejection；`#meterFiber` 命名同步 |
| **P3-6** | 已修文档 + 断言 | T8 §6.3 写明“按 `cost-v1` 前缀匹配，勿精确匹配”；`t8-cost` 增 `startsWith('cost-v1')` 断言 |
| **P3-2** | 已同步 | `docs/T5-状态命令与审计.md`：用法加 `/cg status last-cost`、字段表加 `last-cost`、示例加该行 |
| **P3-3** | 已同步 | `docs/T8-回注自愈与成本归属.md:48` 改 `cost-v1.2` 并注前缀匹配 |
| **P3-4/5** | 已写文档 | T8 §6.3 明写延迟写现象、last-cost 短暂旧值、`tokensAfter` 可能为 `null` 的时机 |
| 其余 3 条 | 未改代码（按 00 决定） | `baseline.mjs`、`index.js`、tokenGuard 均未动 |

## 5. 生产代码无折叠（复核项）

- 我的独立 grep（在 `a75ce82` 快照上，范围 `packages/dsh-context-governance/` 全文件，排除 node_modules/dist）：
  `cg-fold|fold\.|spill|cg_read|\bfold\b` → **0 match**。
- 与 `analysis/t2prime/zero-fold-grep.txt` 自述一致（0 match）。
- 包内无 fold/spill 配置项、无“默认关闭的折叠开关”；T1 折叠实验只在 `analysis/t1/`，不在 `files` 发布范围。

## 6. 测试抽验

- **183/183 pass**（`node --test "test/*.test.mjs"`）。
- 新增：`test/prune-observed.test.mjs` **5** 条（归因/未知/周期/去重/无 pruner+状态行）、`m1.2-cost.test.mjs` **1** 条 P3-1（`ctx.inject` 返回带 `dispose` 的对象 → stop 调用一次）；`m1.2-cost` 现共 7 条。
- 我另做了三组独立检查（见 §2.1/§2.2/§2 只读行），均不依赖 dev 的测试代码。

## 7. 问题清单（全部 P3）

| 编号 | 问题 | 位置 | 建议 |
|---|---|---|---|
| Q1 | `#toolNames`/`#pruneSeen`/`#lastUsage` 三个 Map/Set 只在生命周期内增长、无清理 | `runtime.js` | 按会话上限/周期清理，或注释说明规模可接受（每条几十字节） |
| Q2 | `#pendingPrune` 是全局单槽，`#observePrune` 开始时无条件结算上一条；两会话 prune 交错时，A 的挂起项可能被提前按 `unknown` 落盘 | `runtime.js` `#observePrune` | 改成按 sessionId 的 Map；或至少在结算前判断同会话 |
| Q3 | `tokensPruned` 只对非 null 的 `shadowedTokenCount` 求和，但整体仍标 `measured`；部分缺失时是下界不可辨 | `#writeCost` | 加 `pruneMeasuredCount`/`pruneUnknownCount`，或文档注明“部分缺失时为下界” |
| Q4 | P3-1 的测试用 duck-typed `{dispose}` stub，不是真实 cordis `Fiber`（包内无 cordis 依赖，属合理折中） | `m1.2-cost.test.mjs` | 文档注明“形状对齐、非真实类”；或将来从宿主注入 |
| Q5 | `package.json` 的 `files` 含 `test`，而 `t7-replay.test.mjs` 动态 import 包外 `../../../analysis/t7/scan-fixture.mjs` → 发布包内测试不可独立运行（沿用 0.1.10 的打包 P3） | `package.json` / `test/t7-replay.test.mjs` | 打包阶段决定：去 test 或把 fixture 扫描器移进包内 |
| Q6 | `turn/end` 会把未归属 prune 冲刷为 `outside`；若宿主将来在回合边界之后才发起压缩，会记错周期（当前宿主顺序 prune→…→start 同回合，不受影响） | `#flushUnassignedOutside` | 留注释/监控；真机若出现 outside 且紧接着 start，再调整 |

## 8. 真机验收观察点（用户重启后，复核方不下结论）

1. `logs/governance.log`：`governance apply version=0.1.12`、`capability@apply/@ready` 各一行。
2. 首次真实压缩：`audit.jsonl` 出现 `prune-observed`，八字段齐全，`tool` 与真实工具名一致（宿主 pruner 只折 `read`/`pwsh`），`replacementSeq` 非空。
3. 同周期 `compaction-cost`：`auditVersion=cost-v1.2`、`tokensPruned` 为数字、`pruneCount`≥1、`pruneTools` 形如 `read:8`。
4. `/cg status` 与 `/cg status last-cost` 的 `pruned=… tools=…`；无 prune 的环境应显示 `pruned=0 tools=-`、成本行 `tokensPruned=null`。
5. 审计里不得出现工具正文/路径；`prune-observed` 与 `compaction-cost` 可能不挨着，按事件类型找。
6. 成本行延迟写（M1.2 已说明）：`tokensAfter` 要等 end 后首条 assistant 消息。
7. 回滚口径：junction 指回 0.1.11 源即可（本报告未动安装态）。

## 9. 边界与推送

- 未安装/重启/卸载、未改 profile/`cordis.patch.yml`、未动用户数据；只读 asar、会话日志与仓库。
- 拓扑已确认为直线（`7180313 → d5e6d54 → a75ce82 → 85acc94`）；按约定在本报告之后叠 0.1.11/0.1.12 两份复核报告 commit，**一次 push 只推分支**，不 force。
- 基线口径：0.1.11=`01a7598`；0.1.12=`a75ce82`（文档 `85acc94` docs-only）。
