# 复核基线 · dsh-context-governance 0.1.11（M1.2 + M1.1 T1 证据）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 20:2x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `01a7598`（feat: v0.1.11 M1.2，package.json 0.1.11） |
| 文档基线 | `65ecfde`（T1 门禁记录）+ `ff16e99`/`800c583`/`8f53b00`/`7180313`（均 docs-only） |
| 代码未漂移证据 | `git diff --stat 01a7598 7180313 -- packages/` → 空 |
| 测试快照 | `ff16e99` 经 `git archive` 导出到 `.tmp/snapshot-0111/`（.tmp 已 gitignore） |
| 全量测试 | **177/177 pass**（`node --test "test/*.test.mjs"`，duration 1.41s） |
| 宿主 | 0.2.1-rc.3；真机仍在跑 0.1.10（本次**未安装、未重启**） |
| 独立脚本（我写的，均在 .tmp） | `check-m12.mjs`（成本链行为）、`asar-locate.mjs`（只读 asar）、`probe-claims.mjs`、`probe-prune.mjs`、`probe-seq.mjs`、`recheck-b1.mjs`（B1 复算） |

> 过程事实：复核期间工作区被**其他会话**推进 `01a7598 → 800c583 → 8f53b00 → 7180313`，且 `origin/feat/context-governance-m1` 已到 `7180313`（含 0.1.11 代码）。**不是我推的**；我全程未 push。

## 1. 结论摘要

- **阻断（P1）：0**
- **应修（P2）：0**
- **建议（P3）：9 条**（见 §7）
- M1.2 四项均已在代码中落地，dev 自测与我独立验证一致；折叠/回注/记忆三条既有链路未被改动。

## 2. 逐项核对（00 的复核范围）

### ① `capability@apply` / `capability@ready`（只记类型，不记值）

- `src/capabilities.js`：`SELF_PROBES`/`SERVICE_PROBES` 各加 `tokenMeter`；`describeValue` 只回 `fn/obj/obj(dispatch=fn)/absent/string|number|throws`，不读内容（:45-57）。
- `src/diagnostics.js:45-59`：行前缀改 `capability@<phase>`，内容仍是 `probe=name=类型`。
- `src/audit.js:72-75`：白名单加 `probe: 'text-array'`（逐条 `redactText`，:135-138），`AUDIT_EVENTS` 加两个事件（:24-27）。
- `src/index.js`：apply 时写诊断行 + `audit append('capability@apply')`；`probeReadyCapability` 传入 guard 的 `onFirstEvent`，首个 `session/event` 触发一次（`#readyFired`）。
- 我的验证：`check-m12.mjs` 中 `onFirstEvent` **只触发 1 次**；dev 测试断言 ready 能看到 `get.compaction=obj`/`get.tokenMeter=obj`。
- 证据：`audit.jsonl` 白名单机制保证未知字段被丢弃，探测串中只有类型标记。

### ② `ctx.tokenMeter` 可选注入 + 按需获取（无硬 inject，失败不永久缓存）

- `src/index.js:31` 仍只有 `export const inject = ['tools']` —— **无硬 inject** ✔
- `#getTokenMeter()`：每次按需 `ctx.tokenMeter ?? ctx.get('tokenMeter')`，只缓存“有 `measure` 函数”的对象；失败/缺失返回 null 且**不缓存** ✔
- `#tryInjectTokenMeter()`：`ctx.inject(['tokenMeter'], cb)`，回调里再校验 `measure`；`stop()` 里尝试清理。
- 我的验证：两路（有/无 `ctx.inject`）都能在“晚注册”后拿到 meter（dev 两条用例 + 我的现场复跑）。
- **P3-1**：`ctx.inject` 实际返回 **Fiber**（`@deepseek-ai/cordis/src/registry.ts:176`：`inject(deps, callback): Fiber & PromiseLike<Fiber>`），不是函数；`stop()` 里 `#meterDispose?.()` 会抛 TypeError 被 `catch` 吞掉 → 注释/文档所称“dispose 清理”不成立（仅靠父 fiber 随插件销毁兜底，实际风险低；测试里的 fake 返回了函数，掩盖了这一点）。

### ③ `assistant/message.usage` 兜底 + 来源字段 + `cost-v1.1`

- `#usageOf`：只取 `inputTokens+cacheReadTokens+cacheWriteTokens`，至少一个有限数才算有 usage；`{}`/无字段 → 不算。
- `#newCost`：meter 优先 → `tokenMeter`；否则用本会话最后一条 `assistant/message.usage` → `usage` + `parts`；全缺 → `null`+`none`。
- `#captureCostAfter`：end 后第一条 assistant 消息补 `tokensAfter`；等不到则 `stop()`/下一周期冲刷为 `null`+`none`（`#flushPendingCosts`）。
- `audit.js` 白名单只**新增** 4 个键（`tokensBefore/AfterSource`、`tokensBefore/AfterParts`），`auditVersion: 'cost-v1.1'`。
- **真机可行性证据（我从会话日志直接核）**：
  - `58a2e845`（开发）：`assistant/message` **1370/1370** 条都带 usage；
  - `5d1121ed`（审核）：**434/434** 条带 usage。
  → 兜底在真机有数据来源，不是纸面设计。
