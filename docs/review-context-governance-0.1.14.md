# 复核基线 · dsh-context-governance 0.1.14（batch 比例同源约束）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 21:1x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `b6729da`（feat: 0.1.14，package.json 0.1.14） |
| 需求/文档 | `a7d6609`（出单）、`561d09e`（P2 改同消息绑定） |
| 快照 | `.tmp/snapshot-0114/`（`git archive b6729da`） |
| 全量测试 | **196/196 pass**（duration 1.41s；0.1.13 为 189，+7） |
| 零折叠 | `packages/dsh-context-governance/` 全文件 `cg-fold|fold\.|spill|cg_read|\bfold\b` → **0 match** |
| 拓扑 | `3553a8a（我）→ a7d6609 → 561d09e → b6729da`（直线；origin 仍在 `3553a8a`） |
| 宿主 | 0.2.1-rc.3；真机仍 0.1.12（本次未安装/重启） |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**（0.1.13 的 P2 已修，见 §3）；**建议（P3）：4**。
- 同源约束落地正确：关键字（`批次|进度|progress|batch`）与比例必须**同一条**消息；无关键字 → `skip(no-batch-semantics)`；`YYYY/MM` → `skip(date-like-ratio)`；正文 `{511/958}` 保留、JSON 载荷不参选；**skip 不写 `manual-compaction-loss`**（真批次丢失仍会 fail）。
- **0.1.13 的 P2 根因确认属实**：`2/6` 来自评审语 `0 阻断 / 0 P2 / 6 P3` 中的 `P2 / 6` 被 `RATIO_RE` 的 `\s*` 拼成 `2/6`（见 §3）。

## 2. 逐项核对（00 的复核要点）

### ① P2 绑定实现

- `BATCH_KEYWORD_RE = /批次|进度|progress|batch/i`；`batchMarkers` 里 `keyword` 与 `ratios` 都取自**同一条** `textOf(event)` → 跨消息拼凑不成立 ✔
- `isProgressMessage` 仍只放行 `user/message`(kind=user) 与 `assistant/message`；`tool/*`、规则注入不参与 ✔
- 无关键字但有比例 → 记为 `batchRejected`（不建 `batch`）；`batch===null` 且存在 `batchRejected` → `skip` + `reason=no-batch-semantics` + `seqs:[rejected.seq]` ✔
- 关键字存在但无比例 → 仍 `skip`；只剩日期 → `skip` + `reason=date-like-ratio` ✔

**我的独立验证（`.tmp/check-0114.mjs`，不依赖 dev 测试）**

| 场景 | 结果 |
|---|---|
| 真实快照（我从会话日志重建表面，不用他们的 JSON 夹具） | 0.1.13：`batch.seq=11453 ratios=["2/6"] → fail`；**0.1.14：`batch=null, rejected=11453 → skip(no-batch-semantics)`，failures 里没有 batch-list** ✔ |
| 跨消息：关键字在 A 消息、比例在 B 消息 | `batch=seq2, ratios=[]` → `skip(no-ratio-in-user-messages)`，不 fail ✔（不拼凑） |
| assistant 正文 `0 阻断 / 0 P2 / 6 P3` | `skip(no-batch-semantics)` + `protection-skip{reason=no-batch-semantics, names=[batch-list], manual=true}`，**无 manual-compaction-loss** ✔ |
| 仅 `8000/1500`（无关键字） | 同上：skip + 审计 + 无 loss ✔ |
| `批次 8000/1500` + 摘要覆盖 / 不覆盖 | `pass` / `fail`（**真丢仍判 fail**，写 `manual-compaction-loss: ["batch-list"]`）✔ |
| `批次归档：2026/10` | `skip(date-like-ratio)` + 审计 ✔ |

### ② 四条验收

| # | 验收 | 结果 |
|---|---|---|
| ① | `11479`（tool JSON，ratios=[]）0.1.14 不得 fail | 未成候选 → `skip`，不进 failures ✔ |
| ② | `11453`（`2/6`）0.1.14 不得 fail | `skip(no-batch-semantics)`，`rejected=11453` ✔ |
| ③ | 正例 `批次 8000/1500` 判对 | pass/fail 均正确（dev 用例 + 我的独立用例）✔ |
| ④ | 仅 `8000/1500` 必须 skip 且**不写 manual-compaction-loss** | `skip` + `protection-skip` 落盘 + 无 loss（我的独立 guard 级验证）✔ |

### ③ `2/6` 根因确认

- 真实会话 `seq=11453` 正文含：`**审核复核已出（0 阻断 / 0 P2 / 6 P3）；真机已加载…**`；
- `RATIO_RE` 允许数字与斜杠之间有空白（`(\d{1,6})\s*[／/]\s*(\d{1,6})`），于是 `P2 / 6` 命中为 `2 / 6` → `"2/6"`；
- 与开发在 `DEC-20261025-46`/REQ-05 报告里的解释**完全一致**，假 fail 来源属实。

