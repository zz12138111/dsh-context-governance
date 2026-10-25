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
## DEC-PLUGIN-20261025-21 [tech] fixture 脱敏不依赖 key：递归所有字符串 + 字符串数组按 join 判定

- 背景：二轮复核发现 `data.stream[].args[]`/`texts[]` 的短片段按序 join 能还原正文/路径/会话 id；旧实现按 key 白名单脱敏，T7-R2 只查 `key=text`，因此“深度脱敏”不成立。
- 选择：`extract-replay-fixture.mjs` 的 `sanitizeDeep` 对所有字符串做正则脱敏（CJK/盘符与 UNC 绝对路径/POSIX 常见根/URL/长 token → 占位；session-uuid/uuid → 占位）；字符串数组先 join 判断敏感或为短片段流时整组替换；独立 `scan-fixture.mjs` 做“递归字符串 + join(带/不带分隔符) + raw”三层扫描，T7-R2 复用同一判据。
- 影响：fixture 仍保留 seq/结构/usage，但 token/stream 内容只剩占位；回放功能 15/15 不受影响；fixture 约 570KB/475KB。
- 关联：`analysis/t7/extract-replay-fixture.mjs`、`analysis/t7/scan-fixture.mjs`、`test/t7-replay.test.mjs`；状态：active。

## DEC-PLUGIN-20261025-22 [tech] `commands` 移出硬 inject；新增 `reinjection-shadowed` 审计

- 背景：SPEC-05 指出 `inject=['tools','commands']` 缺 commands 时插件直接 inactive；REQ-02 明确要求“回注被吞”审计。
- 选择：`inject=['tools']`，`/cg status` 用 `ctx.get('commands')` 可选注册（已有 `registered:false` 降级）；`CompressionGuard` 记住每次回注 seq，在下一次 `compaction/summary` 检查 `shadowedSeqs`，命中即写 `reinjection-shadowed`（sessionId/compactionId/seq/cycle/reason）并计数。
- 影响：缺 commands 不再阻断插件；回注被吞可审计。成本归属审计仍未实现，需需求定义字段（不自行标“未列”）。
- 关联：`src/index.js`、`src/compress/runtime.js`、`src/audit.js`、`test/t7-p2.test.mjs`、`test/t7-scenarios.test.mjs`；状态：active。
## DEC-PLUGIN-20261025-23 [tech] T8-1 回注失败自愈：连续 N 次才降级一个周期，成功即恢复

- 背景：ROB-01/06 指出一次 `session.append` 失败会永久 `#disableReinjection`，之后保护预写全部 `protection-write-skipped`，只能重启恢复（S4=B 预写被永久关掉）。
- 选择：删除永久关闭；每次失败写 `reinjection-failed`（count=连续失败次数）；连续 `reinjection.maxFailures`（默认 3，1–20 可配）才写 `reinjection-degraded` 并把模式设为 `degraded-protection`；只**暂停下一个周期**的保护写（`protection-write-skipped` reason=`reinjection-suspended`），该周期仍用既有记忆指针回注；回注成功写 `reinjection-recovered`、清 streak、恢复 `full` 与写入。
- 影响：单次瞬时失败不再伤及 S4=B；降级窗口最多一个周期；`/cg status` 显示 streak/suspended。测试 T8-1/T4-5/S4-F。
- 关联：`src/compress/runtime.js`、`test/t4-reinjection.test.mjs`、`test/t7-scenarios.test.mjs`、`docs/T8-回注自愈与成本归属.md`；状态：active。

## DEC-PLUGIN-20261025-24 [tech] T8-2 成本归属：token-only，实测/估算分列，一周期一条

