# 复核报告（第四轮）· `dsh-context-governance` v0.1.8（附 0.1.9）

> 复核方：审核打包。技术结论以本报告为准；用户验收只看交付物与体验。
> **对象：0.1.8 = `90c897e`（19:34:31 +08）**，固定快照 `.tmp/snapshot-018/rev018/`。
> 复核期间开发又提交了 **0.1.9 = `e2d7667`（19:36:50）**，正好包含上轮 P3-1/P3-2 与 P2 fixture 结构白名单；第 3 节按 0.1.9 附核（快照 `.tmp/snapshot-019/rev019/`），不与 0.1.8 的结论混算。
> 运行态：仍是 **0.1.6**（pid 32544；`logs/governance.log` 最后一行 version=0.1.6）→ 0.1.8/0.1.9 **都没有真机运行证据**，T8 全部为源码 + 离线/独立验证。
> 测试：0.1.8 快照 **166/166 pass**；0.1.9 快照 **168/168 pass**。
> 纪律：未改代码、未 push、未装、未重启。

---

## 0. 结论摘要

| 项 | 结论 | 备注 |
|---|---|---|
| **阻断项** | **0** | 以 0.1.9 为当前 HEAD 判定；严格只发 0.1.8 的话，fixture 结构白名单未做（已被 0.1.9 覆盖） |
| T8-1 回注自愈 | **已修** | 不再永久关闭；默认 3、夹取 1–20；暂停一周期仍回注；下一周期自愈；事件齐全。**P2：阈值未接进插件配置，用户改不了** |
| T8-2 成本归属 | **已实现，A 口径缺 1 个维度** | 主键/数值/来源/auditVersion 齐；实测/估算未混算；审计无正文。**P2：缺 `backend` 字段** |
| 上轮 P3-1 commands 竞态 | 0.1.8 **未做** → 0.1.9 **已修** | `ctx.inject` + 一次重试 + 测试 |
| 上轮 P3-2 shadowedRange 兜底 | 0.1.8 **未做** → 0.1.9 **已修** | 代码 + 测试 |
| 上轮 P2 fixture 结构白名单 | 0.1.8 **未做** → 0.1.9 **已修** | 独立扫描：英文正文 835 → 1（仅 meta.note） |
| STATUS ROB-01/06 | **已按事实改写**（0.1.8 起） | `## 已知风险（当前无）` + 说明；但“在办”表与 REQUIREMENTS 的 T9 口径仍冲突（P3） |

新增 P2 = 2 条（maxFailures 不可配、cost 缺 backend）；新增 P3 = 6 条（见各节）。

---

## 1. T8-1 回注失败自愈（ROB-01/06）

### 1.1 代码核对（0.1.8 快照）
- **不再永久关闭**：`#disableReinjection()` 已删除；`#reinjectionDisabled` 只在构造时置 `false`（`:124`），全文无赋值 true → 永久关闭路径不存在。
- **阈值**：`reinjection.maxFailures` 默认 3、夹取 `[1,20]`（`:183-189`）；状态里暴露 `maxReinjectionFailures`/`reinjectionFailureStreak`/`reinjectionSuspended`（`:390-392`）。
- **失败处理**：每次失败 `#noteReinjectionFailure` 累加 streak（`:520-539`），每次都写 `reinjection-failed`（带 `count`）；达到阈值才置 `#protectionSuspended=true`、mode→`degraded-protection`、写 `reinjection-degraded`（reason=`max-consecutive-failures`）。
- **只暂停一周期**：下一个 `compaction/start` 把 `suspended` 搬进 `#skipProtectionThisCycle` 并清 `suspended`（`:909-911`）；该周期 `#protectBeforeSummary` 写 `protection-write-skipped`（reason=`reinjection-suspended`）后直接返回（`:594-604`），**不写新保护条目**。
- **暂停周期仍回注**：`#injectPointers` 在 entries 为空且 `skipProtectionThisCycle` 时，用既有记忆里的 `session:<id>#…` 指针兜底（`:773-794`），仍走 `session.append`。
- **自愈**：回注成功 → `#noteReinjectionRecovered` 清 streak/suspended/skip、过滤 `reinjection-failed`、写 `reinjection-recovered`、重新 `#applySelection`（`:541-556`）。
- **事件齐全**：`reinjection-failed` / `reinjection-degraded` / `reinjection-recovered` / `protection-write-skipped` 都在 `AUDIT_EVENTS`（`src/audit.js:71-90`）。
- `/cg status` 的 `protection:` 行显示 `enabled(streak=N)` / `suspended(N/max)`（`src/commands/cg-status.js:58-66`）。

