# dsh-context-governance

面向 **DeepSeek Harness（DSH）** 的上下文治理插件：**压缩前后不断线**。

在系统压缩上下文之前，把任务态（目标、待办、最近决定、关键约束）写进**会话级记忆**；压缩后只回注 ID / 状态 / 指针，让下一次模型调用接得上。

- **谁适合**：长任务（单次 >20 轮）、长工具链、需要跨会话接着干、同时开多个工作区的人。
- **谁不适合**：只问几句短问题的人；要求压缩后原文一字不差完整保留的人。

## 它做什么 / 不做什么

- **不换压缩引擎**：沿用宿主（或 `context-zip`），只做观测、保护与回注，不写第二个压缩器。
- **记忆是文件**：会话指针库在 `<DSH home>/context-governance/sessions/<sessionId>/`，可读、可手工修；无数据库、无向量检索。
- **有 session id 即纳入治理**：不要求工作区有 `.git`；root 只作审计/压缩分组，**记忆按会话隔离**。
- **不防误删**：不能阻止模型执行 `rm -rf` 这类危险命令。
- **不存原文**：压缩不可逆，旧对话会被丢弃，只留记忆指针；重要结论请自行存档。
- **不做图表与计费**：只提供 token 级单次记录，不折算成钱。

## 环境（前置）

- **Windows**（实测 Windows 11）；macOS / Linux 未验证。
- **DSH Desktop**：`engines.dsh = ">=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.3 <0.3.0-0"`。
  - 0.2.1 线实测到 `0.2.1-rc.3`；0.2.2 线以 `0.2.2-rc.3` 为下界；**0.3.0+ 拒载**。
- **Node.js `>=22.19.0`**。
- 安装/卸载后需**重启 DSH** 生效。

## 安装（约 30 秒）

```powershell
git clone https://github.com/zz12138111/dsh-context-governance.git
pwsh -NoProfile -File .\dsh-context-governance\packages\dsh-context-governance\install.ps1
# 重启 DSH
```

脚本（幂等，可重跑；默认 profile = `$env:DSH_HOME\profiles\desktop`，否则 `~\.dsh\profiles\desktop`）：

1. 备份 profile `package.json`（`.bak-<时间戳>`）；
2. 写入 `dependencies["dsh-context-governance"] = "file:<插件目录>"` 与 `dsh.profile.bundles`；
3. 建 `node_modules\dsh-context-governance` junction 指向插件目录。

- 指定 profile：`-ProfileDir <path>`。
- 卸载：同一脚本加 `-Uninstall`（删依赖键、bundle 项与 junction；保留备份）。
- 只预览：`-DryRun`。
- **已下载 Release zip**：解压后，从仓库下载 `packages\dsh-context-governance\install.ps1`，运行 `pwsh -File install.ps1 -PluginDir <解压目录>`；或按 Runbook 手动安装。
- **不要**跑 `pnpm install` / `dsh plugin add`：会 prune 依赖或搬走 compression redirect。
- **PowerShell 5.1**：若被 ExecutionPolicy 拦住，用 `powershell -NoProfile -ExecutionPolicy Bypass -File ...`（只影响本次进程）或改用 `pwsh` 7。
- **旧装法是真实目录**（`node_modules\dsh-context-governance` 不是 junction）时，脚本会报错退出、**不会删除**；先按 Runbook 移除旧目录再跑。
- 手动步骤、升级与回滚见 **[插件安装升级 Runbook](docs/插件安装升级-Runbook.md)**。

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
| `/cg last-cost` | 上一次压缩的成本行 |

## 已知限制（1.1.0 随 Release 披露）

1. 无 pin / 无 cwd 会话经 UI 保存时，`policy-set` 落主根审计；该路径**尚未**发 `root-unresolved` 事件（下版补）。A2 值按 session id 落盘、不受影响。
2. `/cg policy show` 的 `layers:` 不含运行时 A2，且 A1 标签写 `session`。
3. `user-store:` 分隔符混用（仅诊断文本层面）。
4. `compaction-loss{rollback-point,b-class}` 历史遗留假告警不删除；`8097e0a` 起改判 pass + `protection-covered`。
5. 显式配置根内多根隔离不完整（`projectRoot` 内不再按 `.git` 细分根）。
6. 宿主 cwd 校验先终止的任务形态（CP5）未真机覆盖，靠离线等价覆盖。
7. 第二个 `DSH_HOME` 场景未做真机覆盖。
8. token 由快照下发；真实边界是 loopback，**勿在非 loopback 暴露监听**。
9. （内部发布工具）`compliance-scan.mjs` 按 git 跟踪文件扫；对解包目录运行会假绿。

另：提前压的收益没有 A/B 量化数据；单次压缩有少量重建开销（约 3.4KB/次）；自动压缩在常规聊天里触发较少（防护重心在长任务）。

## 发布形态

- **仅 GitHub Releases**：当前 `v1.1.0`（2026-11-15），附件 `dsh-context-governance-1.1.0-rc.19.zip`（49 文件 / 282,986 B / SHA256 `A3AAD8CD…F9846`）。
- **暂无 npm 发布**；`package.json` 仍为 `private: true`。
- 发布说明以 **[GitHub Releases](https://github.com/zz12138111/dsh-context-governance/releases)** 为准。

## 许可

**MIT**，`Copyright (c) 2026 zz12138111`，见 [LICENSE](LICENSE)。运行时依赖 DSH 的 `@deepseek-ai/*`（MIT，`Copyright (c) 2026 DeepSeek`）；仓库内不含其源码副本。文档中出现的宿主源码行号/事件名/短句引用仅用于兼容性说明，版权归 DeepSeek。
