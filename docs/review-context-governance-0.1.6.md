# 复核报告（第二轮）· `dsh-context-governance` v0.1.6

> 复核方：审核打包。**技术结论由本报告给出**（源码/schema/契约/版本一致性/回滚可执行性/P1-P2-P3 判定）；
> 用户验收只看交付物与体验，不由本报告替代。本轮**未改代码、未 push、未装、未重启**。
> 对象：分支 `feat/context-governance-m1`，**HEAD `3cb6177`（v0.1.6），工作区干净**。
> 运行态对应关系：真机进程 **pid 32544**（启动 19:14:52），源码 mtime 全部 ≤ 19:12:51（早于启动），HEAD 提交时间 19:15:39 —— **运行中的代码与 HEAD 同内容**，可对照。
> 宿主：DSH Desktop 0.2.1-rc.3（asar）/ profile desktop（deps 14 / bundles 17 / redirect `0.1.0-context-zip`）。
> 基线：第一轮报告 `docs/review-context-governance-0.1.3.md`（钉在 `cdf178b`）。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| **P1（工具未注册，运行期）** | **已修**。四条判据全部通过（§1） |
| **P1（发布/入库，新发现）** | **1 条未修**：回放 fixture 脱敏不完整，含真实会话 id 与可还原的对话/工具参数（§3 SEC-05）。**push/GitHub 前必须修** |
| P2-1 跨会话写入过滤 | **已修**（含 3 条残留口径，§2.1） |
| P2-2 隐私口径 + captureTitle | **已修**（默认仍保留首行，属设计，需用户知悉） |
| P2-3 Runbook §6 回滚 | **部分修**（主体已改；3 处小缺口，§2.3） |
| P2-4 版本单一来源 | **已修** |
| 其余 P2 | REQ-01 部分修（opt-in）；REQ-02/03、ROB-01/06、ROB-02 保留；其中 **REQ-02 的保留理由不成立**（§4） |
| P3 | “已改”11 行属实；**保留清单里的 ROB-10 未兑现**；“保留”实为 **16 行**（00 消息里的“12 条”与文档不符），逐条判定见 §4 |
| 测试 | **159/159 通过**（含 P1 schema 契约 5 条、P2 归属/隐私 5 条） |
| 剩余验证 | 真实压缩（必须在本项目会话里触发）、`/cg status`、只读演练、S3 opt-in（§5） |

**阻断项数：1**（仅“发布/入库”口径 —— fixture 数据卫生；**M1 运行期已无阻断**）。

---

## 1. P1 复验：`mem_write` / `mem_query` 是否真的可用

判据按第一轮约定，四条逐一给证据：

### 1.1 schema 形状（源码 + 独立校验）
- `src/tools/mem-tools.js:42-105`（`writeParameters`）、`:107-134`（`queryParameters`）：标准 JSON Schema，`type:'object'`、`additionalProperties:false`、必填走**顶层 `required` 数组**（`['op']` / `[]`），属性里无 `required`。
- `src/tools/mem-tools.js:208-219`、`:242-264`：`output.schema` 同样是标准 JSON Schema（顶层 `required: ['id','status','type','title']` / `['count','entries']`）。
- 全 `src/` 中 `required: true` 仅出现在**注释**（`:7`、`:39`），非注释代码为 0 —— 与 00 的更正一致。
- **独立校验**：我用从宿主 asar 复刻的 `checkSchemaNode` 规则（不依赖开发者的 `test/host-schema-contract.mjs`）跑两个工具：
  - `mem_write`：parameters PASS / output PASS；
  - `mem_query`：parameters PASS / output PASS。
  （脚本 `.tmp/schema-check.mjs`，规则逐行取自 `app.asar/.../dsh-tools/lib/index.js`。）

