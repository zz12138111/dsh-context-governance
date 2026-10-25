# REQ-12 · 1.0 发布就绪计划（审核打包）

> 依据：`TASKS/REQ-20261025-12-发布就绪-拆解.md`；`docs/1.0-状态定义-v1.md`；00 2026-10-26 指示「只准备、不做公开动作」。
> 基线：HEAD `5f83d10`（0.2.4 T1 已交），全量 316/316（待复核）；干净包脚本 `6ce6e8b`、扫描 `28f749e` 已复核。
> 红线：不发 Release、不推 tag、不建远端、不碰真机 `desktop` profile；演练只在隔离 profile。

## 1. 四项计划

| # | 任务 | 产出路径 | 依赖 0.2.4？ | 现在可做？ |
|---|---|---|---|---|
| T2 | CI 敏感扫描 | `.github/workflows/security.yml`（已移入）+ `docs/CI-敏感扫描-接入说明.md` | **不依赖** | ✅ 用户已批准；**待 00 复核目录后随推送生效** |
| T3 | 兼容矩阵 | `docs/兼容矩阵-1.0.md` | **不依赖** | ✅ 已出（待补 0.2.2/context-zip 复跑证据） |
| T4 | 安装/卸载/回滚演练 | `docs/发布演练-安装卸载回滚.md`（方案）+ 证据 `analysis/req-20261025-12/drills/` | **不依赖**（用当前 HEAD 包或 v0.2.1 基线包即可预演） | ✅ 方案已出；隔离轮已批准，我用 `test-ui`（端口 18769） |
| T5 | Release notes + 已知限制 | 草稿 `release-drafts/Release-notes-1.0-draft.md` | **依赖**：默认开文案（已有 §4.5 必需段落）、**最终命令名**、R-2 真机证据、0.2.4 四项复核结论 | ⚠️ 可先搭骨架（占位符） |
| T6 | 发布 checklist + tag 流程 | `docs/发布checklist-1.0.md` | 部分依赖（版本号从 `package.json:0.2.1` → `1.0.0`；tag 需用户批） | ✅ 可出草稿，勾选项随 T1–T5 更新 |

## 2. 依赖 0.2.4 定型的具体项

1. **命令名**：`/cg compact arm|disarm` 是建议名，开发可改——T5 发布文案与 T6 checklist 里的命令必须用复核后的实际名。
2. **默认开文案**：`docs/review-1.0-发布口径-检查项.md` §4.5 已定必需段落；待 0.2.4 实现后确认 UI/status 字样与文案一致。
3. **R-2 真机证据**（隔离 profile ≥1 次真实提前压）：T5 的「已知限制/已验证」段落与 T6 门禁勾选依赖它。
4. **版本号**：`packages/dsh-context-governance/package.json` 仍是 `0.2.1`；1.0 发布须改为 `1.0.0`（开发提交、我复核）。
5. **engines 范围**：`engines.dsh = ">=0.2.1-rc.2 <0.2.2-0"` 与「支持 0.2.x」的矩阵口径**不一致**（`0.2.2` 被排除）；发布前必须统一（改 engines 或改矩阵），见 `docs/兼容矩阵-1.0.md` §4。

## 3. 现在就能做（本轮已做/待做）

- ✅ T3 兼容矩阵草稿（`docs/兼容矩阵-1.0.md`）；
- ✅ T4 演练方案（`docs/发布演练-安装卸载回滚.md`）；
- ✅ T2 CI 草稿（`release-drafts/ci/`，未启用）；
- ⏭ T6 checklist 草稿（下一批，等 T5 骨架成形一起）；
- ⏭ T4 **执行**：隔离 profile（`native-test` 或 `desktop-test-contextzip`）演练，产出证据目录；需用户/00 给窗口与批准（安装动作即使隔离，也按「动插件」红线报批）。

## 4. 缺什么（请 00 去要）

### 需要用户批准
1. **CI 第三方 Action**（gitleaks 或 trufflehog）引入 + 私有仓库 Actions 启用；是否允许联网拉取镜像/Action。
2. **T4 演练执行窗口**：允许在隔离 profile 安装/卸载/回滚（不碰 `desktop`）。
3. （后续）1.0 tag 名与打 tag 授权、Release 发布授权——本轮不执行。

### 需要开发交付/确认
4. 版本号 `1.0.0` + `REQUIREMENTS/STATUS` 同步。
5. ~~`engines.dsh` 范围定稿~~ **已定（审核 2026-10-26）**：维持 `>=0.2.1-rc.2 <0.2.2-0`；矩阵明确“0.2.2 未验、不支持”。**post-1.0 任务**：拿到 0.2.2 构建 → 隔离复跑 → 放宽 engines（另开提交，不在 1.0 内）。
6. 0.2.4 最终命令名与 status 字样。
7. R-2 真机证据（隔离 profile 的 `early-forced` + `compaction-cost` + status 原文）。
8. **context-zip 复跑（已定：并入 T5 隔离轮）**——用 `desktop-test-contextzip` 跑一次 G2-A，验后端识别与成本字段；无 redirect 则如实报无法复跑。

### 需要环境/素材
9. v0.2.1 基线包：`D:\DS-PROJECT\_backup\dsh-plugins-v0.2.1\`（plugin zip + source zip + manifest）——回滚演练要用。
10. 隔离 profile：`native-test` / `desktop-test-contextzip`（已存在）；演练用哪个由 00 指定。
11. Node ≥22.19、Windows；`compliance-scan` 本地兜底已具备。

## 5. 判定与收口

- T1 干净包：**必须以 1.0 tag 为基线**（不是 HEAD）——tag 未批前只能预演，最终包待 tag 后重导。
- T2/T3/T4/T6 的产物都只是**本地草稿**；公开物（Release、公开仓库、镜像）仍需用户另行批准。
