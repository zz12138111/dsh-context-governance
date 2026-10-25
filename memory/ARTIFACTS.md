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