- 背景：REQUIREMENTS ⑦ 选 A：M1 只做 token 归属、不做金额；主键 compactionId，维度 sessionId/project/backend/model/trigger/occurredAt，数值 tokensBefore/After/Shadowed/Summary/Injected/injectedEntries/Dropped，口径 backendCostSource/governanceCostSource/estimateMethod/auditVersion。
- 选择：`compaction/end` 后回注 microtask 之后写一条 `compaction-cost`；tokensBefore/After 用宿主 `tokenMeter.measure()`（取不到为 null + unknown）；tokensShadowed/tokensSummary/backendUsage 用压缩事件 usage（measured）；tokensInjected 用字符 `ceil(chars/4)`（estimated，method `chars/4`）；tokensDropped 由 `reinjection-shadowed` 的注入估算累加；审计白名单加字段、`backendUsage` 只保留五个 token 数值，仍走 8 类凭据脱敏、不写正文/路径。
- 影响：`/cg status` 不含成本明细（审计文件可查）；实测与估算不混算；金额由外部按单价换算。
- 关联：`src/compress/runtime.js`、`src/audit.js`、`test/t8-cost.test.mjs`、`docs/T8-回注自愈与成本归属.md`；状态：active。
## DEC-PLUGIN-20261025-25 [tech] 回放 fixture 改结构白名单，正文载体整段占位

- 背景：三轮复核指出“模式命中式脱敏”仍保留英文正文/工具参数（auto 835、manual 32 条 ≥30 字符），按序拼 stream/args 可还原内容；DEC-16 的“无正文”不成立。
- 选择：新增 `analysis/t7/structure.mjs` 白名单——事件只保留 type/seq/time、枚举、数值、id 引用、source.kind、shadowedRange/usage；`content`/`message.content` 变成单块占位，`stream`/`texts`/`args`/`meta`/`summary`/`rawOutput`/`lines` 整段 `[redacted:<key>]`，未知键丢弃；生成后再跑递归兜底；T7-R2 增加“结构字段不得含空白散文”断言。
- 影响：fixture 从 571/475 KB 降到 58/55 KB；scan violations=0；回放断言全过；后续新增 fixture 必须走 `structure.mjs`。
- 关联：`analysis/t7/structure.mjs`、`analysis/t7/extract-replay-fixture.mjs`、`test/t7-replay.test.mjs`；状态：active。

## DEC-PLUGIN-20261025-26 [tech] commands 晚挂载重试 + shadowedRange 兜底

- 背景：SPEC-05 把 commands 移出 inject 后，晚挂载会导致 `/cg status` 静默缺失；`reinjection-shadowed` 只看 shadowedSeqs，缺数组时漏判。
- 选择：首次注册失败时优先 `ctx.inject(['commands'], retry)`，否则下个 tick `setTimeout` 重试一次；重试成功写 info、dispose 最终 handler。回注被吞判定改为 `shadowedSeqs.includes(seq) || seq ∈ shadowedRange`。
- 影响：晚挂载可恢复命令；缺 shadowedSeqs 的宿主也能记回注被吞与 tokensDropped。
- 关联：`src/index.js`、`src/compress/runtime.js`、`test/t7-p2.test.mjs`、`test/t8-cost.test.mjs`；状态：active。
## DEC-PLUGIN-20261025-27 [tech] T8 配置收口：reinjection.maxFailures 进配置、成本补 backend 维度与口径修正

- 背景：四轮复核指出 `reinjection.maxFailures` 只在测试可传、配置写 `/cg` 会静默忽略；`compaction-cost` 缺 `backend` 维度；`tokensShadowed` 缺字段默认 0 无法区分、空 usage 误标 measured、late-start trigger 写死 auto、`#reinjectionDisabled` 为死代码、恢复后 mode 粘滞。
- 选择：`DEFAULT_CONFIG.reinjection={maxFailures:3}`，`resolveConfig` 校验整数并夹取 [1,20]，经 `cordis.patch.yml` 示例暴露并传入 guard，`/cg status` 显示 `maxFailures`；成本记录加 `backend: adapter.kind`；`tokensShadowed` 白名单改 `nullable-number`，缺失为 null；`usage` 必须至少含一个有效 token 数值才写 `backendUsage`/measured；late-start trigger 读 `summary.sourceCommandId`；删除死字段；`reinjection-recovered` 后若 reinjection 降级原因清空则直接赋 `selectMode` 结果（不写死 full）。
- 影响：配置生效、成本维度完整、口径可区分 null/0；0.1.9 的 fixture 结构白名单/commands 重试/range 兜底未动。
- 关联：`src/index.js`、`src/compress/runtime.js`、`src/audit.js`、`src/commands/cg-status.js`、`cordis.patch.yml`、`test/t7-p2.test.mjs`、`test/t8-cost.test.mjs`；状态：active。
## DEC-PLUGIN-20261025-28 [tech] M1.2：能力探测双行 + tokenMeter 延迟获取 + usage 兜底 + cost-v1.1