### 1.2 契约测试是否真能“旧形状打红”
- `test/host-schema-contract.mjs:14-188`：复刻宿主白名单/`required` 规则，并提供 `assertToolDefinition`（`:176-188`）。
- `test/tools-schema.test.mjs:29-116`：两个工具 parameters/output 过子集、必填只在顶层、注册成功、**旧 spec 形状被拒**（`:82-107`）、失败原因可见（`:109-116`）。
- **变异测试**（我做的，不依赖其测试）：把 `cdf178b` 的旧 `mem-tools.js` 定义喂给新契约的 `assertToolDefinition` —— `mem_write`/`mem_query` **均被拒**：
  - `schema.properties.id.required is not supported on type "string"`
  - `schema.properties.count.required is not supported on type "integer"`
  → 护栏有效。
- 小注：契约副本用 `isRecord/Array.isArray`，宿主用更严的 `isJsonSchemaRecord/isPlainJsonArray`（拒绝稀疏数组/怪异原型）。对本插件的纯 JSON schema 无差异；若宿主升级子集需同步（文档已注明）。

### 1.3 真机判据（我自己下的结论，不用转述）
- **00 会话**（`--G-DS-HARNESS--/session-53ece2c2…`）：
  - 重启前最后一个 `request/header`：seq 32683，`t=2026-10-25T10:54:06Z`，**tools=90**，无 `mem_*`；
  - 重启后第一个 header：seq 32824，`t=2026-10-25T11:15:56Z`，**tools=92**，`mem_write=YES mem_query=YES`；
  - 集合 diff：**added = mem_query, mem_write；removed = 空**。即 90 → 92（+2），与 00 的观察一致。
- **本工作区两个会话**（独立样本）：
  - `session-58a2e845…`：seq 5166（10:56:28Z）tools=90 → seq 7011（11:15:24Z）tools=92，added 同上；
  - `session-5d1121ed…`：最新 header tools=92，`mem_*` 在列。
- 模型侧 schema（从 header 原文导出，不是看日志）：
  - `mem_write.parameters = {"type":"object","additionalProperties":false,"properties":{…13 个…},"required":["op"]}`，**属性级 required 全 false**；
  - `mem_query.parameters` 同形，`required: []`。
- 我**自己的工具面**也收到了这两个工具（参数同上），说明注册与投影对任何会话生效。
- 审计/日志一致性：`memory/governance/audit.jsonl` 第 2 行 `version:"0.1.6"`、`event:"apply"`、`readOnly:false`；`logs/governance.log` 19:14:54（+08）`apply version=0.1.6 pid=32544 … perception=event event-api=on`。**该 version 由 `readPackageVersion()` 从 package.json 读出**（见 §2.4），不再是手写常量。

### 1.4 端到端（写→读）
- 00 的冒烟条目已在记忆库：`memory/governance/topics/fact.md`、`MEMORY.md` 第 6 行 `MEM-20261025-001 · proposed · fact · context-governance 0.1.6 真机加载成功（event-level）`。
- 我用 `mem_query({ids:["MEM-20261025-001"]})` **实际读回**该条（proposed、detail 完整）—— 注册成功不只是“出现在清单里”，执行链路也通。

**P1 判定：已修（运行期阻断清零）。** 剩余风险不在代码：真实压缩尚未发生，保护/回注链路仍待 §5 V1。

---

## 2. P2 四项逐项

### 2.1 P2-1 跨会话写入过滤 —— **已修**

**实现**：`src/index.js:49-52`（`onlyProject` 默认 true）、`:119`（类型校验）、`:245-247`（传入 guard）；`src/compress/runtime.js:51-57`（`sameDirectory`：`path.resolve` + Windows 大小写不敏感）、`:131-133`（字段）、`:168-171`（`onlyProject` 仅在 projectRoot 非空时生效）、`:229-252`（`session.header.cwd` → 退回 `session.cwd`；cwd 缺失放行并计 `unattributedEvents`）、`:733-747`（`#handle` 入口过滤，外部会话首次 warn 一次）。
**宿主依据**：`session.header.cwd` 是真实字段（宿主 `dsh-session/lib/index.js:1415,1818-1822`，类型校验 `:1047-1049`），会话落盘记录里也有 `cwd`（本机 12 个样本全部可读）。
**测试**：`test/t7-p2.test.mjs:55-142`（外来 cwd 忽略、同 cwd 处理、cwd 未知计数、opt-out、配置校验）。
**我的独立验证**（`.tmp/verify-p2-1.mjs`，真 guard + 真 store）：
- 本会话 cwd（用小写盘符 + 正斜杠模拟大小写/分隔符差异）→ **处理**；
- `G:\DS-HARNESS` 会话 → **忽略**（`ignoredForeignEvents=1`、`ignoredForeignSessions=1`，warn 一次）；
- 无 cwd 会话 → 放行但 `unattributedEvents=1`。
结果与声明一致，且不写本记忆、不 pending。

