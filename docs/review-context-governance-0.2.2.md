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
