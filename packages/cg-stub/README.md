# cg-stub · 最小装载探针

> **这不是产品，也不发布。** 它唯一的目的是验证一件事：**本机 DSH 宿主能不能装载一个本地 Cordis 插件**（profile 依赖 → bundle patch → 加载树行 → `apply()`）。
> 验证通过后，用真正的 `dsh-context-governance` 替换它；验证失败时，问题一定在装载通道，不在业务代码——因为本文件**不 import 任何 `@deepseek-ai/*` 包**。

## 它做什么（全部）

1. 往 `D:\DS-PROJECT\DSH插件开发\logs\cg-stub.log` 追加**一行**启动记录：
   `时间 cg-stub apply version=0.0.1 pid=… enabled=true observer=registered(count-only) cwd=… log=…`
2. 注册一个 `ctx.on('session/event')` 观察器：**只在内存里计数**，不产生任何输出或副作用。
   不读摘要、不读 session、不写记忆、不注册工具、不改配置、不发网络请求。

配置非法也只反映在日志的 `enabled` / `observer` 字段里，`apply()` 不抛错、不阻塞宿主启动。

## 包信息

| 项 | 值 |
|---|---|
| 包名 | `@local/dsh-cg-stub` |
| 版本 | `0.0.1` |
| 入口 | `index.mjs`（纯 ESM，零依赖） |
| 宿主声明 | `engines.dsh = ">=0.2.1-rc.2 <0.3.0-0"`；peer 仅作声明且标 `optional`（避免 pnpm 往 profile 落宿主包副本） |
| bundle patch | `cordis.patch.yml`：插入一行 `id=cg-stub`，`name=@local/dsh-cg-stub` |
| 日志 | `D:\DS-PROJECT\DSH插件开发\logs\cg-stub.log`（`cordis.patch.yml` 里显式钉住；换机器改这一行） |

## 安装（推荐路径：`dsh plugin add`，自动登记 bundle）

> 前提：**完整退出 DSH**（不是关窗口）；下面的命令全部在普通 PowerShell 里跑，不要用管理员，不要动 `cordis.patch.yml`。

```powershell
# 0) 先确认没有 DSH 进程（应当没有输出）
Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' } | Select-Object Id,ProcessName

$dsh  = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$stub = 'D:\DS-PROJECT\DSH插件开发\packages\cg-stub'
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'

# 0.5) 装前留三份可回滚副本（不会覆盖已有 .bak-*）
foreach ($f in 'package.json','cordis.patch.yml','pnpm-lock.yaml') {
  $src = Join-Path $prof $f
  if (Test-Path $src) { Copy-Item $src "$src.bak-cg-stub" -Force }
}

# 1) 装成本地 link: 依赖（会跑 desktop 自带 pnpm）
& $dsh plugin --profile desktop add $stub

# 2) 核对：依赖、bundle、入口文件三者都在（应输出三行 True）
$m = Get-Content (Join-Path $prof 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$m.dependencies.PSObject.Properties.Name -contains '@local/dsh-cg-stub'
$m.dsh.profile.bundles -contains '@local/dsh-cg-stub'
Test-Path (Join-Path $prof 'node_modules\@local\dsh-cg-stub\index.mjs')
```

如果第 2 步有人为 `False`：`add` 没完成（看它自己的 stderr 与 `${prof}\.plugin-manager\logs\operation-*\pnpm.log`），**先不要重启**，按下文“装完必做”恢复 redirect 后再排查。

### 备用手动 patch（仅在 bundles 没自动登记时）

本包的 `cordis.patch.yml` 会自动被 bundle 机制读入，**正常路径不需要改 profile 的 `cordis.patch.yml`**。只有 `dsh plugin add` 成功装上了依赖、但 `dsh.profile.bundles` 里没有它时，才把下面这段**追加**到 `C:\Users\19091\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
- insert:
    - id: cg-stub
      name: "@local/dsh-cg-stub"
      config:
        enabled: true
        logFile: "D:/DS-PROJECT/DSH插件开发/logs/cg-stub.log"
```

> 不要“bundle 已登记”和“profile patch 手加”同时做：同一 `id` 被插入两次会让加载树出现重复行。

## 装完必做（pnpm 已知坑）

`dsh plugin add/remove` 会跑 pnpm；pnpm 会把 profile 里手动放着的 **context-zip 接管 redirect**（`node_modules\@deepseek-ai\dsh-compaction-basic`，版本 `0.1.0-context-zip`）当成多余包挪进 `node_modules\.ignored\@deepseek-ai\dsh-compaction-basic*`。
**缺了它，压缩会静默退回官方 `compaction-basic`**（不报错，行为悄悄变了），所以每次 add/remove 后都要复检：

```powershell
# 3) 复检（必须看到 OK compaction redirect 0.1.0-context-zip）
pwsh -NoProfile -File 'D:\DS-PROJECT\_shared\check-env.ps1'
```

