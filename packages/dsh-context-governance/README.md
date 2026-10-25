# dsh-context-governance

上下文治理插件（DSH / DeepSeek Harness）。M1 目标：**压缩前后不断线**——任务态记忆落项目文件，压缩后只回注 ID/状态/指针，详情按需取。

> 版本：**以 `package.json` 为唯一来源**（本文与代码都不再重复版本号；启动行/审计里的 version 由运行时读取）。
> 当前进度：**T2–T8 + M1.2 + T2′ 离线完成**——记忆文件与契约、`mem_write`/`mem_query`、压缩适配与保护校验、压缩前固化与回注、`/cg status` 与审计正式化、故障注入/轮转/只读降级、S1–S6 验收场景 + 真实自动/手动压缩双样本回放 + 回注自愈 + 成本归属审计（T8）；M1.2 增加 `capability@apply/@ready`、`tokenMeter` 延迟获取、usage 兜底与 `cost-v1.1` 来源字段；T2′ 增加宿主 `compaction/prune` 观测与 `cost-v1.2` 成本视图（不折叠、不落盘）；**M2 0.2.0 策略层**——四层配置合成（内置/profile/插件/项目 `.cg-policy.json`/会话）、`/cg policy show`、`/cg set` 会话覆盖、`/cg status` 的 `policy`/`policy-invalid`/`pressure` 行、项目文件按不可信输入加固（A+C 口径）；**M2 0.2.1 窗口/校验层**——宿主 `contextPressure.contextWindow` 观察、dynamic native 同源、conservative 校验、`/cg status` 的 `window:` 双显，**本版不触发任何压缩**；**全部测试通过（数量见 `node --test` 输出）**。
> 真机：已安装（junction 指向源码目录）；最近一次真机验证记录见 `memory/ARTIFACTS.md`，待验收项见 `STATUS.md`（本文不写具体版本/数字）。**M3 T2（0.3.1）起新会话 header 默认开启**（`/cg header off` 或配置 `memoryHeader.enabled=false` 可关）。
> 安装方式：`docs/插件安装升级-Runbook.md`（`file:` 声明 + junction + bundle；不用 pnpm）。本机已按该方式安装（junction 指向源码），其它机器按 Runbook 操作。

## 为什么不是“又一个记忆插件”

- 只记任务态（决定/偏好/待办/进度/事实/判据/锚点）；压缩保护条目会保留**最新用户消息首行 ≤200 字**与路径/批次等指针（`captureTitle: false` 可关，改为只存 ID/状态/通用标签），其余正文不入库；命中已知凭据形态直接拒写（fail-closed）。
- 记忆是**文件**：人可读、可 git、可人工修；无数据库、无向量检索、无第三方依赖。
- 回注遵守一条硬规则：**详情永不回注**；摘要不可读时只放 ID+状态。
- 压缩沿用宿主或 context-zip，不写第二个压缩引擎，也**不替换** `ctx.compaction`。
- 默认只处理**本项目会话**（`onlyProject: true`，按 `session.header.cwd` 比对 `projectRoot`）；别的项目/工作区的压缩事件直接忽略并计数（`/cg status` 的 `scope:` 行）。

### 隐私边界（准确口径）

- `protection/<cycle>.json`、`topics/*.md`、`MEMORY.md` 里**可能有**：最新用户消息的首行摘要（≤200 字）、规则文件路径、批次路径/数字、回滚点路径、工具 callId。
- 这些内容**不是**“完整正文”，但也**不是**“只知道 ID”：容易泄露的短句/路径会以标题形式长期留在项目记忆里（`MEMORY.md` 可被人读/提交）。
- 关闭方式：`captureTitle: false`（只存通用标签 + `source=session:<id>#<seq>` 指针，细节靠 `mem_query` 回原文）。
- 审计 `audit.jsonl` 永不写标题/正文，只写元数据；凭据形态（8 类）在写入记忆前会被拒。

## 目录

