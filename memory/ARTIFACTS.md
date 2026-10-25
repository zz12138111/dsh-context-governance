# DSH 插件开发 · 精确事实

> 一行一条：日期 · 事实 · 路径/版本/哈希。只记"外部凭证"性质的硬事实。

- 2026-10-25 · 工作区建立：`D:\DS-PROJECT\DSH插件开发`，三个会话（需求/开发/审核打包），模型 deepseek-flash、推理档 High
- 2026-10-25 · 工作区约定：`AGENTS.md`；需求单：`REQUIREMENTS.md`；决策：`DECISIONS.md`（开发单写）；状态：`STATUS.md`
- 2026-10-25 · 角色卡：`G:\DS-HARNESS\roles\ROLE-DSH插件-需求.md` / `-开发.md` / `-审核打包.md`
- 2026-10-25 · 宿主：DSH Desktop `0.2.1-rc.2`，asar 打包（`@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.2`）
- 2026-10-25 · 压缩后端：desktop profile 内 `dsh-context-zip@0.1.10` 接管 `compaction-basic` 行；redirect 包 `@deepseek-ai/dsh-compaction-basic@0.1.0-context-zip`，`base.json` 源版本 `0.2.1-rc.2`；`thresholdRatio 0.65`
- 2026-10-25 · E1/E2 数据：47 个会话 / 16 次压缩（10 手动、6 自动；五段式 10、自由 6；0 失败）；`analysis/e1e2/data/`
- 2026-10-25 · T2 包：`packages/dsh-context-governance`（v0.1.0，纯 ESM，零依赖）；`node --test` 40/40；契约 `docs/记忆契约-v1.md`
- 2026-10-25 · 决策：`DECISIONS.md` 新增 `DEC-PLUGIN-20261025-01..05`（E1/E2/存储格式/路径与锁/代码形态）
- 2026-10-25 · 装载桩：`packages/cg-stub/`（`@local/dsh-cg-stub@0.0.1`，bundle patch `id=cg-stub`，日志 `D:\DS-PROJECT\DSH插件开发\logs\cg-stub.log`）；未安装、未重启、未改 profile
- 2026-10-25 · 环境检查脚本：`D:\DS-PROJECT\_shared\check-env.ps1`（含 context-zip redirect 版本与 `.ignored` 告警）
- 2026-10-25 · 装载桩结论：`logs\cg-stub.log` 5 次 apply（17:11–17:32），`observer=registered(count-only)` → 本地插件装载通道可用；故障根因是 `workspace.json` BOM，与桩无关
- 2026-10-25 · 事故根因：PS 5.1 `Set-Content -Encoding UTF8` 写 BOM → DSH `JSON.parse` 失败 → `workspaceRegistry`/`workspaceController` 不可用；已由 00 修复
- 2026-10-25 · T3 实现：`packages/dsh-context-governance/src/compress/`（adapters/protection/selection/runtime）+ `diagnostics.js`；bundle patch `cordis.patch.yml`（`id=dsh-context-governance`，config 指向本工作区 `memory/governance` 与 `logs/governance.log`）
- 2026-10-25 · T3 测试：全量 **92/92 通过**（`node --test "test/*.test.mjs"`）；T3 文档 `docs/T3-压缩适配与保护.md`
- 2026-10-25 · T4 实现（S4=B）：`protectSync` 同步 journal（`memory/governance/protection/`，ID `MEM-YYYYMMDD-1000+`）+ 异步物化；`end` 后 microtask 回注 1 次；`audit.jsonl`；文档 `docs/T4-压缩前固化与回注.md`
- 2026-10-25 · T4 测试：全量 **106/106 通过**（T2 40 + T3 52 + T4 14）；用例名 S4-A1/A2/A3/M1/M2/I1/I2/F1/F2/F3/AUD/R1
- 2026-10-25 · T4 时序偏差：要求“checkpoint→end 之间”不可实现（append 重入禁止）；改为 end 后首个 microtask，已记 `DEC-PLUGIN-20261025-09`；用户已接受
- 2026-10-25 · T5 实现：`/cg status`（`src/commands/cg-status.js`）+ 审计白名单（`src/audit.js` `AUDIT_FIELD_WHITELIST`）+ 写盘 p50/p95（`src/metrics.js`，guard.status.writeLatency）；文档 `docs/T5-状态命令与审计.md`
- 2026-10-25 · T5 测试：全量 **118/118 通过**（T2 40 + T3 56 + T4 15 + T5 7）；敏感文本注入审计/记忆的脱敏用例通过
- 2026-10-25 · 真机宿主实测 `0.2.1-rc.3`（app.asar；旧 runtime 缓存为 rc.2）；矩阵改为 `>=0.2.1-rc.2 <0.2.2-0`（DEC-12）
- 2026-10-25 · **v0.1.1 事故**：`inject` 加 `compaction` → 插件永久 pending、apply 不执行、日志零新增（token 确为 `compaction`，根作用域不可见）；v0.1.2 撤回 `inject=['tools','commands']`，改事件级（DEC-13）
- 2026-10-25 · v0.1.2 实现：`selectMode` 新增 `event-level`（provider 不可见时）；`startupLine` 增 `perception=event-level compaction-service=absent(token=compaction)` 与 `warning=provider-unavailable`；`PLUGIN_VERSION=0.1.2`；全量 **118/118 通过**
- 2026-10-25 · rc.3 事件级感知核查：`compaction-basic` 仍写 `compaction/start|summary|end`（源码命中 3/2/4），`dsh-session` known-event-types 仍含三类事件 → 事件级感知可用；已装 context-zip 0.1.10 + redirect base rc.2 副本，事务事件由 redirect base 发出
- 2026-10-25 · T3 真实日志审计（16 次压缩）：最新用户被吞 11/16（手动 10/10、自动 1/6）；批次未覆盖 5；回滚未覆盖 6；摘要可读 16/16；规则快照被吞 16/16 但后续 turn 均重注入 baseline；`analysis/t3/data/t3-audit.json`
- 2026-10-25 · 安装方案：`file:` + junction，不跑 pnpm/`dsh plugin add`/`--lockfile-only`；Runbook `docs/插件安装升级-Runbook.md`；安装前基线 deps 13 / bundles 16 / redirect `0.1.0-context-zip`，装后期望 14/17/不变
- 2026-10-25 · v0.1.3 实现：`src/capabilities.js` 能力探测（只记类型，单行 `governance capability … probe=…`）；`perception` 改为“订阅成功才 event”；startup 行加 `event-api=on|off`/`audit=<path>`；`AuditLog` apply 即建文件 + 写 `apply` 记录；`/cg status` 加 `events=N`（运行期收到 `session/event` 计数）；全量 **127/127**
- 2026-10-25 · `session/event` 通道取证（源码级）：`dsh-session` commit 用 `collectSessionCallbacks(entry.emitCtx,[carrier,'session/event',…])` → `ctx.events.dispatch`；`scopeTarget` 过滤器对未打 scope 标签的监听者一律放行 → 根级 `ctx.on('session/event')` 应收全部会话事件；先例 `dsh-agent-instructions`（inject sessionProjections/workingDirectory）
- 2026-10-25 · 18:43 装载后工作区两会话日志里最后一次 `compaction/start` 为 `18:41:28`（早于装载）→ 尚无新压缩，无法据此判定“收不到事件”；`audit.jsonl` 缺失只因 0.1.2 审计懒创建且未发生压缩
- 2026-10-25 · **v0.1.3 真机确认**：能力行 `on=fn,emit=fn,events=obj(dispatch=fn),get.sessions=obj,get.agents=obj,get.sessionProjections=obj,get.compaction=absent`；apply 行 `perception=event event-api=on audit=…`；`audit.jsonl` 首条 apply；`events` 计数待真实压缩
- 2026-10-25 · T6/v0.1.4 实现：审计轮转（默认 8 MiB，`audit-YYYYMMDD.jsonl`，可配 `audit.maxBytes` 64 KiB–1 GiB）；`MemoryStore.probeWritable()` + 装载写探测；只读五类判据、只读下不写记忆/审计但可回注既有指针、start 时探测恢复；`cycle-interrupted`/`cycle-abandoned`；`stats.auditWriteFailures/auditSkippedReadOnly/readOnlyRecoveries`；全量 **136/136**
- 2026-10-25 · T7 回放：`analysis/t7/extract-replay-fixture.mjs` 从真实 `session.v4.jsonl.zstd`（含 `delivery-accepted` 事件、shadowed=1267）提周期并按 key 深度脱敏；fixture `packages/dsh-context-governance/test/fixtures/replay-compaction.json`（约 300 KB，无正文/路径/会话 id）；`test/t7-replay.test.mjs` 回放 start→summary→checkpoint→end 通过





