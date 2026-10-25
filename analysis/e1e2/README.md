# E1/E2 实验目录

> REQ-20261025-01 M1 前置门禁的实验记录与数据。**只读实验**：未改已装插件/配置，未重启 DSH。

## 文件

| 文件 | 内容 |
|---|---|
| `E1-感知层级实验记录.md` | E1 结论、逐层证据、两后端差异、边界与风险 |
| `E2-回注形态实验记录.md` | 三形态 × 吞/重复 × prompt 成本；默认形态建议 |
| `行为矩阵-6.3回写字段.md` | 给需求会话回写架构 §6.3 的成稿字段 |
| `data/compaction-inventory.json` | 47 个会话、16 次压缩的脱敏清单（session/workspace 已哈希） |
| `data/e2-structural.json` | 6 对压缩的“回注是否被下一次压缩吞掉”结构分析 |
| `data/e2-prompt.json` | 真实 context-zip 引擎 + 桩 LLM 截获的摘要 prompt 测量 |
| `data/e2-summary-analysis.json` | 16 篇真实摘要的结构化保留统计（无正文） |
| `lab/scan-sessions.mjs` | 只读扫描会话日志（追加式 zstd 帧串） |
| `lab/e2-structural.mjs` | 用清单中的 shadowedRange 判断回注是否被吞 |
| `lab/e2-prompt-harness.mjs` | 隔离 lab：复制已装引擎到临时目录 + `@deepseek-ai/dsh-llm` 桩 |
| `lab/e2-summary-analysis.mjs` | 摘要结构化标记统计 |

## 复现

前提：本机装有 DSH 0.2.1-rc.2 与 `dsh-context-zip@0.1.10`（desktop profile）。全部只读。

```powershell
cd analysis/e1e2
node lab/scan-sessions.mjs data/compaction-inventory.json
node lab/e2-structural.mjs data/compaction-inventory.json data/e2-structural.json
node lab/e2-prompt-harness.mjs data/e2-prompt.json
# 摘要统计需要先把摘要正文导出到临时目录（见 E2 文档 §4）
```

## 隐私口径

- 不保存会话 ID、用户名、工作区真实路径；`session`/`workspace` 只留 10 位哈希。
- 不保存摘要正文、对话正文；只留长度、命中标记与计数。
- 临时目录（`%TEMP%\cg-lab`）里的原始材料不随仓库发布。
