# DSH 插件开发 · 当前状态

> 只放"现在还活着"的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-25（T8 完成 + 三轮复核：fixture 结构白名单、commands 晚挂载重试、shadowedRange 兜底；等重启）

## 在办

| 会话 | 当前任务 | 状态 |
|---|---|---|
| 需求 | M1 完成；M1.1 已细化（REQ-20261025-02），待 M1 结项后由 00 排期；T9 成本归属待排期 | 待排期 |
| 开发 | T1–T8 + 三轮复核完成；版本见 package.json；等重启验收 | idle |
| 审核打包 | 待命（T6/T7 后独立复核） | idle |

## 进度

- **T1（E1/E2）**：通过。事件级感知、摘要可读、无拦截型前钩子。
- **T2（记忆）**：完成。`packages/dsh-context-governance/`；`mem_write`/`mem_query`。
- **T3（压缩适配与保护）**：离线完成。适配器/自检/保护校验/降级/观测循环；文档 `docs/T3-压缩适配与保护.md`；审计 `analysis/t3/`。
- **T4（压缩前固化与回注）**：离线完成（S4=B）。5 类保护项同步 journal、end 后 microtask 回注、失败降级、audit；文档 `docs/T4-压缩前固化与回注.md`。
- **T5（状态命令与审计）**：离线完成。`/cg status`（后端/能力/记忆/上次压缩与回注/p50p95/审计）；审计字段白名单 + 脱敏；文档 `docs/T5-状态命令与审计.md`。
- **T6（失败与降级）**：离线完成（v0.1.4）。审计 8 MiB 轮转（可配）、五类只读判据 + 恢复探测、事件流中断/卸载留痕、所有失败只 log/audit 不抛宿主；文档 `docs/T6-失败与降级.md`。
- **T7（验收场景）**：离线完成（v0.1.5）。S1–S6 全部用例 + S4 A/M/I/F/AUD/R；真实**自动+手动**压缩双样本脱敏回放；只读人工脚本 `docs/T7-只读降级人工验证.md`；覆盖表 `docs/T7-验收场景-S1-S6.md`。
- **T8（回注自愈 + 成本归属）**：离线完成。ROB-01/06 改为“每次失败留审计、连续 N 次才降级、降级仍可回注、下一周期自愈”；新增 `compaction-cost` 审计（REQUIREMENTS A 字段，token 实测/估算分列，不记金额）；三轮复核后 fixture 改结构白名单、commands 晚挂载重试、shadowedRange 兜底；文档 `docs/T8-回注自愈与成本归属.md`、`docs/T8-复核三轮修复.md`。
- **测试**：全量**通过**（数量见 `node --test "test/*.test.mjs"` 输出；T8 新增成本 4 + 自愈 1，三轮复核新增 commands 晚挂载 + shadowedRange 兜底）。
- **真机**：已安装（deps 14 / bundles 17 / redirect 0.1.0-context-zip / junction 已建）。v0.1.6 已验证 `mem_write`/`mem_query` 注册、`perception=event`、能力行、`audit.jsonl`；v0.1.9 待下次重启验收（`version=<package.json>`、`events=N` 增长、`compaction-cost`、审计轮转、只读脚本；S3 默认关）。
- **T6/T7/T8**：均离线完成；真机验收项列在“下一步”。

## 已知风险（当前无）

- T8-1 已修复 ROB-01/06：回注失败不再永久停写，改为“每次失败审计 + 连续 N 次降级一个周期 + 下一周期自愈”，`reinjection-recovered` 可审计。

## 已知偏差（已接受）

T4 回注时点：checkpoint→end 之间不可实现，改为 end 后首个 microtask（同 tick、下一轮前）；用户已接受，`DEC-PLUGIN-20261025-09`。

## 等待用户/外部

- **真插件安装**：已完成结构安装（junction 指向源码，改完重启即生效）；开发不重启。
- M1.1 / T9：已细化，待 M1 结项后由 00 排期；现在不派活。
- 暂存：GitHub 发布用的仓库地址与账号（发布前需要）。

## 阻塞

- 无（v0.1.9 重启验证由用户执行；只读演练需人工制造不可写根，开发不自行改动安装态）

## 下一步

1. 用户一次性重启 → 校验 `version=<package.json>`、`perception=event event-api=on`、`events=N` 随真实压缩增长、`audit: … rotations=…`。
2. 用户按 `docs/T7-只读降级人工验证.md` 跑一次只读演练（制造不可写根 → read-only → 恢复）。
3. S3 header 默认关闭；要启用需用户拍板改 `memoryHeader.enabled`。
4. 00 转用户验收 → 审核打包独立复核（版本三处已收敛为一处）。
5. M1 结项后 00 排 T9 + M1.1；之后再议新需求。