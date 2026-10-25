# CI 敏感扫描接入说明（REQ-12 T2）

> 状态：**已获用户批准接入第三方 Action**（2026-10-26）；工作流文件已放到 `.github/workflows/security.yml`，**待 00 复核目录结构后随下一次推送生效**。
> 红线：CI 失败即阻发布；不可 `--no-verify` 绕过（CI 在 push/PR 上运行，本地 hook 跳过不影响 CI）。

## 工作流做什么

| 步骤 | 命令 | 作用 |
|---|---|---|
| 单元测试 | `node --test "test/*.test.mjs"`（工作目录 `packages/dsh-context-governance`） | 功能回归 |
| 仓库合规扫描 | `node scripts/compliance-scan.mjs --strict` | 本地兜底规则：凭据/路径/会话 id/许可/产物；**只拦 blocker** |
| gitleaks 全历史 | `gitleaks/gitleaks-action@v2` | 凭据硬门禁（历史提交也扫） |

## 启用与失败处理

- 推送到任意分支/PR 即触发；分支保护开启时可将 `security` 设为必需检查。
- **私有仓库 Actions 额度/许可**：若 Actions 跑不起来或 gitleaks 需要 license：
  - 由仓库 secret `GITLEAKS_LICENSE` 提供（**凭据不进仓库**）；
  - 若仍不可用，按需求 `6005e7c` 的替代方案：**本地 `compliance-scan --strict` + 发布 checklist 标注**，且该替代需用户批准。
- 失败即停：任何一步失败都视为发布门禁未过。

## 边界

- 不上传仓库内容到第三方（gitleaks Action 只在 runner 内执行）；
- 不自动发布、不打 tag、不创建 Release；
- 新增/修改该工作流视为仓库结构变更，需 00 复核后推送。