若出现 `WARN compaction redirect missing`，用下面脚本从 `.ignored` 挑出版本正确的副本移回，再跑一次 check-env：

```powershell
$nm   = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'
$live = Join-Path $nm '@deepseek-ai\dsh-compaction-basic'
if (-not (Test-Path (Join-Path $live 'package.json'))) {
  $cand = Get-ChildItem (Join-Path $nm '.ignored\@deepseek-ai') -Directory -Filter 'dsh-compaction-basic*' -ErrorAction SilentlyContinue |
    Where-Object { (Get-Content (Join-Path $_.FullName 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version -eq '0.1.0-context-zip' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $cand) { throw '没有找到 0.1.0-context-zip 副本：先停手报 00，不要重启。' }
  New-Item -ItemType Directory -Force (Split-Path $live -Parent) | Out-Null
  Move-Item -LiteralPath $cand.FullName -Destination $live
}
(Get-Content (Join-Path $live 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version   # 期望 0.1.0-context-zip
Test-Path (Join-Path $live 'base.js')                                                          # 期望 True
pwsh -NoProfile -File 'D:\DS-PROJECT\_shared\check-env.ps1' | Select-String 'compaction redirect'
```

## 装载成功判据

**唯一最小判据**：完整重启 DSH 后，`logs\cg-stub.log` 末尾出现一行新时间戳的 `cg-stub apply version=0.0.1 pid=<新进程 pid>`，并且 `pid` 与当前 `Get-Process 'DeepSeek Harness'` 的某个 pid 一致：

```powershell
Get-Content 'D:\DS-PROJECT\DSH插件开发\logs\cg-stub.log' -Tail 5
```

- 有 `apply` 行 → 装载通道通（profile 依赖解析 → bundle patch → 行 → apply 全部成立）；行里的 `observer=registered(count-only)` 表示 `ctx.on('session/event')` 注册成功。
- 没有 `apply` 行 → 装载通道断；先看 `dsh.profile.bundles`、profile `node_modules\@local\dsh-cg-stub`、pnpm 日志，再看 DSH 自己的失败信息（见“失败模式”）。

可选：设置 → 插件页应能看到 `@local/dsh-cg-stub`（插件管理面按 profile bundle 枚举；看不到也不影响上面的日志判据）。

## 回滚

```powershell
# 1) 完整退出 DSH
Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' } | Select-Object Id,ProcessName

# 2) 卸依赖（会自动从 dsh.profile.bundles 移除）
$dsh  = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
& $dsh plugin --profile desktop remove '@local/dsh-cg-stub'

# 3) 若曾用“备用手动 patch”：从 cordis.patch.yml 删掉那段 insert（改前先复制一份 .bak）
# 4) 装完必做：check-env + 必要时移回 redirect（同上）
# 5) 核对依赖与 bundle 都没了（应输出两行 True）
$m = Get-Content (Join-Path $prof 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
-not ($m.dependencies.PSObject.Properties.Name -contains '@local/dsh-cg-stub')
-not ($m.dsh.profile.bundles -contains '@local/dsh-cg-stub')

# 6) 重启 DSH；cg-stub.log 不应再出现新行（旧行保留，可手动删日志文件）
```

若 `remove` 失败：先按“装完必做”恢复 redirect，**不要重启**；再用装前副本恢复 `package.json`（或手动删 dependency/bundles 两项），删掉 `node_modules\@local\dsh-cg-stub`（link），最后再恢复一次 redirect 并重启。

## 失败模式（预期只能有这两类）

1. **`dsh plugin add` 失败或 bundle 没登记**：pnpm 报错 / DSH 未完全退出导致 profile 锁超时 / `engines.dsh` 与宿主版本不符（本机应为 `0.2.1-rc.2`）。处置：看命令 stderr 与 `${prof}\.plugin-manager\logs\operation-*\pnpm.log`；不要反复重跑，先恢复 redirect 再排查。
2. **命令成功、但重启后没有 `apply` 行**：加载树没读到行。先查 `dsh.profile.bundles` 是否含本包；再查 profile `node_modules\@local\dsh-cg-stub`；若两者都在，看宿主启动失败信息（CLI 路径会写 `%USERPROFILE%\.dsh\logs\startup-*.log`；桌面版从应用自己的错误提示/日志找）。这一档正是本桩要暴露的通道问题。

## 桩代码自检（不碰宿主）

在安装前可先确认 `index.mjs` 自身可运行（只写一份自检日志，不读宿主）：

```powershell
node --input-type=module -e "import('file:///D:/DS-PROJECT/DSH插件开发/packages/cg-stub/index.mjs').then(m => m.apply({ on: () => {} }, { enabled: true, logFile: 'D:/DS-PROJECT/DSH插件开发/logs/cg-stub.selftest.log' }))"
Get-Content 'D:\DS-PROJECT\DSH插件开发\logs\cg-stub.selftest.log' -Tail 1
```
