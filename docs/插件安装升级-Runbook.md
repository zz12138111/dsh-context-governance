# 真插件安装/升级 Runbook（`dsh-context-governance`）

> 状态：**1.0 已执行（2026-10-26：隔离 profile 装/卸/回滚全过；见 `analysis/req-20261025-12/1.0-10条-复验/08-install/`）**。本文档由 00/用户照着操作；开发会话不安装、不重启、不改 `cordis.patch.yml`。
> 适用：DSH Desktop `0.2.1-rc.3`（asar；旧运行缓存可能显示 rc.2），profile 目录 = `<profile-dir>`（例如 `$DSH_HOME/profiles/desktop`）。
> 改动依据：2026-10-25 实测——`dsh plugin add` 会 prune（`Packages: -33`）、把 compression redirect 挪进 `node_modules\.ignored`、并用 `link:` 写 lock；本 Runbook **完全绕开 pnpm**。
> 相关：架构 §10“安装/升级约束”；`packages/dsh-context-governance/cordis.patch.yml`；`packages/cg-stub/README.md`（redirect 恢复脚本）。
>
> 路径约定：`<repo>` = 本插件源码/发布包所在目录；`<profile-dir>` = 目标 profile；`<shared>` = 校验脚本目录。


---

## 0. 方案与红线

**方案：`file:` 声明 + Windows junction 落位 + bundle 自动登记；不运行 pnpm。**

- profile `package.json`：
  - `dependencies["dsh-context-governance"] = "file:<repo>/packages/dsh-context-governance"`
  - `dsh.profile.bundles` 追加 `"dsh-context-governance"`
- `node_modules\dsh-context-governance`：目录 junction → 插件包目录。
- 插件包自带 `dsh.bundle.patch`，loader 会读 `cordis.patch.yml` 插入行；**不需要改 profile 的 `cordis.patch.yml`**。
- **不运行** `pnpm install`、`dsh plugin add/remove`；**不跑** `pnpm install --lockfile-only`（见 §1.3）。
- 红线：不 `RunAs`、不代点 UAC、不重启由开发执行；所有命令由 00/用户在自己会话里跑。

### 0.1 1.0 安装契约（D9=A / logFile / project / profile）

- **根来源（1.0 多根）**：发布包默认 `projectRoot: ""`（不预填本机路径）。`projectRoot` 为空时，每个会话按
  `session.header.cwd` 上溯最近含 `.git` 的祖先独立成根；`projectRoot` 非空时，其下会话**强制合并**到该根
  （`source=config`，嵌套 `.git` 不另立根），其外会话按自身 cwd 独立成根。根集合持久化为 **state v2**
  `<pc.home>/context-governance/root-state-<profile>.json`（`roots[rootId]`）；v1 自动迁移并留 `.v1.bak`。
  **重启沿用、不重新推断**；无法判定 = 该会话 `no-project-root` fail-closed，不猜主根、不落盘。
  `primaryRoot` 只作 v1 迁移锚点/展示；**config 不改写持久化主根**（移除配置后回落到它）。
- **logFile**：发布包默认 `logFile: ""`（关闭，不建文件、不报错、不写进程 cwd）。要采集安装/升级诊断时，
  在**用户 profile patch** 里配**绝对路径**；非空相对路径会被 `resolveConfig` 以 `CONFIG` 拒绝
  （避免 `path.resolve` 落到应用安装目录）。
- **project**：发布包默认 `project: ""`，运行期由推断出的项目根 `basename` 自动补；`/cg status` 的
  `memory:`、审计成本行、记忆条目 project 均显示该值。
- **/cg profile**：`/cg profile [status|reset|<batch|coding|review|research>]` 给**当前会话**打 profile 标签；
  只影响本会话、进程内不持久化（重启回配置/默认）。`/cg set profile=...` 会按未知键拒绝——**唯一入口是本命令**。
- **隔离安装结论**：`file:` 声明 + Windows junction + `dsh.profile.bundles` 登记，**不跑 pnpm / 不跑
  `dsh plugin add/remove`**；隔离 profile 演练通过装→验→卸→回滚 v0.2.1（见 §2.1 与 08-install 证据）。

---

