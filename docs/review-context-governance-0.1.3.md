# 复核报告 · `dsh-context-governance` v0.1.3（M1 · T1–T5）

> 复核方：审核打包（独立复核）。**本报告只出证据与问题清单，不构成验收结论**；验收归用户。
> 复核对象：`packages/dsh-context-governance`，分支 `feat/context-governance-m1`，**commit `cdf178b`（v0.1.3）**。
> 固定快照：复核期间开发正在改工作区（T6/T7 未提交），本报告一律引用 HEAD 快照，导出见 `.tmp/snapshot/rev/`（`.tmp/` 不入库）。
> 宿主：DSH Desktop **0.2.1-rc.3**（asar，`C:\Users\19091\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`），profile `desktop`（deps 14 / bundles 17 / redirect `0.1.0-context-zip` / junction 存在）。
> 方法：静态阅读 + 宿主 asar 只读提取（`.tmp/host/`）+ 运行期只读证据（`logs/governance.log`、`memory/governance/audit.jsonl`、会话 `request/header`）+ 在快照上跑测试。
> 未做：未改代码、未装/升/卸、未重启 DSH、未 push、未触发真实压缩。

---

## 0. 结论摘要（不是验收结论）

| 级别 | 数量 | 含义 |
|---|---|---|
| **P1 阻断** | **1** | 真机功能缺失：`mem_write` / `mem_query` 实际未注册成功 |
| P2 重要 | 13 | 正确性/口径/发布规范，需开发修或用户拍板 |
| P3 建议 | 23 | 健壮性、文档、可维护性 |
| 验证项 | 8 | 只在真机才能确认（需重启/真实压缩/回滚演练），见 §8 |

**P1 一条（最需要用户知道）**：插件 `apply` 成功、审计有 `apply` 行，但 **`mem_write`/`mem_query` 在真机没有出现在模型工具清单里**（当前进程 18:52 起，18:53 之后新会话的 `request/header` 只有 91/90 个工具，无 `mem_*`），原因是两个工具的输出 schema 用了 `required: true` 这种“spec 形状”，被宿主注册器 `ctx.tools.register()` 的 JSON Schema 子集校验直接拒绝，插件把异常吞成 warn。**因此 M1 验收标准②（模型调用记忆写入工具）在真机目前不可用**；源码侧已复现该异常（§2 COMPAT-01）。

---

## 1. 规范（包结构 / 入口 / manifest / patch）

### SPEC-01 [P2] 缺 `locale/*.json` 与 `icon`，插件清单没有标题/描述/图标
- **证据**：`packages/dsh-context-governance/package.json:9-23`（exports/files 无 `./locale/*.json`、`./icon`，目录无 `locale/`、无图标文件）。
- **依据**：宿主自带的插件开发规范 `app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:29-55` 要求 `meta.title`/`meta.description` + 图标，并随包导出。
- **影响**：Plugin Manager 与“设置→插件”里显示回退文案（包名）与通用图标；本地自用无碍，**发 GitHub / 他人安装时不完整**。
- **建议**：补 `locale/zh.json`、`locale/en.json`（`meta.title/description`）与 64–128px 图标（原创或许可证允许），加进 `exports`/`files`。

### SPEC-02 [P2] 包内 `cordis.patch.yml` 写死本机绝对路径
- **证据**：`cordis.patch.yml:15`（`projectRoot: "D:/DS-PROJECT/DSH插件开发"`）、`:16`（`memoryRoot: "memory/governance"`）、`:26`（`diagnostics.logFile: "D:/DS-PROJECT/DSH插件开发/logs/governance.log"`）；`README.md:66-77` 同文。
- **影响**：作为发布包被他人安装时，记忆与诊断日志会指向一个在本机才存在的路径（不存在则被创建），属于“本机安装配置混进分发包”。
- **建议**：发布版 patch 里 `projectRoot`/`logFile` 留空（空串走 `process.cwd()` / 关闭诊断），README 用占位符；本机安装另放 profile 覆盖层或安装脚本，不要把 00 的绝对路径打进包。

### SPEC-03 [P3] `files` 含 `test`，`main` 与 `exports["."]` 重复
- **证据**：`package.json:8`、`:18-23`（`files` 含 `test`），`src` 代码量约 200 KB，`test` 约 150 KB。
- **影响**：发布 zip 体积与内容噪声；不影响运行。
- **建议**：发布 `files` 改为 `["src","README.md","cordis.patch.yml","locale/*.json","icon"]`；`main` 可保留（兼容旧解析）或删除。

### SPEC-04 [P3] 无宿主 `Config` 导出，配置非法即整插件不加载
- **证据**：`src/index.js:27-98`（手写 `DEFAULT_CONFIG`/`resolveConfig`，非法抛 `MemoryStoreError('CONFIG', …)`）；无 `export const Config`。
- **依据**：`host-plugin.md:57-64`（“Host plugin export forms”一节）建议用 `Config` 让宿主校验并暴露表单；当前做法符合需求单⑥“配置非法→插件不加载、DSH 正常”，但不是宿主推荐路径，用户也无法在 UI 里看到字段说明。
- **建议**：M1 可保留；发布前若想降低“改错 config 就完全不加载”的惊吓，补 `Config`（Schemastery）或在 README 给出每个字段的类型/范围（现 README 只列默认值）。

