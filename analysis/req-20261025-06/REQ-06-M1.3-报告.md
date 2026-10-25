# REQ-20261025-06 / M1.3 原生后端验证（D1）报告

> 依据：`REQUIREMENTS.md` REQ-20261025-06、`TASKS/REQ-20261025-06-原生后端验证-拆解.md`（`37d7f95`）。
> 结论：**原生后端可用，但后端识别未覆盖（D1-1 不通过）**；摘要/回注/手动链路通过；自动压缩链路未实测（见 §4）。
> 版本：验证本身未改代码，仍 **0.1.14**；未 push。

## 1. 隔离实例（D1-5 证据）

| 项 | 值 |
|---|---|
| profile | `C:\Users\19091\.dsh\profiles\native-test`（从 shipped `web` 模板创建，**不含 context-zip、无 redirect**） |
| 插件 | junction `node_modules\dsh-context-governance` → `D:\DS-PROJECT\DSH插件开发\packages\dsh-context-governance`（与桌面同方式，未改用户安装态） |
| 端口 | `127.0.0.1:18765`（与桌面实例 1860 错开；验证后已停，监听已释放） |
| 工作目录 | 会话 cwd = `D:\DS-PROJECT\DSH插件开发`；插件记忆/日志隔离到 `.tmp\native-test-ws\` |
| desktop 实例 | 未受影响（profile 未改、pid 15096 仍在；未卸载/禁用 context-zip） |
| 实例状态 | **已停**（`Get-NetTCPConnection 18765` 无 Listen；无 native-test 进程残留） |

插件配置（profile 级 patch，仅测试 profile）：`projectRoot=D:/DS-PROJECT/DSH插件开发`、`memoryRoot=.tmp/native-test-ws/memory/governance`、`diagnostics.logFile=.tmp/native-test-ws/logs/governance.log`。

## 2. D1-1 后端识别：**不通过（识别缺陷候选）**

- 真机（原生、无 redirect）：`adapter=none`、`compaction-service=absent(token=compaction)`、`mode=event-level`、`perception=event`（`native-test-apply-lines.txt`）。
- 原因（源码级）：`detectAdapter()` 只认 `ctx.compaction` 服务；agent preset 用 `cordis:group` + `isolate: { compaction: true, toolResultPruner: true }` 把服务隔离在 preset 组内，根级插件不可见 —— 无论有没有 context-zip redirect，都是 `none`。
- 影响：**功能不受影响**（保护/回注/成本都走 `session/event`，本轮全部工作）；只是适配器/能力自检把原生标成 `none`，无法区分"原生"与"无后端"。
- 离线佐证（T1）：E1/E2 的 6 次自由摘要（2026-10-19～10-23 17:58Z，早于五段式首次出现 18:39Z）全部 `fiveSectionHits=[]`、`summaryChars` 2,260–11,640 → 原生样本成立；旧会话日志已被清理，无法重取原文，但分类只需"非空 + 标题命中数"。

## 3. D1-2 摘要形态与回注分支：**通过**

- 隔离实例真实原生摘要：**9,193 字符、五段标题命中 0**（自由文本，`## Primary Request and Intent…`）→ `classifySummaryText` = `readable` + `free-form`。
- 回注无"五段式专属分支"（源码 grep：`summary.style` 只出现在 `adapters.js`（契约/自检）、`selection.js`（漂移告警）、`cg-status.js`（展示），回注/覆盖判断不读 style）。
- 实际回注（seq=82）：`[context-governance] 压缩后受保护指针（cycle …, manual=true）：` + 4 条"ID + 状态 + 标题/最后一句 + 见记忆" → 属"标题+指针"形态，与五段式无关。

## 4. D1-3 自动压缩链路：**未实测（部分通过）**

