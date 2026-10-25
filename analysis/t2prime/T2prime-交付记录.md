# T2′ 交付记录：宿主 prune 观测 + cost-v1.2 + 0.1.11 的 6 条 P3

> 版本：**0.1.12**（0.1.11 冻结为 M1.2；`01a7598`/`65ecfde` 未改写）。
> 依据：`REQUIREMENTS.md` §REQ-20261025-02（收口版）、`TASKS/REQ-20261025-02-M1.1-拆解.md`（T2′/T7′）。
> 边界：只读观测；**不折、不改 content、不写任何落盘文件、不加 fold 开关**；未安装、未重启、未改 profile、未 push。

## 1. 实现

### 1.1 `prune-observed`

`CompressionGuard` 订阅 `session/event`，只读 `compaction/prune` + 紧随的替换 `tool/result`：

| 字段 | 来源 |
|---|---|
| `sessionId` | 当前会话 |
| `seq` | prune 事件 seq |
| `shadowedStart` / `shadowedEnd` | `shadowedRange`；缺失时用 `shadowedSeqs` 首尾；再缺为 `null` |
| `shadowedTokenCount` | prune 事件；缺失为 `null` |
| `tool` | 替换事件 `message.source.callId` 反查本会话 `tool/call.name`；查不到 `unknown` |
| `replacementSeq` | 紧随替换 `tool/result` 的 seq；没等到为 `null` |
| `cycle` | `current` / `outside` |

- **去重**：同一 `sessionId + shadowedStart + shadowedEnd` 只记一次。
- **周期归属**：`compaction/end` 之后、`compaction/summary` 之前的 prune 记 `current`；`summary` 之后或没有后续 compaction 的记 `outside`。宿主顺序是 `prune → 替换 → start`，插件先挂起 observation，`start`/`summary` 时归 `current` 并落审计。
- **失败**：事件形状不符仍记 `shadowedTokenCount`，`tool=unknown`/`replacementSeq=null`；异常只 log/audit，不抛宿主。
- **不读正文**：只用 `callId`/`seq`/元数据。

### 1.2 `compaction-cost`（cost-v1.2）

新增字段（旧 v1.1 字段语义不变）：

| 字段 | 口径 |
|---|---|
| `tokensPruned` | 本周期 `cycle=current` 的 `shadowedTokenCount` 之和；measured；无 prune → `null` |
| `pruneCount` | 本周期 prune 条数（去重后） |
| `pruneTools` | 最多 5 项 `name:count` |

- 无 pruner 环境：`pruneCount=0`、`tokensPruned=null`、`pruneTools=[]`；不写 0 冒充已测。
- `auditVersion='cost-v1.2'`；读方按 `cost-v1` **前缀匹配**（`cost-v1.1`/`cost-v1.2` 都命中）。

### 1.3 `/cg status`

`/cg status` 与 `/cg status last-cost` 的 `last-cost` 行：

```text
last-cost: before=30(tokenMeter) after=20(tokenMeter) trigger=auto pruned=4797 tools=read:1
```

无 prune 显示 `pruned=0 tools=-`；无成本记录显示 `last-cost: none`。

## 2. 离线证据

合成宿主事件（tool/call → compaction/prune → 替换 tool/result → start/summary/checkpoint/end）：

- `analysis/t2prime/data/prune-observed-cost-v1.2.jsonl`：

```json
{"ts":"...","event":"prune-observed","sessionId":"session-prune-sample","seq":2,"shadowedStart":10,"shadowedEnd":10,"shadowedTokenCount":4797,"tool":"read","replacementSeq":3,"cycle":"current"}
{"ts":"...","event":"compaction-cost","sessionId":"session-prune-sample","compactionId":"cmp-sample","trigger":"auto","tokensPruned":4797,"pruneCount":1,"pruneTools":["read:1"],"backendCostSource":"measured","governanceCostSource":"unknown","auditVersion":"cost-v1.2", ...}
```

