# T3 实验目录

> REQ-20261025-01 M1 · T3 压缩适配与保护的离线证据。**只读实验**：未安装插件、未重启 DSH、未改 profile。

| 文件 | 内容 |
|---|---|
| `lab/audit-compactions.mjs` | 只读扫描本机会话日志，对 16 次真实压缩核对保护项是否落在 `shadowedRange`，被吞时再看摘要是否覆盖 |
| `data/t3-audit.json` | 脱敏审计结果（会话/事务 ID 哈希；无消息正文） |

## 口径与限制

- “最新用户消息/规则快照/批次/回滚点”用**事件 seq 是否落在 shadowedRange** 判断；不做 surface 重建，因此**不审计工具配对**（宿主在提交时已断言；由 `test/compress-protection.test.mjs` 的合成用例覆盖）。
- 规则快照算“可接受”的条件：被吞后出现更新的同类注入（宿主常在下一次 turn 重新注入 AGENTS baseline）；否则算失败。
- `summary-readable` 只看摘要非空；五段式/自由式都算可读。
- 不保存摘要正文、消息正文、用户名或真实路径。

## 复现

```powershell
cd analysis/t3
node lab/audit-compactions.mjs data/t3-audit.json
```

当前结果摘要：16 次压缩（手动 10 / 自动 6）；最新用户消息被吞 11（手动 10、自动 1）；批次未覆盖 5；回滚未覆盖 6；摘要可读 16/16；规则快照被吞 16/16、但后续均有 baseline 重注入。