### SPEC-05 [P3] `inject=['tools','commands']` 中 `commands` 是“只为 /cg status”的硬门
- **证据**：`src/index.js:25`；`src/commands/cg-status.js:128-144` 用 `ctx.get('commands')`；cordis `inject` 无 optional 形态（`app.asar/.../cordis/lib/index.js:1483-1501,1596-1635`），服务缺失时插件保持 inactive。
- **影响**：在**没有命令面**的部署（例如纯 headless CLI profile）里，插件整体不加载，连记忆工具都失去；`commands` 实际只是 `/cg status` 需要。
- **建议**：保持现状可以接受（宿主 `references/practices.md:20` 明确建议把可选服务放 `inject` 让插件 inactive 而非抛错），但请在 README 写明“本插件要求 tools+commands 两个服务”；若想更宽，改成只 `inject: ['tools']`、`/cg status` 用 `ctx.get('commands')` 探测可选注册（`registerStatusCommand` 已经会降级返回 `registered:false`）。

### 规范正面结论
- 包结构干净：纯 ESM、零运行依赖、无 build、无 `node_modules`；`type: module`、`exports`、`private: true` 都对（`package.json:4-17`）。
- `cordis.patch.yml` 形式与宿主模板一致（`- insert: - id/name/config`，见模板 `templates/decoration/cordis.patch.yml:1-3`）；行 `id` 唯一，`name` 与包名一致。
- 入口导出形态合规：`export function apply(ctx, cfg)` + `export const inject` + `export const name`（`src/index.js:22-25,121`）；资源注册都挂在 `apply` 内，有 `ctx.effect` 清理（`:237-249`）。
- 无多余依赖：`dependencies`/`peerDependencies` 均无；宿主包只在注释里提到，**没有** import（`src/index.js:8-10` 的约束被遵守）。

---

## 2. 兼容（inject / 事件面 / 宿主 0.2.1-rc.3）

### COMPAT-01 [**P1 阻断**] `mem_write` / `mem_query` 真机未注册（输出 schema 被宿主拒绝）
- **现象（运行期）**：
  - `logs/governance.log:5`：`18:52:54 … apply version=0.1.3 … perception=event event-api=on audit=…` → 插件已 apply；
  - 但 18:53 之后的新会话 `request/header` 工具清单只有 **91 / 90** 个，**没有** `mem_write`/`mem_query`（证据：`~/.dsh/sessions/--D-DS-PROJECT-DSH~63D2~4EF6~5F00~53D1--/session-5d…/session.v4.jsonl.zstd`，seq 14 / 334）；
  - 对照：其它 profile 级插件工具（`cross_session_*`、`dsh_browser_*`）都在清单里 → 不是“profile 工具不可见”，是这两个注册失败。
- **根因（源码级已复现）**：
  - 插件用**裸定义**注册：`src/tools/mem-tools.js:274-287`（`ctx.tools.register(definition)`，`defineTool` 由 `rawConfig.defineTool` 注入，但 YAML 配置不可能带函数 → 实际恒为 identity，`src/index.js:128-131`）；
  - 输出 schema 写成 ParameterSchemaSpec 形状：`src/tools/mem-tools.js:196-199`、`:229-240`（属性里 `required: true`）；
  - 宿主 `ctx.tools.register()` 会对 `output.schema` 调 `assertSupportedJsonSchema`（`app.asar/.../dsh-tools/lib/index.js:2974-2983`），其子集规则规定 `required` 只能出现在 object 类型上（同文件 `:241-260`），且 `required` 必须是字符串数组（`:151-161`）；
  - 用宿主这几段规则对 HEAD 的两个工具实跑，得到：`schema.properties.id.required is not supported on type "string" | … | schema.properties.entries.required is not supported on type "array"`（`mem_write` 6 条、`mem_query` 6 条违规）→ `JsonSchemaError` → `registerMemoryTools` 逐工具 catch 成 warn（`src/tools/mem-tools.js:279-286`）→ 真机一个工具都没成。
- **附带问题（同一处修）**：`parameters` 也是 spec 形状，而宿主模型侧是把 `definition.parameters` **原样**当 JSON Schema 用（`dsh-tools/lib/index.js:3135-3144` `schemaOf` 直通；`wireSchemas` `:2932-2943`）；即便绕开 register，模型拿到的参数 schema 也不合法（`schema.op is not a supported keyword …`）。
- **建议**（任一，首选手写 JSON Schema）：
  1. 在 `mem-tools.js` 里手写标准 JSON Schema：`{type:'object', properties:{…}, required:['op'], additionalProperties:false}`，去掉属性里的 `required: true`；参数同样处理；`execute` 自己保留现成的参数校验兜底；
  2. 或宿主可解析时（本机 asar 下**不行**，见 COMPAT-02）`import { defineTool } from '@deepseek-ai/dsh-tools'` 用宿主编译；
  3. 修完加一条“宿主 schema 子集”契约测试（见 TEST-01）。
- **验证**：重启后新会话工具清单出现 `mem_write`/`mem_query`（验证项 V1）。