**残留（口径，不阻断）**：
1. **验证口径要改**：00 自己的会话 cwd = `G:\DS-HARNESS`，在 `onlyProject=true` 下会被**忽略**。原计划“让用户触发一次压缩、开发抽样本看 audit”若在 00 会话或其它工作区做，将**看不到** `protection-write`。→ 必须在 `D:\DS-PROJECT\DSH插件开发` 工作区的会话里触发压缩（或经批准临时 `onlyProject:false`）。这是本轮最重要的验证修正。
2. cwd 恰为 projectRoot **子目录**的会话会被排除（精确比较，fail-closed）；文档未写这条，建议补一句。
3. cwd 缺失的旧会话仍放行（fail-open）并计数；可接受，但属“仍可能串项目”的残余面。
4. `#foreignSessions` 是只增集合（每个外部会话一条），长跑会缓慢增长；可忽略，或加 LRU。

### 2.2 P2-2 隐私口径 + `captureTitle` —— **已修**

**实现**：`src/compress/protection-memory.js:36-58`（`captureTitle=false` → 标题取 `fallback` 通用标签）、`src/compress/runtime.js:171,474-480`（配置透传）；`src/index.js:51-52,120,141-142`（默认 true + 校验）；`src/commands/cg-status.js:70-77`（`capture-title=on/off` 可见）。
**文档**：`packages/dsh-context-governance/README.md:12`（“保留最新用户消息首行 ≤200 字 + 路径/批次指针；`captureTitle:false` 可关”）、`:18-23`（隐私边界专节，明确“不是完整正文，也不是只知道 ID”）。
**测试**：`test/t7-p2.test.mjs:123-142`。
**我的独立验证**（`.tmp/verify-p2-2-4.mjs`）：
- 默认：`最新用户消息（敏感内容已省略）`（含 `sk-…` 的标题命中凭据形态被替换）、`规则在场：D:\work\AGENTS.md`；
- `captureTitle=false`：`最新用户消息` / `规则注入在场`，**不含**密钥/路径，`source` 指针保留（`session:s1#3`）。
**残留（设计，需用户知悉）**：默认 `captureTitle=true` **仍会把首行 ≤200 字**写进 journal/topics/MEMORY.md；要更保守得显式设 `captureTitle:false`。这与 README 现在的新口径一致，不再算“文档说谎”。

### 2.3 P2-3 Runbook §6 回滚 —— **部分修**

**已改（核对属实）**：`docs/插件安装升级-Runbook.md:220-291`
- 明确“只还原实际改过的内容”；manifest 只删本插件的 dependency/bundle（`:235-253`，Node 脚本按名删除，不整份覆盖）；
- `cordis.patch.yml`/`pnpm-lock.yaml` 默认**不还原**，仅 hash 不同时警告（`:272-279`）；
- junction 删除检查 `$LASTEXITCODE` 并断言链接消失（`:230-233`）；
- redirect 仅在版本 ≠ `0.1.0-context-zip` 时从备份恢复，恢复后断言（`:255-263`）；
- `.ignored` 两份副本的判据（优先备份、其次版本、再 mtime）（`:280`）；
- 备份保留 3 份 + 人工确认删除（`:281-285`）；回滚点写入 `memory/ARTIFACTS.md`（`:286-287`）；数据去留三处（`:289-291`）。

