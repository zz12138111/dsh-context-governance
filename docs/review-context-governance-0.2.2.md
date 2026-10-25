# 复核报告 · context-governance 0.2.2 骨架（EarlyCompactor）

> 复核人：审核打包会话（`cs_DNciCVhuZD`）· 2026-10-26
> 口径：只报证据、修正与边界，**不判验收**；口径决策归需求/用户。
> 对象：`2367d57`（`src/compress/early.js` 88 行 + `test/early-022.test.mjs` 82 行）。测试实测 **290/290 pass**。

## 0. 结论一句话

**“默认不执行”这个性质成立且已被单测钉住**（armed 先判、双事实缺一不试探、不抛、不降级）。
但**打开开关前必须先修一处**：宿主 `compactNow` 是异步的，当前同步 `attempt()` 捕获不到异步的 busy/失败——这是“开了关才危险”的那个点。

## 1. 四点逐项

### 1.1 `armed=false` 时真的“连引擎都不取” —— 成立 ✔

- 代码顺序：`early.js:61` `if (!this.#armed) return {ok:false, reason:'disabled'}` → `:63` 才 `this.#getEngine()`。判断在取引擎之前，**结构上不可能先取**。
- 单测：`test:24-30` 用计数器断言 `engineTaken === 0`，并 `deepEqual` 整个返回 `{ok:false,reason:'disabled'}`。
- 构造器（`:40-44`）只存函数与布尔，不调用；`arm()/disarm()` 只改字段，无副作用。

### 1.2 safe timing 的两个事实从哪来 —— 调用方传入，模块不推断 ✔

- 签名 `attempt({session, turnEnded, agentIdle})`（`:60`），默认 `false`；判定用 `turnEnded !== true || agentIdle !== true`（`:62`），非布尔真值（如 `'yes'`）也按缺事实处理。
- `early.js` **没有任何 import / 事件订阅**（文件头无 import 行；`:9-10` 注释明确“调用方负责提供事实，本模块不猜”）。全仓无 `ctx.on` 引用。
- 即：事实只能来自接线方；缺省（不传/传错）一律 `not-idle`，fail-safe。

### 1.3 `preExecuteAsk` / `preExecuteDeny` 确实没接线 ✔

- 全仓 grep（`packages/**`、`docs/`、`scripts/`）：只有 `early.js:82,86`（定义）与 `test:8,80,81`（测试）引用，**无任何 src 文件导入**。
- `src/index.js` 未引用 `compress/early`；本模块甚至未被插件入口加载——真正“死代码 + 测试”。
- 返回形状 `{kind:'ask'|'deny', reason}` 与 `:79-80` 注释一致；本版无调用，符合“不接线”。

### 1.4 单测是否覆盖 `armed=true` 但 turn 中 —— 覆盖了 ✔

- `test:32-39`：`armed:true`，分别测 `turnEnded:false`、`agentIdle:false`、`{}` 三种，全部断言 `not-idle`，并断言 `fake.calls.length === 0`（compactNow 一次都没调）。
- 这比 `armed=false` 更关键，已覆盖。

## 2. 新发现（打开开关前必须处理）

### P2-1 宿主 `compactNow` 是异步的，同步 `attempt()` 捕不到异步错误

- 宿主实现：`.tmp/host/…/dsh-compaction-basic__lib__index.js:985` `compactNow(agent, signal, sourceCommandId)`，函数体 `return agent.runMaintenance(async (agentSignal) => { … })`；
- `runMaintenance`（`.tmp/host/…/dsh-agent-loop__lib__index.js:822`）返回 `(async () => { … })()` → **Promise**。
- 骨架 `early.js:68` 在 `try` 里同步调 `engine.compactNow(session)` 并立即 `return {ok:true}`（`:69`）：
  - 失败/忙若发生在异步阶段 → **不会**进入 `catch`，得到“假 ok:true” + 未处理的 Promise rejection（Node 默认抛 → 进程级错误）；
  - 单测的 fake（`test:52,65`）是**同步 throw**，所以这条路径测不到。