- 我的独立行为验证（`check-m12.mjs`，非 dev 测试）：before=125(`usage`,parts={100,20,5})、after=60(`usage`)、`auditVersion=cost-v1.1`、未到 after-usage 前**不落半条**、多条 assistant 消息**只落 1 条**、`stop()` 不重复落行。
- **P3-4**：成本行延迟写 → `/cg status` 的 `last-cost` 在 after-usage 到达前显示上一条（或 none）；audit 里 `compaction-cost` 可能出现在后续事件之后，不能按“紧随 reinjection”找。
- **P3-5**：end 后第一条 assistant 消息若没 usage（如中断），直接记 `null`+`none`，不会等第二条。
- **P3-6**：`auditVersion` 值由 `cost-v1` → `cost-v1.1`；字段层兼容（只增、sanitizer 不校验版本），但**精确匹配 `cost-v1` 的读方会漏新行**，建议文档写明“按前缀/忽略未知字段”。

### ④ `ctx.compaction` 可用性结论（2026-10-25 真机更正）

- `dsh-base/cordis.patch.yml:348-352` 确挂 `token-meter` + `compaction-basic`；本机 profile `cordis.patch.yml:79-82` 有 `thresholdRatio: 0.65`；真机 `58a2e845` 也确实发生过自动/手动压缩（`4193–4197`、`8535–8539`）。
- **但真机 0.1.12 的 `capability@apply`（20:34:54）与 `capability@ready`（20:35:54）两条都是 `compaction=throws`、`get.compaction=absent`**，ready 出现在首个会话事件之后仍未变 → **“apply 时 absent 只是探测时机（ready 时可得）”不成立**。
- 两列语义不同（cordis `reflect.ts`）：`ctx.X` 是“未 inject 的属性读取”，服务不在 fiber store 链上时抛 `cannot get property "X" without inject`（`reflect.ts:144-170`）；`ctx.get('X')` 是“无 inject 要求的 store 读取”，未提供时返回 `undefined`（`reflect.ts:9-19`）。对照证据就在同一条日志里：**`tokenMeter=throws` 但 `get.tokenMeter=obj`** —— 所以 `throws` 列不能当作“服务坏了/不存在”，只有 `get.X` 是可用性信号。
- 结论（更正后，2026-10-25 0.1.14 真机定性）：**该部署下插件 scope 根本没有提供 `ctx.compaction`** —— `get.compaction(strict=false)` 在 @apply（13:18:10Z）与 @ready（13:18:23Z）两条都是 `undefined`（`obj` 才表示“有 impl 未 active”，已排除）；插件不依赖它（压缩走 `session/event` 的 `compaction/start|summary|end`，0.1.10 起一直如此），**「回注时点修正」在该部署下不可行，只能按事件时序推断**。
- 定性路径：先用 `get.X`（`absent`）确认不可见，再用 `ctx.get('compaction', false)` 区分——`undefined` = 本 scope 未提供（已定性），`obj` = 有 impl 但未 active（已排除）。

## 3. 回归面（折叠/回注/记忆三链路）

- 代码改动仅 6 个文件：`audit.js`、`capabilities.js`、`commands/cg-status.js`、`compress/runtime.js`、`diagnostics.js`、`index.js`；**回注、记忆、压缩后端文件未动**。
- `runtime.js` 的 `#handle`：0.1.10 的 switch 里本来就没有 `assistant/message` 分支（已与 `cca9890:runtime.js` 对照），新增分支只做 usage 采集/成本补齐后 `return`，不影响既有 case。
- 既有链路测试（T2–T8 回归、fixture、commands 晚挂载、range 兜底）全绿。

## 4. `/cg status` 的 `last-cost`

- 实际行：`last-cost: before=1400(tokenMeter) after=500(tokenMeter) trigger=auto`；无正文/路径/凭据/sessionId（`lastCost` 对象里带 sessionId/compactionId，但**不打印**）→ **无敏感泄露**。
- 位置：插在 `last-reinjection` 与 `protection` 之间；新增一行不破坏按前缀解析的读方。
- **P3-2**：契约文档未同步 —— `docs/T5-状态命令与审计.md:22-23`（字段表）与 `:37-39`（样例行）都还没有 `last-cost`。

## 5. 新增复核项：生产代码无折叠（00 追加）

