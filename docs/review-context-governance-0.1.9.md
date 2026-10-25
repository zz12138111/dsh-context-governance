# 复核报告（第四轮·对象更新）· `dsh-context-governance` v0.1.9

> 复核方：审核打包。**技术结论以本报告为准**；用户验收只看交付物与体验。
> 对象：**0.1.9 = `e2d7667`（19:36:50 +08）**，固定快照 `.tmp/snapshot-019/rev019/`（0.1.8=`90c897e` 作废，仅作 before/after 对照）。
> ⚠️ 复核期间工作区**又出现未提交改动**：`REQUIREMENTS.md`/`STATUS.md`/`cordis.patch.yml`/`src/compress/runtime.js`/`src/index.js`（mtime 19:4x，内容看起来是在补上轮两条 P2：`backend` 字段、`reinjection.maxFailures` 配置、`tokensShadowed=null` 等）。**本报告只对 `e2d7667` 有效，这些未提交改动未复核**（见 §6）。
> 运行态：仍是 **0.1.6**（pid 32544；`logs/governance.log` 最后一行 version=0.1.6）→ 0.1.9 **没有真机证据**；以下均为源码 + 独立离线验证。
> 测试：0.1.9 快照 **168/168 pass**。
> 纪律：未改代码、未 push、未装、未重启。

---

## 0. 结论摘要

| 项 | 结论 | 一句话 |
|---|---|---|
| **阻断项** | **0** | 三处修复全部落地；T8 仍成立 |
| 1. fixture 结构白名单 | **已修** | 独立复扫：旧泄漏串全消失、`preMessages/events` 内空白字符串 0、violations 0；结构/回放保留 |
| 2. P3-1 commands 晚挂载 | **已修** | `ctx.inject(['commands'], retry)`；我实测：首次 warn → 服务出现后注册 `cg` 一次 → dispose 释放；重复回调不重复注册 |
| 3. P3-2 shadowedRange 兜底 | **已修** | before/after 对照：0.1.8 只有 range 时 0 事件；0.1.9 写 1 条 `reinjection-shadowed` 且 `tokensDropped` 同步 |
| T8（0.1.8 内容）是否仍成立 | **成立** | 在 0.1.9 快照重跑 T8-1 四周期与 T8-2 三场景，结果与 0.1.8 一致 |
| STATUS / 文档一致性 | **部分一致** | 风险段已按事实改写、T8 修文档数字一致；但 **T9 口径未收口**、T8 文档两条与代码不一致（P3，其中 2 条源自未修的 P2） |

**上轮两条 P2 在 0.1.9 仍未修**：① `reinjection.maxFailures` 未接进插件配置；② `compaction-cost` 缺 A 口径的 `backend` 维度。两条都不阻断，但 doc/code 已不一致（见 §4/§5）。

---

## 1. fixture 结构白名单（第三轮 P2）—— **已修**

### 1.1 实现核对
`analysis/t7/structure.mjs`（131 行）：
- 白名单：`type/seq/time` + `NUMBER_KEYS(turn/shadowedTokenCount/maxTokens/start/end)` + `shadowedSeqs/shadowedRange/usage`（仅五个 token 数值）+ `compactionId/sourceCommandId→[id]` + `provider/model/role/name/kind/form`（仅 `[A-Za-z0-9._:/-]{1,96}` 才保留，否则 `[redacted:enum]`）+ `source` 的 `kind/form/plugin` + `message` 的 `role/content(占位)/source/id`；
- `content/text/summary/rawOutput/stream/texts/args/lines/detail/title/meta/messages` → `[redacted:*]` 占位；**未知键丢弃**（`structureEvent` 末尾只保留白名单）；
- 生成后再跑一次 `sanitizeDeep` 兜底（`extract-replay-fixture.mjs`）。