- 影响：G2 里“turn 中必 busy”的映射正是异步抛出的；一旦 armed=true，最该防的 busy 恰好漏网。
- 修法：`attempt` 改 `async` 并 `await engine.compactNow(...)`；或保留同步入口但 `.catch()` 回映射。补一条“fake 返回 rejected Promise → reason=busy/failed、不产生 unhandled” 的单测。

### P2-2 参数形状与宿主不一致：传 `session`，宿主收 `agent`

- 宿主签名是 `(agent, signal, sourceCommandId)`，第一参是 **agent**（要 `agent.runMaintenance` / `agent.session`）；骨架文档写 `@param {object} [input.session]`、调用传 `session`。
- 用真引擎时：`signal` 为 `undefined` → 首行 `signal.throwIfAborted()` 同步 TypeError → 被 catch → `reason:'failed'`（安全但永远失败）。
- 修法：等真接线时传 `agent` 与 `AbortSignal`；在此之前把注释/参数名改正，避免接线照抄。

### P3-1 同步 busy 文案不被识别

`runMaintenance:823` 在 phase 非 idle 时同步抛 `new Error('agent "<id>" already has active work')`。`isBusyCompactionError`（`:22-30`）三个分支都不匹配（无 `ManualCompactionError`/`BUSY`；第三分支要求 message 同时含 `not idle|busy` **且** `compaction`）→ 映射成 `failed` 而非 `busy`。按 G2 这正是“turn 中”的场景。建议把 `/already has active work/` 纳入 busy 判定。

### P3-2 `getEngine()` 在 try 外

`:63` 的 `this.#getEngine()` 在 `try` 之前；若访问器本身抛错（本项目真机遇到过抛错 getter：`ctx.sessionProjections` 是抛错 getter），异常会直接传给调用方，违背“不抛宿主”。建议把取引擎也包进 try，映射 `no-engine`/`failed`。

## 3. 与报告/文档的一致性

- 骨架注释（`:2-10`）把 `DEC-20261025-79`、G2 busy 语义写清楚了，无夸大。
- 未发现“已实现功能”的外部宣传——`README`/`STATUS` 未把 0.2.2 写成已交付（本轮 grep 未见）。

## 4. 问题清单

| 编号 | 级别 | 问题 | 处理时机 |
|---|---|---|---|
| **P2-1** | P2 | `attempt()` 同步，宿主 `compactNow` 返回 Promise → 异步 busy/失败漏捕、假 ok、unhandled rejection | **打开 armed 之前** |
| **P2-2** | P2 | 参数形状错：宿主收 `(agent, signal, …)`，骨架传 `session` | 接线时，与 P2-1 一起 |
| P3-1 | P3 | 同步 `already has active work` 未识别为 busy | 打开开关前顺手 |
| P3-2 | P3 | `getEngine()` 在 try 外，访问器抛错会外泄 | 同上 |

## 5. 复验命令

```powershell
cd packages/dsh-context-governance
node --test "test/*.test.mjs"          # 290/290 pass
# 宿主证据（解包副本）：
# .tmp/host/dsh-compaction-basic__lib__index.js:985  compactNow(agent, signal, sourceCommandId)
# .tmp/host/dsh-agent-loop__lib__index.js:822        runMaintenance → (async () => {…})()
```

## 6. 边界

本复核**不判**“0.2.2 能不能开开关”：按当前代码，armed=false 时行为安全；armed=true 且用真引擎时，P2-1/P2-2 会让最该防的 busy 场景漏掉。开关是否打开属用户决策，本文只给上述证据。

## 7. 复验（`64c6d93`，2026-10-26 02:05）

修复提交：`64c6d93`（5 files）。实测 **292/292 pass**（原 290 + 扫描回归 2）。

| 原问题 | 修复 | 复验结论 |
|---|---|---|
| **P2-1** 同步 `attempt()` 漏捕异步 busy/失败 | `attempt()` 改 `async` + `await engine.compactNow(...)`（`early.js:62,72`）；单测 fake 改 async reject | **成立**：busy/failed 都能从异步阶段进 catch；返回类型已是 `Promise` |
| **P2-2** 传 session、宿主收 agent | 参数改 `{agent, signal, sourceCommandId}`（`early.js:62`），原样透传三参（`:72`） | **成立**：单测断言三参 identity（`calls[0].agent/signal/sourceCommandId`） |