**结论：是（无折叠）。**

- 范围：`packages/dsh-context-governance/` 全部文件，排除 `node_modules/`、`dist/`（含 src/test/*.md/*.yml）。
- 命令：逐文件 `Select-String`（大小写不敏感，SimpleMatch 计数）：
  - `cg-fold` → **0**
  - `fold` → **0**
  - `spill` → **0**
  - `折叠` → **0**
  - `prune` → **1**，唯一命中是 `cordis.patch.yml:7` 的注释“不运行 pnpm install / dsh plugin add（会 prune + 搬走 compression redirect）”，**不是折叠代码**
  - `analysis/` 引用 4 处，全部是文档/测试注释（README 指向 `../../analysis/*`；`t7-replay.test.mjs:118` 以动态 import 引 `../../../analysis/t7/scan-fixture.mjs`）——与折叠无关，但沿用 0.1.10 复核的 **P3（测试依赖包外 analysis/，打包脆弱）**。
- 结论：生产代码**没有** fold/spill/`[cg-fold]`/`fold.*`/折叠 flag；T1 折叠实验只存在于 `analysis/t1/`（`fold-probe.mjs`、`f1-evidence.mjs` 等）；
- 发布包风险：若打包只含 `packages/dsh-context-governance`，`t7-replay.test.mjs` 会因缺 `analysis/t7/scan-fixture.mjs` 而不可独立跑（非运行时问题，是包完整性 P3，打包阶段需定 `files`/是否带 test）。

## 6. T1 证据可复现性抽查（抽查而非逐条）

| 检查 | 结果 |
|---|---|
| F1 路径 A 行号：`dsh-tools/lib/types/index.js:1152-1188`（postExecute 替换 content）、`:1018-1029`（finalize 先跑 postExecute） | **命中**（逐行核对） |
| `dsh-agent-loop/lib/index.js:570/571`（先 finalize 再 appendToolResult）、`:691-706`（append 用 result.content） | **命中** |
| F1 路径 B：pruner `lib/index.js:8-14` 默认 8192/4096/1024、`:159-177` `compaction/prune` + `surfaceOp.replace`；`compaction-basic:926-944` 调 pruneSession | **命中**（:929 溢出 / :943 压力两处） |
| README 引用：`dsh-tools/README.zh.md:109`（流水线）、pruner `README.zh.md:116`（模型看到折叠版） | **命中**（原文一致） |
| `job_output` caveat：`dsh-tool-jobs/lib/index.js:240-255` `finalizeContent` 在 policy 后按 `outputLimitBytes` 再截断 | **命中** |
| tokenGuard 默认只 `pwsh` | profile `cordis.patch.yml:87-92` 证实（`tools: [pwsh]`）；但 `internal/token-guard.mjs:28/:260-319` 的**行号无法复核**：`~/.dsh/token-guard/` 下只有 `metrics.jsonl`，源码不在 asar/profile（**P3-7**，证据可复现性注记） |
| B1 数字 | 用 dev 的 `baseline.mjs` + 时间闸 `2026-10-25T12:08:34Z` **精确复算**：开发 19/1129/1411、需求 54/280/338、审核 14/410/469；合计 87/1819/2218；名单内候选 0/11/0；tokenGuard 23/2/4；hostPruner 8 ⇒ 与文档表完全一致 |
| B1 复现的坑 | `baseline.mjs` 无快照参数，直接复跑会用“现在”的日志（数字漂移）；需先按 `12:08:34Z` 过滤（**P3-8**） |
| 真实会话细节 | 8 条 `compaction/prune`（seq 4177–4191）**全为 read**；原结果 8,392–19,153 字符；替换版一律 5,159；shadowedTokenCount 2,106–4,797 ⇒ 与文档一致 |
| 下一次请求用量 | seq 4171 = 791,339（811+790,528）；seq 4201 = 24,006（4,038+19,968）⇒ 与文档一致，证明替换版被下一请求消费 |
| B2 8 维表 | 模板在 `9d0f01b:TASKS/REQ-20261025-02-M1.1-拆解.md:32-48`（8 行）；T1 表 8 行**逐维一一对应**，含“处置/要回答的问题”。注：`8f53b00` 已按 T2=A 重写该任务单，模板原文要按 commit `9d0f01b` 取，看工作区会看不到 |
| 合成成本样例 `analysis/t1/data/m1.2-cost-sample.jsonl` | 由 `make-cost-sample.mjs` 跑真实 guard 生成（非手写）：before=1400/after=500、`*Source=tokenMeter`、`cost-v1.1`；字段与真实 writer 一致 |

## 7. 问题清单（全部 P3，非阻断）

| 编号 | 问题 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | `#meterDispose` 实为 Fiber（非函数），`stop()` 里 `?.()` 抛错被吞 → 注入 scope 未显式 dispose（父 fiber 兜底） | `runtime.js` `#tryInjectTokenMeter`/`stop` | 存 `() => fiber?.dispose?.()`；测试 fake 改成返回带 `dispose` 的对象，避免掩盖 |
| P3-2 | `/cg status` 新增 `last-cost`，契约文档未同步 | `docs/T5-状态命令与审计.md:22-23,37-39` | 补字段说明 + 样例行 |
| P3-3 | T8 文档字段表仍写 `auditVersion=cost-v1`（同文档 §M1.2 已写升 v1.1） | `docs/T8-回注自愈与成本归属.md:48` | 改 `cost-v1.1`，并补 4 个新字段 |
| P3-4 | 成本行延迟写：`last-cost` 短暂显示旧值；audit 里 cost 可能晚于后续事件 | `runtime.js:1295-1316` | 文档写明“after-usage 到达后才落行”，读方按 event 类型而非相邻行 |
| P3-5 | end 后第一条 assistant 消息无 usage 时直接 `none`，不等下一条 | `#captureCostAfter` | 可连续尝试 N 条/直到有 usage（或注明取舍） |
| P3-6 | `auditVersion` 精确匹配兼容性：值变了，字段只增 | `runtime.js:658` | 文档写“按前缀 `cost-v1` 匹配 / 忽略未知字段” |
| P3-7 | T1 引用的 tokenGuard 源码行号不可复核（文件不在 asar/profile） | `analysis/t1/T1-门禁记录.md:74` | 补源码绝对路径或改为“配置证据” |
| P3-8 | `baseline.mjs` 无时间闸，复跑会漂移 | `analysis/t1/baseline.mjs` | 加 `--until <iso>` 或把快照时间写进命令 |
| P3-9 | `capability@ready` 仅在 `compression.enabled=true` 时接线；关压缩时无 ready 行，诊断不对称 | `src/index.js`（`onFirstEvent` 只在压缩分支） | 与 apply 探测一样始终接线，或在文档说明 |
| 附 | 口径更正：`m1.2-cost` 实际新增 **6** 条（不是 7；171→177=+6） | `test/m1.2-cost.test.mjs` | 改 STATUS/任务单里的“7 条” |

### 7.1 处置（2026-10-25 00 转达，用户已定）

- **进 0.1.12（6 条）**：P3-1（Fiber 清理）、P3-6（`auditVersion` 前缀匹配）、P3-2（T5 文档）、P3-3（T8 文档）、P3-4/P3-5（成本行延迟写写进文档）—— 已由 00 转给开发，随 T2′ 一起修。
- **不进代码（按“证据方法局限/其余小项”留在本报告）**：P3-7（tokenGuard 源码行号不可复核）、P3-8（`baseline.mjs` 无时间闸）、P3-9（`capability@ready` 仅在压缩开启时接线），以及 §7 的条数口径更正。

## 8. 真机验收观察点（用户重启后执行，复核方不下结论）

1. `logs/governance.log`：`governance apply version=0.1.11`、`capability@apply`、`capability@ready` 各一行。
2. `capability@ready` 里看 `compaction=`/`get.compaction=` 与 `tokenMeter=`/`get.tokenMeter=` 的类型 —— **真机已确认（0.1.14，13:18Z）：`get.tokenMeter=obj`，`get.compaction=absent` 且 `get.compaction(strict=false)=undefined`**（本 scope 未提供，见 §2④）。
3. 首次真实压缩后 `memory/governance/audit.jsonl`：`compaction-cost` 的 `auditVersion=cost-v1.1`、`tokensBefore/After` 非 null、`*Source` 与 ready 探测一致。
4. `tokensAfter` 的**到达时机**：`compaction/end` 后第一条 `assistant/message` 之后才出现（不是压缩完成立刻有行）。
5. `/cg status` 的 `last-cost: before=…(source) after=…(source) trigger=…`。
6. 审计顺序：cost 行可能晚于其他事件出现，别按相邻行找。
7. 只读演练仍按 `docs/T7-只读降级人工验证.md`；S3 header 仍默认关。
8. 回滚：本次未动安装态；如需回退 = 把 junction 指回 0.1.10 源（用户批准后执行），不涉及数据迁移。

## 9. 边界遵守

- 未 push、未安装/卸载/升级、未重启 DSH、未改 profile/`cordis.patch.yml`、未动用户数据；只读 asar 与本地会话日志。
- 写文件范围：`.tmp/`（gitignore、分析脚本）与本报告；本报告的正式落盘位置为 `docs/review-context-governance-0.1.11.md`（00 2026-10-25 批准），未改代码与其他文档。
- 版本口径：本报告只针对 **0.1.11 = `01a7598`**；T2′ 的 0.1.12 另出基线，不混版。