## 1. 为什么是这套方式

### 1.1 `file:` 而不是 `link:`

- `link:` 是 pnpm 的“链接协议”，写进 lock 后会被后续 pnpm 操作重新解析；本次事故里 pnpm 同时把未登记的 `@deepseek-ai/dsh-compaction-basic` redirect 当 extraneous 挪走。
- `file:` 是“本地目录依赖”的标准声明；本 Runbook 不跑包管理器，运行时由 junction 满足 Node 解析。manifest 与 lock 会暂时不一致，但 DSH 启动只读 manifest；**这是有意的取舍**，换来零 prune、零 lock 改写、零 redirect 漂移。

### 1.2 为什么手动 junction

- Node/DSH 只需要 `node_modules\<name>` 能解析到包；junction 正是 Windows 上最轻的等价物。
- 已在临时目录验证：junction 下 `createRequire(...).resolve('dsh-context-governance/package.json')` 与 ESM `import` 都正常（2026-10-25）。
- 卸载时只删 junction，不碰插件源码目录。

### 1.3 要不要 `pnpm install --lockfile-only`？

**不要。** 理由：
1. 它仍会重写整份 `pnpm-lock.yaml`（解析/registry 状态都可能变），而运行时根本不需要 lock 条目；
2. 插件零运行依赖，junction 已满足解析；
3. 一旦跑 pnpm，就必须重新承担 prune/redirect 风险。
若未来确实要让 pnpm 管理这个插件（例如发布到 npm 后），另立方案：先完整备份、先演练、装后按 §6 恢复 redirect。

---

## 2. 基线（安装前现测，不写死数字）

| 项 | 取值方式 |
|---|---|
| profile dependencies | 安装前读 `package.json` 的 `dependencies` 数量（记为 N） |
| `dsh.profile.bundles` | 安装前读 `dsh.profile.bundles` 数量（记为 B） |
| compression redirect（`node_modules\@deepseek-ai\dsh-compaction-basic\package.json`） | 若存在记版本；本 Runbook 不做 pnpm，**不得变化** |
| `dsh-context-governance` 依赖 / bundle | 安装前应均不存在 |
| 插件源码目录 | `<repo>/packages/dsh-context-governance`（junction 目标） |

**安装成功后应变为**：dependencies **N+1**、bundles **B+1**、redirect **不变**、`logs/governance.log` 出现
`capability@apply`/`apply` 行（若启用诊断）。

### 2.1 隔离安装演练结论（P4，2026-10-26）

- fresh `p4-fresh`：deps 0→1、bundles 2→3、junction 正常；`apply version=1.0.0`；`/cg status` 显示 `project-root=…\ws-fresh (source=inferred)`、`roots: 1`；卸载回 deps 0 / bundles 2 / junction 无。
- migrate `p4-migrate`：v1 seed → v2（`migratedFrom=1`、`primaryRoot=ws-a`、`.v1.bak` 字节一致）；重启不重推；A/B 两真实根，`roots: 2 (active=2)`；卸载后 A/B artifacts 14→14、项目文件 4 files/106 bytes 不变。
- configRoot `p4-configroot`：outer/outside 两根、nested 不立根；只读根真实 `/compact` 后 `protection=unavailable` + `b1-host-native-unprotected`；卸载 6→6 artifacts、3 files/108 bytes 不变。
- 兼容回滚：`v0.2.1`（tag `f585434`）单根 ws-a 启动，只读 v1；**不是完整/多根回滚**。
- 收尾：三个 profile 删除、18769/18770/18771 无监听、无 `p4-*` 进程、worktree 移除；desktop 配置字段不变（进程 ID 有宿主子进程抖动，未改配置）。
- **未验/不声称**：orphaned 无真机样本（引用 B2d）；EBUSY 三连前有两次瞬时失败；`/compact` 有 `compaction-loss`，不写“保护全过”；configRoot `primaryRoot=null`（计划原写 outer 与 P1 冲突）。
- 证据：`analysis/req-20261025-12/P4-drill-20261026-200123/`；报告 `docs/发布演练-安装卸载回滚.md`。

---

## 3. 装前检查与备份