### 1.2 独立验证（`.tmp/verify-0.1.8-t8.mjs`，跑 0.1.8 快照；maxFailures=2 便于两周期到阈值）
| 周期 | 注入 | streak | mode | suspended | 关键审计 |
|---|---|---|---|---|---|
| 1 | 失败 | 1 | `full` | false | `reinjection-failed count=1` |
| 2 | 失败 | 2 | `degraded-protection` | true | `reinjection-degraded count=2 reason=max-consecutive-failures` |
| 3 | **成功（fallback）** | 0 | `full` | false | `protection-write-skipped compactionId=cmp-30 reason=reinjection-suspended` + `reinjection-recovered` |
| 4 | 成功 | 0 | `full` | false | 保护写盘计数继续增长（证明预写恢复） |

- 第 3 周期注入文本**含 `MEM-` 指针**（说明用的是既有记忆，而不是新写），且 `session.append` 真被调用；
- 事件集合实际出现：`reinjection-failed`、`reinjection-degraded`、`protection-write-skipped`、`reinjection-recovered`、`reinjection`；
- 默认/夹取实测：不传配置 → `max=3`；传 99 → 20；传 0 → 1。
- 结论：**T8-1 的“不永久关闭 / 阈值 / 暂停一周期仍回注 / 下一周期自愈 / 事件”全部成立**（离线层面）。

### 1.3 发现
- **P2-1（配置缺口）**：`reinjection.maxFailures` 只在 `CompressionGuard` 构造参数里，**没有**进 `DEFAULT_CONFIG`/`resolveConfig`/`cordis.patch.yml` 透传。用户在 `cordis.patch.yml` 写 `reinjection: { maxFailures: 5 }` 会被静默忽略（`index.js` 没有 `reinjection` 字段；实测 grep 只有 runtime 与测试用例出现该名）。→ 需求“可配 1–20”只在测试层成立，用户层不成立。建议 `DEFAULT_CONFIG.reinjection = { maxFailures: 3 }` + 校验整数 1–20 + 传入 guard，并在 patch/README 示例。
- P3-1：文档写自愈后“恢复 `full`”；本机 `adapter=none`，恢复后选择器给的是 **`event-level`**（`full` 只在 provider 可见时出现）。建议文档写成“恢复到选择器给出的正常模式”。
- P3-2：若降级周期 fallback **没有**任何既有条目（reinjection-skipped），不会触发 `reinjection-recovered`；由于 `#selection.mode` 是 `degraded-protection` 且 `#degradedReasons` 仍含 `reinjection-failed`，`#applySelection` 的粘滞分支（`:691-697`）会让状态**一直显示 degraded-protection**（虽然下一周期保护写已恢复）。建议“暂停结束”本身也清降级态/写一条恢复审计。
- P3-3：`#reinjectionDisabled` 字段与两处判断是死代码（永远 false），`/cg status` 的 `disabled` 分支不可达；建议删字段或保留明确注释。

---

## 2. T8-2 成本归属审计（`compaction-cost`）