### 1.2 独立复验（`.tmp/verify-0.1.9-fixture.mjs`，不使用开发扫描器）
| 指标 | 0.1.8（对照） | **0.1.9 auto** | **0.1.9 manual** |
|---|---|---|---|
| 文件大小 | 571 KB | **58.8 KB** | **54.9 KB** |
| strings | 4111 | **566** | **544** |
| CJK/绝对路径/URL/session-uuid/裸 uuid/长 token（单串 + 数组 join + 全局 join） | 0（但含英文正文） | **0** | **0** |
| 旧泄漏串（`Update runtime test…`、`Need add T4…`、`const guard = new CompressionGuard`、`Time sampled while preparing`、`ARTIFACTS`、`Get-ScheduledTask`、`DSH-*` 任务名、`session-53ece2c2/58a2e845`、`19091`、`DS-PROJECT`、`AGENTS.md`） | **5 个命中** | **全无** | **全无** |
| `preMessages/events` 内**含空白**字符串（句子/命令/正文） | 1512 | **0** | **0** |
| 非 meta 的 prose（≥20 字符且含空格） | 1027 | **0** | **0** |
| 结构保留 | — | events:`start / delivery-accepted / summary / user/message / end`；summary 保留 `shadowedSeqs=1267`、`shadowedRange 9..4167`、`shadowedTokenCount=599733`、`usage` 五字段、`provider/model`、`summary=[redacted:summary]` | 同上，`shadowedSeqs=920`、range `25537..28856`、`shadowedTokenCount=304316` |

- T7-R2 追加“结构字段不得含空白”断言（`t7-replay.test.mjs` 新增 5 行）→ 与我独立扫描一致；
- 回放未被破坏：0.1.9 `t7-replay` / `t7-scenarios` 全过（168/168）；
- 结论：**fixture 已真正“无句子/命令/正文”**，只留结构；`meta.note` 是唯一说明性英文（设计允许，T7-R2 明确排除 meta）。

### 1.3 小提醒（P3）
- `structuralString` 允许 `[A-Za-z0-9._:/-]{1,96}`：理论上 `https://x/y` 这类 URL 或 `C:/x` 这样的串若出现在 `provider/model/name/kind` 键上会被保留；当前数据里没有，且这些键的语义是枚举。建议以后把 `[A-Za-z]` 前缀/URL 形态也拦掉（更保险）。
- fixture 现在是“结构回放”，不再验证文本相关的覆盖判断（summary 是占位），回放测试的语义应写明“结构级”。

---

## 2. P3-1 `commands` 晚挂载重试 —— **已修**

### 2.1 实现（0.1.9 `src/index.js:305-341`）
- 首次注册失败仍 `warn`（带原因）；
- 有 `ctx.inject` → `ctx.inject(['commands'], retryStatusCommand)`；没有则 `setTimeout(retryStatusCommand, 0)`；
- `commandRef.current` 保存“最终注册成功”的 handler，`dispose` 释放它；
- 重复回调有 `if (commandRef.current.registered) return` 守卫。

### 2.2 独立验证（`.tmp/verify-0.1.9-p3.mjs`，不依赖开发测试）
- 构造没有 commands 的 ctx 调 `apply` → `warn_first=true`，`inject_deps=['commands']`；
- 随后把 commands 服务塞进去并触发 `ctx.inject` 回调 → `registered_after_inject=['cg']`；
- **再触发一次回调** → 仍然只有 1 条（`duplicate_guard=true`）；
- 触发 effect dispose → `disposed_on_teardown=['cg']`。
- 开发用例：`test/t7-p2.test.mjs:167-197`（同样覆盖 warn → 晚挂载 → 注册成功）。

### 2.3 小提醒（P3）
- 重试回调里仍用**原 ctx** 调 `registerStatusCommand`（没用 `ctx.inject` 给的新 ctx）；本机同 realm 没问题，若 commands 处于不同 isolate 域，`ctx.get('commands')` 仍可能取不到。
- `setTimeout` 兜底只补一次；服务更晚到仍会缺命令（有 `ctx.inject` 时不受影响）。

---

## 3. P3-2 `shadowedRange` 兜底 —— **已修**

- 代码（0.1.9 `src/compress/runtime.js:1029-1037`）：命中条件改为
  `shadowedSeqs.includes(lastInjection.seq) || (Number.isFinite(start) && Number.isFinite(end) && seq>=start && seq<=end)`；`tokensDropped` 同路径累加。