- 背景：M1 真机 `tokensBefore/After` 恒 null、能力行 `compaction=absent`；复查确认是插件侧时序（apply 一次探测/缓存），不是宿主限制（后经真机推翻，见影响）；真机 `assistant/message` usage 齐全可兜底。
- 选择：能力探测 apply 记 `capability@apply`、首个会话事件后记 `capability@ready`（诊断行 + audit，只记类型）；`tokenMeter` 不加硬 inject，`ctx.inject(['tokenMeter'], cb)` 可选注入 + 按需 `ctx.tokenMeter ?? ctx.get('tokenMeter')`（成功才缓存）；`assistant/message.usage` 按会话缓存，`tokensBefore/After` 优先 meter、退回 usage、全缺 `null`+`none`；新增 `tokensBeforeSource`/`tokensAfterSource`/`tokensBeforeParts`/`tokensAfterParts`，`auditVersion=cost-v1.1`，只增字段；`/cg status` 显示 `last-cost`。
- 影响：真机重启后应能给出非 null 成本水位与来源；**`ctx.compaction` 真机纠正**：本部署插件 scope 拿不到（`capability@apply/@ready` 的 `get.compaction` 均 `absent`），插件不依赖它（压缩观测走 `session/event`），故“回注时点可修”的 P1 前提不成立；下次探测用 `ctx.get('compaction', false)` 区分“无提供”与“有 impl 未 active”。不改压缩后端/回注；两路都缺仍不伪造。
- 关联：`src/capabilities.js`、`src/diagnostics.js`、`src/audit.js`、`src/index.js`、`src/compress/runtime.js`、`src/commands/cg-status.js`、`test/m1.2-cost.test.mjs`、`test/t8-cost.test.mjs`、`docs/T8-回注自愈与成本归属.md`；状态：active。

## DEC-PLUGIN-20261025-29 [tech] T2′：只观测宿主 prune，不折叠/spill；cost-v1.2

- 背景：用户拍板 T2=A（收口）——宿主 pruner 已在压缩点覆盖全部 >8k，白名单可折上限约 15.3%，`pwsh`+`read` 占 71.0% 且不折；早折净收益未证。
- 选择：生产代码不折/不写 spill/不提供 fold 开关；只读 `compaction/prune` + 紧随替换 `tool/result`，写 `prune-observed`（工具名按 `callId` 反查 `tool/call`，查不到 `unknown`；同 range 去重；`cycle=current/outside`）；`compaction-cost` 增 `tokensPruned`（measured，无 prune 为 null）/`pruneCount`/`pruneTools`（top5），`auditVersion=cost-v1.2`；`/cg status` 与 `last-cost` 显示 `pruned`/`tools`。
- 影响：只增加可见性，不改模型可见内容；无 pruner 时 `pruneCount=0` + `tokensPruned=null`，不伪造；P3-1 改为 `fiber.dispose()`；P3-6 读方按 `cost-v1` 前缀匹配。
- 关联：`src/compress/runtime.js`、`src/audit.js`、`src/commands/cg-status.js`、`test/prune-observed.test.mjs`、`docs/T5-状态命令与审计.md`、`docs/T8-回注自愈与成本归属.md` §7；状态：active。

## DEC-PLUGIN-20261025-30 [tech] 0.1.13：batch 判据收窄（真修假阳性）+ `get.compaction(strict=false)` 归因

