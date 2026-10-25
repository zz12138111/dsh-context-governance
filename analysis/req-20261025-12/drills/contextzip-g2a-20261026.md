# context-zip × 0.2.1-rc.3 G2-A 复跑记录（2026-10-26）

> 结论先行：**未达 G2-A 判据**。`desktop-test-contextzip` 的 redirect 确实存在（`@deepseek-ai/dsh-compaction-basic` = `0.1.0-context-zip`），但实测摘要形态为 free-form，`adapter-inferred` 判成 **host-basic (inferred)**，不是 context-zip。按 00 口径如实报「未验」，不伪造。

## 环境

- profile：`desktop-test-contextzip`（桌面测试 profile，含 `dsh-context-zip` bundle + redirect）
- 端口：18768；host 0.2.1-rc.3
- 挂载方式：临时 junction `dsh-context-governance`、`g2-probe` 进 profile `node_modules`，`--patch .tmp/t5/ctxzip-patch.yml` 插入；**未改 profile package.json / bundles**；跑完 junction 已删、redirect 仍 `0.1.0-context-zip`、18768 无监听。
- 会话：`session-96b9b4d2-1ad5-4709-98f1-da373538f63e`（短 id `96b9b4d2`）
- 压力：小会话（`tokensBefore=3502` tokenMeter），G2-A 只验事务与后端判定，不验压力门槛。

## 事件与读数

探针（`g2-probe`，`G2_PROBE_MODE` 未设，含 G2B/G2A）：

```
G2A attempt signal=set
event compaction/start seq=24 sourceCommandId=probe-g2a
event compaction/summary seq=26 sourceCommandId=probe-g2a
event compaction/end seq=28 sourceCommandId=probe-g2a
G2A ok elapsed=12949ms
```

治理审计（`.tmp/ctxzip-ws/memory/governance/audit.jsonl`）：

```json
{"event":"adapter-inferred","sessionId":"session-96b9b4d2-…","adapter":"host-basic (inferred)","inferred":true,"kinds":["free-form"],"reason":"summary-shape"}
{"event":"protection-write","compactionId":"c9d1eff4-d03c-4a1a-b40a-9adf7130bcb9","manual":true,"count":3,"kinds":["latest-user","rules","rollback"]}
{"event":"protection-materialized","compactionId":"c9d1eff4-…","moved":3}
{"event":"manual-compaction-loss","compactionId":"c9d1eff4-…","failures":["latest-user-message","rule-injection","rollback-point"]}
{"event":"reinjection","compactionId":"c9d1eff4-…","manual":true,"count":3,"seq":29}
{"event":"compaction-cost","compactionId":"c9d1eff4-…","backend":"host-basic","backendKind":"host-basic","backendLabel":"host-basic (inferred)","auditVersion":"cost-v1.4","tokensBefore":3502,"tokensAfter":2396,"tokensBeforeSource":"tokenMeter","tokensAfterSource":"tokenMeter","tokensShadowed":1585,"tokensSummary":2017,"tokensInjected":64,"injectedEntries":3,"tokensDropped":0,"backendUsage":{"inputTokens":426,"outputTokens":2017,"cacheReadTokens":23040,"cacheWriteTokens":0,"totalTokens":25483}}
```

## 判据对照

| 判据 | 实测 | 结论 |
|---|---|---|
| `compaction/start→summary→end` | seq 24→26→28，G2A ok 12.949s | ✅ |
| `adapter-inferred` 显示 context-zip（非 host-basic） | **host-basic (inferred)**，kinds=[free-form] | ❌ |
| `compaction-cost` 字段/摘要可读 | 字段齐全（cost-v1.4）；`tokensSummary=2017`、`summary=readable/free-form` | ✅ |

## 归因与建议（供审核/需求定）

1. redirect 版本为 `0.1.0-context-zip`，但本 profile 的摘要形态是 **free-form**（非五段式），所以 `classifySummaryText` 判 host-basic；可能原因：该 context-zip 版本摘要风格非五段，或引擎路径未走到 redirect（`detectAdapter` 只看 `ctx.get('compaction')`，本部署为 absent，只能靠摘要形态推断）。
2. 兼容矩阵这格应标 **「未验」**（不是「通过」）；若要真验，需审核给出可证明 context-zip 引擎生效的方法（例如直接探测旧 `undoManualSeat`/`declaredConfig` 标记，或宿主提供 `ctx.compaction`）。
3. 本轮未改任何产品代码/profile 配置；仅临时 junction + `--patch`。

## 收尾

- 实例已停（18768 无监听）；两个 junction 已删；redirect 仍 `0.1.0-context-zip`；profile `package.json` 未改动。
