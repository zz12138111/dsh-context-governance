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

## DEC-PLUGIN-20261025-15 [tech] T6 降级口径：审计 8 MiB 轮转、只读五类判据、中断/卸载显式留痕

- 背景：T6 要求所有失败显式、可回退、不抛宿主；审计原先只追加不轮转，记忆根不可写时只有“写失败”没有“只读模式”，事件流中断会静默丢 pending。
- 选择：审计默认 **8 MiB** 上限（`audit.maxBytes` 可配 64 KiB–1 GiB），轮转 `audit-YYYYMMDD.jsonl`，先 rename 再写、不删历史；只读判据五类（mkdir/写探测/写者锁/外部改动/写 IO 错），只读时**不写记忆也不写审计正文**、能读能回注（回注既有 `session:<id>#` 条目）、压缩不阻断；恢复在每次 `compaction/start` 探测（root-not-writable 重探测、external-change 走 `reload()`）；事件流中断（同会话无 end 的新 start）记 `cycle-interrupted`，卸载残留记 `cycle-abandoned`。
- 影响：I/O 类写失败不再降级为 `degraded-protection`（转只读，语义更准）；`/cg status` 增加 `read-only=` 与 `audit-health`；新增配置项 `audit.maxBytes` 需过校验。插件版本 `0.1.4`；全量 136/136。
- 关联：`src/audit.js`、`src/memory/store.js`（`probeWritable`）、`src/compress/runtime.js`、`src/index.js`、`docs/T6-失败与降级.md`；状态：active。

## DEC-PLUGIN-20261025-16 [tech] T7 回放：真实 session 事件序列脱敏后入库，不依赖新的真机压缩

- 背景：T7 需要真实 `session/event` 才能验，但真机压缩时机不可控；本机已有多份真实会话日志（`~/.dsh/sessions/**/session.v4.jsonl.zstd`，多 zstd frame）。
- 选择：`analysis/t7/extract-replay-fixture.mjs` 只读解析 frame、取最近一个完整压缩周期，按 key 白名单（text/content/path/summary/oldText/newText…）深度脱敏为 `[redacted:N]`，生成 `test/fixtures/replay-compaction.json`（结构/seq/时间/usage/shadowedSeqs 保留）；`test/t7-replay.test.mjs` 回放 start→summary→checkpoint→end，断言保护写盘/审计/回注。
- 影响：T7 可在无新压缩的情况下做回归；fixture 含真实 seq 规模（shadowed=1267），但无正文/路径/会话 id；新增数据文件约 300 KB。
- 关联：`analysis/t7/extract-replay-fixture.mjs`、`packages/dsh-context-governance/test/fixtures/replay-compaction.json`、`test/t7-replay.test.mjs`；状态：active。

## DEC-PLUGIN-20261025-17 [tech] 版本单一来源：运行时读 package.json，代码不再手写

- 背景：审核打包指出 `package.json` / `PLUGIN_VERSION` / 文档三处手写版本，易漂移（0.1.2→0.1.5 每版都要手动同步）。
- 选择：`src/diagnostics.js` 的 `readPackageVersion()` 用 `new URL('../package.json', import.meta.url)` 读取并 JSON.parse，导出 `PLUGIN_VERSION`；读不到降级 `unknown`（启动行仍可写）。测试断言 `PLUGIN_VERSION === package.json.version` 且源码无 `PLUGIN_VERSION = '0.x` 字面量。文档里的版本号是说明文本，不参与运行。
- 影响：以后升版只改 `package.json` 一处；若插件被整体打包且路径改变，最坏显示 `unknown`，不阻断装载。
- 关联：`src/diagnostics.js`、`test/t7-scenarios.test.mjs`（S7）；状态：active。

## DEC-PLUGIN-20261025-18 [tech] S3 新会话 header 走 opt-in，默认关闭

- 背景：S3 要求“偏好 → 新会话 header 带上”，M1 原实现没有会话开头注入；直接默认开启会改变宿主消息流，未在真机验证。
- 选择：新增 `src/memory/header.js`，挂 `agent/pre-step`（第一步、每会话一次），只读 `active` 的 `preference`/`decision`，最多 5 条/600 字；`memoryHeader.enabled` 默认 `false`，开启后才注册；失败只 warn。
- 影响：默认行为与 0.1.4 完全一致；开启后模型在第一步能看到偏好 ID+标题；真机需用户拍板后再开并观察一轮。
- 关联：`src/memory/header.js`、`src/index.js`、`test/t7-scenarios.test.mjs`（S3/S3b）、`docs/T7-验收场景-S1-S6.md`；状态：active。
## DEC-PLUGIN-20261025-19 [tech] 工具描述符改标准 JSON Schema，并按宿主子集加契约测试

- 背景：v0.1.3 真机 `mem_write`/`mem_query` 未注册——`output.schema` 用旧 spec 形状（属性级 `required:true`）被宿主 `assertSupportedJsonSchema` 拒绝，`parameters` 同样不合法；异常被吞成 warn。
- 选择：`src/tools/mem-tools.js` 手写标准 JSON Schema（顶层 `required` 数组、`additionalProperties` 布尔、object/array 关键字位置正确）；删除不可实现的 `defineTool` 注入；复制宿主校验规则到 `test/host-schema-contract.mjs`，对两个工具的 `parameters` 与 `output.schema` 各断言一次，并把“旧 spec 形状必须被拒”作为回归用例。
- 影响：工具能过宿主 register 与模型侧 schema；宿主升级子集时需同步测试（已注明）；注册失败原因仍逐工具 catch 但会写入 warn。
- 关联：`src/tools/mem-tools.js`、`test/tools-schema.test.mjs`、`test/host-schema-contract.mjs`；状态：active。

## DEC-PLUGIN-20261025-20 [tech] 只处理本项目会话；保护条目可关首行（captureTitle）

- 背景：`session/event` 是全局的，但记忆根固定；其它项目/子代理压缩会写本记忆并把指针回注到那个会话（COMPAT-04）；`protection` 会存最新用户首行，与“不复制正文”表述不符（SEC-01）。
- 选择：`onlyProject` 默认 true，按 `session.header.cwd`（退回 `session.cwd`）与 `projectRoot` 归一化比较，不匹配则忽略并计数（cwd 缺失则放行但计入 `unattributedEvents`）；`captureTitle` 默认 true，false 时保护项只写通用标签 + 指针，不写首行/路径；README 隐私口径改成“首行 ≤200 + 指针，凭据拒写”。
- 影响：默认行为更保守（不串项目）；关标题后详情只能靠 `mem_query` 回原文；`/cg status` 增加 `scope:` 行。版本 `0.1.6`。
- 关联：`src/compress/runtime.js`、`src/compress/protection-memory.js`、`src/commands/cg-status.js`、`README.md`、`docs/T7-复核修复-0.1.6.md`；状态：active。