### ④ 三列对照可复现

- 我重跑 `node analysis/req-20261025-05/replay-real.mjs`，输出与 `analysis/req-20261025-05/replay-real.txt` **逐字一致**（`Compare-Object` 为空）：A/B 两个表面都是 `0.1.12 pass / 0.1.13 fail / 0.1.14 skip(no-batch-semantics)`。
- `analysis/req-20261025-04/replay-diff.mjs` 重跑仍为 6 场景 4 改判（与既有 `replay-diff.txt` 一致）；它现在用 `git show 2cea1ca` 取 0.1.13 源码，**0.1.12 基线仍用本地 `protection-0.1.12.js` 副本**（见 P3-1 的措辞澄清）。

### ⑤ P3① / P3②

- P3① 日期：`YEAR_PREFIX_RE`（19xx/20xx）+ 1–12 剔除，进入 `dateLike`；只剩日期时 `skip(date-like-ratio)` ✔
- P3② 正文比例保留：`stripStructuredPayload` 仅当 `{…}`/`[…]` 片段含引号或冒号才剥离；`批次进度 {511/958}` 保留并可判 pass；`{"batch":"511/958"}` 被剥离 → `no-ratio-in-user-messages` ✔
- P3③④⑤ 未纳入（`capabilities.js` 未改；`analysis/req-20261025-05` 用 `git show` 取旧版，不放新副本）✔

### ⑥ 无回归

- 改动仅 `protection.js`（+72/−33 行级）与 3 个测试文件 + 文档；折叠/回注/记忆/成本路径未动 ✔
- `auditVersion` 仍 `cost-v1.2`；`protection-skip` 字段未变（`reason/names/count/manual`）✔
- 0.1.13 的 5 条 P3：③ 随同源约束收敛，④⑤ 未处理（backlog 不变）✔

## 3. 测试抽验

- **196/196 pass**；新增 7 条 = `compress-protection` 6 + `compress-integration` 1 ✔
- 集成用例断言：skip 不写 `manual-compaction-loss`、`protection-skip.reason=no-batch-semantics`、`manual=true`、`names` 含 `batch-list` ✔
- 我另做 6 组独立验证（§2①的表格），全部通过。

## 4. P3 清单

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | `analysis/req-20261025-04/protection-0.1.12.js` 仍是 441 行源码副本（`replay-diff.mjs` 的 0.1.12 基线仍在用它）；“不再放副本”只对 0.1.13 成立 | `analysis/req-20261025-04/` | 二选一：给副本加“冻结基线”注释并在脚本头写明，或让 `replay-diff.mjs` 统一 `git show 2cea1ca^` 后删副本 |
| P3-2 | `snapshot-11509.json` 含真实会话正文片段（如 `0 阻断 / 0 P2 / 6 P3`）与真实摘要 | `analysis/req-20261025-05/real/` | 公开仓库前与其它 `analysis/` 数据一起脱敏（沿用既有备注） |
| P3-3 | `batchRejected` 只留**最后一条**被拒候选，多候选时 skip 证据只报最后一条 seq | `protection.js` `snapshotProtection` | 可留列表或在 reason 里注明“最后一例” |
| P3-4 | 关键字 `进度` 较泛：如“测试进度 183/183”仍会绑定并被判 fail（有关键字即候选） | `BATCH_KEYWORD_RE` | 接受现状即可，文档已写“宁可 skip 不可 fail”的取舍；若真机出现再收窄 |

## 5. 真机验收观察点（重启后，复核方不下结论）

1. 下一次真实压缩：**不应再出现 `batch-list=fail`**（普通计数不再绑定）；若批次消息带 `批次/进度 + x/y` 且摘要没覆盖，仍会 fail——那才是真信号。
2. 出现 `skip` 时看 `protection-skip.reason`：`no-batch-semantics`（有比例无关键字）/ `no-ratio-in-user-messages`（有关键字无比例）/ `date-like-ratio`（只有日期）。
3. `manual-compaction-loss` 里不应再出现 `batch-list`（除非真批次丢失）。
4. 成本/回注/记忆行为与 0.1.12/0.1.13 一致（`cost-v1.2`、`prune-observed` 不受影响）。

## 6. 边界与推送

- 未安装/重启/卸载、未改 profile、未动用户数据；只读 asar、会话日志与仓库。
- 拓扑直线（`3553a8a → a7d6609 → 561d09e → b6729da`）；本报告提交前先 `git log -1` 确认父提交，随后 fast-forward push 只推分支、不打 tag。
- 基线口径：0.1.11=`01a7598`；0.1.12=`a75ce82`；0.1.13=`2cea1ca`；0.1.14=`b6729da`。