### 7.1 重点核“无 unhandled”是否真断言

- **测试体没有显式断言**：`early-022.test.mjs` 的 busy 用例标题写“不 unhandled”，但正文只有 `await attempt()` + 断言结果，**没有 `process.on('unhandledRejection')`、也没有 `setImmediate` 冲刷**。
- **间接保证成立**（我实测）：`node --test` 对未处理拒绝会判失败（探针：`Promise.reject` 未处理 → 测试 ✖、exit 1）。且 busy 用例断言 `ok=false`——若有人删掉 `await`，结果会变 `{ok:true}`，**行为断言先失败**。所以回归能被抓住，只是不靠那句标题。
- 建议（低优先）：补 `process.on('unhandledRejection')` + `setImmediate` 的显式断言，或把标题改成“被 await 捕获；漏 await 时行为断言+运行器双保险”，避免标题名不副实。

### 7.2 重点核 signal 是否真来自调用方

- `early.js` 全文 grep：**无 `AbortController`**，`signal` 只出现在参数（`:62`）与透传（`:72`）。
- 单测用 `new AbortController().signal` 传入并断言 `calls[0].signal === signal`（identity）→ 没有骨架自造信号、也就不会“永远不取消”。
- 小边界：`signal` 默认 `null`，真引擎首行 `signal.throwIfAborted()` 会 TypeError → 被捕获成 `failed`（fail-safe，不误压）；建议接线时把 signal 设为必传并在注释里写明。

### 7.3 仍未修（沿用本报告 §4，不是本次回归）

- **P3-1**：`runMaintenance` 的同步 busy 文案 `already has active work` 仍未被 `isBusyCompactionError` 识别 → 会映射 `failed` 而非 `busy`。
- **P3-2**：`getEngine()` 仍在 `try` 外，访问器抛错会外泄给调用方。

## 8. 下一轮复核清单（0.2.2，按开发四步，00 已放行 2026-10-26）

> 用途：开发四步交付后逐项给“通过/不通过”；不替用户判“能不能开 armed”。
>
> **复核基线（哈希链，00 对齐）**：`c143793` → `a35a8a1`（7）→ `94b17a3`（2）→ `c470e89`（1）→ `5694028`（1），四笔全在 `analysis/`。此后 `b707f3d`/`e79f629`（STATUS）、**`25268bc`（P3-1 修复：`early.js` + test）**——产品代码基线已不是 `c9807b6`。
>
> **边界（00 定）**：四步全程 `armed=false`；**第 5 步接线必须等这四项复核通过后另报**，复核结论里要明确确认这条。

### 8.1 四步对照

| 步 | 开发交付 | 复核判据 | 证据要求 |
|---|---|---|---|
| ① P3-1 | `String(code).toLowerCase()==='busy'` + `ManualCompactionError && /\bidle\b/i` | 对 G2-B 原文案（`code='busy'`、idle-required message）→ `true`；`attempt` → `reason=busy` | 单测 fixture 用原文；同时覆盖同步文案 `already has active work`（旧路径，别漏） |
| ② 契约变更 | `runtime.js` stats 拆 `compactionFailures`/`protectionFailures`；`cg-status.js` 出 `protection=`+legend；`early.js` 返回值 `ok`→`accepted` | 见 8.2 三条硬验证（调用点全改 / 不计入压缩失败 / 不触发升级） | **必须用单测证明**，不接受“只看了代码” |
| ③ logger 落点 | 定性 `#logger` 是否宿主 `ctx.logger`；保护失败是否同时写 `diagnostics.logFile` | 给出**定性结论**：若 `#logger`=宿主 logger，则“不进 governance.log”是**设计**还是**缺陷**，落文档 | 对照开发 commit 的「原来 X → 现在 Y」；隔离实例触发一次 protection failed，给文件+行 |
| ④ audit 增记 | `messagesLength` + `textHash`（sha256 前 8） | `messagesLength` 语义 = 注入量（0/1），不是数组总长（`[header, ...messages]` → 总长=基线+1）；`textHash` 不可反推、正文未进其它字段 | 单测固定输入断言 hash；审 audit 全部字段无正文；给可公开性结论（见 8.3） |

