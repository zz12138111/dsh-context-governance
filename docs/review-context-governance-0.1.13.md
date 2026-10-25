# 复核基线 · dsh-context-governance 0.1.13（batch 判据收窄 + `get.compaction` 归因）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 21:0x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `2cea1ca`（feat: 0.1.13，package.json 0.1.13） |
| 需求/文档 | `6a85ee9`（REQ-20261025-04 出单） |
| 快照 | `.tmp/snapshot-0113/`（`git archive 2cea1ca`） |
| 全量测试 | **189/189 pass**（duration 2.93s；0.1.12 为 183，+6） |
| 零折叠 | `packages/dsh-context-governance/` 全文件 `cg-fold|fold\.|spill|cg_read|\bfold\b` → **0 match** |
| 拓扑 | `d8b5781 → 6a85ee9 → 2cea1ca`（直线；其后的 `edf228f` 是我 0.1.12 的 LICENSE 提交，非 0.1.13 内容） |
| 宿主 | 0.2.1-rc.3；真机仍 0.1.12（本次未安装/重启） |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：1**；**建议（P3）：5**。
- 收窄的**方向正确**：tool/JSON、日期不再被当进度；`ratios=[]` 从空泛 `pass` 改为 `skip` 并落 `protection-skip` 审计；两条正例（`511/958`）行为不变。
- **但**：收窄只排除了“非人类消息”和“日期”，**没有排除人类/助手正文里的普通计数**。用 20:46 的真实快照回放：0.1.13 会把 assistant 消息里的 `2/6` 当批次比例 → `batch-list=fail`，而 0.1.12 同快照是空泛 `pass`。即“假通过”变成了“**假失败**”（详见 §4）。建议 0.1.14 收口，0.1.13 本身不阻断。

## 2. 逐项核对（00 的复核要点）

### ① batch 收窄是否到位

- `isProgressMessage()`：只放行 `user/message`（`source.kind === 'user'`）与 `assistant/message`；`tool/call`、`tool/result`、规则注入、checkpoint 全部排除 ✔
- `stripStructuredPayload()`：先删围栏代码块、`{…}`（≤400 字符、无嵌套）、`[…]`（≤400 字符、无嵌套）✔
- `RATIO_RE = /(?<![\d/／])(\d{1,6})\s*[／/]\s*(\d{1,6})(?![\d/／])/g`：`2026/10/25` 不中，`511/958` 命中 ✔
- 多候选：带比例优先、同类取最近（`snapshot.batch` 选择条件）✔

### ② `ratios=[]` → `skip` + 审计

- `verifyProtection` 新增分支：`batch.ratios.length === 0` → `skip`，`reason='no-ratio-in-user-messages'`，附 `seqs` ✔
- `ratiosCovered([])` 改为返回 `false`（防再出现空泛 pass）；**唯一调用点**已由新分支挡住，无其它调用方 ✔
- 运行时：`report.checks` 中带 `reason` 的 skip → `protection-skip` 审计（`reason`/`names`/`count`/`manual`，不含正文）✔
- **我的独立验证**（`.tmp/check-0113.mjs`，不走 dev 测试）：
  - 关键字-only 用户消息 → `batch-list=skip` + `protection-skip{reason=no-ratio-in-user-messages, names=["batch-list"], count=1}` ✔
  - tool/result JSON（`{"batch":"T3","progress":"511/958"}`）→ `skip` **无 reason**、**无** `protection-skip` 事件 ✔
  - 正例 `511/958` 且摘要覆盖 → `pass` ✔
  - 日期 `2026/10/25` → `skip` + reason ✔

### ③ 两条 regression

| 场景 | 结果 |
|---|---|
| 反例：tool/result 含 `{"batch":…}` | `batch=null` → `batch-list=skip`（无 reason）✔ |
| 正例：用户消息 `8000/1500` | 摘要覆盖 → `pass`；不覆盖 → `fail` ✔（dev 用例 + 我的独立用例都过） |

### ④ 6 场景改判 diff

我**独立重跑** `analysis/req-20261025-04/replay-diff.mjs`，输出与 `replay-diff.txt` **逐字一致**：`status changed: 4/6`；⑥ 日期 fail→skip、① tool JSON pass→skip、② 空泛 pass→skip、③ 关键字 pass→skip；**④⑤ 正例不变**（pass/fail 均保持）。
另核对：`analysis/req-20261025-04/protection-0.1.12.js` 与 `d8b5781` 的 `protection.js` **逐行一致**（441 行；Compare-Object 0 差异），基线副本可信。

> 注意：这 6 个场景里没有“普通计数（如 `183/183`、`2/6`）出现在人类/助手正文”的样本 —— 这正是 §4 漏测的那类。

### ⑤ `get.compaction` 归因（strict=false）

