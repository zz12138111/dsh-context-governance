# Release notes 1.0 技术素材（供审核撰写，非发布文案）

> 本文件只给事实、字段、默认值与证据锚点，不含「推荐/应该」类口径；发布措辞由审核定。
> 生成基线：`8db68f9`（含 #8 文档/证据）；运行时等价 `dc2da72`；全量测试 **419/419**。

## 1. 版本与包面

- 包名：`dsh-context-governance`；**version 1.0.0**；`private: true`。
- `engines.node`: `>=22.19.0`；`engines.dsh`: `>=0.2.1-rc.2 <0.2.2-0`（实测宿主 0.2.1-rc.3；0.2.2 未验，宿主升级后插件拒载）。
- 发布包 `files`: `src`、`README.md`、`cordis.patch.yml`；**不含 `test/`**。
- `npm pack --dry-run` 实测：**30 文件、0 个 test/、0 个本机路径/用户名命中**（证据 `08-install/package-pack-scan.txt`）。
- 包内 `projectRoot/project/logFile` 默认空、`memoryRoot` 相对；无本机绝对路径。
- OS：Windows 11 实测；macOS/Linux 未验。压缩后端：原生 `compaction-basic` 与 `context-zip`；ACP/第三方闸门不支持。

## 2. 变更清单（按验收条目）

| # | 条目 | 事实 |
|---|---|---|
| 1 | B-1 跨项目 | 单根模型；根外会话 `early-skipped(reason="foreign-session")`、`compactNow=0`；宿主原生压缩只记 `compaction-cost(source="host-native")`（含 sessionId/时间/backend/前后 tokens），**无 protection/reinjection/记忆/header 写入**；根未知 `no-project-root` fail-closed；总闸/项目层 disabled = `out-of-scope`（三枚举互斥） |
| 2 | B-2 `committed` fallback | `early-forced` 无 fresh report 时 `compaction` 写 `unknown`（不再 `committed`）；有报告才采用报告枚举 |
| 3 | 两个死键 | `compact.cooldownMin` / `compact.minDeltaTokens` 真正生效（冷却内不重复、增量不足不触发） |
| 4 | 窗上界 | `at ≥ native−0.02`（含边界）一律拒绝，reason `above-effective-window`；运行时窗口收缩导致生效层/回落落入 `(native−0.02, native]` → `window-shrunk`（回落层不可用另记 `fallback-over-native`）；`/cg status` 不显示假 `early=on` |
| 5 | 空窗 | `(native−0.02, native]` 是非可用区间，不是“合法但永不触发”；status 如实 `early=off (<reason>)`；窗口存在但 `validated=false` 时显示 `early=on (…; unvalidated)` |
| 6 | 会话级 | 命令侧会话标识只读 `invocation.agent.session.id`；`/cg set` 覆盖按会话分桶；`/cg compact arm/disarm` 只影响本会话；缺失会话 id 拒绝、不退化进程级；重启覆盖清空 |
| 7 | profile 按会话 | `/cg profile [status\|reset\|<batch\|coding\|review\|research>]` 只影响当前会话、进程内不持久化；`/cg set profile=` 按未知键拒绝 |
| 8 | 安装契约 | D9=A：默认空根，首次会话推断并持久化；`logFile` 空=关闭，非空必须绝对路径；`project` 空由根 basename 补；发布包 0 绝对路径；隔离演练装/卸/回滚通过（证据 `08-install/`） |
| 9 | 压力会话隔离 | `/cg status` 压力按当前会话取，不显示别的会话最近压力 |
| 10 | auto loss 审计 | 新写统一 `compaction-loss`（`sessionId/compactionId/manual/trigger:'auto'|'manual'/failures/entries/auditVersion:'loss-v1.0'`）；`manual:false` 保护失败也写；`manual-compaction-loss` 只读兼容、不双写；未观测 start 带 `reason:'late-mount'`；history 回查 `292d1e97=发生丢失`、`ca9c9bb8=无法判定` |
| 11 | R-MEMROOT | 用户级状态文件 `<pc.home>/context-governance/root-state-<profile>.json`（无 home 时 `<pc.dir>/context-governance/root-state.json`）；身份唯一来源 `ctx.get('profileContext')`（不读 env）；字段 `{version, root, source:'inferred', inferredAt, inferredFromCwd, instance:{profile}, configRoot?}`；推断失败不落盘/不换根；配置优先且只写 `configRoot` 镜像，移除配置回落持久化根；根变化写 `persistence-identity`/`inferred-fresh`/`project-root-changed`；`/cg status` 显示 `project-root`/`persistence-identity` |

## 3. 默认值（发布包默认；不代表本机配置）