### COMPAT-02 [P3] `defineTool` 注入点不可实现，注释与实现不一致
- **证据**：`src/index.js:128-131`（`rawConfig.defineTool`）、`src/tools/mem-tools.js:5-6`（注释称“由 T3 的插件入口用 defineTool 包一层”）；`cordis.patch.yml:10-26` 的 config 来自 YAML，无法传函数。
- **影响**：宿主编译路径永远不会生效（也是 COMPAT-01 的近因）。
- **建议**：删掉这个注入参数，避免误导；若将来要接宿主编译，走真正的模块解析方案并记录在 DECISIONS。

### COMPAT-03 [P2] 两套版本区间不一致，宿主升到 0.2.2-rc.x 会“声明兼容、实际降级”
- **证据**：`package.json:34` `"dsh": ">=0.2.1-rc.2 <0.3.0-0"`；`src/compress/adapters.js:28-31` 宿主矩阵 `['>=0.2.1-rc.2 <0.2.2-0']`。
- **影响**：0.2.2-rc.1 时 `engines.dsh` 认为兼容，但自检 `host-version` 判 `fail` → `selectMode` 直接 `observe-only`（`src/compress/selection.js:114-127`），插件静默不干活；而 `engines` 只是声明，宿主并不强制，容易被读成“支持 0.2.x 全系”。
- **建议**：统一到同一区间（要么把 engines 收窄到 `<0.2.2-0`，要么把矩阵放宽并在自检里降级为 warn）；README 写明“已验证矩阵”。

### COMPAT-04 [P2] 跨会话/跨项目写入：监听所有会话，却只有一个固定项目记忆
- **证据**：`src/compress/runtime.js:203`（`ctx.on('session/event', (session, event) => this.#handle(session, event))`，**未按 session/workspace 过滤**）、`:316-368`（start 即写保护）、`:452-549`（end 后往该 session 回注）；项目与记忆根固定：`src/index.js:82-97`、`cordis.patch.yml:15-17`。
- **源码依据（事件可见性）**：`session/event` 由 Session 提交时发给所有“未被 scope 排除”的监听者（`app.asar/.../dsh-session/lib/index.js:1226-1229,1579-1592`），而 `dsh-scope` 的 carrier 对**没有 scope tag** 的监听者一律放行（`app.asar/.../dsh-scope/lib/index.js:327-338`）。插件挂在 profile 根，ctx 无 agent scope tag → **会收到所有会话（含子代理、其它工作区）的压缩事件**。
- **影响**：别的项目/会话压缩时，它的“最新用户消息首行、规则路径、批次数字”会被写进**本工作区**的 `memory/governance`（project 固定 `DSH插件开发`），本项目的记忆指针也会被回注进**那个会话**。单机单人风险可控，但违反“只碰本项目数据”的直觉，也让记忆库串味。
- **建议**：加一个归属判定：按 `session.header.cwd`/workspace 根与 `projectRoot` 比对，或配置 `sessions: { allow: [...] }`；至少提供 `onlyProject: true` 默认值并在 README 写明跨会话行为。若 M1 明确只服务“本工作区会话”，这是应修项（用户/需求拍板）。

### COMPAT-05 [P2] `classifySummaryText` 的可读性判定恒为 `readable`
- **证据**：`src/compress/adapters.js:299-310`，`:306` 为 `readability: headings >= 4 ? 'readable' : 'readable'`（两个分支相同）。
- **影响**：只要摘要非空就 `readable`，`degraded-summary-unreadable`/“只回注 ID+状态”路径（需求 S5）只剩“摘要为空”一种触发；如果 context-zip/宿主给出乱码式摘要，仍按可读处理，覆盖判断可能错。
- **建议**：明确 partial/unreadable 判定（例如乱码率、五段标题缺失数、长度阈值），或把该三元删掉并注释“非空即 readable（E1 实测）”以免误读。属 T3 遗留，建议 T6 一并收。

### COMPAT-06 [P3] `perception=event` 只证明“订阅挂上”，不证明“事件到达”
- **证据**：`src/compress/runtime.js:188-191`（`perception` 只看 `eventApi && started`）；`/cg status` 已提供 `events=N`（`src/commands/cg-status.js:20-26`，DEC-14 也这么说）。
- **影响**：启动行 `perception=event` 容易被读成“已经在看压缩”。实际重启后**尚未发生任何压缩**（见验证缺口 V2）。
- **建议**：文档/STATUS 统一口径“perception=订阅成功；events=N 才是到达证据”；`/cg status` 可以把 `events=0` 时显式标 `(no session/event observed yet)`。