### 8.2 第 2 步的三条硬验证（防“看着分了、实际还在升级”）

1. **调用点全改**：`grep -rn "\.ok\b" packages/dsh-context-governance/src` + 所有 `attempt(` 调用点（含测试）；漏一处 = 静默 `undefined`。单测断言返回对象只有 `accepted`，且全量 `node --test` 全绿。
2. **`protectionFailures` 真不折算压缩失败**：构造 protection failed，断言 `stats.compactionFailures` **不变**、`stats.protectionFailures` +1；若保留旧 `stats.failures`，必须明确它不再被压缩路径使用。
3. **`protection=failed` 不触发重试/关开关**：用 spy 断言 `compactNow` 只调一次、`armed` 保持 `true`、无 backoff/disable 调用；再补一条“`compaction=failed` 才升级”的反向用例。

### 8.3 第 4 步 `textHash` 的可公开性判断

- sha256 前 8 位 = **32 bit**：不可反推原文，但**可作“确认”**——若 header 文本来自低熵记忆标题，持有候选文本者可验证猜测。发布物若要公开 audit，建议**加盐/HMAC** 或明确“hash 仅内部去重，不随发布物公开”。
- 需确认：audit 记录里除 `textHash` 外无 header 正文、无 `header.text`、无条目标题拼接；`messagesLength` 只记数量。
- 碰撞：32 bit 对“同会话内去重”够用，不应用于全局唯一标识。

### 8.4 已有判据（沿用）

**三条验收判据（00 采纳）**：① P3-1 fixture 用 G2-B 真实文案；② 单测覆盖“保护失败 + 回注成功 → 仍算可用、不重试”；③ 文案不得把 protection 失败渲染成“压缩失败”。

**复核时同时确认**：`armed=false` 全程成立；第 5 步未开；0.2.2 交付记录里 `ok=false` 语义与本节一致。

## 9. 四项复核结果（基线 `629a3a0`，补验到 `0c77f0d`，2026-10-26）

基线：`629a3a0` 时全量 **297/297**；`30d4bcd` 时 **298/298**（early-022 11/11）；`0c77f0d` 时 **300/300**（均在独立 worktree 实跑）。

| 项 | 判定 | 依据 |
|---|---|---|
| ① P3-1（`25268bc`+`30d4bcd`） | **通过** | 两条 busy 路径都命中：idle 文案（G2-B 真机）+ `already has active work`（宿主源码 `dsh-agent-loop:823` + 单测）；`code` 大小写不敏感；反例 `agent has active work but not compaction` → `false` 防过宽；`attempt` 断言 `accepted:false, reason:busy` |
| ② 契约/stats/status（`2fd4f6f`+`aacea07`） | **通过** | 全仓无 `attempt().ok` 调用点；返回仅 `accepted`；stats 拆三计数；单测断言 protection failed 时 `compactionFailures=0`、`protectionFailures=1`；`shouldEscalateEarly` 纯函数测试覆盖 |
| ③ logger（`3179ddf`） | **通过** | `#logger = ctx.logger`（`index.js:500` 传入）→ 不进 `governance.log` 属**设计**；新增 `diagnosticsLogFile` 落点（只记 names + compactionId，<200 字符），单测覆盖；README/T5 已同步 |
| ④ audit（`0c77f0d`） | **通过** | `textHash` 四处已移除（src 仅 `atomic.js` 的文件哈希仍在，与本项无关）；`onInjected(header,{messagesBefore,messagesAfter})`，audit 写 `injected=差值`+两值；两个新用例钉住“基线含 system → 总长 2 但 injected=1”“零注入 → 不触发、长度不变” |

### 9.1 对第 4 步的两条审核结论（已由 `0c77f0d` 落实）

