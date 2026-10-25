# DSH 插件开发 · 当前状态

> 只放"现在还活着"的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-25（v0.1.3 感知语义修正 + 能力探测 + 审计 apply 留痕；待用户重启验证）

## 在办

| 会话 | 当前任务 | 状态 |
|---|---|---|
| 需求 | M1 已拆；E1/E2 已回写 §6.3；S4=B 已拍板 | 完成 |
| 开发 | T1–T5 离线完成；v0.1.3（感知语义 + 能力探测）源码就绪；待重启 | idle |
| 审核打包 | 待命（T6/T7 后独立复核） | idle |

## 进度

- **T1（E1/E2）**：通过。事件级感知、摘要可读、无拦截型前钩子。
- **T2（记忆）**：完成。`packages/dsh-context-governance/`；`mem_write`/`mem_query`。
- **T3（压缩适配与保护）**：离线完成。适配器/自检/保护校验/降级/观测循环；文档 `docs/T3-压缩适配与保护.md`；审计 `analysis/t3/`。
- **T4（压缩前固化与回注）**：离线完成（S4=B）。5 类保护项同步 journal、end 后 microtask 回注、失败降级、audit；文档 `docs/T4-压缩前固化与回注.md`。
- **T5（状态命令与审计）**：离线完成。`/cg status`（后端/能力/记忆/上次压缩与回注/p50p95/审计）；审计字段白名单 + 脱敏；文档 `docs/T5-状态命令与审计.md`。
- **测试**：全量 **127/127 通过**（T2 40 + T3 56 + T4 15 + T5 7 + 感知/能力探测 9）。
- **真机**：已安装（deps 14 / bundles 17 / redirect 0.1.0-context-zip / junction 已建）。v0.1.0 矩阵过窄落 `observe-only`；v0.1.1 `inject` 加 `compaction` 导致 pending；v0.1.2 撤 inject 后 apply 成功，但 `perception` 取契约值 `none`（`mode=event-level`）。**v0.1.3**：`perception` 改为“订阅成功才算 event”、apply 写能力探测行、审计 apply 即建文件；等重启验证 `perception=event event-api=on` 与 `audit=…`。
- **T6/T7**：未开工（故障注入扩展；S1–S6 + S4 用例）。

## 已知偏差（已接受）

T4 回注时点：checkpoint→end 之间不可实现，改为 end 后首个 microtask（同 tick、下一轮前）；用户已接受，`DEC-PLUGIN-20261025-09`。

## 等待用户/外部

- **真插件安装**：已完成结构安装（junction 指向源码，改完重启即生效）；开发不重启。
- 暂存：GitHub 发布用的仓库地址与账号（发布前需要）。

## 阻塞

- 无（v0.1.3 重启验证由用户执行；T6 可离线继续）

## 下一步

1. 用户重启 → `logs\governance.log` 应有两行：`governance capability version=0.1.3 … probe=on=fn,events=obj(dispatch=fn),…`（看 `events`/`get.sessions` 是否 `absent`）与 `governance apply version=0.1.3 … mode=event-level … perception=event event-api=on audit=<path> … warning=provider-unavailable`；再跑 `/cg status` 看 `event-api=on` 与 `events=N`。
2. 开发做 T6（故障注入/审计轮转/只读降级）；若能力探测显示事件面不可订，再按探测结果改走注入路线。
3. T7 验收（S1–S6 + S4 用例）→ 审核打包复核 → 00 转用户验收。