- 2026-10-25 · T7/v0.1.5 完成：S1–S6 场景用例 13 条（S4 拆 A/M/I/F/AUD/R）；真实双样本回放 `test/fixtures/replay-compaction.json`（自动，18:41，shadowed=1267）与 `replay-compaction-manual.json`（手动，00 会话，shadowed=920，`manual=true`），均由 `analysis/t7/extract-replay-fixture.mjs` 深度脱敏；文档 `docs/T7-验收场景-S1-S6.md`、只读人工脚本 `docs/T7-只读降级人工验证.md`
- 2026-10-25 · v0.1.5 版本单一来源：`diagnostics.readPackageVersion()` 运行时读 `package.json`，`PLUGIN_VERSION` 不再手写（测试断言源码无字面量）；三处手写版本收敛为 package.json 一处
- 2026-10-25 · S3 opt-in：`src/memory/header.js`（`agent/pre-step` 第一步注入偏好/决定 header，一次/会话，默认 `memoryHeader.enabled=false`，失败只 warn）；需用户拍板才在真机开启
- 2026-10-25 · 全量测试 **149/149**（T2 40 + T3 56 + T4 15 + T5 7 + 感知 9 + T6 7 + T7 回放 2 + T7 场景 13；相对 0.1.4 新增 13）
- 2026-10-25 · 复核 P1 修复（v0.1.6）：`mem_write`/`mem_query` 描述符改标准 JSON Schema（顶层 required，去掉属性级 `required:true`）；删除 defineTool 注入；新增 `test/host-schema-contract.mjs`（复刻宿主 `assertSupportedJsonSchema` 规则）+ `test/tools-schema.test.mjs`（5 条，含旧形状被拒的回归）
- 2026-10-25 · 复核 P2 修复：① `onlyProject`（默认 true，按 `session.header.cwd` 比对 projectRoot，外来会话忽略并计数，`/cg status` 有 `scope:` 行）② 隐私口径改正 + `captureTitle`（默认 true，false 只存通用标签与指针）③ Runbook §6 改为“只还原实际改过项”：manifest 只删本插件条目、patch/lock 默认不还原、junction 退出码断言、`.ignored` 取版本匹配副本、备份保留 3 份、回滚点记 ARTIFACTS ④ 版本单一来源：`PLUGIN_VERSION` 运行时读 package.json，测试/README/STATUS/Runbook 不再硬编码
- 2026-10-25 · P3 顺手修：COMPAT-02（删 defineTool）、COMPAT-03（engines 与矩阵统一 `<0.2.2-0`）、COMPAT-05（readability 去死分支）、COMPAT-06（events=0 提示）、ROB-03（删 dispose 死兜底）、ROB-04（审计失败标注 this-process）、ROB-07（由 schema 契约覆盖）、ROB-08（格式）；其余 13 条保留并在 `docs/T7-复核修复-0.1.6.md` 写明原因
- 2026-10-25 · 全量测试 **159/159**（新增 P1 5 + P2 5；版本断言改为读 `PLUGIN_VERSION`）
- 2026-10-25 · 复核二轮阻断修复（v0.1.7）：fixture 脱敏改**递归所有字符串**（CJK/绝对路径/URL/session-uuid/长 token → 占位；字符串数组按 join 与短片段流整组替换，不依赖 key）；重生成两份 fixture，`analysis/t7/scan-fixture.mjs` 扫描 strings=4111/1851、violations=0，raw 无 CJK/19091/session-53ece2c2/DS-PROJECT；T7-R2 改递归+join+join-tight+raw 硬断言；回放 15/15 通过
- 2026-10-25 · 复核二轮 P3：SPEC-05 `inject=['tools']`（commands 可选，缺服务仍 apply，只 warn）；ROB-10 README/契约写明“手改索引会被覆盖”；REQ-02 新增 `reinjection-shadowed` 审计（回注 seq 被下一次压缩 shadow 时记录，stats.reinjectionShadowed）；成本归属仍待需求定字段
- 2026-10-25 · Runbook §6 收尾：改 manifest 前留 `.cg-bak-<时间戳>`、写后断言插件条目已消失；redirect 读取前 `Test-Path`；已含只删本插件条目/patch-lock 不还原/junction 退出码/.ignored 判据/备份保留 3 份/回滚点记录
- 2026-10-25 · 已知风险落文件：ROB-01/06（一次 append 失败永久关停保护预写）写入 STATUS“已知风险”，列为 T8 第一项；本轮不修
- 2026-10-25 · 全量测试 **161/161**（新增 SPEC-05 与 REQ-02 用例）
- 2026-10-25 · T8-1 自愈（v0.1.8）：回注失败不再永久 `#disableReinjection`；每次失败写 `reinjection-failed(count=连续次数)`，连续 `maxFailures`（默认 3）才写 `reinjection-degraded` 并只暂停下一周期保护写；降级周期用既有记忆指针回注，成功写 `reinjection-recovered`、清计数、恢复 full；`/cg status` 显示 `reinjection=enabled(streak=N)`/`suspended(N/max)`。测试：新增 T8-1 自愈 + 更新 T4-5/S4-F
- 2026-10-25 · T8-2 成本归属（v0.1.8）：每周期一条 `compaction-cost`（compactionId 主键；sessionId/project/backend/model/trigger/occurredAt；tokensBefore/After 用宿主 tokenMeter；tokensShadowed/tokensSummary/backendUsage 用压缩事件 usage；tokensInjected 字符估算标 estimated；tokensDropped 来自 reinjection-shadowed；backendCostSource/governanceCostSource + estimateMethod + auditVersion=cost-v1）；审计白名单新增字段，`backendUsage` 只收五个 token 数值，仍不含正文/路径
- 2026-10-25 · 全量测试 **166/166**（新增 T8 成本 4 条 + 自愈 1 条；0.1.7 的其余行为保留）