- 手动链路（同一 guard 代码路径）完整：`protection-write`(4) → `protection-materialized`(4) → `manual-compaction-loss`(latest-user-message, rule-injection) → `reinjection`(seq=82, count=4) → `compaction-cost`（`trigger=manual`、`backend=none`、`model=deepseek-account/deepseek-flash`、`auditVersion=cost-v1.2`、`tokensPruned=null`/`pruneCount=0`、`tokensBefore/After` 均 tokenMeter）。
- **自动压力未触发**：宿主原生触发点 ≈67.85%（`0.8 + 65536`，1M 窗口约 678K tokens），隔离实例只跑到 ~70K tokens，时间/成本不允许继续堆。建议补验方式（不阻塞结论）：单次 `read` 一个 >1M token 的巨型文本触发 `context-overflow`（该分支会调 `pruneSession`，可同时验 `prune-observed` 正路径），或用小窗口模型另起一轮。
- 5 类保护项：本轮 4 条指针（latest-user/rules/batch/rollback）全部固化并回注；`tool-pairing` 由宿主保证（未单独断言）。

## 5. D1-4 手动压缩：**通过**

- S4=B 三件套齐全：① 4 条记忆指针（MEM-20261025-1000…1003）；② `manual-compaction-loss` 告警（宿主手动压缩吞最新用户/规则，预期行为）；③ 回注可见最后一句（`MEM-… 仍生效：最后用户消息：请读取 … 并总结三点。`）。
- 与 context-zip 下的差异：无（回注形态、成本字段、trigger 判定一致）。

## 6. 需要 0.1.15 吗？

- **D1-1 是唯一不通过项**，属"识别缺陷"（非功能缺陷）：建议二选一，**改代码前先由需求确认**：
  - **A（推荐）**：事件形态推断——首次 `compaction/summary` 后按 `classifySummaryText` 把 `free-form → host-basic`、`five-section → context-zip` 标为 `inferred`（不覆盖 `none` 的功能路径），仅修 `/cg status`/审计可读性，风险低；
  - **B**：不改代码，文档写明"本部署 `adapter=none` 是隔离所致，功能走事件级"，把 `none` 视作合法状态。
- D1-2/D1-4 通过，D1-3 自动分支待补验（方法与 §4 同），均不需要代码修改。

## 7. 证据路径

- `analysis/req-20261025-06/native-test-apply-lines.txt`（capability/apply 行）
- `analysis/req-20261025-06/native-test-audit.jsonl`（隔离实例 10 条审计）
- 会话：`session-b2cd6d19-200c-459a-a527-a963c51dc167`（原生手动压缩 2 轮：summary 7,749 / 9,193 字符、0 五段标题；回注 seq=82）
- 实例日志：`.tmp/native-test-ws/logs/governance.log`（原始）；`~/.dsh/profiles/native-test/`（隔离 profile，已停，可保留作复验）

## 8. 0.1.15 修复与 D1-1 复验（2026-10-25）

- **实现**：`inferBackendFromStyles` + `withInference`（`src/compress/adapters.js`）——free-form→`host-basic (inferred)`、five-section→`context-zip (inferred)`、混合→`mixed (unverified)`、无观察→`unknown`；`runtime.js` 在每次 `compaction/summary` 后更新 `adapter.inference` 并写 `adapter-inferred` 审计；`/cg status` 增加 `inferred=…`；`compaction-cost` 仅在实测 kind 为 `none/unknown` 时用推断补位，新增 `backendInferred`，`auditVersion=cost-v1.3`。
- **硬约束**：推断不进任何行为分支（保护/回注/降级/成本计算仍读实测 kind 与既有来源）；单测「相反推断下选择器输出不变」；四种形态 + 混合 + `/cg status` 标注共 6 条新用例。
- **隔离实例复验**：0.1.15 加载（`apply version=0.1.15`，15:10:05Z）后手动 `/compact`：
  - `adapter-inferred`：`adapter="host-basic (inferred)"`、`inferred=true`、`kinds=["free-form"]`；
  - `compaction-cost`：`backend="host-basic (inferred)"`、`backendInferred=true`、`auditVersion=cost-v1.3`；
  - `/cg status`：`compression: mode=event-level adapter=none inferred=host-basic (inferred) perception=event … summary=readable/free-form`。
- **证据**：`native-test-0.1.15-reverify.jsonl`、`native-test-0.1.15-cg-status.txt`。
- **测试**：全量 **202/202** 通过（+6）；版本 0.1.15；未安装/未重启桌面、未 push；隔离实例已停（18765 无监听）。