**三处小缺口（建议修，均 P3）**：
1. `:265` 注释写“本插件已从 manifest 消失”但**没有断言**：Node 脚本只打 `removed:`，无人检查 `dependencies`/`bundles` 里确实没有该名字。建议加 `if (JSON.stringify(manifest).includes('dsh-context-governance')) throw` 或检查计数。
2. `:255-257` 直接 `Get-Content (Join-Path $redirectDir 'package.json')`，目录/文件缺失时会先抛 `ItemNotFoundException`，而不是走“按 §6 处理”。建议先 `Test-Path`。
3. manifest 改写前没有 `.bak`（`:235-253` 直接写）。虽然 §3 有安装前备份，但回滚本身再留一份 `.bak` 更稳。

**未做的事**：本轮只读，**没有实跑** §6（需退出 DSH）；可执行性只做了静态核对。真跑建议隔离 profile 或先整体备份。

### 2.4 P2-4 版本单一来源 —— **已修**

**实现**：`src/diagnostics.js:15-25`：`readPackageVersion()` 用 `new URL('../package.json', import.meta.url)` 读并解析，失败降级 `unknown`；`PLUGIN_VERSION` 由它派生，启动行/能力行/审计全用它（`index.js:264`）。
**测试**：`test/t7-scenarios.test.mjs:424-428`（S7：`PLUGIN_VERSION === package.json.version`，且源码无 `PLUGIN_VERSION = '0.` 字面量）。
**独立验证**：`PLUGIN_VERSION="0.1.6"` = `package.json.version` = `readPackageVersion()`；`package.json:34` `engines.dsh` 已收窄为 `>=0.2.1-rc.2 <0.2.2-0`，与 `adapters.js:29` 矩阵一致。
**残留（P3 注释级）**：`diagnostics.js:43` 的示例仍写 `version=0.1.3`；`capabilities.js:2`、`runtime.js:217` 等注释带旧版本——历史说明，不影响运行。

---

## 3. 新问题（本轮发现）

### SEC-05 [**P1 · 发布/入库**] 回放 fixture 脱敏不完整：含真实会话 id 与可还原的对话/工具参数
- **证据**：
  - `test/fixtures/replay-compaction.json:29979` 含真实 `sessionId: session-58a2e845-cec5-4229-afa9-7f09a0fc0207`；
  - `test/fixtures/replay-compaction-manual.json:40251` 含 **00 会话 id** `session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6`（顶层 `fixture.sessionId` 虽是合成的 `session-t7-fixture`，但事件里的 `data.sessionId` 没洗）；
  - 两份 fixture 合计 **8227** 处中日韩字符；`data.stream[].args[]` 有 5589 个字符串片段、`data.stream[].texts[]` 7381 字符。把它们按顺序 join 可还原**完整句子/工具参数**，例如：
    - `"我已按计划实际运行了一次，完整流程与结果如下：…"`
    - `{"command": "Select-String -Path 'D:\\\\DS-PROJECT\\\\DSH插件开发\\\\…'"}`
    - 连 `G:\DS-HARNESS\memory\ARTIFACTS.md` 的内容片段、计划任务名都能拼回。
  - 原因：`analysis/t7/extract-replay-fixture.mjs:37-42` 的 `REDACT_KEYS` 没有 `args`、`texts`、`sessionId`；`redactDeep` 只按 key 白名单命中，token 数组整段漏过。
