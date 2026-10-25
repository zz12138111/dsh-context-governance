# dsh-context-governance

上下文治理插件（DSH / DeepSeek Harness）。M1 目标：**压缩前后不断线**——任务态记忆落项目文件，压缩后只回注 ID/状态/指针，详情按需取。

> 版本：**以 `package.json` 为唯一来源**（本文与代码都不再重复版本号；启动行/审计里的 version 由运行时读取）。
> 当前进度：**T2–T8 离线完成**——记忆文件与契约、`mem_write`/`mem_query`、压缩适配与保护校验、压缩前固化与回注、`/cg status` 与审计正式化、故障注入/轮转/只读降级、S1–S6 验收场景 + 真实自动/手动压缩双样本回放 + 回注自愈 + 成本归属审计（T8）；**全部测试通过（数量见 `node --test` 输出）**。
> 真机：已安装（junction 指向源码目录）；最近一次真机验证记录见 `memory/ARTIFACTS.md`，待验收项见 `STATUS.md`（本文不写具体版本/数字）。S3 新会话 header 默认关闭，需用户拍板后再开。
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
│  ├─ commands/cg-status.js    `/cg status`
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
  memoryHeader:
    enabled: false                    # S3：新会话注入偏好/决定 header（opt-in，默认关）
    maxEntries: 5
    maxChars: 600
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

运行 `node --test "test/*.test.mjs"`；**全部通过**（数量以输出为准）。覆盖字段/状态/并发/外部修改/锁/损坏/敏感信息/工具/宿主 schema 子集/适配器/保护/运行时/项目归属/隐私开关/固化/回注/审计/轮转/只读/能力探测/S1–S6/真实自动+手动序列回放/版本单一来源。

## 设计约束（与架构一致）

- 回注只放 `ID + 状态 + 指针`；未覆盖时最多补一行标题；详情永不回注（E2）。
- 进程内单写者队列；跨进程只做检测与只读，不承诺合并。
- 原子写（临时文件 + rename），覆盖前留一代 `.bak`。
- 不写凭据；命中常见凭据形态直接拒绝。
- 不替换压缩 provider；不自动切换后端；降级只改变治理层自身行为并显式报告。