```
packages/dsh-context-governance/
├─ src/
│  ├─ index.js                 插件入口（配置 → 记忆库 → 工具 → 压缩观察）
│  ├─ diagnostics.js           可选启动日志（首次安装验证）
│  ├─ audit.js                 最小审计 JSONL（同步追加、字段白名单、不写正文）
│  ├─ metrics.js               p50/p95 统计
│  ├─ memory/                  契约、主题文件格式、原子写、写者锁、MemoryStore、保护 journal
│  ├─ compress/
│  │  ├─ adapters.js           行为契约 + 后端识别 + 自检 + 宿主版本探测
│  │  ├─ protection.js         压缩前后保护校验（6 项）
│  │  ├─ protection-memory.js  5 类保护项 → 标题+指针
│  │  ├─ selection.js          冲突检测 + 模式/降级
│  │  └─ runtime.js            CompressionGuard（start 固化 / end 回注 / 写盘耗时）
│  ├─ policy.js                M2 策略层：四层合成/校验/native/压力四段（纯函数）
│  ├─ commands/cg-status.js    `/cg status`、`/cg policy show`、`/cg set`
│  └─ tools/mem-tools.js       mem_write / mem_query
├─ test/                       node:test（数量见运行输出；含真实压缩双样本 fixture）
├─ cordis.patch.yml            bundle patch（本机安装 config）
└─ package.json
```

文档：`../../docs/记忆契约-v1.md`、`../../docs/T3-压缩适配与保护.md`、`../../docs/T4-压缩前固化与回注.md`、`../../docs/T5-状态命令与审计.md`、`../../docs/插件安装升级-Runbook.md`。
实验：`../../analysis/e1e2/`（E1/E2）、`../../analysis/t3/`（T3 真实日志审计）。

## 工具面（T2）

- `mem_write`：`create` / `update` / `confirm` / `supersede` / `expire`；模型写入与高风险项默认 `proposed`。
- `mem_query`：不带 `ids` 只回索引行；带 `ids` 才回详情（≤20 条）。

## 压缩面（T3 + T4）

- 订阅 `session/event`：`compaction/start` 快照 → `summary` 校准 → checkpoint → `end` 核对；**只读**，不改宿主。
- 识别宿主默认 / context-zip（运行时标记），自检失败或 provider 未知 → `observe-only`；摘要不可读 → `degraded-summary-unreadable`。
- 保护检查：最新用户消息、规则注入（旧快照可由新 baseline 取代）、工具配对切口、批次清单、回滚点、产物/摘要。
- **压缩前固化（S4=B）**：`compaction/start` 内同步写 5 类保护项（最新用户首行、规则在场、批次 STATE、回滚点、未闭合 callId）到 `protection/` journal 与记忆；随后异步物化。
- **回注**：`compaction/end` 后首个 microtask 注入一次 `ID+状态+（未覆盖时）标题`；详情永不回注；同 cycle 去重。
- 失败：写失败 → audit + `degraded-protection`；注失败 → audit + `observe-only`；均不抛宿主。
- 发现（真实 16 次压缩）：宿主**手动压缩不保护**最新用户消息/批次/回滚点；T4 采用“记忆指针 + 显式告警 + 回注标题”补偿（S4=B 已拍板）。

## 状态与审计（T5）

- `/cg status`：后端/能力、mode/degraded/conflicts、记忆计数、上次压缩/回注、写盘 `p50/p95`、审计文件与最近失败。
- 审计 `audit.jsonl`：显式字段白名单（`src/audit.js` 的 `AUDIT_FIELD_WHITELIST`）；只写元数据，不写正文/标题；敏感字符串替换为 `[redacted:kind]`。
- 写盘耗时：每次 `protectSync` 的 `durationMs` 进 audit 与 guard 样本；`/cg status` 显示 p50/p95；判据 p95>50ms 才考虑减 fsync，**不改异步**。
- M1.2：`capability@apply`/`capability@ready` 两行能力探测（诊断 + audit，只记类型）；`tokenMeter` 延迟获取 + `assistant/message.usage` 兜底；`compaction-cost` 增加 `tokensBefore/AfterSource`（`tokenMeter`/`usage`/`none`）与可选 parts，`auditVersion` 自 0.1.11 起为 `cost-v1.1`；`/cg status` 增加 `last-cost:` 行。
- T2′（0.1.12）：只读观测宿主 `compaction/prune`，写 `prune-observed`（工具名、阴影范围、token、replacementSeq、cycle）；`compaction-cost` 增 `tokensPruned`/`pruneCount`/`pruneTools`，`auditVersion=cost-v1.2`；`/cg status [last-cost]` 显示 `pruned=<tokens> tools=<top5>`。**不折叠、不改 content、不写落盘文件**。
- 0.1.13：`batch-list` 判据收窄——只从人类 `user/message` 与 `assistant/message` 正文取“数字/数字”比例（排除 `tool/*`、JSON/代码块、日期）；没有比例判 `skip` 并写 `protection-skip`（`reason=no-ratio-in-user-messages`），不再空泛 pass；能力探测加 `get.compaction(strict=false)`（`obj`=有 impl 未 active / `undefined`=本 scope 未提供 / 不支持=`unknown`）。
- 0.1.14：`batch-list` 改为**同消息绑定**——批次语义（`批次|进度|progress|batch`）与比例必须在同一条对话正文里，否则 `skip(no-batch-semantics)`；`YYYY/MM` 不算比例（`date-like-ratio`）；`stripStructuredPayload` 只剥像 JSON 的 `{…}`/`[…]`，正文 `{511/958}` 保留。判据原则：宁可 `skip` 不可 `fail`。
- 0.1.15：后端识别补**事件形态推断**——原生 free-form → host-basic (inferred)、五段式 → context-zip (inferred)、混合 → mixed (unverified)；只进 /cg status/审计展示，功能路径不读推断。
- 0.1.16：成本字段拆分——`backend`/`backendKind` 只写枚举（`host-basic`/`context-zip`/`unknown`，不含括号/空格），展示串移到 `backendLabel`，推断补位由 `backendInferred` 标记，`auditVersion=cost-v1.4`；`/cg status` 用 `backend-label=`；包内文本文件禁止控制字符（有测试闸）。0.1.17：`backend`/`backendKind` 枚举补 `none`（实测 none 不折叠）；控制字符闸扩到仓库根（排除 `.tmp`/`node_modules`/`.git`）。
- 0.1.18：`/cg status` 改用 `backend-kind=`（实测 none 显示 none，与成本行一致；推断时另附 `backend-label=`）。注意 `adapter=` 是实测 kind，`backend-kind=` 是解析结果——无推断时相同、推断补位时不同；`backend=` 仍指宿主/后端版本。控制字符闸改用 `git ls-files` 只扫 tracked 文件。

