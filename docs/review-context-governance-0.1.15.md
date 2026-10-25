# 复核基线 · dsh-context-governance 0.1.15（事件形态推断 inferred + cost-v1.3）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 23:1x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。
> 本次重点不是“功能对不对”，而是“**推断有没有偷偷影响行为**”。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `fd0b08d`（feat: 0.1.15，package.json 0.1.15） |
| 需求/验证文档 | `37d7f95`（出单）、`83cc08e`（D1 验证记录）、`93a85a8`（REQ-06 回填决策 A） |
| 快照 | `.tmp/snapshot-0115/`（`git archive fd0b08d`） |
| 全量测试 | **202/202 pass**（duration 1.62s；0.1.14 为 196，+6） |
| 拓扑 | `9e8eb73（origin）→ 37d7f95 → 83cc08e → 93a85a8 → fd0b08d`（直线） |
| 宿主 | 0.2.1-rc.3；桌面未安装/未重启；隔离实例已停 |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**；**建议（P3）：5**（含 1 处文档控制字符）。
- 四条硬约束全部成立：三处标注 inferred、功能路径不读推断、判不出保持 unknown、`mixed` 标 `unverified` 且 `inferred=false`。
- `cost-v1.3` 边界正确：**实测可得时不用推断补位**；只有实测 kind 为 `none`/`unknown` 时才补，并显式 `backendInferred`。

## 2. 四条硬约束逐项

### ① 一律标 inferred（三处）

- **`/cg status`**：`cg-status.js:34-39` 仅在实测 `kind` 为 `none`/`unknown` 且推断非 unknown 时追加 `inferred=<label>`；实测 JSON 行：`adapter=none inferred=host-basic (inferred)`（`native-test-0.1.15-cg-status.txt`）。
- **审计行**：`adapter-inferred`（`audit.js` 白名单 `inferred:boolean`），真实隔离实例写出
  `{"event":"adapter-inferred","adapter":"host-basic (inferred)","inferred":true,"kinds":["free-form"],"reason":"summary-shape"}`（`native-test-0.1.15-reverify.jsonl`）。
- **成本行**：`compaction-cost` 带 `backend` + `backendInferred`，真实实例 `backend="host-basic (inferred)"`、`backendInferred=true`、`auditVersion=cost-v1.3`。
- 我的独立验证：`inferred=` 标记只在 `none`/`unknown` 实测时出现；实测 `host-basic` 适配器下**不出现**该标记（脚本 D 组，见 §4）。

### ② 不得据此做行为分支（重点自查）

- 源码级：`grep 'inference|backendInferred|inferred' src/` 的读取点只有三处——`cg-status`（展示）、`runtime.#writeCost`（归属字段）、`runtime.#handle`（观察→更新 inference→写 `adapter-inferred`）。`selection.js`、`protection.js`、回注路径**没有任何读取**。
- **选择器断言我自己复跑**（不只看 dev 测试）：
  - 同一 `none` 适配器分别注入 free-form / five-section / mixed 三种相反推断 → `selectMode()` 输出 **deepEqual 一致**（mode 均为 `event-level`）；
  - 同一**实测 `host-basic`** 适配器做同样三注入 → 输出也 **deepEqual 一致**（mode 均为 `full`）。
  - 结论：dev 的断言是真的，且不只对 `none` 成立。
- **功能面等价性**：我用同一 guard 分别跑 free-form 与 five-section 两轮完整周期，`stats.events/protectionWrites/reinjections`、`lastReport.failures` 名称、以及**功能审计事件多重集合**（剔除 `adapter-inferred` 与成本归属字段）**完全相同**；只有 `compaction-cost.backend/backendInferred` 不同（属归属展示）。

### ③ 判不出保持 unknown

- 无摘要形态可观察（空摘要）时：`inferBackendFromStyles([]) = unknown/inferred=false`；成本行 `backend` 保持实测 kind（例：`none`）、`backendInferred=false`；`/cg status` 不打印 `inferred=`。
- 我的独立验证（脚本 C 组）：`none + 无观察 → backend=none, backendInferred=false` ✔

### ④ 混合形态 → `mixed (unverified)` 且 `inferred=false`

- `inferBackendFromStyles(['free-form','five-section'])` → `{kind:'mixed', label:'mixed (unverified)', inferred:false}`（源码 + 我的脚本 A 组断言）。
- 真实两轮（free-form 后 five-section）后：`status.adapter.inference.kind=mixed`、成本行 `backend="mixed (unverified)"`、`backendInferred=false`（dev 用例与我的 C 组一致）。

## 3. `cost-v1.3` 落法（边界没写反）

`runtime.#writeCost`：

