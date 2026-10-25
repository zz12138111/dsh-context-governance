# context-zip 生产后端 · R-2 真实触发（2026-10-26）

> 目的：在**生产同款 context-zip 后端** profile 上验证提前压**自动触发**（不是探针 G2-A）。按审核五条判据取证。

## 1) 环境可证

| 项 | 值 |
|---|---|
| profile | `desktop-test-contextzip` |
| bundles 含 `dsh-context-zip` | ✅（bundles 末项 `dsh-context-zip`） |
| redirect | `@deepseek-ai/dsh-compaction-basic` = **`0.1.0-context-zip`** |
| 插件挂载 | 临时 junction `node_modules/dsh-context-governance` → `D:\DS-PROJECT\DSH插件开发\packages\dsh-context-governance`（当前仓库；package version `0.2.1`，0.2.4 代码） |
| profile package.json/bundles | **未改**（仅 junction + `--patch` 插入行） |
| 宿主 | 0.2.1-rc.3；端口 18768 |

## 2) 真实触发

- `armed`：默认开（`early=on (default)`）
- `compact.at=0.35`（会话层 `/cg set`，同一实例内完成构造与触发）
- 压力：`measured=0.437, effective=0.437`（`≥0.35` 且 `< native−0.02=0.6734`）
- `turn/end` 后 50ms：`early-forced` 原文：

```json
{"ts":"2026-10-25T19:06:52.044Z","event":"early-forced","sessionId":"session-96b9b4d2-1ad5-4709-98f1-da373538f63e","accepted":true,"compaction":"committed","protection":"failed","failures":["latest-user-message","rule-injection","rollback-point"],"reinjected":true,"compactionId":"cc144603-6e19-4dae-bba7-6909b0100b28","delayMs":50,"effective":0.437,"threshold":0.35,"native":0.6934}
```

- 决策：`early-decision action=force reason=forced effective=0.437 threshold=0.35`

## 3) 压缩确实发生

```json
{"ts":"2026-10-25T19:06:52.040Z","event":"compaction-cost","compactionId":"cc144603-…","project":"contextzip-test","backend":"host-basic","backendKind":"host-basic","backendLabel":"host-basic (inferred)","backendInferred":true,"trigger":"manual","tokensBefore":161580,"tokensAfter":2981,"tokensBeforeSource":"tokenMeter","tokensAfterSource":"tokenMeter","tokensShadowed":159569,"tokensSummary":843,"tokensInjected":69,"injectedEntries":3,"tokensDropped":0,"backendUsage":{"inputTokens":424,"outputTokens":843,"cacheReadTokens":457984,"cacheWriteTokens":0,"totalTokens":459251},"auditVersion":"cost-v1.4"}
```

- 事件流：`compaction/start → compaction/summary → compaction/end`（探针上一轮同 profile 记录 seq 24→26→28；本轮 governance `events=66`，`last-compaction`/`last-cost` 均指向 `cc144603`）。
- **允许项**：`backend=host-basic (inferred)` —— 审核明确 adapter 识别不用解决；用环境证据（redirect+bundle）钉住“跑的是 context-zip profile”。

## 4) 保护 + 回注

```json
{"event":"protection-write","compactionId":"cc144603-…","manual":true,"count":3,"kinds":["latest-user","rules","rollback"]}
{"event":"protection-materialized","compactionId":"cc144603-…","moved":3}
{"event":"manual-compaction-loss","compactionId":"cc144603-…","failures":["latest-user-message","rule-injection","rollback-point"],"entries":3}
{"event":"reinjection","compactionId":"cc144603-…","manual":true,"count":3,"seq":95}
```

- `/cg status`：`last-reinjection: status=injected seq=95 lines=3`；`protection: writes=1 writeFailures=0 reinjections=1 injectionFailures=0`。

## 5) `/cg status` 原文落盘

`analysis/req-20261025-12/drills/contextzip-R2-status.txt`（含 `early=on (default)`、`last-early: forced effective=0.437`、`last-compaction: id=cc144603 compaction=committed protection=failed`、`last-cost`）。

## 判据对照（审核五条）

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| 1 | 环境可证（redirect/bundle/junction/未改 profile） | 上表 | ✅ |
| 2 | 真实触发（armed 默认开、at=0.35、0.35≤eff<native−0.02、delay 50） | eff=0.437，early-forced accepted | ✅ |
| 3 | 压缩确实发生（cost tokensBefore/After + 事件流） | 161580→2981 tokenMeter；start→summary→end | ✅（backend=host-basic 允许） |
| 4 | 保护/回注三件套 | protection-write/materialized/reinjection | ✅ |
| 5 | 不碰桌面、实例停/profile 还原 | 见收尾 | ✅ |

## 收尾

- 实例已停（18768 无监听）；`node_modules/dsh-context-governance` junction 已删；redirect 仍 `0.1.0-context-zip`；profile package.json/bundles 未改。
- 会话 `session-96b9b4d2…` 为上一轮 G2-A 复跑同一会话的延续（同一 ctxzip memoryRoot）；历史中已有一次探针压缩，本轮为**自动触发**的新 cycle `cc144603`。