> 在**普通 PowerShell**（非管理员）里逐段执行；建议**全程同一个 PS 会话**（`$prof`/`$before`/函数会在下文复用）。先完整退出 DSH（托盘退出，不是关窗口）。

```powershell
# 0) 必须无输出
Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' } | Select-Object Id,ProcessName

$prof   = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$plugin = '<repo>\packages\dsh-context-governance'
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $prof ".backup-cg-$stamp"
New-Item -ItemType Directory -Force $backup | Out-Null

# 1) 备份 manifest / lock / patch / redirect
foreach ($f in 'package.json','pnpm-lock.yaml','cordis.patch.yml') {
  Copy-Item (Join-Path $prof $f) (Join-Path $backup $f) -Force
}
Copy-Item (Join-Path $prof 'node_modules\@deepseek-ai\dsh-compaction-basic') `
          (Join-Path $backup 'dsh-compaction-basic') -Recurse -Force
Write-Host "backup -> $backup"

# 2) 环境自检：与装前基线一致即可；不应新增 MISSING/WARN（退出码 0）
pwsh -NoProfile -File '<shared>\check-env.ps1'

# 3) `.dsh` JSON 不得有 BOM（期望无输出）
Get-ChildItem "$env:USERPROFILE\.dsh" -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.json' -and $_.FullName -notmatch '\\node_modules\\' } |
  ForEach-Object {
    $b = [IO.File]::ReadAllBytes($_.FullName)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { "BOM: $($_.FullName)" }
  }