- **独立 before/after**（`.tmp/verify-0.1.9-p3.mjs`；第二次压缩清空 `shadowedSeqs`、只给覆盖回注 seq 的 `shadowedRange`）：
  - **0.1.8**：`shadowed_events=0`、`second_cost_tokensDropped=0`、`stats.reinjectionShadowed=0`；
  - **0.1.9**：`shadowed_events=1`、`second_cost_tokensDropped=24`（= 第一次注入估算）、`stats.reinjectionShadowed=1`。
- 开发用例：`test/t8-cost.test.mjs:228-261`。

---

## 4. T8（0.1.8 内容）在 0.1.9 是否仍成立 —— **成立**

用同一份独立脚本（`verify-0.1.8-t8.mjs` 改为指向 0.1.9 快照）重跑：
- **T8-1**（maxFailures=2）：失败 1→streak=1/full；失败 2→`degraded-protection`+`reinjection-degraded count=2`；周期 3→`protection-write-skipped(reason=reinjection-suspended)` + fallback 指针回注成功（文本含 MEM-）+ `reinjection-recovered` + streak=0 + mode 恢复；周期 4→保护写盘继续增长。事件集合齐全。
- **T8-2**：`compaction-cost` 两周期两条；字段与数值与 0.1.8 一致（`tokensBefore=100/tokensAfter=200/tokensShadowed=900/tokensSummary=50/tokensInjected=27/backendUsage 五字段/backendCostSource=measured/governanceCostSource=estimated/estimateMethod=chars/4/auditVersion=cost-v1`）；`tokensDropped` 第二周期=27=第一周期 tokensInjected；无 meter/usage 时 null/unknown 不伪造；audit raw 无正文/路径。
- **仍未修的两条 P2（随 0.1.9 一起存在）**：
  1. **`reinjection.maxFailures` 用户不可配**：`DEFAULT_CONFIG`/`resolveConfig`/`cordis.patch.yml` 都没有 `reinjection`；只有 `CompressionGuard` 构造参数（测试用）支持。用户在 patch 里写会被**静默忽略**。
  2. **`compaction-cost` 缺 `backend` 维度**：REQUIREMENTS A 口径（`REQUIREMENTS.md:49`）明确列 `backend`；`#writeCost` 未写该字段，`t8-cost` 4 条测试也未断言；而 `docs/T8-回注自愈与成本归属.md:35` 的字段表声称有 `backend`。
  （这两条正是我上轮报告 P2-1/P2-2；复核期间工作区已在改，但**未提交，不属 0.1.9**。）

---

## 5. STATUS / 文档与 0.1.9 的一致性

### 已一致
- `STATUS.md`（0.1.9 快照）`## 已知风险（当前无）` + 明确写“T8-1 已修复 ROB-01/06…`reinjection-recovered` 可审计”（`:28-30`）——**按事实改写，不是删掉**；真机段写 v0.1.9 待重启验收（`:25`）。
- `docs/T8-复核三轮修复.md`：168/168、fixture `566/544`、`violations=0` 与我的独立结果一致；版本 0.1.9。
- `docs/T7-验收场景-S1-S6.md:34` 已改成“保留结构字段”，与 fixture 实现一致。
- 版本：`package.json:3 = 0.1.9`，`PLUGIN_VERSION` 运行时读取，审计 `apply.version=0.1.9`（离线）。

### 不一致（P3，需 00/需求收口）
1. **T9 口径在 0.1.9 快照里仍冲突**：
   - `STATUS.md:10` “T9 成本归属待排期”、`:39` “M1.1 / T9 … 待排期”、`:52` “00 排 T9 + M1.1”；
   - `REQUIREMENTS.md:76` “需新增 T9：成本归属审计（A 口径；T8 已被 ROB-01/06 占用）”；
   - 但 T8-2 已经实现成本归属并在 0.1.9 测试通过。→ 验收台账会对不上（复核期间工作区正在改成“T9 已被 T8-2 吸收”，但未提交）。