```js
const useInference = (kind === 'none' || kind === 'unknown') && inference !== null && inference.kind !== 'unknown';
const inferredKind = useInference ? inference.label : null;
backend: inferredKind ?? kind,
backendInferred: inferredKind !== null && inference.inferred === true,
```

我的边界验证（脚本 C 组）：

| 实测 kind | 注入推断 | 成本行结果 |
|---|---|---|
| `host-basic`（实测） | free-form | `backend=host-basic`、`backendInferred=false`（**保持 measured**） |
| `unknown`（实测） | five-section（同轮观察） | `backend=context-zip (inferred)`、`backendInferred=true` |
| `none`（实测） | free-form（同轮观察） | `backend=host-basic (inferred)`、`backendInferred=true` |
| `none` | 无可观察形态 | `backend=none`、`backendInferred=false` |

- 字段只增：`backendInferred` 新增；`auditVersion` 升 `cost-v1.3`；v1.2 字段语义未动（`tokens*`、`prune*` 不变）。
- `backendCostSource` 的 measured/unknown 判定只看 `backendUsage`，与推断无关 ✔（不会把推断混进 measured）。

## 4. 测试与证据

- **202/202 pass**（快照 `fd0b08d`）；新增 6 条（`test/m1.3-inference.test.mjs`）：四类推断、选择器不读推断、free-form 成本标注、five-section 功能一致、mixed 不标 inferred、`/cg status` 标注。
- 我的独立脚本 `.tmp/check-0115.mjs` 四组（A 选择器不变 / B 全周期功能等价 / C 成本补位边界 / D 状态标记范围）全部通过。
- 隔离实例证据：`native-test-0.1.15-reverify.jsonl`（含 `adapter-inferred` + `cost-v1.3` 实写）、`native-test-0.1.15-cg-status.txt`（`inferred=host-basic (inferred)`）。
- **18765 无残留**：`Get-NetTCPConnection -LocalPort 18765` = 无监听；`node/pwsh` 进程按 18765 过滤无残留实例（仅我自己的检查命令）。

## 5. P3 清单

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | README 的 0.1.15 行含**控制字符**（0x08 backspace、0x07 bell），渲染后 `backendInferred` 变 `ackendInferred`、`auditVersion` 变 `uditVersion` | `packages/dsh-context-governance/README.md` 0.1.15 行 | 删除控制字符，改回纯文本 `（backendInferred）`、`；auditVersion=cost-v1.3` |
| P3-2 | `compaction-cost.backend` 现在可能写 `host-basic (inferred)` 这种**标签**而非枚举 kind，下游若按枚举解析会失配 | `runtime.js#writeCost` | 文档写明“`backend` 可能是 label，需配合 `backendInferred`”；或拆 `backendKind`/`backendLabel` |
| P3-3 | `#observedStyles` 是 guard 级 Set，**跨会话累积**：同一 project 里不同会话用不同后端形态时，会长期停在 `mixed (unverified)` | `runtime.js` | 安全（不误标单一后端），但建议文档注明“mixed 可能来自跨会话累积” |
| P3-4 | 隔离实例证据缺 **0.1.15 的 `apply version=0.1.15` 行**（apply-lines 只有 0.1.14）；0.1.15 已加载靠 `adapter-inferred`/`cost-v1.3` 反推 | `analysis/req-20261025-06/native-test-apply-lines.txt` | 下次隔离复验补录 apply 行，证据链更硬 |
| P3-5 | `adapter-inferred` 每次 label 变化各写一行，多会话下可能重复出现 | `runtime.js#handle` | 可接受；如噪声大可加去重（同 label 连续不重复） |

## 6. 真机验收观察点（桌面重启后，复核方不下结论）

1. `apply version=0.1.15`；`compaction-cost.auditVersion=cost-v1.3`。
2. 首次真实压缩后 `adapter-inferred` 出现一次，且 `/cg status` 显示 `adapter=none inferred=…`。
3. 同一 project 再压一次：若形态一致 → 仍标 inferred；若第二次换形态 → `mixed (unverified)`、`backendInferred=false`。
4. 实测 kind 可得的部署（例如未来 profile 未隔离）→ 成本行 `backendInferred` 必须为 `false`。
5. 保护/回注行为与 0.1.14 一致（推断只改归属展示）。

## 7. 边界与推送

- 未安装桌面/未重启、未改 profile、未动用户数据；只读 asar、会话日志与仓库。
- 拓扑直线（`9e8eb73 → 37d7f95 → 83cc08e → 93a85a8 → fd0b08d`）；本报告提交先 `git log -1` 确认父提交，fast-forward push 只推分支、不打 tag。
- 基线口径：0.1.11=`01a7598`；0.1.12=`a75ce82`；0.1.13=`2cea1ca`；0.1.14=`b6729da`；0.1.15=`fd0b08d`。
