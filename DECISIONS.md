# DSH 插件开发 · 决策记录（开发单写）

> 开发会话是唯一写者；需求/审核只读。
> 格式：一条决策 ≤5 行：日期 · 编号 · 决定 · 理由/影响 · 关联文件。
> 编号规则：`DEC-PLUGIN-YYYYMMDD-NN`。

## 模板

```
## DEC-PLUGIN-YYYYMMDD-01 [user|dev|tech] 一句话结论
- 背景：为什么现在要定
- 选项：A … / B … / C …（推荐项注明）
- 选择：X，理由一句话
- 影响：改动面、回滚方式
- 关联：文件/任务单
- 状态：active
```

---

## DEC-PLUGIN-20261025-01 [tech] E1：两后端均为“事件级”感知，治理层只观察不替换压缩引擎

- 背景：T1 门禁要求至少“状态级”；宿主压缩事务可观察性决定 T3 适配形态。
- 选项：A 替换 `ctx.compaction` 拿前钩子 / B 只订阅 `session/event` / C 只读日志推断。
- 选择：B（C 兜底）。实测 `compaction/start|summary|checkpoint|end` 全部持久化，start 在摘要调用前同步到达，但没有 veto/范围字段。
- 影响：T3 只做压缩前校验 + 压缩后审计；不得与 context-zip 抢 provider；版本漂移靠契约自检。
- 关联：`analysis/e1e2/E1-感知层级实验记录.md`、`analysis/e1e2/行为矩阵-6.3回写字段.md`；状态：active。

## DEC-PLUGIN-20261025-02 [tech] E2：默认回注只放 ID+状态+指针，摘要可读且未覆盖才补一行标题

- 背景：三种回注形态在 context-zip 下的“被吞/重复/接续”需要定默认。
- 选项：A 详情 / B 标题+指针 / C ID+状态（条件补标题）。
- 选择：C。6/6 真实压缩对证明 checkpoint 后注入必被下一次压缩吞掉（不跨压缩重复）；三形态都原样进入摘要输入（字符增量 177/43/26），详情有二次摘要风险；引擎不去重。
- 影响：T4 需覆盖判断 + 表面去重 + 每压缩周期一次；“被吞”按 `seq ∈ shadowedRange` 审计；详情永不回注。
- 关联：`analysis/e1e2/E2-回注形态实验记录.md`、`docs/记忆契约-v1.md` §8；状态：active。

## DEC-PLUGIN-20261025-03 [tech] 记忆存储用 Markdown 主题文件 + 派生 MEMORY.md，不用 JSONL/数据库

- 背景：T2 要求人可读、可 git、可人工编辑，同时要有索引。
- 选项：A JSONL 真源 + Markdown 镜像 / B 每 type 一个 Markdown 块文件 / C SQLite。
- 选择：B。块标记 + 固定字段行；解析失败按损坏处理；索引每次写后重建。
- 影响：每次写重写一个 type 文件并留一代 `.bak`（调用少，可接受）；人工编辑必须保持块结构。
- 关联：`docs/记忆契约-v1.md`、`packages/dsh-context-governance/src/memory/entry-format.js`；状态：active。

## DEC-PLUGIN-20261025-04 [tech] 记忆根、ID 与写者锁的固定取值

- 背景：T2 落地需要稳定路径与编号，避免多项目/多会话互相踩。
- 选择：根 `<project>/.dsh/memory`；ID `MEM-YYYYMMDD-NNN`（本地自然日、项目内递增）；锁 `.writer.json`（pid+startedAt；活进程→只读，死进程→覆盖）。
- 影响：跨进程不合并；同项目第二个写者显式只读；本地日期回拨不会重号。
- 关联：契约 §2/§5、`src/memory/store.js`、`src/memory/lock.js`；状态：active。

## DEC-PLUGIN-20261025-05 [dev] T2 代码形态：零依赖 ESM + node:test，工具层不 import 宿主包

- 背景：红线禁止装/重启，T2 必须能独立自测；T3 才接宿主 `defineTool`/Schemastery。
- 选择：纯 ESM（Node ≥22.19）；工具描述符按宿主 ParameterSchemaSpec 形状书写，`defineTool` 由入口参数注入；`node --test` 40 条全绿。
- 影响：T3 入口需补宿主包解析（asar 布局）与配置表单；本包尚未装入任何 profile。
- 关联：`packages/dsh-context-governance/`、`docs/记忆契约-v1.md`；状态：active。