- **为什么之前的“脱敏校验”没发现**：`test/t7-replay.test.mjs:116-135` 只检查 **key 为 `text`** 的字符串，以及原文里**连续**出现的 `DS-PROJECT/19091/AGENTS.md`；token 数组既不是 `text` 键，也会把路径/中文拆碎，两个检查都绕过。`docs/T7-验收场景-S1-S6.md:35` 写的“人工 scan（CJK 泄漏=0）”与实际不符；`DECISIONS.md:134` 的“无正文/路径/会话 id”不成立。
- **影响**：该分支**尚未 push**，但已进 commit `3cb6177`；`package.json.files` 含 `test`，发布 zip/npm 包也会带上。含 00 与另一会话的真实对话/工具参数（含本机路径），属于用户数据入库。
- **建议修（P1，push 前）**：
  1. `REDACT_KEYS` 增加 `args`、`texts`、`sessionId`、`parentSession`、`callId`、`id`（或对 `stream` 整体只保留 `type/index/usage` 数字）；重新生成两份 fixture。
  2. `T7-R2` 改为：递归收集**所有字符串**，禁止 CJK、禁止 `[A-Za-z]:\\`、禁止 `session-<uuid>`，并断言 join 后也不出现敏感串；再加一条“token 数组必须被脱敏”的回归。
  3. 修后 `git diff` 里 fixture 只应剩 type/seq/time/usage/结构；必要时在 DEC-16/T7 文档里更正“无正文/路径/会话 id”的表述。

### OPS-01 [P2 · 验证口径] `onlyProject` 与 00 会话冲突（详见 §2.1 残留 1）
- 00 会话 cwd = `G:\DS-HARNESS` → 被新过滤忽略。**第一轮设计的“真实压缩验收”必须改在本项目工作区会话里做**，否则 audit 不会出现 `protection-write`，会被误判成“事件没到达”。
- 建议：验收清单里写死“在 `D:\DS-PROJECT\DSH插件开发` 工作区新建/使用会话 → `/compact`”。

### P3 新发现
| ID | 证据 | 说明 / 建议 |
|---|---|---|
| P3-01 | `STATUS.md:38,42`、`docs/插件安装升级-Runbook.md:3`、`docs/T7-只读降级人工验证.md:1,15` | 仍写 `0.1.5`：重启校验清单、Runbook 状态、只读脚本。改成“以 package.json 为准/当前版本”，避免用户按错版本核对。 |
| P3-02 | 本报告 §2.3 | Runbook 三处小缺口（manifest 断言、redirect Test-Path、回滚前 .bak）。 |
| P3-03 | `src/audit.js:188-198` | `#ensureFile` 把 `#sizeBytes` 置 0，即使文件已有内容（本机已有 0.1.3 行）；轮转会晚一个周期，不丢数据。可改为 `statSync` 真实大小。 |
| P3-04 | `src/compress/runtime.js:134,739-745` | `#foreignSessions` 只增不减；长跑可加 LRU（数量很小，低优先）。 |
| P3-05 | `test/host-schema-contract.mjs:21-27` | 副本比宿主宽松（普通数组 vs dense/plain 检查）；建议在文件头写明“宽松副本，宿主若变严需同步”，或直接用宿主规则抽包。 |
| P3-06 | `docs/T7-复核修复-0.1.6.md:81-102` | “保留”表实际 16 行（00 消息说 12 条）；建议文档给行数/编号，避免口径不一致。 |
| P3-07 | `DECISIONS.md:134`、`docs/T7-验收场景-S1-S6.md:35` | 脱敏声明与事实不符（见 SEC-05）；修完 fixture 后同步更正。 |

---

## 4. “保留”的 P3 逐条判定（开发者理由 → 我的结论）

> 说明：`docs/T7-复核修复-0.1.6.md:81-102` 的保留清单是 **16 行**（不是 12 条）。已改清单 11 行均核实；保留清单中 **ROB-10 未兑现**（见下）。