## 策略层（M2 / 0.2.0）

**0.2.0 只做“什么时候压可控、压了值不值能算”的配置与状态层**：不提前压、不调用宿主引擎、不接管 provider（引擎接线是 0.2.1）。

- 合成顺序（低 → 高）：**内置 → profile 标签 → 插件配置 → 项目 `.cg-policy.json` → 会话 `/cg set`**；`/cg policy show` 逐键给出 `source`，`layers:` 链里空层标 `(empty)`。
- `compact.at` 是**占窗口比例**（默认 0.60），上限是动态 `native = floor(min(W×0.8, W−O−65536))/W`。**0.2.1 起默认取观测窗口 1,048,576 → 0.6934**；无观察时回退配置窗口 1,000,000 → 0.6785。`at > native` 拒绝并说明“M2 不支持推迟”。`at < 0.30` 需配置文件 `compact.lowThresholdAck=true`，否则回退内置值并记 `low-threshold-unacked`。
- `compact.early` 是**纯配置 `on|off`**（默认 on；`research` profile 默认 off）；“引擎通道是否可取到”留给 0.2.1 的 `early-channel`，0.2.0 没有任何引擎接线。
- 项目文件 `.cg-policy.json` 按**不可信输入**处理（`DEC-20261025-62` A+C）：
  - 只允许项目内相对路径（绝对路径/`..` 拒绝），containment 复核（**词法层**，不解析 junction/symlink），>64KB 不读；
  - **禁** `compact.lowThresholdAck` / `compact.estimateSafety`（`project-denied`），`compact.at` 下限 **0.45**（`below-min`），上限 `native`；
  - 任一键被拒 → **整层拒绝**（不逐键降级）→ 退回下一层；`source=project` + 键 + 原因进 `policy-invalid` 审计，并在 `/cg status` 的 `policy-invalid:` 行可见；
  - **只在 `apply` 读一次**：改文件后需重启插件才生效。
- **窗口来源与校验（0.2.1）**：`current` = `#lastSession` 的 `request/context.contextWindow`，`conservative = min(已观察窗口)`；`native` 每次用同一个 `W` 现算（`nativeFromWindow`），无观察回退配置并标 `config-fallback`；`request/context` 不带 `contextWindow` → **删除旧值置 unknown（不沿用）**；校验按 conservative，运行时 `at > native` → 拒绝该层 + `policy-invalid` 审计。**退化口径 A**（`W ≤ O+65536`）：`native=unknown (degenerate)`，禁造常数 0.6785，设置 `at` 的层一律拒绝（`native-uncomputable`），继承值标 `unverified-degenerate`，`W` 恢复后自动恢复。**本版不触发任何压缩**（`src/` 无 `compactNow`/`compactRegion` 调用）。
- 压力四段（只展示，不据此压缩）：`measured`（最近 `assistant/message.usage` 的 input+cacheRead+cacheWrite 占窗口）、`estimated`（`tokenMeter` 估算）、`adjusted = estimated × estimateSafety`、`effective = max(measured, adjusted)`；`ratio = measured/estimated` 用来判断估算是否偏低；行内带 `window=1M (session 58a2e845)`（分母 + 会话可见）。任一来源缺失写 `-`，不伪造。
- `/cg set <key>=<value>` / `/cg set reset`：写会话层（最高优先级）。只允许 `compact.at`/`compact.early`/`compact.cooldownMin`/`compact.minDeltaTokens`/`cost.remainingTurns`；`estimateSafety`/`lowThresholdAck` 明确拒绝（只能改配置文件）。覆盖是**进程内**的，重启即失效。