### 兼容正面结论（有源码依据）
- **`get.compaction=absent` 的根因已定位**，不是 token 拼写：`CompactionEngine extends Service` 以 `super(ctx,'compaction')` 提供（`app.asar/.../dsh-compaction/lib/index.js:169-173`），但 standard preset 把它放在 `cordis:group` 且 `isolate: {compaction: true}`（`app.asar/.../dsh-web-app/presets/standard.patch.yml:66-76`）；cordis 服务解析沿父链只在 isolate key 相同时可见（`cordis/lib/index.js:682-693`），`ctx.get()` 取不到就返回 `undefined`（`:755-772`）。所以 DEC-13 撤掉 `compaction` inject 的结论**成立**；事件级路线是当前唯一可行路径。
- **事件 API 可见性有源码依据**：宿主自带插件 `dsh-client-product-analytics` 的 `lib/index.js` 里就是 `ctx.on("session/event", …)` 并判 `event.type === "compaction/start"`（只读提取，`app.asar/dsh/node_modules/@deepseek-ai/dsh-client-product-analytics/lib/index.js`）；`compaction/start|summary|end` 由 `session.append()` 写入日志（`dsh-compaction-basic/lib/index.js:469,484,495,634`），`commit()` 再同步分发给监听者（`dsh-session/lib/index.js:1579-1592`）。
- **用到的 Session 面 API 都存在**：`session.surface`（`dsh-session/lib/index.js:1329`）、`surface.nodes`（`:561`）、`eventAt(seq)`（`:1439`）。
- **`user/message` 的 `source.kind` 自定义值可写入**：宿主只校验 kind 为非空字符串（`dsh-session/lib/types/index.js:247-295`，`assertMessageEventShape`），回注消息（`src/compress/runtime.js:641-656`）形状合法；`compact-checkpoint` 也确实是宿主 checkpoint 的 kind（`dsh-compaction/lib/index.js:109`）。
- **`/cg status` 的命令形状合规**：`definitionId/name/description/input.hint/handler(invocation.rawInput)→{kind,text}` 与宿主 `dsh-commands` 的 `normalizeDefinition/normalizeResult` 一致（`dsh-commands/lib/index.js:149-181,379-394`），`cg` 符合名字正则（`:78`）。
- **宿主版本探测可用**：`detectHostVersion` 首选 `resourcesPath/app.asar/dsh/package.json`（`src/compress/adapters.js:400-425`），实测该文件存在且为 `0.2.1-rc.3`，日志 `host=0.2.1-rc.3` 与之一致。

---

## 3. 安全边界（审计 / 记忆路径 / protection journal）

### SEC-01 [P2] `protection/<cycle>.json` **会含原文片段**（最新用户消息首行 ≤200 字），与“不复制正文”口径不一致
- **证据链**：
  - 快照取首行：`src/compress/protection.js:94-98`（`titleOfText` = 首个非空行、去空白、截 200）、`:190-192`（`latestUser.title`）；
  - 转成保护项：`src/compress/protection-memory.js:50-64`（`title = 最后用户消息：<首行>`，`source = session:<id>#<seq>`）；
  - 同步写 journal：`src/memory/store.js:290-358`（`journal.entries = [{id,title,type,status,project,writer,confidence,risk,…,detail:''}]`，`detail` 恒空，但 **title 有内容**）；
  - 物化进主题文件与索引：`src/memory/store.js:406-430`、`src/memory/entry-format.js:56-100`（title 落 `topics/*.md`）、`:236-264`（`MEMORY.md` 索引也带 title）；
  - 回注时还会把“未被摘要覆盖”的 title 放进上下文：`src/compress/runtime.js:487-505`（`formatPointer(entry,{includeTitle})`）。
- **边界实际有多严**：
  - 命中已知凭据形态会**拒写**（`src/memory/contract.js:61-79` 的 8 类正则 + `:128-138`、`:240-246` 抛 `SENSITIVE_CONTENT`）→ 保护写失败、audit 留痕（fail-closed），这点做得对；
  - 但**非已知形态的敏感内容**（明文密码、身份证/手机号、私聊内容、客户数据）不会被识别，会以 200 字首行落盘并长期留在记忆库/索引里。
- **影响**：这是“任务态记忆”的既定取舍（需求单写的是“标题+指针”），但 README/架构里的“不复制正文”“不存原始对话”表述过强，用户按字面理解会高估隐私边界；且 `MEMORY.md` 是给人看/可 git 的。
- **建议**：① 文档改成“只保留最新用户消息首行 ≤200 字 + 指针，其余正文不入库”；② 增加 `captureTitle: false`（或 `titleMaxChars: 0`）配置，默认仍开；③ 可选：对 title 再做一次“像凭据/像个人信息”的宽判（至少 `Bearer`、`password:` 中文变体、长数字串），命中则只写 `(已省略)`；④ 明确记忆库的清理/退出策略（见 RB-02）。

### SEC-02 [P3] 审计白名单本身是干净的（正面结论 + 一个残余）
- **证据**：白名单只有元数据字段（`src/audit.js:19-45`），**没有任何正文/标题字段**；所有 `append` 调用点只传 `sessionId/compactionId/manual/count/durationMs/ids/kinds/reason/code/moved/seq/failures/entries/status/mode/adapter/host/backend/version/perception/eventApi/omitted`（`src/index.js:195-204`；`src/compress/runtime.js:323-327,358-366,373-378,416-419,423-426,464-468,474-478,496-501,527-533,540-544,576-579`），全部命中白名单；未知字段会被丢弃（`src/audit.js:95-103`）。
- **运行期核对**：`memory/governance/audit.jsonl` 只有 1 行 `apply`，字段与白名单一致，无正文。
- **残余**：`reason` 是任意 `Error.message`（`runtime.js:377,425,543`），走 `redactText`（只认 8 类凭据形态、截 300）——宿主错误文案里若带路径/片段会原样入库；建议对 `reason` 也改成枚举短语（`code` 已有）+ 可选细节，不直接落 message。