- `analysis/t2prime/data/status.txt`：`last-cost: ... pruned=4797 tools=read:1`（`/cg status` 和 `last-cost` 两处）。
- 生成脚本：`analysis/t2prime/make-prune-sample.mjs`（合成 fixture，不含真实正文）。

## 3. 测试

```powershell
cd packages/dsh-context-governance
node --test "test/*.test.mjs"
```

**183/183 pass**。新增：

- `test/prune-observed.test.mjs` 5 条：
  1. 归因 + 字段 + `replacementSeq` + `cycle=current` + 无正文/路径；
  2. `callId` 查不到 → `tool=unknown`；
  3. `summary` 之后 → `cycle=outside`，不进本周期成本；
  4. 同 range 去重 → 只 1 行、成本只计 1 次；
  5. 无 prune → `pruneCount=0`/`tokensPruned=null`/`pruneTools=[]`，`/cg status` 显示 `pruned=0 tools=-`。
- `test/m1.2-cost.test.mjs` 增 1 条 P3-1：`ctx.inject` 返回 Fiber → `stop()` 调 `dispose()`，不再当函数调用。
- `test/t8-cost.test.mjs` 增 P3-6 断言：`cost-v1.2` 满足 `startsWith('cost-v1')`。

## 4. 0.1.11 复核的 6 条 P3（逐条）

| # | 处置 | 说明 |
|---|---|---|
| **P3-1** | **已改实现** | `ctx.inject` 返回 cordis **Fiber**，不是 dispose 函数；`stop()` 只调用 `fiber.dispose()`（并吞掉异步 rejection）。选“修实现”而不是改文档，因为原写法抛 `TypeError` 被 catch 吞、语义错误；父 fiber 仍兜底。测试见上。 |
| **P3-6** | **已改文档 + 测试** | 读方按 `cost-v1` **前缀匹配**；T8 §6.3 写明兼容口径；`t8-cost` 断言 `cost-v1.2`.startsWith(`cost-v1`)。 |
| **P3-2** | **已改文档** | `docs/T5-状态命令与审计.md`：用法补 `/cg status last-cost`，表补 `last-cost`（before/after/source/trigger/pruned/tools），示例补该行；顺带修正 `inject=['tools']`/commands 可选。 |
| **P3-3** | **已改文档** | `docs/T8-回注自愈与成本归属.md:48` 的 `auditVersion` 改 `cost-v1.2`，并注明读方前缀匹配。 |
| **P3-4/5** | **按文档说明** | §6.3 写明：meter 不可用时 cost 行延迟到 end 后首条 assistant usage（或 stop/新周期冲刷）；期间 `/cg status` 的 `last-cost` 可能短暂显示旧值，audit 中 cost 行可能晚于后续事件、不挨着 reinjection；以 `occurredAt`/`ts` 判断。 |
| 其余 3 条 | **不改代码** | tokenGuard 源码不可复核（`~/.dsh/token-guard/` 仅 metrics）、`baseline.mjs` 无时间闸会漂移、其余小项——遵从 00 决定。 |

## 5. 零折叠自查

```powershell
Get-ChildItem packages/dsh-context-governance -Recurse -File |
  Select-String -Pattern 'cg-fold|fold\.|spill|cg_read|\bfold\b'
```

结果：**0 match**（`analysis/t2prime/zero-fold-grep.txt`）。T1 实验探针只在 `analysis/t1/`，不进 `packages/`、不进 `package.json`、无“默认关闭的折叠开关”。

## 6. 交付边界与待验收

- 未安装/未重启/未改 profile/未 push；0.1.11 的 `01a7598`/`65ecfde` 未改写。
- 真机待用户重启：`version=0.1.12`、`prune-observed`、`compaction-cost` 带 `tokensPruned`/`pruneCount`/`pruneTools`、`/cg status` 的 `pruned=… tools=…`。
- 审核复核时请核对“生产代码无折叠”与 P3 六项；有阻断经 00 转开发。