## DEC-PLUGIN-20261025-06 [tech] T3 不替换压缩 provider：保护只做“校验 + 告警 + 降级”

- 背景：E1 证明宿主无拦截型前钩子；替换 `ctx.compaction` 会与 context-zip 抢行，违反 M1 边界。
- 选择：`CompressionGuard` 只订阅 `session/event`；适配器只识别/自检；保护失败只报告，不 veto；后端切换只给人工建议。
- 影响：手动压缩吞掉受保护内容时无法阻止，只能检测与补偿；模式分 `full / degraded-summary-unreadable / observe-only / disabled`。
- 关联：`src/compress/`、`docs/T3-压缩适配与保护.md`；状态：active。

## DEC-PLUGIN-20261025-07 [dev] 真插件安装改用 `file:` + junction，不用 pnpm

- 背景：`dsh plugin add` 实测 prune 33 个包、搬走 compression redirect、改写 lock；事故根因还需避开 BOM。
- 选择：manifest 写 `file:D:/…/packages/dsh-context-governance` + bundles 追加 + `node_modules` junction；**不跑 pnpm，也不跑 `--lockfile-only`**；manifest 用 Node 写 UTF-8 无 BOM。
- 影响：manifest 与 lock 暂时不一致（运行时只读 manifest）；升级同路径自动生效；回滚靠预装备份。
- 关联：`docs/插件安装升级-Runbook.md`、`packages/dsh-context-governance/cordis.patch.yml`；状态：active。

## DEC-PLUGIN-20261025-08 [user] 手动压缩下“受保护内容零丢失”口径待拍板

- 背景：真实 16 次压缩审计：最新用户消息被吞 11/16（手动 10/10、自动 1/6）；批次未覆盖 5；回滚未覆盖 6。宿主手动压缩只保留最后一个 surface 节点。
- 选项：A 改 S4 为“自动压缩零丢失 + 手动压缩显式告警 + 记忆/原文可找回”（推荐）/ B 压缩前把受保护项写入记忆（只存标题+指针）/ C 替换压缩引擎强制执行（违反 M1 边界）。
- 影响：A 不改代码即可进 T4/T7，但 S4 文案要改；B 增加写入面与隐私边界；C 不建议。
- 关联：`docs/T3-压缩适配与保护.md` §6.3、`analysis/t3/data/t3-audit.json`；状态：**用户已拍板 B（2026-10-25）**。

## DEC-PLUGIN-20261025-09 [tech] 回注从“checkpoint→end 之间”改为“end 后首个 microtask”

- 背景：checkpoint 的 append 仍在发布期，`session.append` 重入会被宿主拒绝；宿主同栈立刻 append end，二者之间无同步窗口。
- 选项：A 替换 provider 以获得精确钩子 / B end 后 microtask 注入 / C 等下一轮 `agent/pre-step`。
- 选择：B；同一 tick、下一轮模型调用前；E2 已证注入会在下一次压缩被吞，时机在 end 前后不改变该结论。
- 影响：与要求 3 的字面时序有偏差，需 00/用户知悉；若坚持字面时序，只能走 A（M1 不做）。
- 关联：`docs/T4-压缩前固化与回注.md` §5；状态：**用户已接受（2026-10-25）**。

## DEC-PLUGIN-20261025-10 [tech] 压缩前固化走“同步 journal + 异步物化”，保护 ID 预留 1000+

- 背景：`compaction/start` 是摘要生成前唯一同步窗口；MemoryStore 的写者队列是异步的，不能 await。
- 选择：`protectSync` 同步写 `protection/<cycle>.json`（临时文件+fsync+rename），随后异步并入 topics/MEMORY；ID 用 `MEM-YYYYMMDD-1000+` 预留，防止与普通条目抢号；崩溃后 open 自动物化。
- 影响：压缩前多一次 2–4KB 同步 IO（实测量级 <5ms，audit 记 durationMs）；journal 短暂双份存储，物化后删除。
- 关联：`src/memory/store.js`、`src/compress/protection-memory.js`；状态：active。

## DEC-PLUGIN-20261025-11 [tech] T5 审计用显式字段白名单；写盘耗时以 p50/p95 暴露