1. **`messagesLength` 硬编码不可接受，改真实差值**：已改为 `onInjected(header, { messagesBefore, messagesAfter })` + `injected = after - before`；`messagesAfter` 由构造式 `[header, ...messages]` 推出（before+1），两个新用例覆盖了“总长≠注入量”和“零注入不触发”。
2. **审核结论：不做 header hash**（本记录的判断，非转述）。理由：
   - **无消费者**：注入形态由 `injected=0|1`（或 `messagesBefore/After`）+ `count=N` + `tokensInjected` 已能完整回答“注没注、注了几条、多大”；内容一致性当前没有真实需求。
   - **32 bit + 低熵**：sha256 前 8 位对低熵文本（header 来自少量记忆标题）可被持有候选文本者验证猜测，只够会话内去重、不适合作标识。
   - **少一个字段少一条边界**：删除比“限定内部使用”更省事，也避免 audit 被带出本机时多一处可确认信息。
   - 将来确有“内容一致性”需求时：用 **HMAC（每安装盐）** 取 8–16 位，并在文档写明仅内部。
   - **反向断言（`assert.equal(x.textHash, undefined)`）审核认可保留**：它钉住决定、不产生任何生产写入；建议再收紧为 `assert.equal('textHash' in obj, false)`（键不存在），不改也可接受。

### 9.1.1 文档补句（供 T5/README 引用）

写入 T5/README：「**audit 是权威记录，warn 只是提示**；保护失败的持久证据是 `manual-compaction-loss`（带 `failures`），日志不是唯一观测点。」

### 9.2 跟踪项（不阻塞 0.2.2 本批）

- **`compactionFailures` 恒 0**：`0c77f0d` 已补注释「暂未接线（当前恒 0）；接线后由 compactNow 失败累加，勿当 bug」——此项关闭。第 5 步接线时仍需补失败路径（`compaction='failed'` 目前无生产者）。
- **同步 busy 文案**：`30d4bcd` 已补 `already has active work`，并加反例 `agent has active work but not compaction` → `false` 防过宽；此项关闭。证据等级：idle 文案有 G2-B 真机；`already has active work` 为**宿主源码审计**（`.tmp/host/dsh-agent-loop__lib__index.js:823` 逐字一致）+ 单测，无真机。

### 9.3 结论

**① ② ③ ④ 全部通过**（④ 于 `0c77f0d` 复验）。四项全过，可按 00 边界一次性推分支（只推分支，不打 tag、不碰 main），推后回报「远端 = 本地 HEAD」hash。

### 9.4 推送记录

- `c143793..5a79e08` 已推（四项通过之后）；远端 = 本地 = `5a79e08`；未打 tag、未改 main。
- 推送前 `compliance-scan`：`blocker=0 review=2`（均为 §9.4/§9.4 类文档示意串误报）。

## 10. 第 5 步复核口径（预登记，2026-10-26）

范围：`turn/end` 门禁 + `early-*` 审计；**`armed` 仍 false、不打开真实触发**。复核时逐条：

1. **开关未打开**：`EarlyCompactor` 构造处 `armed` 为默认 `false`；全仓无 `arm()` 调用点；无配置项/命令可打开。
2. **门禁双事实**：仅在 `turnEnded === true && agentIdle === true` 时调用 `attempt`；缺任一不取引擎、不试探（单测覆盖 turn 中）。
3. **审计字段**：`early-*` 事件含 `compaction=committed|skipped|failed` + `protection=ok|failed` + `failures[]` + `reinjected` + `accepted`（或等价），**不得再出现 `ok`**。
4. **不升级**：`protection=failed` 不触发重试/关开关（spy 断言 `compactNow` 只调一次、`armed` 保持、无 disable）；只有 `compaction=failed` 或 `reinjected=false` 才升级。
5. **`compaction='failed'` 有生产者**：失败路径必须写报告/审计，否则 §9.2 的跟踪未闭。
6. **无真实触发**：`armed=false` 时门禁走 disabled 分支，不调 `compactNow`。
7. **回归**：全量测试通过；全仓无 `attempt().ok` 残留读取。
8. **边界声明**：复核结论必须写明“**armed 未打开、不构成真实触发**；打开 armed 需用户再批一次”。

