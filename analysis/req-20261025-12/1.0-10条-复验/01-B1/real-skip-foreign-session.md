# 2b · #1 真机证据：外部会话 `foreign-session` skip（已签收）

- 日期：2026-10-26（本地 12:14–12:21，UTC 04:14–04:21）
- 代码：2b `f362850`（fail-closed 收口后）
- 审计文件：`memory/governance/audit.jsonl`
- 判据：`early-skipped(reason=foreign-session)` 来自项目根外会话；**不是** `unknown-pressure`；无 `early-forced`、无 `compaction-cost`。

## 1. 原始审计行（恰 1 条）

```json
{"ts":"2026-10-26T04:18:29.596Z","event":"early-skipped","sessionId":"session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6","sessionShortId":"53ece2c2","reason":"foreign-session","threshold":0.6,"native":0.6934}
```

- 会话 cwd = `G:\DS-HARNESS`（00 会话），在持久化根 `D:\DS-PROJECT\DSH插件开发` 之外。
- 同窗口 `04:14–04:25Z` 内 `early-forced`/`compaction-cost` 计数 = **0**。
- 该行无 `effective` 字段：scope 判定在 pressure 之前，证明 `foreign-session` **优先于** `unknown-pressure`；单测另有“注入已知压力”用例。

## 2. 配置与进程时序（日志 `logs/governance.log`）

| 时间（UTC） | 事件 |
|---|---|
| 04:14:54.588/591Z | pid 19664 `capability@apply` / `apply`（armed=true 窗口开始后的 reload） |
| 04:18:29.596Z | 审计 `early-skipped(foreign-session)`（上条） |
| 04:18:39（本地） | `cordis.patch.yml` 恢复 `"compact.early.armed": false`（mtime） |
| 04:18:41.253/255Z | pid 19664 再次 `capability@apply` / `apply`（恢复后 reload） |
| 04:19:01.359/362Z | 新进程 pid 4640 `capability@apply` / `apply` |
| 04:21:27.320Z | pid 4640 `capability@ready` |

- 当前进程：`DeepSeek Harness` pid **4640**，StartTime 12:18:50（本地，恢复之后）。
- 恢复后 `04:20Z` 起 `early-*` 计数 = **0**（armed=false 静默，符合预期）。
- 备份：`cordis.patch.yml.bak-armed-20261026-121451`（保留）。

## 3. 判据结论

- **通过**：单测 394/394 + 真机 `foreign-session` skip（无 force/cost，非 unknown-pressure）。
- **未含/观察项**：外部会话真实宿主原生压缩的 `compaction-cost` 行未在本次出现；单测已覆盖字段边界（source=host-native、无 protection/reinjection、store 零写），**Release 不得声称已有该实机证据**。
- **边界保留**：`cwd===''` 的 `unattributed` 放行属已接受的内部边界，不计入外部隔离承诺。