- 背景：0.1.12 复核 §11 指认 batch 假阳性——`textOf(event)` 扫全部事件，工具结果/审计 JSON 里的 `"batch"` 字段命中宽正则；取不到 `x/y` 时 `ratios=[]`，旧 `ratiosCovered([])` 只要求摘要非空 → 空泛 pass（`protection.js:396`）。另 `get.compaction` 只记 `absent`，分不清“本 scope 未提供”与“有 impl 未 active”。
- 选择：batch 只从人类 `user/message` 与 `assistant/message` 正文取“数字/数字”明确比例（排除 `tool/*`、规则注入、JSON/代码块，日期不算）；`ratios=[]` 判 `skip` + `reason=no-ratio-in-user-messages`，写 `protection-skip` 审计（白名单加 `names`）；带比例的消息优先于仅关键字。能力探测加 `ctx.get('compaction', false)`：`obj`=有 impl 未 active / `undefined`=本 scope 未提供 / 不支持或抛错=`unknown`，不猜。
- 影响：原先“假通过”样本变“真 skip”（预期行为变化，非回归）；`auditVersion` 维持 `cost-v1.2`；不改折叠/回注/记忆/成本路径。离线回放 6 场景 4 改判（`analysis/req-20261025-04/replay-diff.txt`）；全量 **189/189**。
- 关联：`src/compress/protection.js`、`src/capabilities.js`、`src/audit.js`、`src/compress/runtime.js`、`test/compress-protection.test.mjs`、`test/compress-integration.test.mjs`、`test/perception-capabilities.test.mjs`、`docs/T3-压缩适配与保护.md`、`docs/T8-回注自愈与成本归属.md` §6.5、`docs/T5-状态命令与审计.md`；状态：active。

## DEC-PLUGIN-20261025-31 [tech] 0.1.14：batch 比例同源约束（宁可 skip 不可 fail）

- 背景：0.1.13 收窄后，助手/用户正文里的收口与测试计数（`2/6`、`183/183`）被当批次比例 → 判 `fail` 并写 `manual-compaction-loss` 假阳性（真机 `seq=11453`，`2/6` 来自评审语 `0 阻断 / 0 P2 / 6 P3`）；`YYYY/MM`、正文 `{511/958}` 也会误伤。
- 选择：批次语义（`批次|进度|progress|batch`）必须与比例出现在**同一条** `user/message` 或 `assistant/message` 正文，跨消息拼凑不算；无关键字但有比例 → 不算候选，记 `batchRejected` 并 `skip(no-batch-semantics)`；`YYYY/MM`（19xx/20xx + 1–12）剔除后 `skip(date-like-ratio)`；`stripStructuredPayload` 只剥“像 JSON”的 `{…}`/`[…]`（含引号或冒号），保留正文比例；判据原则“宁可 skip 不可 fail”（fail 会触发 `manual-compaction-loss`）。
- 影响：真实快照 A/B（`0.1.12 seq=11479 ratios=[] → pass`、`0.1.13 seq=11453 ratios=["2/6"] → fail`）在 0.1.14 均 `skip(no-batch-semantics)`、不进 failures；正例必须带关键字；`auditVersion` 维持 `cost-v1.2`。离线三列对照 `analysis/req-20261025-05/`；全量 **196/196**。
- 关联：`src/compress/protection.js`、`test/compress-protection.test.mjs`、`test/compress-integration.test.mjs`、`test/compress-helpers.mjs`、`docs/T3-压缩适配与保护.md`、`docs/T5-状态命令与审计.md`、`analysis/req-20261025-05/`；状态：active。

## DEC-PLUGIN-20261025-32 [tech] `ctx.compaction` 不可得根因：agent preset `isolate`

- 背景：0.1.14 真机 `get.compaction(strict=false)=undefined` 只定性到“本 scope 未提供”，根因未定位（此前怀疑挂载时机/redirect）。
- 事实：agent preset 把 `compaction-basic` 与 `tool-result-pruner` 放进 `cordis:group` 并设 `isolate: { compaction: true, toolResultPruner: true }`（本机可见的 `@local/dsh-computer-use/presets/cordis.patch.yml` 三套 custom preset 均带；`standard` 的 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 同口径，见需求核对）→ 两个服务被隔离在 preset 组作用域内，根级插件不可见；与 token 拼写、挂载时机无关。
- 影响：provider 路线在现有部署下**不可行**（要动需宿主级改动，M1 不做）；插件继续走 `session/event` 事件级；prune 观测走事件流，不依赖该服务；`/cg status` 的 `get.compaction=absent`、`get.compaction(strict=false)=undefined` 是设计行为，不再当异常。
- 关联：`docs/T3-压缩适配与保护.md` §6.4、`docs/T8-回注自愈与成本归属.md` §6.5、`logs/governance.log` capability@apply/@ready；状态：active。

