
# 只读分析工具（D-MGMT-021，2026-11-15）

均只读会话日志与 asar，不改任何文件、不联网。需要 Node ≥ 24（`node:zlib` 的 zstd）。

## session-shape.mjs
解压多帧 `session.v4.jsonl.zstd`，输出事件骨架 + source 归属（不输出正文）。

```powershell
node analysis/dsh-021-turn-cursor/tools/session-shape.mjs <session.v4.jsonl.zstd> [maxLines] [typeFilterRegex]
# 例：只统计 system/message
node analysis/dsh-021-turn-cursor/tools/session-shape.mjs "$env:USERPROFILE\.dsh\sessions\--D-DS-PROJECT-DSH~63D2~4EF6~5F00~53D1--\session-58a2e845-cec5-4229-afa9-7f09a0fc0207\session.v4.jsonl.zstd" 0 '^system/message$'
```

## event-inspect.mjs
查看指定 seq 事件的字段骨架与 source.kind/plugin/form（不输出正文）。

```powershell
node analysis/dsh-021-turn-cursor/tools/event-inspect.mjs <file.zstd> 59 60 61
```

## 已核数据（开发侧）
- `session-58a2e845-cec5-4229-afa9-7f09a0fc0207`（51 MB / 68,365 事件）：`system/message` 4 条，全部 `source.kind=system-prompt`。
- P4-fix-b `rerun2/b-a-surface-rebuild.jsonl`：3 条重建副本全部 `user/message`（user / agent-instructions / skill-catalog）。