- `capabilities.js` 新增 `LAX_PROBES=['compaction']`，输出 `get.compaction(strict=false)`：`obj`（有 impl 未 active）/`undefined`（本 scope 未提供）/`unknown`（不支持或抛错）✔
- 我的现场探测（4 态）：`obj` / `undefined` / `unknown` / `no-get`（`ctx.get` 缺失时）均符合预期 ✔
- 真机值（2026-10-25 13:18Z，0.1.14 重启后确认）：@apply 与 @ready 两条都是 **`get.compaction(strict=false)=undefined`** → 本 scope **看不到** compaction 服务（`obj` 才表示“有 impl 未 active”）；**根因：agent preset 的 `cordis:group` + `isolate: {compaction: true}`**（`@local/dsh-computer-use/presets/cordis.patch.yml`、`@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 均如此）；「回注时点修正」在该部署下**不可行**，只能按事件时序推断。

### ⑥ 无回归

- 改动仅 4 个源文件：`audit.js`(+2)、`capabilities.js`(+19)、`protection.js`(+51)、`runtime.js`(+14)；折叠/回注/记忆/成本路径未动 ✔
- `auditVersion` 仍 `cost-v1.2`；成本字段未变 ✔
- 0.1.12 的 6 条 P3 仍 backlog（代码里没有相关改动）✔

## 3. 测试抽验

- **189/189 pass**（快照上跑）；新增 6 条 = `compress-protection` 4 + `perception-capabilities` 1 + `compress-integration` 1 ✔
- `protection-skip` 落盘有专门用例（`compress-integration`），断言 `reason` 与 `names` ✔
- 我另做了 4 组独立检查（见 §2②、④、⑤ 及 §4），不依赖 dev 测试代码。

## 4. P2（真实数据上新出现的“假失败”）

**证据（A/B 同一真实快照，`session-58a2e845` 20:46 手动压缩，窗口 8538–11499）**：

```
0.1.12 | batch.seq=11479 ratios=[]        | check=pass
0.1.13 | batch.seq=11453 ratios=["2/6"]   | check=fail   → failures 多出 batch-list
```

- 11453 是一条 **assistant/message**，正文里有“2/6”（一次收口计数，不是批次进度）；20:46 的摘要里没有“2/6”。
- 0.1.12 选中 11479（一条**审计 JSON dump**）→ `ratios=[]` → 空泛 pass（旧 bug）；0.1.13 排除了 tool/result，改选 11453 → **fail**（新 bug）。
- 结论：**收窄没有把“普通 x/y 计数”排除**，而真实项目会话里 `183/183`、`177/177`、`2/6`、`4/5` 这类计数非常常见 → 之后的真实压缩很可能反复出现 `batch-list=fail`，并被写进 `manual-compaction-loss`，看起来像“批次丢了”。
- **不是**“该 pass 的改成 skip”（那条 00 提醒的口径没被违反）；这是“**非批次的计数被当成批次并判 fail**”。

**建议（0.1.14）**：任一即可
1. 比例必须与 `批次|进度|progress|batch` **同消息**出现才算候选（当前是“关键字或比例”任一即可）；
2. 或只取 `user/message`（助手正文的计数噪声最大）；
3. 或要求比例前后文形如“批次/进度 … x/y”。
并在 `manual-compaction-loss` 的说明里补一句：batch-list 失败只表示“选中的比例未被摘要覆盖”，不等于批次真的丢。

## 5. P3 清单

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | `RATIO_RE` 仍接受“年/月”形态（如单独出现的 `2026/10`） | `protection.js` `RATIO_RE` | 可加“四位数/≤12”排除或要求两侧有批次语境 |
| P3-2 | `stripStructuredPayload` 会删掉用户正文里 `{511/958}` 这类括号进度（假阴性） | `stripStructuredPayload` | 文档注明；或只删“像 JSON 的”块（含引号/冒号） |
| P3-3 | 助手正文参与取数 → 测试计数噪声大（与 §4 同源） | `isProgressMessage` | 若采纳 §4 方案 1/2 可一并解决 |
| P3-4 | `analysis/req-20261025-04/protection-0.1.12.js` 是 0.1.12 源码的 441 行副本（未发布，但会与源码漂移） | `analysis/req-20261025-04/` | 注明“快照副本/RFC 基线”，或改由 `git show d8b5781:…` 生成 |
| P3-5 | probe 字段名内嵌 `=`（`get.compaction(strict=false)=undefined`），按 `=` 切分的外部读者会误读 | `capabilities.js` | 文档注明；或改名为 `get.compaction.lax` |

## 6. 真机验收观察点（重启后，复核方不下结论）

1. ✅ 已确认（2026-10-25 13:18Z，0.1.14）：`capability@apply`/`@ready` 都是 `get.compaction(strict=false)=undefined` → 本 scope 看不到（根因：agent preset `cordis:group` + `isolate.compaction: true`）；「回注时点修正」不可行，只能按事件时序推断。
2. 下一次真实压缩：若摘要/消息里有明确 `x/y`，`batch-list` 应能 pass/fail；若只有关键字 → `skip` + `protection-skip`（`reason=no-ratio-in-user-messages`）。
3. **若出现 `batch-list=fail` 且比例是 `2/6`、`183/183` 这类计数 → 属于 §4 的已知假失败，不要当成批次丢失**（0.1.14 修复前）。
4. 成本/回注/记忆行为与 0.1.12 一致（`cost-v1.2`、`prune-observed` 不受影响）。

## 7. 边界与推送

- 未安装/重启/卸载、未改 profile、未动用户数据；只读 asar、会话日志与仓库。
- 拓扑确认直线：`d8b5781 → 6a85ee9 → 2cea1ca`；本报告提交将在 `edf228f`（LICENSE）之上，fast-forward push，只推分支，不打 tag。
- 基线口径：0.1.11=`01a7598`；0.1.12=`a75ce82`；0.1.13=`2cea1ca`。