| # | 条目 | 开发理由（摘要） | 我的判定 | 建议 |
|---|---|---|---|---|
| 1 | SPEC-01 locale/icon | 发布规范，等打包定形态 | **成立**（属我打包阶段） | 发布前我补 locale/icon；M1 不要求 |
| 2 | SPEC-02 patch 绝对路径 | 本机安装配置，文档已注明 | **部分成立** | 本机可用；**发布版必须**改占位/覆盖层，否则每个安装者都写 `D:/DS-PROJECT/...`。归我处理 |
| 3 | SPEC-03 files/main | 打包细节，归审核 | **成立**（我的活） | 发布 zip 时收紧 `files` |
| 4 | SPEC-04 无 Config | 引 schemastery 与零依赖冲突；非法配置=不加载已满足 S6 | **成立**（宿主 Config 需要 `schemastery`，外部插件在 asar 下不可解析） | 保留；README 字段表已够 |
| 5 | SPEC-05 `commands` 硬 inject | “缺 commands 时已降级为 warn” | **理由不成立**：`inject` 缺服务时插件**根本不 apply**（cordis inactive），不会走到 `registerStatusCommand` 的 warn；只有“服务在但 register 抛错”才 warn | 改文档措辞，或把 `commands` 移出 inject、用现有 `ctx.get('commands')` 探测后可选注册（代码已具备降级返回） |
| 6 | SEC-02 `reason` 落 Error.message | 已有白名单 + 8 类脱敏 | **成立**（可延后） | 后续把 `reason` 收紧为 `code` + 短因，别直接落 message |
| 7 | SEC-03 memoryRoot 可越界 | 本地可信；硬断言破坏自定义路径 | **部分不成立** | 建议“越界只 warn（不阻断）+ 显式 `allowOutsideRoot`”，成本低，兼顾自定义路径 |
| 8 | ROB-01/06 回注失败永久停写 | 属 P2 但不在本轮四项，留专项 | **程序上成立，但应升级处理** | 这是 S4=B 核心：一次 `session.append` 瞬时失败会永久关掉**后续所有**压缩的保护预写（`runtime.js:457-465`）。建议 T8 第一项：只关注入、保留预写，下一周期可恢复；并在 STATUS“已知偏差”记账 |
| 9 | ROB-02 同 pid 锁冲突 | HMR 需实例 token，影响面大 | **成立（可延后）** | 但 Runbook 升级步骤应明说“改源码后重启，不要依赖 HMR 重载”，否则用户会看到 `memory-readonly` 不知所措 |
| 10 | ROB-05 全量 surface 扫描 | 压缩低频，sessionProjections 属 M1.1 | **成立** | 保留 |
| 11 | ROB-09 保护条目无 TTL | 需用户/需求拍板 | **成立** | 需一条用户决策：TTL/合并/保留原样 |
| 12 | ROB-10 索引可手改 | “文档已写不要手改，补一句‘手改会被覆盖’即可” | **未兑现**：README:99/记忆契约:21 只有“不要手改/不手改”，**没有**“手改会被覆盖”；该句并未补上 | 补一句即可（P3，成本最低） |
| 13 | ROB-11 空 projectRoot 回退 cwd | 改行为影响现有安装；文档已写必须配 | **部分不成立** | 桌面版 `process.cwd()` 是安装目录，静默写错地方；建议空值时**只 warn**（不改行为），让用户知道 |
| 14 | REQ-02 成本归属/被吞审计 | “需求未定义口径，M1 未列” | **理由不成立**：`REQUIREMENTS.md:44`（验收⑦）明确列了“成本归属”“回注被吞/重复、失败”；M1 未实现可以，但不能说“M1 未列” | 要么补实现（至少 `reinjection-shadowed` 审计），要么让需求/用户**明确降级**并改需求单；不能静默保留 |
| 15 | REQ-03 记忆写失败重试一次 | “重试一次后跳过压缩需需求确认语义” | **部分成立**：需求⑥的“跳过本次压缩”在 M1 边界内**不可实现**（治理层无 veto）；但“重试一次”本身可实现 | 实现“重试一次”，并把需求⑥改成“重试一次 → 仍失败则只读/告警”；不要拿“跳过压缩”当整条不做的理由 |
| 16 | REQ-01 S3 header | 已实现但默认关闭，需用户拍板 | **成立** | 功能已实现（`src/memory/header.js`，默认 `enabled:false`）；开/不开是用户决策，不是代码问题 |

**“已改”11 行抽查**：COMPAT-02/03/05/06、ROB-03/04、ROB-08、RB-02..06、VER-02 均属实（我逐条对了源码/文档/测试）。其中 ROB-07 由 P1 契约测试覆盖成立；ROB-10 不在已改清单内（在保留清单，见上）。