样例输出（带 fixture 头）见 `../../analysis/req-20261025-09/samples-0.2.1.txt`（**示意/裁剪，非实跑**）；完整口径见 `../../docs/T5-状态命令与审计.md` §1.1–§1.5。

**命令可用性（与使用说明 v0.3 一致）**：0.2.x 目前只有 `/cg status` / `/cg policy show` / `/cg set`；`/cg compact now` 计划 0.2.2（提前压执行）、`/cg cost` 计划 0.2.3——当前对未知参数只返回 usage，不假装执行。

## 配置（bundle patch）

```yaml
config:
  projectRoot: "D:/DS-PROJECT/DSH插件开发"
  memoryRoot: "memory/governance"     # 相对 projectRoot
  project: "DSH插件开发"
  compression:
    enabled: true
    hostVersion: ""                   # 空 = 自动探测
    backendVersion: ""                # 空 = 运行时识别，版本标 unknown
  diagnostics:
    logFile: "D:/DS-PROJECT/DSH插件开发/logs/governance.log"
  audit:
    maxBytes: 8388608                 # 8 MiB 后轮转 audit-YYYYMMDD.jsonl
  reinjection:
    maxFailures: 3                    # 连续回注失败阈值（1–20）
  memoryHeader:
    enabled: true                     # M3 T2（0.3.1）：新会话 header 默认开；/cg header off 或此键可关
    maxLines: 8                       # ≤8 行；配额 todo2/progress2/decision2/anchor1/preference1
    maxChars: 800
    oldAgeDays: 14                    # >14 天仍注入，标 [Old] 排末尾
    oldLimit: 30                      # 旧条目上限
  policy:                             # M2 / 0.2.0 策略层
    profile: ""                       # batch | coding | research | review（空 = 不打标）
    windowTokens: 1000000             # 窗口；native 上限据此计算
    reservedTokens: 256000            # 输出预留；native = floor(min(W*0.8, W-O-65536))/W
    projectFile: ".cg-policy.json"    # 只允许项目内相对路径；>64KB 不读
    values: {}                        # 插件层（最高配置优先级，低于会话 /cg set）
    # 例：values: {"compact.at": 0.58, "compact.early": false}
```

配置非法 → 插件不加载（DSH 继续默认行为）。`compression.enabled=false` 时只注册记忆工具，不订阅压缩事件。

## 存储布局

```
<projectRoot>/<memoryRoot>/
├─ MEMORY.md      派生索引（一行一条，不手改；手改会在下次写入时被覆盖）
├─ .writer.json   进程间写者锁
├─ audit.jsonl    审计（T4 起；只写元数据，不写正文）
├─ protection/    压缩前同步落盘的保护 journal（物化成功后清理）
└─ topics/*.md    每种类型一个主题文件，条目块可人工编辑
```

## 自测

```powershell
cd packages/dsh-context-governance
node --test "test/*.test.mjs"
```

运行 `node --test "test/*.test.mjs"`；**全部通过**（数量以输出为准）。覆盖字段/状态/并发/外部修改/锁/损坏/敏感信息/工具/宿主 schema 子集/适配器/保护/运行时/项目归属/隐私开关/固化/回注/审计/轮转/只读/能力探测/S1–S6/真实自动+手动序列回放/版本单一来源，以及 0.2.0 策略链（四层来源、项目层整层拒绝、路径/大小闸、压力四段、`/cg set` 覆盖与回滚、经 apply 的集成）。

## 设计约束（与架构一致）

- 回注只放 `ID + 状态 + 指针`；未覆盖时最多补一行标题；详情永不回注（E2）。
- 进程内单写者队列；跨进程只做检测与只读，不承诺合并。
- 原子写（临时文件 + rename），覆盖前留一代 `.bak`。
- 不写凭据；命中常见凭据形态直接拒绝。
- 不替换压缩 provider；不自动切换后端；降级只改变治理层自身行为并显式报告。







