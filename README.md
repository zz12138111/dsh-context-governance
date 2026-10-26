# dsh-context-governance

面向 **DeepSeek Harness（DSH）** 的上下文治理插件：**压缩前后不断线**。

在系统压缩上下文之前，把任务态（目标、待办、最近决定、关键约束）写进项目记忆；压缩后只回注 ID / 状态 / 指针，让下一次模型调用接得上。

- **不换压缩引擎**：沿用宿主（或 `context-zip`），只做观测、保护与回注，不写第二个压缩器。
- **记忆是文件**：`memory/governance/` 可读、可 git、可手工修；无数据库、无向量检索。
- **多工作区**：按会话 cwd 上溯最近的 `.git` 判根，各项目记忆 / 审计 / 锁互相独立。

## 环境

- **Windows**（实测 Windows 11）；macOS / Linux 未验证。
- **DSH Desktop `0.2.1-rc.3`**；`engines.dsh = ">=0.2.1-rc.2 <0.2.2-0"`，宿主升到 0.2.2+ 会被**拒载**。
- **Node.js `>=22.19.0`**。

## 安装

把包目录解压到本地，在 DSH profile 里用 `file:` 依赖 + bundle 挂载，并把 `node_modules/@local/dsh-context-governance` 指向包目录（junction）。

- **不要**跑 `pnpm install` / `dsh plugin add`：会 prune 依赖或搬走 compression redirect。
- 安装、升级、卸载与回滚步骤见 **[插件安装升级 Runbook](docs/插件安装升级-Runbook.md)**。

## 快速上手

见 **[快速上手 —— 上下文治理插件](docs/guides/quickstart.md)**。装好默认就工作：窗口到 **60%** 找安全时机提前压；新会话 header 最多 **8 行 / 800 字符**（实测约 69 tokens）。

## 命令

| 命令 | 作用 |
|---|---|
| `/cg status` | 状态：根、窗口、策略、上次压缩/回注/成本、审计 |
| `/cg roots` | 当前纳管根清单 |
| `/cg policy show` | 四层策略合成结果与每键来源 |
| `/cg set <key>=<value>` | 会话内临时改阈值（重启回默认） |
| `/cg profile [batch\|coding\|review\|research]` | 给当前会话换档 |
| `/cg compact [status\|arm\|disarm]` | 本会话提前压开关 |
| `/cg header [status\|on\|off]` | 本会话记忆 header 开关 |
| `/cg last-cost` | 上一次压缩的成本行 |

`/cg compact now`、`/cg cost` 尚未实现。

## 已知限制

- **提前压的收益没有 A/B 量化数据**；机制上更早释放上下文，实际节省未实测。
- 单次压缩有少量重建开销（约 **3.4KB/次**），暂未单列进 `compaction-cost.tokensInjected`；成本数字以 `tokenMeter` 的 before/after 为准。
- **自动压缩在常规聊天里触发很少**（防护重心在长任务、高频工具调用）；该路径**尚未真机验证**——这是证据范围说明，不代表稳定性问题。
- **1.1 才提供**：记忆去重清理、跨会话汇总账单。
- `configRoot`（`projectRoot` 非空）下嵌套 `.git` 不另立根；显式配置根内的多根隔离不完整（已知限制，不是 bug）。
- 不防误删（不能阻止 `rm -rf`）、不存原文（压缩不可逆，只留记忆指针）、不做图表与计费。
- **发布形态**：仅 GitHub；当前 tag `v1.0.0`。`v0.2.1` 为**历史兼容 tag（保留在仓库中、可见）**，仅作旧版兼容回滚参考，**不推荐新装使用**；1.0 的回滚以 `v1.0.0` 为准。

## 发布说明与许可

- 发布说明：**[1.0.0 Release Notes](docs/guides/release-notes-1.0.md)**；变更记录以 Release notes 为准，本仓库不单独维护 CHANGELOG。
- **License**：MIT，`Copyright (c) 2026 zz12138111`，见 [LICENSE](LICENSE)。
- 运行时依赖 DSH 的 `@deepseek-ai/*`（MIT，`Copyright (c) 2026 DeepSeek`）；仓库内不含其源码副本。文档中出现的宿主源码行号/事件名/短句引用仅用于兼容性说明，版权归 DeepSeek。