## DEC-PLUGIN-20261025-33 [tech] 0.1.15：事件形态推断（inferred）+ cost-v1.3

- 背景：REQ-20261025-06 D1-1 —— 原生下 `ctx.compaction` 被 preset `isolate` 隔离，`detectAdapter()` 恒 `none`；功能不受影响，但 `/cg status`/审计/`compaction-cost.backend` 无法区分原生。
- 选择：`inferBackendFromStyles` 按 `classifySummaryText` 形态推断（free-form→host-basic、five-section→context-zip、混合→mixed/unverified、无观察→unknown），**只进展示/归因**：`/cg status` 显示 `inferred=…`，新增 `adapter-inferred` 审计；`compaction-cost` 仅在实测 kind 为 `none/unknown` 时用推断 label，新增 `backendInferred`，`auditVersion=cost-v1.3`（只增字段）。
- 影响：功能路径（保护/回注/降级/成本计算）不读推断（单测「相反推断下选择器输出不变」）；迁移真实 kind 已知时不覆盖（保持 measured）；隔离实例复验 `host-basic (inferred)`。
- 关联：`src/compress/adapters.js`、`src/compress/runtime.js`、`src/commands/cg-status.js`、`src/audit.js`、`test/m1.3-inference.test.mjs`、`docs/T3`/`T5`/`T8`、`analysis/req-20261025-06/`；状态：active。

## DEC-PLUGIN-20261025-34 [tech] 0.1.16：控制字符闸 + cost 字段拆分（cost-v1.4）

- 背景：0.1.15 复核 P3 —— `README.md` 含 0x08/0x07（`\b`/`\a` 被写入路径转义）；`compaction-cost.backend` 在 0.1.15 被写成展示串（`host-basic (inferred)`），破坏枚举语义。
- 选择：清 README 控制字符并加防复发测试（包内 `.md/.js/.mjs/.json/.yml` 禁 C0/DEL，命中列文件+偏移；自证注入→fail）；`compaction-cost` 拆 `backendKind`（枚举，与 `backend` 同值）+ `backendLabel`（展示串）+ `backendInferred`（仅实测 kind 为 none/unknown 且推断补位时 true，mixed 也算补位）；`backend` 恢复只写枚举；`auditVersion=cost-v1.4`（只增字段，`backend` 语义回退）；`/cg status` 改用 `backend-label=`。
- 影响：下游按枚举聚合仍读 `backend`；读展示串改读 `backendLabel`；功能逻辑未改。
- 关联：`src/compress/runtime.js`、`src/commands/cg-status.js`、`src/audit.js`、`test/no-control-chars.test.mjs`、`test/m1.3-inference.test.mjs`、`docs/T5`/`T8`、`README.md`；状态：active。

## DEC-PLUGIN-20261025-35 [tech] 0.1.17：backend 枚举补 `none` + 控制字符闸扩到仓库根

- 背景：0.1.16 把实测 `none` 折叠成 `unknown`，与真 unknown 不可区分（真机常态是 none，成本审计会堆假 unknown）；控制字符闸只覆盖包内，`AGENTS.md` 的 0x0C 逃过。
- 选择：`backend`/`backendKind` 枚举扩为 `none`/`unknown`/`host-basic`/`context-zip`（实测 none 保留 none，未知 provider 才 unknown；mixed 仍 unknown+label）；`auditVersion` 维持 `cost-v1.4`（值域扩展非 schema 变更）；控制字符闸扫描仓库根（排除 `.tmp`/`node_modules`/`.git`，允许 `\n\t\r`），清 `AGENTS.md` 的 0x0C。
- 影响：M2 账本按枚举聚合不再把常态 none 误记 unknown；闸覆盖仓库文档，防同类转义复发。
- 关联：`src/compress/runtime.js`、`test/m1.3-inference.test.mjs`、`test/no-control-chars.test.mjs`、`AGENTS.md`、`docs/T5`/`T8`、`README.md`；状态：active。