### 2.1 代码核对（0.1.8 快照）
- 一周期一条：`compaction/end` 里先 `#scheduleReinjection`，再 `queueMicrotask(() => #writeCost(...))`（`:1116-1124`）；即使回注失败/跳过也写。
- 字段来源：`#newCost`（`:467-481`）在 start 时测 `tokensBefore`；summary 时取 `usage`/`tokensSummary`/`shadowedTokenCount`/`provider+model`（`:1019-1027`）；end 时记 `occurredAt`（`:1111-1115`）；`#writeCost` 组装并写审计（`:484-518`），`auditVersion:'cost-v1'`。
- 白名单同步新增（`src/audit.js:51-67`）：`project/model/trigger/occurredAt`、`tokensBefore/After/Shadowed/Summary/Injected`、`injectedEntries`、`tokensDropped`、`backendUsage`、`backendCostSource`、`governanceCostSource`、`estimateMethod`、`auditVersion`；`nullable-number` 与 `usage` 两种新类型只在 `sanitizeValue`（`:109-120`）里接受数字/五个已知 token 字段，**没有正文字段**。
- `tokensDropped`：仅在 `reinjection-shadowed` 判定里累加 `lastInjection.tokens`（`:1030-1035`，estimated chars/4）。
- `#tokenMeter` 从 `ctx.tokenMeter ?? ctx.get('tokenMeter')` 取，整体 try/catch（`:183-196`）→ 取不到不会崩，记 unknown。

### 2.2 独立验证（同脚本，0.1.8 快照）
**有 tokenMeter + usage（manual 触发）**：
```
compactionId=cmp-100 sessionId=session-t8 project=proj model=deepseek-account/deepseek-flash
trigger=manual occurredAt=… tokensBefore=100 tokensAfter=200 tokensShadowed=900
tokensSummary=50 tokensInjected=27 injectedEntries=1 tokensDropped=0
backendUsage={inputTokens:1000,outputTokens:50,cacheReadTokens:20,cacheWriteTokens:0,totalTokens:1070}
backendCostSource=measured governanceCostSource=estimated estimateMethod=chars/4 auditVersion=cost-v1
```
- 周期 2 的 `tokensDropped=27`，**等于**周期 1 的 `tokensInjected=27` → 确实来自 `reinjection-shadowed`；
- 每周期恰好 1 条（2 周期 → 2 条）。
**无 tokenMeter / 无 usage**：`tokensBefore/tokensAfter/tokensSummary=null`、`backendUsage` 省略、`backendCostSource=unknown`、`governanceCostSource=estimated`（因为回注仍成功）、`estimateMethod=chars/4` → **没有把估算伪装成 measured**。
**审计不含正文**：`audit.jsonl` raw 不含我注入的 `UNIQUE_BODY_XYZ`/`UNIQUE_CKPT_XYZ`、不含 `Goal: x`、不含 `X:\` 路径（白名单 + raw 双查通过）。

### 2.3 发现
- **P2-2（A 口径缺 `backend`）**：REQUIREMENTS 的 A 口径维度是 `sessionId/project/**backend**/model/trigger/occurredAt`；`#writeCost` 实际写出的记录**没有 `backend`**（源码与 4 条 t8 测试都没断言该字段；独立记录里也没有）。`audit.js` 白名单本来就有 `backend`（早先 apply 行在用），所以修起来只需加一行 `backend: this.#adapter.kind` 并补测试。
- P3-4：`tokensShadowed` 在宿主事件缺 `shadowedTokenCount` 时保留初值 **0**（`:1023-1025`），无法区分“真是 0”与“取不到”；建议 null 或加 `tokensShadowedSource`。
- P3-5：`tokensAfter` 是在**回注之后**测的（`#writeCost` 在注入微任务后），包含本次注入的节点（独立结果 100→200：就是注入那条消息）；A 口径写的是“压缩后”。tokensInjected 单列可扣，但建议文档注明或改为注入前采样。
- P3-6：`usage={}`（空对象）时 `backendUsage!==null` → `backendCostSource='measured'`，但 sanitizer 把空对象丢弃，记录里没有 `backendUsage`；建议以“清洗后非空”为准计算 source。
- P3-7：start 未观察到的周期（late-start）在 summary 里建 state 时 `trigger` 硬编码 `auto`（`:1005`），manual 会记错；低频但可修。

