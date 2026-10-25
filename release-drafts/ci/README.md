# CI 敏感扫描（REQ-12 T2）· 草稿，未启用

> 为什么放在 `release-drafts/` 而不是 `.github/workflows/`：引入第三方 Action 需要**用户批准**（REQ-12 红线）。放在这里不会被 GitHub 触发；批准后移动到 `.github/workflows/security.yml` 即生效。

## 启用步骤（需批准）

1. 用户批准：① 引入 `gitleaks/gitleaks-action`（或 trufflehog）；② 私有仓库 Actions 可用；③ 若 gitleaks 私有仓库需要 license，提供 `GITLEAKS_LICENSE` secret（**这是凭据，不进仓库**）。
2. 把 `security-workflow.yml` 移到 `.github/workflows/security.yml`。
3. 推一次 PR/分支验证跑绿；失败则回退该文件（不 force-push）。

## 门禁设计

- **不可 `--no-verify` 绕过**：CI 在 push/PR 上运行，本地 hook 的跳过不影响 CI；仓库分支保护（如启用）可要求该检查通过。
- **三层**：
  1. `node --test` 全量测试（当前 316/316）；
  2. `node scripts/compliance-scan.mjs --strict`（本地兜底扫描，**只拦 blocker**；review 需人工）；
  3. gitleaks 全历史扫描（凭据硬门禁；与本地扫描互补）。
- 产物：扫描报告上传为 artifact（保留 7 天），便于复核。

## 备选

- `trufflehog`：`trufflesecurity/trufflehog`（`--only-verified` 减少误报）；
- 若不允许第三方 Action：改为**自托管脚本**（`scripts/compliance-scan.mjs` 已具备），但只覆盖本仓库规则，不如 gitleaks 全。

## 不做什么

- 不自动发布、不打 tag、不创建 Release；
- 不上传仓库内容到第三方（gitleaks Action 只在 runner 内执行）。