| 键 | 默认 | 说明 |
|---|---|---|
| `compact.at` | **0.60** | 可用上界 `native−0.02`（观测 1,048,576 → native 0.6934、上界 0.6734；配置窗口 1,000,000 → native 0.6785、上界 0.6585） |
| `compact.early` | **true** | 提前压开关 |
| `compact.early.armed` | **true** | **发布默认开真实触发**；项目层 `.cg-policy.json` 对该键一律不生效（记 `policy-invalid(project-excluded)`）；本机取证期曾临时 false，已恢复（**非产品默认**） |
| `compact.cooldownMin` | **10** | 冷却分钟 |
| `compact.minDeltaTokens` | **20000** | 按窗口换算比例：1M≈2pp、200k=10pp、128k≈15.6pp（不是固定 1pp） |
| `compact.estimateSafety` | 1.35 | 仅配置文件可改 |
| `header.enabled` | true | 新会话 header 默认开 |
| `projectRoot` | **""** | D9=A：首次推断并持久化；不预填本机路径 |
| `project` | **""** | 运行期由推断根 basename 补 |
| `memoryRoot` | `memory/governance` | 相对唯一项目根解析 |
| `logFile` | **""** | 关闭；非空必须绝对路径，相对路径 `CONFIG` 拒绝 |
| `onlyProject` | true | **仅兼容展示**，不决定作用域；根外会话一律外部（cost-only），`false` 不扩大作用域 |
| `policy.windowTokens` | 1,000,000 | 无观测时回退 |
| `policy.reservedTokens` | 256,000 | native 计算预留 |
| `audit.maxBytes` | 8 MiB | 轮转 |
| `reinjection.maxFailures` | 3 | 连续失败降级 |

## 4. 已知限制（§4.8b 原文；Release/README 必须写）

> **记忆工具未按会话隔离（1.0 已知限制，计划 1.1）**：`mem_write` / `mem_query` 不做项目根/会话校验；**外部工作区的会话也可能读取或写入本项目记忆**。插件的「外部会话不读写记忆」承诺**仅适用于压缩观测、保护、回注与成本记录**，不包含这两个记忆工具。需要严格隔离时，请只在项目内会话使用；1.1 将补同一作用域判定（外部/未知会话拒绝并审计 `memory-tool-rejected`）。

分类：数据边界问题，非压缩/保护缺陷；不阻塞 1.0，但**不得暗示工具面已隔离**。

## 5. 发布前真机观察项（§4.12 原表，未观测/不声称）

| # | 观测项 | 现状 | 拿不到时的 Release 口径 |
|---|---|---|---|
| 1 | **#1 外部会话宿主原生 cost**：真实 `compaction-cost` 行 `source=host-native`，含 backend/前后 tokens、无 protection/reinjection、store 零写 | 未观测到（单测覆盖字段边界） | 不声称“外部压缩已有实机证据” |
| 2 | **#4/#5 `/cg status` 文本**：unvalidated 显示 `early=on (...; unvalidated)`；收缩/空窗显示 `early=off (reason)`；恢复回 on | 真机文本未采（单测覆盖） | 不声称 status 已真机验过 |
| 3 | **#10 真机 auto loss**：宿主自动压缩保护失败 → `compaction-loss(manual:false, trigger:auto)` | 未观测（单测覆盖） | 不声称已有 auto 实机 loss 证据 |
| 4 | **#11 双 profile 真机**：两个 profile 各写各状态文件、互读不到 | 单测覆盖 alpha/beta；本机只有 desktop | 不声称双 profile 已真机验证 |
| 5 | **#11 根变化真机**：config 变更 / 状态文件丢失 / 损坏 → `project-root-changed` / `inferred-fresh`，旧记忆不迁移 | 单测覆盖；真机未做 | 不声称根变化已真机验证 |
| 6 | **#11 `/cg status` 根文本**：root / memoryRoot / source 可见 | 真机文本未采（单测覆盖） | 不声称 status 已真机验过 |

## 6. 破坏性/行为变更（升级需知）

- **会话级语义**：`/cg set`、`/cg compact arm|disarm`、`/cg profile` 均按当前会话；缺失 `agent.session.id` 直接拒绝；重启后覆盖清空。
- **根模型**：`projectRoot` 默认空 → 首次推断 + 持久化；旧配置若依赖“未配置回落 process.cwd”，行为改变；记忆根随推断根解析，旧记忆不迁移/不删除。
- **外部会话**：不再进入保护/回注/记忆/header；仅记录宿主原生压缩事实与用量（`source:"host-native"`）。`onlyProject=false` **不再**扩大作用域。
- **`/cg profile` 新入口**；`/cg set profile=...` 拒绝。
- **`logFile` 相对路径**从“可用但落到进程 cwd”改为 `CONFIG` 拒绝；包内默认空。
- **`compact.at` 上界**从 `> native` 收紧到 `≥ native−0.02`；已在旧版本生效的层可能变为 `above-effective-window`/`window-shrunk` 并自动失效。
- **loss 事件重命名**：新写 `compaction-loss`（`loss-v1.0`）；`manual-compaction-loss` 只读；`compaction-cost` 仍 `cost-v1.4`。
- **status 行变化**：新增 `project-root:`、`persistence-identity:`、`last-loss:`；`scope:` 的 `only-project` 仅展示；`early=` 可能在 unvalidated/非可用区间显示 off。
- **发布包不含 `test/`**；安装/升级按 Runbook（junction + 不跑 pnpm）。

## 7. 证据锚点

- 测试：全量 **419/419**（`node --test "test/*.test.mjs"`）。
- 安装/卸载/回滚：`analysis/req-20261025-12/1.0-10条-复验/08-install/`。
- 2b 外部 skip 真机：`analysis/req-20261025-12/1.0-10条-复验/01-B1/real-skip-foreign-session.md`。
- #10 历史回查：`analysis/req-20261025-12/1.0-10条-复验/10-auto-loss/historical.md`。
- 包面扫描：`08-install/package-pack-scan.txt`（30 文件 / 0 test / 0 命中）。