### SEC-03 [P3] 记忆根没有“别越界”的约束
- **证据**：`src/index.js:85` `memoryRoot: path.resolve(projectRoot, memoryRoot)`；`src/memory/store.js:130` 同样直接 `path.resolve`，无“必须在 projectRoot 内”的断言。
- **影响**：配置写 `../../别处` 或绝对路径即可把记忆写到任意位置；配置属本地可信，但发布版用户误配的代价是“在别的项目目录里写文件”。
- **建议**：resolve 后断言 `isInside(projectRoot, memoryRoot)`，需要外部路径时显式 `allowOutsideRoot: true`；在 README 的配置表里写明。

### SEC-04 [P3] `project` 名不参与路径（正面），但写进每条记忆/锁文件
- **证据**：路径只用 `rootDir`（`src/memory/store.js:77-83,360-363`），`project` 只做隔离校验（`src/memory/entry-format.js:166-171`）与展示；`.writer.json` 含 `pid/project/startedAt`（`src/memory/lock.js:59-65`）。
- **结论**：不会因为 project 名里的 `../` 穿越路径（正面）；`project` 只出现在记忆文件与锁里，不敏感。

---

## 4. 回滚（Runbook §6 是否可执行、覆盖三处）

### RB-01 [P2] §6 覆盖了 junction / manifest / redirect，但“顺手还原”会覆盖未改动文件
- **证据**：`docs/插件安装升级-Runbook.md:232-238` 无条件把备份里的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 覆盖回 profile；而 §4 的安装步骤只改了 `package.json`（`:127-145`），`pnpm-lock.yaml`/`cordis.patch.yml` 从未被改（备份只是安全网）。
- **影响**：如果安装后到回滚前，用户/其它插件升级改过 `cordis.patch.yml` 或 lock，回滚会把它们一起退回旧版，属于“回滚成功但把别人的改动弄丢”。
- **建议**：回滚前先 `git`/hash 对比（或只在文件 `LastWriteTime`/hash 变化时还原）；`cordis.patch.yml` 明确“本插件不改它”，可不还原或在还原前提示 diff。
- **正面**：三处覆盖本身齐全——删 junction（`:228-230`）、还原 profile `package.json`（含 dependencies+bundles，`:233-235`）、恢复 `@deepseek-ai/dsh-compaction-basic` redirect（`:236-238`）；回滚前要求完整退出 DSH（`:220`），方向正确。

### RB-02 [P3] 备份目录：命名可排序，但无保留上限/清理，且“取最新”假设过强
- **证据**：备份名 `.backup-cg-<yyyyMMdd-HHmmss>`（`Runbook.md:72-73`）；回滚取“按名字倒序第一个”（`:224-226`）。
- **影响**：每次安装/升级都新增一份（含 redirect 整个目录），长期堆积、无清理说明；若同一秒两次、或手工改过目录名，倒序取到的未必是目标安装；回滚报告里也没有“本次备份 = 哪个来源版本”。
- **建议**：备份目录里写一份 `manifest.json`（时间、插件版本、profile 计数、被替换文件 hash）；保留最近 3 份并给出清理命令；回滚时可指定 `--backup <dir>`，不要只靠名字排序。

### RB-03 [P3] 删除 junction 不检查退出码
- **证据**：`Runbook.md:229-230` `if (Test-Path $link) { cmd /c rmdir "$link" }`，之后不再断言链接已消失。
- **影响**：链接被占用/权限不足时 `rmdir` 失败但脚本继续，DSH 重启后仍能解析到插件源码 → “回滚了但插件还在”。
- **建议**：`if ($LASTEXITCODE -ne 0) { throw … }`；回滚末尾断言 `-not (Test-Path $link)`。