---

## 3. 上轮三条（P3-1 / P3-2 / P2 fixture）在 0.1.8 vs 0.1.9

> 00 的怀疑成立一半：**0.1.8 里这三项都没做**；但开发在复核期间已提交 **0.1.9（e2d7667）** 把三项都补了。以下分开给证据。

### 3.1 0.1.8（`90c897e`）
- `commands` 晚挂载：`index.js` 只有首次 `registerStatusCommand` + warn，无 `ctx.inject`/重试（全文件无 `ctx.inject`/`setTimeout`）。
- `shadowedRange` 兜底：`runtime.js` 全文无 `shadowedRange` 引用（只有 `shadowedSeqs`）。
- fixture 结构白名单：**未做**。我自己的扫描：auto `strings=4111`、`prose_strings=835`；manual 仍含 PowerShell 命令/任务清单（v0.1.7 同类残留）。

### 3.2 0.1.9（`e2d7667`）—— 三项都已修
- **P3-1**：`index.js:305-341` 先注册，失败则 `ctx.inject(['commands'], retryStatusCommand)`，无 `ctx.inject` 时 `setTimeout(...,0)` 重试一次，`commandRef.current` 管 dispose，成功写 info。测试 `t7-p2.test.mjs:167-197`（commands 初始不存在 → apply 成功 + warn → 服务出现后回调 → `cg` 注册成功）。
- **P3-2**：`runtime.js:1029-1037` 命中条件改为 `shadowedSeqs.includes(seq) || (seq 在 shadowedRange 内)`；`tokensDropped` 同路径累加。测试 `t8-cost.test.mjs:228-261`（清空 shadowedSeqs、只给覆盖注入 seq 的 range → 仍写 `reinjection-shadowed`）。
- **P2 fixture 结构白名单**：新增 `analysis/t7/structure.mjs`；fixture 从 571 KB/475 KB 降到 **58 KB/55 KB**。我的独立扫描（不用其 `scan-fixture.mjs`）：
  - auto `strings=566`、manual `544`；**`prose_strings=1`（仅 meta.note）**；无字符串数组；
  - 单串/数组 join/全局 join 违规 0；`session-53ece2c2/19091/DS-PROJECT/DS-HARNESS/AGENTS.md` 无；
  - `preMessages`/`events` 里只剩结构：如 `{"type":"user/message","seq":…,"data":{"content":[{"type":"text","text":"[redacted:content]"}],"source":{"kind":"user"},"role":"user","id":"[id]"}}`；summary 保留 `shadowedRange/shadowedSeqs/usage/provider/model`，`summary/rawOutput` 被替换。
  - T7-R2 追加“结构字段不得含空白”断言（`t7-replay.test.mjs` 新增 5 行），与我的判断一致。
  - 0.1.9 全量 **168/168 pass**。
- 0.1.9 的 P3 小尾巴（不阻断）：重试回调里仍用**原 ctx** 调 `registerStatusCommand`（没用 `ctx.inject` 给的新 ctx）——本机同 realm 没问题，跨 isolate 场景可能仍失败；`setTimeout` 只补一次，服务更晚到仍会缺命令。

---

## 4. STATUS 里 ROB-01/06 的记账

- **0.1.8 `STATUS.md:28-30`**：`## 已知风险（当前无）` + 明确写“T8-1 已修复 ROB-01/06：回注失败不再永久停写，改为每次失败审计 + 连续 N 次降级一个周期 + 下一周期自愈，`reinjection-recovered` 可审计”。→ **不是删掉，而是按事实改写**（符合 00 的要求）。
- 但有两处残留 **P3-8/P3-9**：
  1. 0.1.8 的“在办”表还写着“T8 已知风险、T9 成本归属待排期”（`:11`），与同文件 T8 已完成、风险已清矛盾；0.1.9 该行仍写“T9 成本归属待排期”。
  2. `REQUIREMENTS.md:76`（0.1.8/0.1.9 都在）写“需新增 **T9：成本归属审计（A 口径；T8 已被 ROB-01/06 占用）**”，但 T8-2 已经把成本归属实现了。→ 需求/任务编号需要收口：要么把 T9 标记为“已由 T8-2 吸收”，要么明确 T9 是另一次增强；否则验收台账会对不上。

