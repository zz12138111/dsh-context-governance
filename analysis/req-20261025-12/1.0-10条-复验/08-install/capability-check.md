# #8 第二 profile 可行性预检（不装插件）

- 时间：2026-10-26（桌面实例运行中；全程未重启/未改 desktop）
- 目标：确认可在**不碰 desktop** 的前提下创建并独立启动第二个 profile；失败即门禁 E 不通过。
- 结论：**通过**。两个一次性 profile 均独立进程/端口/URL/profile 目录；desktop 三快照完全一致。

## 1. 能力验证 A：一次性空 profile `cg-cap-test`

命令级步骤（PowerShell）：
```powershell
# 1) 记录 desktop 快照（package hash / patch hash / plugin junction / node_modules 顶层数 / bundles 数）
# 2) 从 shipped web 模板复制（不 boot、不 pnpm）
Copy-Item "$env:USERPROFILE\.dsh\profiles\web" "$env:USERPROFILE\.dsh\profiles\cg-cap-test" -Recurse
# 3) 独立启动（独立端口 18779）
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
Start-Process $dsh -ArgumentList @('--profile','cg-cap-test','--port','18779','--no-open') ...
```
输出：
- stdout：`dsh web: http://127.0.0.1:18779/?token=<redacted>`
- `Get-NetTCPConnection -LocalPort 18779 -State Listen` → `127.0.0.1:18779` 1 条；
- 进程：`DeepSeek Harness.exe` pid 32812，父 12484，命令行含 `--profile cg-cap-test --port 18779 --no-open`；
- profile 目录：`C:\Users\19091\.dsh\profiles\cg-cap-test`，`node_modules` 无 `dsh-context-governance`。
- 停止：`taskkill /PID 12484 /T /F` → 端口无监听；删除 profile；无 `root-state-cg-cap-test.json`。
- desktop 快照：`desktop-before.json` / `desktop-during.json` / `desktop-after.json` **完全一致**
  （package hash `B588DA62…C8BE`、patch hash `1F577744…7AE0`、plugin junction true、node_modules 145、bundles 17）。

## 2. 能力验证 B（正式演练 profile）`cg-install-test` 空 profile 预检

- 从 shipped `web` 模板复制；只把 package.json `name` 改为 `dsh-profile-cg-install-test`；**未装插件**。
- 启动：`dsh --profile cg-install-test --port 18769 --no-open`：
  - stdout：`dsh web: http://127.0.0.1:18769/?token=<redacted>`；
  - `Get-NetTCPConnection -LocalPort 18769 -State Listen` → `127.0.0.1:18769` 1 条；
  - 进程：`DeepSeek Harness.exe` pid 14636，父 24480，命令行含 `--profile cg-install-test --port 18769 --no-open`；
  - profile 目录存在且 `node_modules\dsh-context-governance` 不存在；
  - 无 `root-state-cg-install-test.json`（未加载插件/未推断）。
- 停止：`taskkill /PID 24480 /T /F` → `Get-NetTCPConnection -LocalPort 18769` **no listen**。
- desktop 快照：`desktop-pre-check-before.json` / `desktop-pre-check-during.json` /
  `desktop-pre-check-after.json` **完全一致**（同上五个字段）。
- `cg-install-test` profile **保留为空 profile**，供安装演练继续使用（未删、未装）。

## 3. 隔离性与回滚结论

| 项 | 结果 |
|---|---|
| 独立进程 | 是（`--profile cg-cap-test/cg-install-test` 各自父/子进程，与 desktop 进程树无关） |
| 独立端口/URL | 是（18779/18769，均由对应实例独占监听；停止后无 Listen） |
| 独立 profile 目录 | 是（`~/.dsh/profiles/<profile>`，不读写 desktop 目录） |
| desktop 三快照 | **完全一致**（package hash / patch hash / plugin junction / node_modules 顶层数 / bundles 数） |
| 是否使用 `dsh plugin add/remove` | **否** |
| 演练临时 profile | `cg-cap-test` 已删；`cg-install-test` 保留为空 profile 待安装 |

> 备注：`dsh --help` 显示支持 `--profile <name>` / `--from-default-profile <name>` / `--patch`；
> 本次用 shipped `web` 目录复制建 profile（与历史 `native-test` 同法），CLI 启动独立实例成立。
> 证据文件：本目录下 `desktop-*.json`、`precheck-instance.log`（已脱敏 token）、`precheck-pid.txt`。
