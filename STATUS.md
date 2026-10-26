# DSH 插件开发 · 当前状态

> 只放“现在还活着”的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-26 20:30（**P4 隔离演练已执行；门禁 E 未签收**；全量 **486/486 ×3**；`1.0.0` 未发布、未 push、**未闭环**）

## 当前（B 方案 · P4）

- **任务**：`dsh-context-governance` 改为全局上下文治理层（B 方案：纳管所有可判定根），P1→P4 分层交付。
- **P1/P2/P3**：已签。P3 实现 `573b7d9`、只读披露补签 `28dd40f`；全量 486/486。
- **P4**：方案 `57bc4e3`；隔离演练 `analysis/req-20261025-12/P4-drill-20261026-200123/`；报告 `docs/发布演练-安装卸载回滚.md`。
- **未做/不可做**：未 push、未打 tag、未转公开仓；桌面安装/重启由用户另行批准。

### P4 结果（数字）

| Phase | 结果 | 关键数字 |
|---|---|---|
| 预检/包面 | 过 | 36 文件 / 0 test / 0 本机路径 |
| A fresh | 过 | deps 0→1→0；bundles 2→3→2；项目文件 2 files/53 bytes |
| B 迁移 | 过 | v1→v2；`.v1.bak` 字节一致；重启不重推 |
| B 多根 | 过 | A/B 两真实根；`roots: 2 (active=2)`；A 仍 primary |
| B `/compact` | 真触发 | A/B 各 protection/materialized/reinjection/cost；同时有 `compaction-loss` |
| B 兼容回滚 | 过（仅兼容） | v0.2.1 单根；artifacts 14→14；4 files/106 bytes |
| B 卸载 | 过 | 14→14；4 files/106 bytes |
| C configRoot | 主体过 | outer/outside 2 根；nested 不立根；`primaryRoot=null`（计划原写 outer） |
| C 只读 | 过 | 精确 `protection=unavailable` + `b1-host-native-unprotected` |
| C 卸载 | 过 | artifacts 6→6；3 files/108 bytes |
| 观察项 | 留证 | orphan 无真机样本（B2d）；EBUSY 3 次 486；只读精确披露 |
| teardown | 过 | 三端口无监听、无 p4-* 进程、worktree/profile 已删 |

### P4 门禁 E：未签收

1. **desktop 进程 ID 不一致**：package/patch/deps/bundles/junction 全一致；`14924` 被宿主子进程替换（后为 `15784`），进程数仍 7。未重启 desktop、未改配置；不写成“全部字段一致”。
2. **configRoot `primaryRoot`**：实测 `null`，计划 §5.2 原写 outer；P1 设计/测试明确 config 不得改写持久化主根。**计划判据与 P1 冻结口径冲突**，需用户/审核决定改哪一边，不能把 null 写成 outer。
3. **migrate profile-after**：收尾补采，非卸载当时；关键字段与 before 一致，已标 `recoveredAt`。
4. **测试抖动**：正式三连前有两次瞬时失败（P3 时序、P2 清理 ENOTEMPTY），重跑通过；未改测试，不宣称零抖动。
5. **`/compact` 保护校验**：四件套已触发，但 `compaction-loss` 失败项（latest-user-message/rule-injection/rollback-point）存在；不写“保护全过”。

## 分层状态

- **P1**：已签（`73849f3`）；可判定根 registry、state v2、根 audit、configRoot 强制合并、containment。
- **P2**：已签（`3e30f22` + 签收 `1d23552`）；每根 store/锁/审计、`mem_*` 按根。
- **P3**：已签（`573b7d9`；补签 `28dd40f`）；RootGuardPool、每根保护/回注/header/early/只读披露/orphan 归档。
- **P4**：执行完成、未签收；发布文档已改写，等审核 + 用户验收。

## 待决策 / 下一步

1. **门禁 E 偏差处置**：configRoot `primaryRoot` 改计划判据还是改设计；desktop 进程 ID 是否要求在停用窗口复采；migrate after 补采是否接受。
2. 审核打包独立复跑 486/486 + 包面 36/0，复核发布文档。
3. 用户验收；通过后才谈发布/打 tag/推送。
4. 不把 P4 结果写成功能闭环；不宣称 orphan GC、EBUSY 零抖动、完整回滚。

## 历史（归档）

- P3 细节：`docs/P3-实现说明.md`（含 P4 结果 §7）。
- P2/P1 细节：`docs/P2-交付说明.md`、`docs/P1-交付说明.md`。
- 0.2.x 版本说明：`docs/0.2.4-发布说明草稿.md`（已标历史，单根语义不得用于 1.0）。