---

## 5. 剩余验证（0.1.8/0.1.9 都还没上真机）

> 当前运行仍是 0.1.6。以下必须重启后才有结论；我没有重启/安装权限，也不做。

| # | 验证项 | 预期 |
|---|---|---|
| V1 | 重启到最新版本（0.1.9） | `version=0.1.9`（读 package.json）、`perception=event`、`events=N`、`audit: max/size/rotations` |
| V2 | 真实压缩（必须 cwd=`D:\DS-PROJECT\DSH插件开发` 的会话） | audit 出现 `protection-write` / `reinjection` / **`compaction-cost`**（含 backend—修复后） |
| V3 | 第二次压缩吞掉上次回注 | `reinjection-shadowed` + `compaction-cost.tokensDropped` 增加 |
| V4 | `/cg status` | `protection: reinjection=enabled(streak=0)`（或 suspended(N/3)）、`scope:`、`audit:` 行 |
| V5 | 回注自愈（真机） | 需要一次 append 失败（如宿主重入/磁盘错误），不易人为制造；建议以离线用例为准，真机只观察是否出现 `reinjection-degraded/recovered` |
| V6 | 发布打包 | locale/icon、patch 占位、files 收紧、zip 结构（我的阶段） |

---

## 6. 证据索引

- 快照：`.tmp/snapshot-018/rev018/`（90c897e=0.1.8）、`.tmp/snapshot-019/rev019/`（e2d7667=0.1.9）。
- 独立脚本：`.tmp/verify-0.1.8-t8.mjs`（T8-1 四周期 + T8-2 三组场景）、`.tmp/scan-fixture-independent-v2.mjs`（fixture 三层扫描，不使用开发扫描器）。
- 代码（0.1.8）：`src/compress/runtime.js:124,183-189,390-392,467-481,484-518,520-539,541-556,594-604,682-700,773-794,909-911,1019-1035,1111-1124`；`src/audit.js:51-67,71-90,109-120`；`src/commands/cg-status.js:58-66`；`src/index.js`（无 `reinjection` 配置透传）。
- 代码（0.1.9）：`src/index.js:305-341`；`src/compress/runtime.js:1029-1037`；`test/t7-p2.test.mjs:167-197`；`test/t8-cost.test.mjs:228-261`；`analysis/t7/structure.mjs`；`test/t7-replay.test.mjs`（+5 行结构断言）。
- 文档：`docs/T8-回注自愈与成本归属.md`（0.1.8）、`docs/T8-复核三轮修复.md`（0.1.9）、`STATUS.md:28-30`（0.1.8）、`REQUIREMENTS.md:44-50,76`。
- 测试结果：0.1.8 `166/166`；0.1.9 `168/168`。

---

**复核结论一句话**：T8-1 与 T8-2 的机制都真落地了（自愈四周期实测通过；成本记录实测/估算分列、无正文、tokensDropped 与 shadow 对齐），**阻断 0**；但 A 口径缺 `backend`、`maxFailures` 用户不可配是两条应修的 P2；上轮三条（commands 竞态、shadowedRange、fixture 结构白名单）在 0.1.8 未做、在复核期间提交的 0.1.9 已全部补上（fixture 独立扫描只剩 meta.note 一条说明文字）；STATUS 的风险段落已按事实改写，但“在办”表与 REQUIREMENTS 的 T9 编号需要收口。

**复核方**：审核打包 · cs_DNciCVhuZD · 2026-10-25 19:4x（+08:00）