### RB-04 [P3] `.ignored` 里有两份 redirect 副本，§7 未说明该用哪份
- **证据**：profile `node_modules\.ignored\@deepseek-ai\` 下同时存在 `dsh-compaction-basic` 与 `dsh-compaction-basic_1`（pnpm 事故遗留，两份内容都读得到）；`Runbook.md:260` 只说“按 cg-stub README 恢复”。
- **影响**：回滚/修复时若拿错副本，redirect 版本可能不对（当前正确值是 `0.1.0-context-zip`）。
- **建议**：Runbook 明确“以 `.backup-cg-*/dsh-compaction-basic` 为准，`.ignored` 只做二次来源”；并在恢复后用 `package.json` 的 `version` 断言 `0.1.0-context-zip`。

### RB-05 [P3] 回滚点没落到“可查的地方”
- **证据**：安装/回滚流程没有任何写 `memory/ARTIFACTS.md` 或 STATUS 的步骤；备份路径只在终端输出里。
- **影响**：隔几天回滚要靠翻会话记录找 `.backup-cg-*`。
- **建议**：安装成功后把“备份目录、插件版本、profile 前后计数”写进 `memory/ARTIFACTS.md`（开发写）或本次复核报告附录；回滚报告里也回填实际使用的备份路径。

### RB-06 [P3] 数据目录的“留/删”只有一句口头说明
- **证据**：`Runbook.md:250` “`memory\governance\` 属于数据，可保留也可移动到备份；不要删别人的项目记忆。”
- **影响**：卸载后记忆仍在项目里（可能被误提交/误以为是仓库内容）；若用户想彻底清理没有一步步的路径。
- **建议**：给出明确选项：保留（默认）→ 在 `.gitignore` 已挡 `memory/`？当前 `.gitignore` 只挡 `node_modules/dist/…`，**没有**挡 `memory/governance`（它是项目记忆，应该入库还是不入库？需要口径）；清除 → 列出确切的三个路径（`memory/governance`、`logs/governance.log`、profile 的 junction/.backup）。

---

## 5. 版本一致性

### VER-01 [P2] 版本号仍是“三处手写 + 测试硬编码”，审计里的 `version` 与包版本无绑定
- **证据**：
  - 源：`package.json:3` `"version": "0.1.3"`；
  - 常量：`src/diagnostics.js:11` `PLUGIN_VERSION = '0.1.3'`，被启动行/能力行/`apply` 审计使用（`:38,60`；`src/index.js:197`）；
  - 文档：`README.md:5` 仍写 **0.1.2**（`:7` 还写“v0.1.2 待重启验证”、`:99` “118 tests”）；`STATUS.md:21-23` 写 127 tests / T6/T7 未开工；
  - 测试：`test/perception-capabilities.test.mjs:91,153`、`test/compress-integration.test.mjs:146,148,175` 硬编码 `0.1.3`。
- **影响**：只要 `package.json` 与 `diagnostics.js` 有一处漏改，日志/审计里的 `version` 就会与包版本不一致（审计可复核性受损）；README/STATUS 已出现漂移（0.1.2 vs 0.1.3，118 vs 127 vs 实际工作区 136）。
- **建议**：以 `package.json` 为唯一源：`diagnostics.js` 用 `fs.readFileSync(new URL('../package.json', import.meta.url))`（或 `createRequire`）取版本并 export；测试改用该常量；README/STATUS 的版本与测试数由发布前脚本核对（或至少只写“见 package.json”）。
- **注**：`cordis.patch.yml` 不含版本字段，不需要改。

### VER-02 [P3] README/STATUS/Runbook 与实际状态漂移（细节）
- **证据**：
  - `README.md:8` “本包尚未装进任何 profile” —— 实际已装（junction + deps14/bundles17）；
  - `Runbook.md:4` 写宿主 `0.2.1-rc.2` —— 实际 `0.2.1-rc.3`（`logs/governance.log:5`）；
  - `Runbook.md:184-189` 的期望探针行写 `bus=absent,session=absent,…` —— 实际 0.1.3 日志是 `bus=throws,session=throws,…`（`logs/governance.log:4`）；
  - `STATUS.md:21` 127 tests 与 HEAD 一致，但 README 118、工作区 136（T6/T7 用例已出现），三处数字应统一或改成“见当前测试输出”。
- **建议**：发布前用一次“文档对账”把版本/测试数/宿主版本/安装状态统一；Runbook 的期望行改成从真实日志抄。

---

## 6. 需求/验收覆盖缺口（只列事实，等用户/需求定级）

### REQ-01 [P2] 验收①/S3“新会话/唤醒注入小 header”在 HEAD 代码里没有实现
- **证据**：全文搜索无 `session/created`、`agent/inject`、`inbox`、`systemPrompt` 相关调用（`src/**` 仅命中回注前缀字符串与文件头）；唯一的注入发生在 `compaction/end` 后（`src/compress/runtime.js:446-549`）。
- **影响**：需求单验收①“新会话/唤醒注入小 header（目标、待办、最近决定、关键约束）”与 T7 的 S3 目前会失败；M1 现状是“压缩后不断线”，不是“换会话也接上”。
- **建议**：需求/开发明确 S3 是 M1 内还是 M1.1；若要，最小实现是 `session/created` 时读 `memory/governance/MEMORY.md` 的 active 行做一次 header（仍有 token 预算与去重问题）。

### REQ-02 [P2] 验收⑦“成本归属”“回注被吞”审计未落地
- **证据**：`src/audit.js:48-61` 的事件清单无成本/token 字段（白名单也无）；`src/compress/runtime.js` 只在 `#hasCycleMessage` 做去重（`:436-444`），没有“上次回注的 seq 是否落进本次 `shadowedRange`”的审计；`memory/governance/audit.jsonl` 仅 apply。
- **影响**：需求单⑦/T5 任务表要求的“成本归属、回注被吞/重复、失败”目前只有“重复/失败”，成本与“被吞”缺失；`/cg status` 的 `events=N` 能间接看到达，但不能看被吞。
- **建议**：T6/T7 里补一条 `reinjection-shadowed`（回注 seq 与下次 `shadowedSeqs` 交集）+ 成本字段（若宿主能拿到 usage）；若不进 M1，请在 DECISIONS 记“延后到 M1.1”并同步需求单验收项。

### REQ-03 [P2] 需求⑥“记忆写失败重试一次”未实现（T6 在做，提醒验收时按新提交复看）
- **证据**：`src/compress/runtime.js:369-381` 失败即 audit + `degraded-protection`，无重试；`src/memory/store.js` 写入失败直接抛。
- **建议**：T6 落地后本报告相关段落需复核一次；本报告不对 T6 下结论。

---

## 7. 其他健壮性（P3）

| ID | 证据 | 问题 / 建议 |
|---|---|---|
| ROB-01 [P2] | `src/compress/runtime.js:286-294,321-329,452-459` | 一次回注失败会 `#disableReinjection` → 模式 `observe-only`，**同时**让后续压缩跳过保护写盘（`protection-write-skipped`）。等于一次瞬时失败（如宿主 `session append cannot reenter`）就永久关掉 S4=B 的预写；建议只关“回注”、保留下周期预写，或下次成功时恢复。 |
| ROB-02 [P2] | `src/memory/lock.js:51-72`；`src/index.js:237-249` | 写者锁把**同进程**的存活 pid 也当冲突 → 插件 HMR/重载时新 store 变只读，保护写盘全部失败（audit 有 failed，但不显眼）。建议锁里加进程内实例 token，允许同 pid 的“新实例替换旧实例”，或在 dispose 里确保先释放。 |
| ROB-03 [P3] | `src/index.js:243-249`；宿主 `cordis/lib/index.js` 无 `emit("dispose")`（asar 全文扫描 0 命中） | `ctx.on('dispose')` 兜底是死代码（cordis 没有该事件）；本机 `ctx.effect` 存在所以主路径 OK，但若将来换宿主/降级会漏清理（锁不释放）。建议删掉或换成 `ctx.effect` 不可用时的显式报错。 |
| ROB-04 [P3] | `src/commands/cg-status.js:76-84`；`src/audit.js:152-170` | `/cg status` 的 `recentFailures` 只读**进程内** ring buffer（≤200 条），重启后审计文件里的历史失败不可见；建议读 `audit.jsonl` 末尾几行或明示“本次进程”。 |
| ROB-05 [P3] | `src/compress/runtime.js:551-722`；宿主 `references/practices.md:26` | 每收到 `session/event` 都进 switch；每次压缩对**全部 surface nodes** 做快照/扫描（`snapshotProtection`），大 session（几千节点）是 O(n) 同步开销；治理层可改用 `sessionProjections`（宿主推荐）或只扫增量。当前压缩频率低，列为建议。 |
| ROB-06 [P3] | `src/compress/runtime.js:452-549` | 回注失败后无重试/无下周期恢复；`state.report` 只写一次。与 ROB-01 同源，修复时一并考虑。 |
| ROB-07 [P3] | `test/tools.test.mjs:85-100,118-131` | 工具注册测试用假 `ctx.tools.register`（只 push 名字），**不校验宿主 schema 子集**，因此 COMPAT-01 在 127/127 全绿下漏掉。建议把宿主 `assertSupportedJsonSchema` 的规则抽成测试内小校验器（或 fixtures），对两个工具的 `parameters/output.schema` 各断言一次。 |
| ROB-08 [P3] | `src/memory/entry-format.js:254` | `].join('\n');  const lines = [];` 同一行两个语句，风格瑕疵（不影响运行）。 |
| ROB-09 [P3] | `src/memory/store.js:124-173,290-358` | 保护 journal 每个 cycle 一份文件、物化后删除；但**物化后的条目永久保留**（每个压缩新增 1–5 条，无过期/归档策略）。长期使用会让 topics/MEMORY 膨胀（索引有 maxChars 截断，但条目本身和 memory 文件不会）。建议给保护条目一个 TTL/合并策略（或标 `expires`）。 |
| ROB-10 [P3] | `src/memory/store.js:452-485` | 外部修改检测覆盖 topics 与“意外出现的 `.md`”，但 `MEMORY.md` 本身不参与（可被手改后下次写覆盖）；文档应写明“索引是派生物，手改会被覆盖”。 |
| ROB-11 [P3] | `src/index.js:85` | `memoryRoot` 相对路径默认按 `projectRoot` 解析；`projectRoot` 为空时用 `process.cwd()`（宿主进程目录），在桌面版是安装目录，不是工作区——配置漏写 `projectRoot` 时会静默写到程序目录。建议空值时回退到 workspace 根或直接报错。 |

---

## 8. 验证项清单（给 00/用户；标注是否需要批准）

> 这些是“真机才能确认”的项，不是问题；按当前状态**尚未验证**。

| # | 验证项 | 前置/风险 | 建议执行人 |
|---|---|---|---|
| V1 | 修 COMPAT-01 后重启，新会话工具清单出现 `mem_write`/`mem_query`，能实际写读一条 | 需重启 DSH（用户批准）；写入会在 `memory/governance` 落文件 | 用户 + 开发 |
| V2 | 触发一次真实压缩（手动 `/compact`）→ `audit.jsonl` 出现 `protection-write`/`protection-materialized`/`reinjection`；`/cg status` 的 `events>0` | 压缩会改写该会话上下文（不可逆），建议用**测试会话**；需用户批准 | 用户 |
| V3 | `/cg status` 可执行且输出含 `event-api=on`、`events=N`、memory 计数 | 只读 | 用户/00 |
| V4 | 压缩后立刻看 `memory/governance/protection/*.json`：确认 `title` 是否含不希望落盘的片段；物化后看 `topics/`、`MEMORY.md` | 只读；决定是否要 SEC-01 的配置开关 | 00/用户 |
| V5 | `audit.jsonl` 逐行检查字段 ⊆ 白名单、无正文/凭据 | 只读 | 审核打包 |
| V6 | 插件热重载（改文件触发 HMR 或 profile patch）后看 `/cg status` 是否 `memory-readonly`（验证 ROB-02） | 可能改变运行状态；建议测试会话 | 开发/用户 |
| V7 | 回滚演练：装一份、回滚、核对 junction/manifest/bundles/redirect/check-env 全绿（验证 RB-01..05） | 需停 DSH+重启；在**隔离 profile**或先备份 | 用户 + 00 |
| V8 | 发布前：zip 解包结构、README 安装步骤、locale/icon（SPEC-01）、绝对路径（SPEC-02） | 只读静态检查 + 一次隔离安装 | 审核打包（下一轮） |

---

## 9. 复核对象与证据索引

- **代码快照**：`.tmp/snapshot/rev/packages/dsh-context-governance`（`git archive HEAD`，`cdf178b`）；报告所有 `文件:行` 均指此快照。
- **测试**：`cd .tmp/snapshot/rev/packages/dsh-context-governance && node --test "test/*.test.mjs"` → **127/127 pass**（HEAD）。工作区当前含 T6/T7 未提交改动时另行跑得 136/136 pass（**不在本报告结论内**）。
- **运行期**：
  - `logs/governance.log`（18:52:54 +08）——能力探测行 + apply 行，`host=0.2.1-rc.3`、`adapter=none`、`mode=event-level`、`perception=event`、`audit=…`；
  - `memory/governance/audit.jsonl`——仅 1 行 `apply`；
  - 会话头工具清单：`~/.dsh/sessions/--D-DS-PROJECT-DSH~63D2~4EF6~5F00~53D1--/session-5d1121ed-…`（seq 14：91 tools；seq 334：90 tools；无 `mem_*`）；
  - 压缩事件统计（重启后）：`compaction/start=0`、`summary=0`、`end=0`（全部 8 次发生在本次重启前）→ 事件到达未验证（V2）。
- **宿主源码（只读提取，`app.asar/dsh/node_modules/@deepseek-ai/…`）**：
  - `dsh-tools/lib/index.js`：`defineTool:838-871`、`register:2974-2983`、`assertSupportedJsonSchema:323-327`、schema 子集检查 `:163-315`、`schemaOf:3135-3144`、`wireSchemas:2932-2943`；
  - `dsh-compaction/lib/index.js:169-173`（Service 名 `compaction`）、`dsh-compaction-basic/lib/index.js:469,484,495,634`（三类 compaction 事件 append）；
  - `dsh-session/lib/index.js:1226-1240,1579-1592`（session/event 分发与逐监听者隔离）、`1329,1439,561`（surface/eventAt/nodes）；
  - `dsh-scope/lib/index.js:327-338`（carrier 准入规则：无 scope 标签的监听者全局放行）；
  - `cordis/lib/index.js:676-698`（未 inject 的服务读取抛错）、`755-772`（`ctx.get` 缺失返回 undefined）、`1306-1328`（inject 激活判定）；
  - `dsh-web-app/presets/standard.patch.yml:66-76`（compaction 组 `isolate.compaction=true`）；
  - 插件规范：`dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:29-64`、`references/practices.md:20,26`、模板 `templates/decoration/{package.json,cordis.patch.yml}`。
- **复现脚本**（`.tmp/`，不入库，可重建）：`schema-check.mjs`（照抄宿主 schema 子集规则，喂 HEAD 的两个工具定义 → 输出 6+6 条违规）；`read-tools.mjs` / `read-session.mjs`（解压会话 JSONL 读 `request/header`）；`asar-probe.mjs` / `asar-scan.mjs`（只读 asar 提取）。

---

## 10. 未复核 / 明确不覆盖

1. 工作区**未提交的 T6/T7 改动**（复核期间仍在变，19:0x 见 `src/audit.js` 轮转、`src/compress/runtime.js`、`src/index.js`、`src/memory/store.js`、**新增 `src/memory/header.js`**、`docs/T6-失败与降级.md`、`test/t6-*`、`test/t7-*`、`analysis/t7/`）——等提交后再复核一轮；本报告所有结论只对 `cdf178b` 成立。
2. **context-zip 后端**未在当前真机跑通（`adapter=none`，provider 被 preset group 隔离）；双后端验收（需求⑤）无本轮证据。
   - **结项注记（2026-10-25，架构 v1.1 + REQ-01 结项口径）**：真机实际运行的就是 **context-zip**（profile redirect 接管 `compaction-basic` 行）；宿主默认后端未单独跑；**provider 路径已结案不可行**——根因是 agent preset 把 compaction 服务放进 `cordis:group` 并设 `isolate: { compaction: true }`（`@local/dsh-computer-use/presets/cordis.patch.yml` 与 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 等多套 preset 一致；本报告 §9 已记录 preset `isolate.compaction=true`），根级插件 `ctx.get('compaction', false)` 返回 `undefined` 属设计行为。按 REQ-01 结项口径，双后端以**事件级契约一致**为准，本条**不再是待验证项**。
3. 真实压缩下的保护/回注行为（V2）——重启后尚未发生压缩，全部结论仍是静态 + 离线测试。
4. 安装/升级/回滚**实跑**——本轮只读，未执行 Runbook。
5. 发布形态（zip/Release 说明/tag）——下一阶段（打包）再做。

---

**复核方签名**：审核打包 · cs_DNciCVhuZD
**复核时间**：2026-10-25 19:0x（+08:00）
**定位**：仅证据与问题清单；修复建议交开发，验收结论归用户。