# 4) 记录基线（抄下来，装完对比）
function Get-CgProfileState {
  $m = Get-Content (Join-Path $prof 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $r = (Get-Content (Join-Path $prof 'node_modules\@deepseek-ai\dsh-compaction-basic\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  [pscustomobject]@{
    dependencies   = @($m.dependencies.PSObject.Properties).Count
    bundles        = @($m.dsh.profile.bundles).Count
    redirect       = $r
    pluginDep      = @($m.dependencies.PSObject.Properties.Name) -contains 'dsh-context-governance'
    pluginBundle   = @($m.dsh.profile.bundles) -contains 'dsh-context-governance'
  }
}
$before = Get-CgProfileState
$before | Format-List
```

期望：`dependencies`/`bundles` 等于 §2 记录的 N/B（本机历史基线为 13/16，1.0 以现测为准）、`redirect` 与安装前一致、两个 plugin 标记 `False`。

---

## 4. 安装

```powershell
$prof   = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$plugin = '<repo>\packages\dsh-context-governance'

# 5) 建 junction（已存在就停手，按回滚/旧安装处理）
$link = Join-Path $prof 'node_modules\dsh-context-governance'
if (Test-Path $link) { throw "已存在 $link：先确认是否旧安装，不要覆盖" }
New-Item -ItemType Junction -Path $link -Target $plugin | Out-Null
Test-Path (Join-Path $link 'cordis.patch.yml')     # True
Test-Path (Join-Path $link 'src\index.js')         # True

# 6) 改 profile package.json（Node 写 UTF-8 无 BOM；不跑 pnpm）
$env:CG_PROFILE_JSON = Join-Path $prof 'package.json'
node --input-type=module -e @'
import fs from 'node:fs';
const file = process.env.CG_PROFILE_JSON;
const name = 'dsh-context-governance';
const spec = 'file:<repo>/packages/dsh-context-governance';
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.dependencies ??= {};
if (manifest.dependencies[name] !== undefined) throw new Error('dependency already present: ' + name);
manifest.dependencies[name] = spec;
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (manifest.dsh.profile.bundles.includes(name)) throw new Error('bundle already present: ' + name);
manifest.dsh.profile.bundles.push(name);
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('updated ' + file);
'@

# 7) 立即验证：无 BOM、能 JSON.parse、能解析到包
$b = [IO.File]::ReadAllBytes($env:CG_PROFILE_JSON)
if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { throw 'package.json 有 BOM，立即回滚' }
node -e "JSON.parse(require('node:fs').readFileSync(process.env.CG_PROFILE_JSON,'utf8')); console.log('json ok')"
node -e "const {createRequire}=require('node:module');const r=createRequire(process.env.CG_PROFILE_JSON);console.log('resolved=' + r.resolve('dsh-context-governance/package.json'))"

# 8) 对比基线（deps +1、bundles +1、redirect 不变）
$after = Get-CgProfileState
$after | Format-List
if ($after.dependencies -ne ($before.dependencies + 1)) { throw 'dependencies 数量不符，回滚' }
if ($after.bundles -ne ($before.bundles + 1)) { throw 'bundles 数量不符，回滚' }
if ($after.redirect -ne $before.redirect) { throw 'redirect 版本变了，按 §6 处理/回滚' }
if (-not ($after.pluginDep -and $after.pluginBundle)) { throw 'plugin 依赖或 bundle 未登记，回滚' }

# 9) 重复装后检查：check-env 全绿 + BOM 扫描无输出
pwsh -NoProfile -File '<shared>\check-env.ps1'
Get-ChildItem "$env:USERPROFILE\.dsh" -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -eq '.json' -and $_.FullName -notmatch '\\node_modules\\' } |
  ForEach-Object {
    $x = [IO.File]::ReadAllBytes($_.FullName)
    if ($x.Length -ge 3 -and $x[0] -eq 0xEF -and $x[1] -eq 0xBB -and $x[2] -eq 0xBF) { "BOM: $($_.FullName)" }
  }
```

到这里**不要启动 DSH**，先确认第 8/9 步全部通过。

---

## 5. 重启与装后自检

1. 正常启动 DSH（用户手动）。
2. 等 10 秒，检查启动记录：

```powershell
Get-Content '<repo>\logs\governance.log' -Tail 3
```

**期望两行**（时间/pid/host 可不同；v0.1.3 起）：

```
2026-10-25T…Z governance capability version=<package.json> pid=… probe=on=fn,emit=fn,get=fn,events=obj(dispatch=fn),bus=absent,session=absent,sessions=absent,agents=absent,workspace=absent,compaction=absent,commands=obj,tools=obj,logger=obj,sessionProjections=absent,get.events=absent,get.sessions=absent,…,root=child
2026-10-25T…Z governance apply version=<package.json> pid=… adapter=none mode=event-level host=… backend=unknown compaction-service=absent(token=compaction) perception=event event-api=on audit=…\memory\governance\audit.jsonl memory=… warning=provider-unavailable
```

- `perception=event event-api=on`：`ctx.on('session/event')` 订阅成功；若为 `event-api=off`，能力探测行会指出哪个 token 缺失。
- `adapter=none`：本机拿不到 `compaction` 服务（根作用域不可见），走事件级路线，属预期；识别到 provider 时会变 `context-zip`/`host-basic` 且 `mode=full`。
- `audit=…`：`audit.jsonl` 在 apply 时即创建，首行是 `{"event":"apply",…}`。
- 没有这两行：按 §7 排查，不要反复重启。

**1.0（多根）装后必须能看出根/记忆/来源**：
- 首个带 cwd 的会话事件后，`/cg status` 应出现
  `project-root: <root> (source=inferred|persisted|config)`、
  `persistence-identity: source=profileContext name=<profile> … path=<home>/context-governance/root-state-<profile>.json`、
  `memory: project=<root basename> root=<root>/<memoryRoot>`；
- 状态文件 `root-state-<profile>.json` 为 **v2**：`{version:2, roots:{rootId:{…}}, primaryRootId, configRoot}`；v1 迁移后留 `.v1.bak`；
- **重启不得出现**新的 `inferred-fresh`/`project-root-changed`，v2 状态 hash/mtime 不变（沿用不重推）；
- 多根时应看到 `roots: N`，每根独立 `memory`/`audit`；`configRoot` 下嵌套 `.git` 不新增根；
- 根未知时 `/cg status` 显示 `project-root: unknown (no-project-root)`，记忆工具/header/提前压不挂载（fail-closed）。

3. 工具面（可选人工确认）：新开一个会话，让模型调用 `mem_query`/`mem_write` 或查看工具列表；能调用即注册成功。
4. 命令面：`/cg status`、`/cg policy show`、`/cg set`、`/cg profile [status|reset|<batch|coding|review|research>]`、
   `/cg header [status|on|off]`、`/cg compact [status|arm|disarm]`。`/cg profile` 只影响当前会话、进程内不持久化；
   `/cg set profile=...` 会按未知键拒绝。
5. 再跑一遍装后状态（不要重装）：

```powershell
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
function Get-CgProfileState {
  $m = Get-Content (Join-Path $prof 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $r = (Get-Content (Join-Path $prof 'node_modules\@deepseek-ai\dsh-compaction-basic\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  [pscustomobject]@{
    dependencies = @($m.dependencies.PSObject.Properties).Count
    bundles      = @($m.dsh.profile.bundles).Count
    redirect     = $r
    pluginDep    = @($m.dependencies.PSObject.Properties.Name) -contains 'dsh-context-governance'
    pluginBundle = @($m.dsh.profile.bundles) -contains 'dsh-context-governance'
  }
}
Get-CgProfileState | Format-List      # 14 / 17 / 0.1.0-context-zip / True / True
pwsh -NoProfile -File '<shared>\check-env.ps1'
```

---

## 6. 回滚（任一步失败都先回滚，再排查）

> 先完整退出 DSH。原则：**只还原本插件实际改过的内容**——manifest 只删本插件条目（不整份覆盖），
> `cordis.patch.yml`/`pnpm-lock.yaml` 本插件安装时**从未改过**，默认不还原（避免覆盖他方后来的改动）。

```powershell
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
# 默认取最新备份；也可显式：$backup = '<指定目录>'
$backup = Get-ChildItem $prof -Directory -Filter '.backup-cg-*' | Sort-Object Name -Descending |
          Select-Object -First 1 -ExpandProperty FullName
if (-not $backup) { throw '找不到 .backup-cg-* 备份目录' }

# 1) 删 junction（只删链接，不碰源码）；失败即停，并断言链接已消失
$link = Join-Path $prof 'node_modules\dsh-context-governance'
if (Test-Path $link) { cmd /c rmdir "$link"; if ($LASTEXITCODE -ne 0) { throw "删除 junction 失败: $link" } }
if (Test-Path $link) { throw "junction 仍存在: $link" }

# 2) manifest：先留 .bak，再只删本插件的 dependency + bundle（保留其它插件后来加的条目）
$env:CG_PROFILE_JSON = Join-Path $prof 'package.json'
$manifestBak = "$env:CG_PROFILE_JSON.cg-bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $env:CG_PROFILE_JSON $manifestBak -Force
Write-Host "manifest 已备份: $manifestBak"
node -e @'
const fs = require('node:fs');
const file = process.env.CG_PROFILE_JSON;
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const removed = [];
if (manifest.dependencies && Object.hasOwn(manifest.dependencies, 'dsh-context-governance')) {
  delete manifest.dependencies['dsh-context-governance'];
  removed.push('dependency');
}
const bundles = manifest?.dsh?.profile?.bundles;
if (Array.isArray(bundles) && bundles.includes('dsh-context-governance')) {
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== 'dsh-context-governance');
  removed.push('bundle');
}
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
const stillDependency = saved.dependencies && Object.hasOwn(saved.dependencies, 'dsh-context-governance');
const stillBundle = Array.isArray(saved?.dsh?.profile?.bundles) && saved.dsh.profile.bundles.includes('dsh-context-governance');
if (stillDependency || stillBundle) throw new Error('manifest 断言失败：dsh-context-governance 仍存在');
console.log('removed:', removed.join(',') || 'none', '| assert: dsh-context-governance absent');
'@
if ($LASTEXITCODE -ne 0) { throw 'manifest 回滚失败；.bak 未丢失，可人工恢复' }

# 3) redirect：先确认文件存在；只有当前值与备份不同才还原（相同说明本插件没动过它）
$redirectDir = Join-Path $prof 'node_modules\@deepseek-ai\dsh-compaction-basic'
$redirectPkg = Join-Path $redirectDir 'package.json'
if (-not (Test-Path $redirectPkg)) { throw "redirect 缺 package.json: $redirectPkg" }
$redirectVersion = (Get-Content $redirectPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($redirectVersion -ne '0.1.0-context-zip') {
  New-Item -ItemType Directory -Force $redirectDir | Out-Null
  Copy-Item (Join-Path $backup 'dsh-compaction-basic\*') $redirectDir -Recurse -Force
  if (-not (Test-Path $redirectPkg)) { throw "还原后 redirect 缺 package.json: $redirectPkg" }
  $redirectVersion = (Get-Content $redirectPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
if ($redirectVersion -ne '0.1.0-context-zip') { throw "redirect 版本不对: $redirectVersion" }

# 4) 校验：JSON 无 BOM/可解析、本插件已从 manifest 消失、redirect 正确、check-env 全绿
$b = [IO.File]::ReadAllBytes((Join-Path $prof 'package.json'))
if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { throw 'package.json 有 BOM' }
node -e "JSON.parse(require('node:fs').readFileSync(process.env.CG_PROFILE_JSON,'utf8')); console.log('json ok')"
pwsh -NoProfile -File '<shared>\check-env.ps1'
```

- **不强还原**：`cordis.patch.yml`、`pnpm-lock.yaml` 在 §4 安装步骤里没有改过；若它们与备份不同，说明另有改动，默认保留现状。需要比对时先看 diff：
  ```powershell
  foreach ($f in 'cordis.patch.yml','pnpm-lock.yaml') {
    if ((Get-FileHash (Join-Path $prof $f)).Hash -ne (Get-FileHash (Join-Path $backup $f)).Hash) {
      Write-Warning "$f 与备份不同（可能是他方改动），默认不还原；如确认是本次安装造成，再手动 Copy-Item"
    }
  }
  ```
- **`.ignored` 两份 redirect 副本取哪一份**：优先用 `.backup-cg-*/dsh-compaction-basic`。只有备份缺失时才用 `.ignored`，判据是 **`package.json.version === '0.1.0-context-zip'`**；两份都满足时取 `LastWriteTime` 较新的，并在移回后立即断言版本。不要只看目录名（`_1` 不保证更新）。
- **备份清理**：保留最近 **3** 份，超过的按名字（含时间戳）删旧；不要删仍在回滚窗口内的那份：
  ```powershell
  $old = Get-ChildItem $prof -Directory -Filter '.backup-cg-*' | Sort-Object Name -Descending | Select-Object -Skip 3
  $old | ForEach-Object { Write-Host "可删除: $($_.FullName)" }   # 确认后再 Remove-Item -Recurse
  ```
- **记录回滚点**（RB-05）：回滚完成后把“备份目录、当前 manifest 计数、redirect 版本、时间”写进 `memory\ARTIFACTS.md`，例如：
  `2026-10-25 · 回滚：.backup-cg-20261025-185959 → deps 13 / bundles 16 / redirect 0.1.0-context-zip`
- 重启后确认：`logs\governance.log` 不再出现新行；DSH 正常；工作区可用。
- **数据目录去留**（RB-06）：
  - 保留（默认）：`memory\governance\`（记忆）、`logs\governance.log`（诊断日志）；`memory/governance/` 已在 `.gitignore` 中，不随仓库提交。
  - 彻底清理：退出 DSH 后删除 `memory\governance\`、`logs\governance.log`、profile 下的 junction 与 `.backup-cg-*`（源码 `packages\dsh-context-governance\` 不动）。

---

## 7. 失败排查（按顺序，不要跳）

| 症状 | 先查 | 处置 |
|---|---|---|
| DSH 起不来 / 工作区 unavailable | `package.json` 是否有 BOM、能否 `JSON.parse` | 立即按 §6 回滚；BOM 是 2026-10-25 事故根因 |
| DSH 正常但没有 `governance.log` 行 | `dsh.profile.bundles` 是否含插件；junction 是否可解析；`cordis.patch.yml` 的 `diagnostics.logFile` | 修 manifest/junction 后重启；仍无则回滚 |
| 日志 `adapter=host-basic` | redirect 版本是否 `0.1.0-context-zip`；备份 `.backup-cg-*/dsh-compaction-basic` | 优先用备份恢复；`.ignored` 只作二次来源，按 §6 的版本判据取，再重启 |
| 日志 `mode=observe-only` | 行内 `conflicts` / 宿主版本 | 版本出矩阵或 provider 未知时属预期降级；贴日志报开发 |
| `check-env` 有 WARN | redirect / threshold / context-zip 配置 | 先恢复 redirect；不要改 `cordis.patch.yml` |
| 插件工具没注册 | 启动日志是否有 `tool mem_* was not registered`；宿主是否 `UNSUPPORTED_SCHEMA` | v0.1.6 起 schema 已改为宿主子集；仍失败则贴日志报开发 |

DSH 启动失败诊断：CLI 路径会写 `%USERPROFILE%\.dsh\logs\startup-*.log`；桌面版看应用错误提示。

---

## 8. 升级

1. 完整退出 DSH。
2. 更新 `<repo>\packages\dsh-context-governance\` 源码（junction 自动指向新内容；同名同路径无需改 manifest）。
3. 改插件版本号后，启动自检看 `logs\governance.log` 的 `version=`。
4. 若插件**路径或包名**变了：删旧 junction、建新 junction、更新 `dependencies` 的 `file:` 值；bundle 名不变则无需动 `dsh.profile.bundles`。
5. 若 `cordis.patch.yml` 的 config 变了：随包生效，重启即可；**不要**在 profile patch 里重复插入同一 `id`。
6. 升级同样执行 §5 的装后自检；不需要 pnpm。

---

## 9. 装完自检清单（打勾）

- [ ] DSH 已完整退出（`Get-Process` 无输出）
- [ ] 备份目录已生成（manifest/lock/patch/redirect 四份）
- [ ] 装前 `check-env.ps1` 无新增 MISSING/WARN、`.dsh` JSON 无 BOM
- [ ] 基线：deps N / bundles B / redirect 0.1.0-context-zip（按 §2 现测）
- [ ] junction 存在且 `cordis.patch.yml`、`src\index.js` 可见
- [ ] manifest 写入后无 BOM、`JSON.parse` 通过、`createRequire` 能解析
- [ ] 装后：deps N+1 / bundles B+1 / redirect 不变 / pluginDep=true / pluginBundle=true
- [ ] 装后 `check-env.ps1` 全绿、BOM 扫描无输出
- [ ] 重启后 `logs\governance.log` 有 `capability@apply` 与 `apply version=<package.json 版本>` 两行
- [ ] apply 行含 `perception=event`、`event-api=on`、`audit=…audit.jsonl`；`audit.jsonl` 首行为 `event=apply`
- [ ] 首个项目会话后 `/cg status` 显示 `project-root`（`source=inferred|persisted|config`）、`persistence-identity`、`memory: project=<basename> root=…`；多根时 `roots: N`
- [ ] 状态文件 `root-state-<profile>.json` 为 v2（`roots`/`primaryRootId`/`configRoot`）；v1 迁移留 `.v1.bak`；重启后 hash/mtime 不变、无新 `inferred-fresh`
- [ ] `configRoot` 下嵌套 `.git` 不新增根；只读根 `/compact` 后为 `protection=unavailable`（不是 `ok`）
- [ ] `/cg profile status` 可用；`/cg set profile=...` 被按未知键拒绝（1.0 新入口）
- [ ] 包内 `diagnostics.logFile` 为空（默认关闭）；如需诊断在 profile patch 配**绝对路径**
- [ ] 任意会话能看到 `mem_write` / `mem_query`
- [ ] 回滚路径已读一遍（§6），备份目录位置已记下

---

## 10. 本 Runbook 的来源

- 装载通道已由 `cg-stub` 验证（3–5 次 apply；`observer=registered(count-only)`）。
- `dsh plugin add` 的副作用来自 2026-10-25 实测：prune、redirect 移入 `.ignored`、lock 写 `link:`。
- junction 解析已用临时目录验证：`createRequire(...).resolve` + ESM `import` 均通过。
- BOM 事故：PS 5.1 `Set-Content -Encoding UTF8` 写 BOM → DSH `JSON.parse` 失败 → `workspaceRegistry`/`workspaceController` 挂起；本 Runbook 所有写 JSON 的地方都走 Node `fs.writeFileSync(...,'utf8')` 或 `[IO.File]::WriteAllText` + `UTF8Encoding(false)`。
