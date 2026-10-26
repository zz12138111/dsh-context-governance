# DSH 插件开发 · 当前状态

> 只放“现在还活着”的：在做什么、卡在哪、待谁决策。过期项直接删。
> 更新：2026-10-26 22:05（**1.0 收口；P4 已签；§16 已满足**；`1.0.0` 未发布、未 push、未打 tag）

## 当前（B 方案 · 1.0 收口）

- **任务**：`dsh-context-governance` 改为全局上下文治理层（B 方案：纳管所有可判定根），P1→P4 分层交付。
- **P1/P2/P3**：已签。P3 实现 `573b7d9`、只读披露补签 `28dd40f`；**P3 已重签**：缺陷修复 `09130f6`（10 files +386/−40）后全量 **488/488**（`p3-fix-full-final.log` 1 次）；旧签 `ab44f29` 已被该缺陷打回。
- **P4 整体已签**：`66b9eb2`（报告口径）；增量证据在 `analysis/req-20261025-12/P4-drill-20261026-200123/rerun2/`。
- **§16 已满足**：`REQUIREMENTS.md:487`（commit `3f922e8`）；gap16 真机负向验收 ①②③ 经审核裁定有效；启动预算 **9/10**（8 有效 + 1 中止 0 证据）。
- **发布状态**：未发布、未 push、未打 tag、未转公开仓；桌面安装/重启由用户另行批准。**下一动作：等用户批 push（可能连带 §4.3 旧数字修正）。**

## P4 结果（数字）

| Phase | 结果 | 关键数字 |
|---|---|---|
| 预检/包面 | 过 | 36 文件 / 0 test / 0 本机路径 |
| A fresh | 过 | deps 0→1→0；bundles 2→3→2；项目文件 2 files/53 bytes |
| B 迁移 | 过 | v1→v2；`.v1.bak` 字节一致；重启不重推 |
| B 多根 | 过 | A/B 两真实根；`roots: 2 (active=2)`；A 仍 primary |
| B `/compact` | 过（rerun2） | A/B 双根四件套齐、无 `compaction-loss`；`count=4` / `moved=4` / `seq=62·66` |
| B 兼容回滚 | 过（仅兼容） | v0.2.1 单根；artifacts 14→14；4 files/106 bytes |
| B 卸载 | 过 | 14→14；4 files/106 bytes |
| C configRoot | 过 | outer/outside 2 根；nested 不立根；`primaryRoot=null` + `configRoot=outer` + `source=config` |
| C 只读 | 过 | 精确 `protection=unavailable` + `b1-host-native-unprotected` |
| C 卸载 | 过 | artifacts 6→6；3 files/108 bytes |
| 观察项 | 留证 | orphan 无真机样本（B2d）；EBUSY 旧阶段 486/486 ×3；只读精确披露 |
| 全量测试 | 过 | P3 fix 后 **488/488 ×1**（`p3-fix-full-final.log`） |
| teardown | 过 | 三端口无监听、无 p4-* 进程、worktree/profile 已删 |

## 已知限制（1.0）

1. **`/cg status` 是派生展示**：`last-compaction` 等状态行不是权威落盘；压缩触发以 per-root audit 的 `compaction-cost.trigger=manual` + compaction 事件（start/summary/end）为准。
2. **`MEMORY.md` 索引头必重写**：非只读打开 store 时 `store.js:182-194` 会 `#writeIndex()` 重建 `Updated` 头；sha/mtime 变化不代表记忆条目变更（length/条目/topics 需按语义核）。
3. **正常关闭不可验 + 审计字段缺口**：Windows 下无 `/F` 的 `taskkill` 对无窗口 console 进程被拒，`root-guard-disposed` 取不到；gap16 按 kill 路径接受。`memory-tool-rejected` 未落 `root/rootId`（`mem-tools.js:241-252` 只传 reason），**1.0.1 补**。

## 分层状态

- **P1**：已签（`73849f3`）；可判定根 registry、state v2、根 audit、configRoot 强制合并、containment。
- **P2**：已签（`3e30f22` + 签收 `1d23552`）；每根 store/锁/审计、`mem_*` 按根。
- **P3**：已重签（`573b7d9` + 补签 `28dd40f` + 修复 `09130f6`）；全量 488/488；旧签 `ab44f29` 打回。
- **P4**：整体已签（`66b9eb2`）；增量证据 `rerun2/`；已闭 `compaction-loss`，不再写“保护全过”。

## 待决策 / 下一步

1. 等用户批准 push（是否连带 `docs/发布演练-安装卸载回滚.md` §4.3 的 `count=3/moved=3 → 4/4` 修正）。
2. 未批准前不做任何 git 写操作、不 push、不打 tag、不启动实例。
3. 不宣称 orphan GC、EBUSY 零抖动、完整/多根回滚；不把 `status` 派生行写成权威。

## 历史（归档）

- P3 细节：`docs/P3-实现说明.md`。
- P4 细节：`docs/发布演练-安装卸载回滚.md`、`analysis/req-20261025-12/P4-drill-20261026-200123/`。
- P2/P1 细节：`docs/P2-交付说明.md`、`docs/P1-交付说明.md`。
- 0.2.x 版本说明：`docs/0.2.4-发布说明草稿.md`（已标历史，单根语义不得用于 1.0）。