## 11. 第 5 步复核结果（`c79feb0`，2026-10-26）

基线：HEAD `c79feb0`，工作树 clean；独立 worktree 全量 **310/310**。

| # | 判据 | 结论 |
|---|---|---|
| 1 | 开关未打开 | **通过**：`index.js:526 getArmed: () => false` 硬编码；全仓无 `arm()` 调用点；无配置/环境变量入口（`/cg` 只有 `compact.early` 可**关**，不能开 armed）；打开需改源码 |
| 2 | 门禁双事实 | **通过（附注）**：只在 `session/event → turn/end` 后 50ms 调度；`decideEarly` 有 turn/idle 短路测试。**附注**：接线处 `turnEnded/agentIdle` 恒传 `true`（`early-wiring.js:114-115`），idle 是“假设”不是测量；靠宿主 busy 拒绝兜底（G2-B），失败映射 `early-aborted` |
| 3 | 审计字段 | **通过**：`early-forced` 带 `compaction/protection/failures/reinjected/delayMs/accepted`；白名单覆盖 `accepted/action/effective/threshold/native/...`；无 `ok` |
| 4 | 不升级 | **通过（本批）**：接线代码无重试/无 disable 路径；`shouldEscalateEarly` 本批未使用（注释说明留后续批次） |
| 5 | `compaction='failed'` 有生产者 | **不通过**——见 11.1 |
| 6 | 无真实触发 | **通过（行为实测）**：`armed=false` + `check()`，`ctx.get` 调用 **0 次**、audit **0 条**；`getGuard/getPolicy` 设为抛错也未触发 |
| 7 | 回归 | **通过**：310/310；新文件无 `.ok` 残留 |
| 8 | 边界声明 | 已写入本节末（原文） |

### 11.1 P2：非 accepted 的 `early-*` 事件会抄**上一次**报告的字段

**实测**（worktree 内脚本，busy 与 fail 两种引擎，guard 里保留一份旧 `lastReport={compaction:'committed',protection:'ok',reinjected:true}`）：

```
busy {"event":"early-aborted","compaction":"committed","protection":"ok","reinjected":true}
fail {"event":"early-failed","compaction":"committed","protection":"ok","reinjected":true}
```

**问题**：`early-wiring.js:149-156` 无条件读 `getGuard()?.status?.lastReport`。本次 attempt 被拒/失败时并不会产生新报告，于是 `compaction` 仍写 `committed`、`protection` 写 `ok`、`reinjected` 写旧值——**审计说谎**，而 §9.5 已把 audit 定为权威记录；更严重的是下一批的 `shouldEscalateEarly` 正是读 `compaction/reinjected`，会被旧值毒化（永远不升级）。

**修法**：attempt 前先取 `prevReport = getGuard()?.status?.lastReport`；`result.accepted === true` 时才用（新）report；否则固定写 `compaction:'failed'`（busy 同理）、`protection:null`、`failures:[]`、`reinjected:null`。补单测：断言 aborted/failed 事件里 `compaction` 不是 `committed`、`protection` 不是 `ok`。

### 11.2 其他附注（不阻塞）

- `armed=false` 时仍会为每个 `turn/end` 排一个 50ms 定时器（`check` 立即返回）——无服务/审计副作用，仅极少调度开销；可在订阅处先判 `armedNow()`。
- `shouldEscalateEarly` 本批未接入，需在下一批落实“`protection=failed` 不升级”的实际判定点。
- `early-decision` 在每次 armed 检查都写一条（含 skip），属预期。

### 11.3 边界声明（原文）

> 本轮范围 = `turn/end` 门禁 + `early-*` 审计，**`armed` 保持 false、不打开真实触发**；打开 `armed` 属另一项发布/启用决定，**需用户再批一次**，不在本轮结论内。

### 11.4 结论

第 5 步 **① ② ③ ④ ⑥ ⑦ 通过；⑤ 不通过**（P2 审计字段抄袭旧报告）。修复后按 11.1 的断言补测再复验；在此之前不推分支、不打开 armed。