2. `docs/T8-回注自愈与成本归属.md:13` 写 `reinjection.maxFailures` “可配 1–20”，实际用户不可配（见 §4 P2-1）；
3. `docs/T8-回注自愈与成本归属.md:18` 写自愈“恢复 `full`”，本机 `adapter=none` 实际恢复 `event-level`（措辞）；
4. `docs/T8-回注自愈与成本归属.md:35` 的 `backend` 字段实际缺失（见 §4 P2-2）。

---

## 6. ⚠️ 工作区未提交改动的提醒（影响“重启 → push”计划）

本报告写作时 `git status` 已脏，未提交文件：`REQUIREMENTS.md`、`STATUS.md`、`cordis.patch.yml`、`src/compress/runtime.js`、`src/index.js`。内容看起来是在修我上轮的两条 P2（加 `backend`、加 `reinjection.maxFailures` 配置、`tokensShadowed` 初值改 null、`backendMeasured` 要求非空、late-start trigger、删死字段）。**这些未提交、未复核。**

对 00 的“重启 → push”建议：
- **可 push 当前 HEAD `e2d7667`（无阻断）**；
- 但**不要从脏工作区重启**：DSH 通过 junction 读源码，重启会加载这批未提交代码，而我还没复核；
- 两条路选一：① 让开发先提交这批 P2 修复，我做 10 分钟增量复核，再“重启 → push”；② `git stash`/`checkout` 到 `e2d7667` 后重启并 push 0.1.9（之后再合 P2 修复）。

---

## 7. 剩余真机验证（0.1.9 未加载）

| # | 项 | 预期 |
|---|---|---|
| V1 | 重启 | `version=0.1.9`、`perception=event`、`events=N`、`audit: max/size/rotations` |
| V2 | 真实压缩（cwd=`D:\DS-PROJECT\DSH插件开发` 会话） | `protection-write` / `reinjection` / `compaction-cost` |
| V3 | 第二次压缩吞回注 | `reinjection-shadowed` + `tokensDropped`（0.1.9 起 range 也能触发） |
| V4 | `/cg status` | `protection: reinjection=enabled(streak=0)` / `suspended(N/3)`；`scope:`；`audit:` |
| V5 | 自愈（真机，不易造） | 观察是否出现 `reinjection-degraded/recovered`；正常态不应出现 |
| V6 | 打包（我的阶段） | locale/icon、patch 占位、files 收紧、zip 结构；Release 前再做 |

---

## 8. 证据索引

- 快照：`.tmp/snapshot-019/rev019/`（e2d7667=0.1.9）、`.tmp/snapshot-018/rev018/`（90c897e=0.1.8，对照）。
- 独立脚本（`.tmp/`）：`verify-0.1.9-fixture.mjs`（结构/泄漏串三轮扫描）、`verify-0.1.9-p3.mjs`（commands 晚挂载 + range before/after）、`verify-0.1.9-t8.mjs`（T8-1/T8-2 复跑）。
- 代码（0.1.9）：`analysis/t7/structure.mjs:9-131`；`src/index.js:305-341`；`src/compress/runtime.js:1029-1037`；`src/audit.js:51-67,71-90`；`src/compress/runtime.js:467-518,520-556,594-604,773-794,909-911,1019-1035,1111-1124`（T8）。
- 测试：`test/t7-p2.test.mjs:167-197`、`test/t8-cost.test.mjs:228-261`；全量 168/168。
- 文档：`docs/T8-复核三轮修复.md`、`docs/T8-回注自愈与成本归属.md:13,18,35`、`STATUS.md:10,25,28-30,39,52`、`REQUIREMENTS.md:49,76`。

---

**复核结论一句话**：0.1.9 的三处修复都真做了——fixture 已彻底结构白名单（旧泄漏串全无、空白正文 0）、commands 晚挂载能重试一次且 dispose 正确、shadowedRange 兜底有 before/after 证据；T8 在 0.1.9 上仍成立。**阻断 0，可 push**；但两条上轮 P2（maxFailures 不可配、cost 缺 backend）仍在，且工作区已有未提交的 P2 修复——建议先提交并让我增量复核，再“重启 → push”，别从脏工作区重启。

**复核方**：审核打包 · cs_DNciCVhuZD · 2026-10-25 19:5x（+08:00）
