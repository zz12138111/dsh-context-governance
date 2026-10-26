# #8 安装/卸载/回滚演练记录（隔离 profile `cg-install-test`，2026-10-26）

> 执行人：开发；环境：Windows 11、DSH 0.2.1-rc.3、源包 1.0.0（HEAD `dc2da72`）。
> 全程未重启/未改 desktop；未对 desktop 运行 `dsh plugin add/remove`；未 push/tag。

## 0. 预检（先于安装）

- 空 profile `cg-install-test`（从 shipped `web` 模板复制）独立启动：
  pid 14636、`127.0.0.1:18769`、profile 目录独立、无插件/无状态文件。
- desktop 三快照（before/during/after）**完全一致**：package hash `B588DA62…C8BE`、
  patch hash `1F577744…7AE0`、plugin junction true、`node_modules` 145、bundles 17。
- 另一次 `cg-cap-test` 空 profile 独立启动（18779）后已删除；同样三快照一致。
- 详情：`capability-check.md`、`desktop-{before,during,after}.json`、`desktop-pre-check-*.json`。

## 1. 安装

| 项 | 结果 |
|---|---|
| 手法 | `file:` 声明 + junction + bundle 追加；**未跑 pnpm / 未用 `dsh plugin add`** |
| profile 状态 | deps **0→1**、bundles **2→3**、`pluginDep/bundle=true`、junction → 源包 |
| 启动 | `dsh --profile cg-install-test --port 18769 --no-open` → 监听 127.0.0.1:18769 |
| 插件加载 | diagnostics：`capability@apply version=1.0.0`、`apply version=1.0.0 … audit=… memory=…`、`capability@ready` |
| D9=A 根 | `/cg status`：`project-root: D:\DS-PROJECT\DSH插件开发 (source=inferred, inferred-fresh)` |
| 持久化身份 | `persistence-identity: … name=cg-install-test … path=C:\Users\19091\.dsh\context-governance\root-state-cg-install-test.json` |
| 状态文件 | 落**该测试 profile 身份路径**；内容 `root`/`source:"inferred"`/`inferredFromCwd`/`instance.profile="cg-install-test"`（副本+sha256 见本目录） |
| project basename | `memory: project=DSH插件开发`（包内 `project:""`，由推断根自动补） |
| memory/audit | `memory: root=D:\…\.tmp\cg-install-ws\memory\governance`；`audit: file=…\audit.jsonl`（与 desktop 隔离） |
| 版本/注册 | `version=1.0.0`；无 `registration failed`/`perception=none` |
| 未触发真实压缩 | 本轮未执行 `/compact`；**四件套未验证**，不写“已验”；引用既有 #1/#6 真机证据 |

证据：`install/state.before.json`、`state.after-install.json`、`package.before.json`、
`cordis.before.yml`、`root-state-cg-install-test.json`、`root-state.sha256.txt`、
`status-cg-install-test.txt`、`install-diagnostics.log`、`install-audit.jsonl`、`instance-install.log`（token 已脱敏）。

## 2. 卸载

| 项 | 结果 |
|---|---|
| 手法 | 停实例 → 只删 junction → 还原 `package.json`/`cordis.patch.yml`（不删源目录） |
| profile 状态 | deps **1→0**、bundles **3→2**、`pluginDep/bundle=false`、junction 不存在 = **state.before** |
| 重启后 | `--dump-config` 无 `dsh-context-governance`；无新 `governance apply` 日志（log mtime 停在卸载前） |
| `/cg` 命令 | 发送 `/cg status` 被当普通对话文本（未产生插件命令输出）→ 命令不存在（或仅 usage） |
| 源/记忆 | 源包目录完整；隔离记忆目录保留（未删） |
| 用户级状态文件 | `root-state-cg-install-test.json` **保留未删** |

证据：`uninstall/state.before-uninstall.json`、`state.after-uninstall.json`、`package.before-uninstall.json`、
`cordis.before-uninstall.yml`、`dump-config-uninstalled.txt`（`plugin-in-composed=False`，1231 行）、
`instance-uninstalled.log`（脱敏）。

## 3. 回滚 v0.2.1

| 项 | 结果 |
|---|---|
| 包来源 | `git worktree add --detach .tmp/drill-v0.2.1 v0.2.1`（f585434，`package.version=0.2.1`） |
| 安装 | junction → worktree 包；deps/bundles 追加；profile patch 给 v0.2.1 所需 `projectRoot`（仅隔离配置） |
| 启动 | 127.0.0.1:18770；apply 行 `version=0.2.1`、`capability@ready version=0.2.1` |
| 命令面 | `/cg` 已识别（错误输入返回 Usage）；`/cg status` 输出正常（**v0.2.1 的 status 不含 version 行**，版本以 apply 日志为准） |
| 记忆/header | `memory: project=cg-rollback-test`、隔离 memory/audit；无版本/契约错误 |
| 收尾 | 停实例 → 卸载 v0.2.1 → profile 回 `state.before`；worktree 已移除；18770 无监听 |

证据：`rollback/state.after-rollback-install.json`、`state.after-rollback-uninstall.json`、
`instance-rollback.log`（脱敏）、`rollback-diagnostics.log`、`rollback-audit.jsonl`、
`status-rollback-0.2.1.txt`。

## 4. 包面（发布契约）

- `package.json files` 已去掉 `test`；`npm pack --dry-run --json` → **30 个打包文件、0 个 test/**；
  对 30 个文件全文扫 `D:/DS-PROJECT|DS-PROJECT|C:\Users|19091|Users[\/]` → **0 命中**。
- `cordis.patch.yml` 默认：`projectRoot:""`、`project:""`、`logFile:""`、`memoryRoot:"memory/governance"`；
  README 示例无本机路径/用户名。
- `logFile` 空：`appendDiagnosticLine('')` 返回 false、不建文件不抛错；非空相对路径在 `resolveConfig`
  直接 `CONFIG` 拒绝（不会 `path.resolve` 到进程 cwd）；`install-8` 单测覆盖。
- 证据：`package-pack-files.txt`、`package-pack-scan.txt`、`06-*`（若另存）。

## 5. 收尾与残留

- 隔离 profile `cg-install-test` 已删除；18769/18770 均无监听；无 `drill-v0.2.1` worktree。
- **用户级状态文件按审核口径保留**：`C:\Users\19091\.dsh\context-governance\root-state-cg-install-test.json`
  （副本 `root-state-cg-install-test-final.json`；删除需备份+文档，未删）。
- desktop 最终快照 `desktop-final.json` 与预检前 `desktop-pre-check-before.json` **一致**。
- **未验证/不声称**：真实 `/compact` 四件套、外部会话 skip 未在隔离实例重复采样（引用 2b 已签真机证据）；
  Release 不得把这些写成已在本轮验证。