- 背景：审计需可复核且不能落正文；T7 需判断同步 fsync 是否拖慢压缩。
- 选择：`src/audit.js` 维护 `AUDIT_FIELD_WHITELIST`（未知字段丢弃、字符串敏感替换）；每次 `protectSync` 的 `durationMs` 进审计与 guard 样本，`/cg status` 显示 p50/p95、audit 保留逐次值。
- 影响：新增审计字段必须改白名单；p95>50ms 才考虑减 fsync，**禁止改异步**（会丢“摘要前落盘”语义）。
- 关联：`src/audit.js`、`src/commands/cg-status.js`、`docs/T5-状态命令与审计.md`；状态：active。

## DEC-PLUGIN-20261025-12 [tech] 宿主矩阵改为同 rc 线区间；backend unknown 只告警

- 背景：实际宿主 `0.2.1-rc.3` 不在精确枚举（仅 rc.2）内 → 自检 fail → observe-only；`adapter=none` 同时暴露 compact 服务探测时机问题。
- 选择：host 匹配 `>=0.2.1-rc.2 <0.2.2-0`（接受 rc.2+ 与 0.2.1 稳定版，拒绝 rc.1/0.2.2+/0.1.x）；context-zip backend `unknown` 只 warn，不降级。
- 影响：小版本升级不再误降级；自检仍以事件面/摘要行为为准，不因区间通过而跳过契约检查。
- 关联：`src/compress/adapters.js`、`docs/T3-压缩适配与保护.md` §6.4；状态：active。（本条原写"`inject` 增加 `compaction`"，已被 DEC-13 撤销。）

## DEC-PLUGIN-20261025-13 [tech] 撤掉 `compaction` 硬依赖，压缩感知改走事件级

- 背景：v0.1.1 把 `compaction` 加进 `inject` 想保证服务先挂载，结果插件永久 pending、apply 完全不执行、且无任何日志。实测服务 token 确为 `compaction`（`CompactionEngine extends Service` → `super(ctx,"compaction")`），但插件根作用域 `ctx.compaction`/`ctx.get('compaction')` 均为空——是**可见性/挂载**问题，不是 token 拼写。
- 选择：`inject=['tools','commands']` 只保留根级可见服务；压缩感知走 `ctx.on('session/event')` 里的 `compaction/start|summary|end`（E1 已验证）；provider 不可见时 `selectMode` 返回 **`event-level`**（新增模式），T3 保护校验与 T4 固化/回注照常工作。
- 影响：apply 必然执行；启动行与 warn 明写 `compaction-service=absent(token=compaction)` / `warning=provider-unavailable`，不再静默；未来 provider 真正可见则自动升级为 provider 路线。插件版本 `0.1.2`；全量测试 118/118。
- 关联：`src/index.js`（`inject`/`compactionProbe`/`startupLine`）、`src/compress/selection.js`（`MODES`/`selectMode`）、`docs/T3-压缩适配与保护.md` §6.4；状态：active。

## DEC-PLUGIN-20261025-14 [tech] `perception` 只表示“实际订阅成功”；apply 时 dump 事件面能力（只记类型）

- 背景：v0.1.2 在 provider 不可见时日志写 `perception=none` 却 `mode=event-level`——`perception` 直接取了 `adapter.perception`（`kind=none` 固定 `none`），与订阅是否挂上无关，容易被读成“没在看压缩”。
- 选择：`guard.perception` = 已 `start()` 且 `ctx.on` 存在 → `event`，否则退回契约值；新增 `src/capabilities.js`，apply 时写一行 `governance capability … probe=on=fn,events=obj(dispatch=fn),…,get.sessions=absent,root=self`，**只记 typeof 类型**；启动行补 `event-api=on|off`、`audit=<path>`；审计在 apply 时建文件并写 `apply` 记录。
- 影响：`perception` 不再可能“假报”；下次重启能从一行里看出宿主到底暴露了哪些事件面 API；`/cg status` 增加 `event-api`/`events=N`，`N` 是运行期真实收到 `session/event` 的计数（判断“事件是否真的到达”的硬证据）。
- 关联：`src/capabilities.js`、`src/diagnostics.js`、`src/index.js`、`src/compress/runtime.js`、`src/audit.js`、`docs/T3-压缩适配与保护.md` §6.5；插件版本 `0.1.3`；状态：active。