---

## 5. 剩余验证项（需要真机/用户；我不做重启与安装）

| # | 验证项 | 要点 | 谁做 |
|---|---|---|---|
| V1 | **真实压缩**（本项目会话） | 必须在 cwd=`D:\DS-PROJECT\DSH插件开发` 的会话里 `/compact`（00 的 G 盘会话会被 onlyProject 忽略）；预期 audit 出现 `protection-write`、`protection-materialized`、`reinjection`，`/cg status` 的 `events>0` | 用户触发，我/开发看证据 |
| V2 | `/cg status` | 检查 `scope: … only-project=on capture-title=on ignored-foreign=…`、`events=N`、`audit: … rotations=…`、`protection: read-only=`。只读命令 | 用户 |
| V3 | 只读降级演练 | 按 `docs/T7-只读降级人工验证.md`：deny `memory\governance` → 压缩不阻断、`read-only=` 出现 → 恢复后写入回来 | 用户 |
| V4 | S3 header | 用户拍板后把 `memoryHeader.enabled` 打开一次，观察新会话第一步是否出现 header（默认关，不改行为） | 用户决策 |
| V5 | fixture 修复后重跑 | SEC-05 修完 → `node --test` + 重新生成的两份 fixture 人工抽查（CJK/路径/session id 均 0） | 开发修，我复核 |
| V6 | 发布包检查 | locale/icon、patch 占位、`files` 收紧、zip 结构、README 安装步骤 | 我（打包阶段） |

---

## 6. 证据与复现

- **代码/快照**：HEAD `3cb6177`；工作区干净；运行进程 pid 32544（源码 mtime ≤19:12:51 < 启动 19:14:52）。
- **测试**：`cd packages/dsh-context-governance && node --test "test/*.test.mjs"` → **159 pass / 0 fail**；定向：`node --test test/tools-schema.test.mjs test/t7-p2.test.mjs` → 10/10。
- **真机**：
  - `logs/governance.log:3-4`（0.1.6 capability/apply，19:14:54 +08，host=0.2.1-rc.3）；
  - `memory/governance/audit.jsonl` 2 行（0.1.3/0.1.6 apply，后者 `readOnly:false`）；
  - 会话 header：`--G-DS-HARNESS--/session-53ece2c2…` seq 32683(90) → 32824(92, +mem_query+mem_write)；`--D-DS-PROJECT-DSH~63D2~4EF6…/session-58a2e845…` seq 5166(90) → 7011(92)；
  - `mem_query({ids:["MEM-20261025-001"]})` 读回 00 的冒烟条目。
- **独立脚本**（`.tmp/`，不入库）：`verify-p2-1.mjs`（归属过滤）、`verify-p2-2-4.mjs`（captureTitle/版本）、`schema-check.mjs`（宿主规则副本校验）、`scan-headers*.mjs` / `diff-headers.mjs`（会话 header）、`fixture-cjk.mjs`（fixture 泄漏统计）。
- **宿主源码依据（只读 asar 提取）**：`dsh-tools/lib/index.js:838-871`（defineTool 编译 spec）、`:2974-2983`（register 校验）、`:323-327`（assertSupportedJsonSchema）、`:241-260`（required 只能 object）、`:3135-3144`（schemaOf 直通 parameters）；`dsh-session/lib/index.js:1415,1818-1822`（header.cwd）。

---

**复核结论一句话**：0.1.6 的 P1 在代码、测试、真机 header、端到端读写四个层面都已修复，P2 四项里 3 项已修、Runbook 部分修；**唯一阻断是 fixture 数据卫生（发布前必须重做脱敏）**；P3 保留清单中有 3 条理由不成立/未兑现（SPEC-05、ROB-10、REQ-02），另有 3 条部分成立（SEC-03、ROB-11、REQ-03）。

**复核方**：审核打包 · cs_DNciCVhuZD · 2026-10-25 19:2x（+08:00）
