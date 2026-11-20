#Requires -Version 5.1
<#
.SYNOPSIS
    幂等地安装 / 卸载 dsh-context-governance 到指定的 DSH profile。

.DESCRIPTION
    安装时把插件目录以 file: 依赖写进 <ProfileDir>\package.json，并把插件名追加到
    dsh.profile.bundles（已存在则不重复），同时在 <ProfileDir>\node_modules 下建立
    指向插件目录的 junction。卸载执行反向操作。脚本只在内容确实变化时才备份
    package.json（同目录 package.json.bak-<yyyyMMdd-HHmmss>）；重复运行不产生新备份。

    脚本只改这些位置：
      - <ProfileDir>\package.json 的 dependencies["dsh-context-governance"]
      - <ProfileDir>\package.json 的 dsh.profile.bundles
      - <ProfileDir>\node_modules\dsh-context-governance（junction）
    不删除任何真实目录；遇到非 junction 的同名路径只报错（-Force 也不删）。

.PARAMETER ProfileDir
    目标 DSH profile 目录（含 package.json）。默认：$env:DSH_HOME\profiles\desktop，
    若 DSH_HOME 为空则 $HOME\.dsh\profiles\desktop。

.PARAMETER RepoRoot
    仓库根目录，仅在脚本不位于插件包内时用于推导默认 -PluginDir（兼容旧位置 scripts\）。
    默认：脚本所在目录的父目录。

.PARAMETER PluginDir
    插件包目录（含 package.json 与 dsh.bundle.patch）。
    默认：若脚本所在目录自身就是插件包（$PSScriptRoot\package.json 含 dsh.bundle.patch），
    则用该目录（随包分发的 install.ps1 即此情况）；否则回退 <RepoRoot>\packages\dsh-context-governance。
    从 Release zip 解压安装时，可直接指向解压目录，不依赖仓库结构。

.PARAMETER Uninstall
    卸载：删 dependencies 键、从 bundles 移除、删除指向本插件的 junction、保留 .bak-* 备份。

.PARAMETER DryRun
    只打印将要做的改动，不写文件、不建/删 junction、不备份。

.PARAMETER Force
    允许覆盖式处理：当 node_modules 下的路径是 junction 但指向别处时，先删旧链接再建。
    真实目录永远不会被删除（只报错）。

.EXAMPLE
    pwsh -NoProfile -File packages\dsh-context-governance\install.ps1

.EXAMPLE
    pwsh -NoProfile -File packages\dsh-context-governance\install.ps1 -ProfileDir D:\tmp\profile -DryRun

.EXAMPLE
    pwsh -NoProfile -File packages\dsh-context-governance\install.ps1 -PluginDir D:\unzipped\dsh-context-governance

.EXAMPLE
    pwsh -NoProfile -File packages\dsh-context-governance\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$ProfileDir,
    [string]$RepoRoot,
    [string]$PluginDir,
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$script:PackageName = 'dsh-context-governance'
$script:BakPrefix = 'package.json.bak-'

function Fail {
    param([string]$Message)
    Write-Output "[error] $Message"
    exit 1
}

function Write-Info {
    param([string]$Message)
    Write-Output "[info] $Message"
}

function Resolve-FullPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        Fail '路径不能为空。'
    }
    $p = $Path.Trim()
    if ($p -eq '~') {
        $p = $HOME
    } elseif ($p -like '~/*' -or $p -like '~\*') {
        $p = Join-Path $HOME $p.Substring(2)
    }
    try {
        $full = [System.IO.Path]::GetFullPath($p)
    } catch {
        Fail "无法解析路径 '$Path'：$($_.Exception.Message)"
    }
    $full = $full.TrimEnd('\', '/')
    if ($full -match '^[A-Za-z]:$') {
        $full = $full + '\'
    }
    return $full
}

function Read-JsonFile {
    param([string]$Path, [string]$Label)
    try {
        $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    } catch {
        Fail "无法读取 $Label（$Path）：$($_.Exception.Message)"
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
        Fail "$Label 是空文件：$Path"
    }
    try {
        $obj = $text | ConvertFrom-Json
    } catch {
        Fail "$Label 不是合法 JSON：$Path（$($_.Exception.Message)）"
    }
    if ($null -eq $obj) {
        Fail "$Label 解析结果为空：$Path"
    }
    if (-not ($obj -is [System.Management.Automation.PSCustomObject])) {
        Fail "$Label 顶层必须是 JSON 对象：$Path"
    }
    return $obj
}

function Write-JsonFile {
    param([string]$Path, $Object)
    try {
        $json = $Object | ConvertTo-Json -Depth 32
    } catch {
        Fail "序列化 JSON 失败：$Path（$($_.Exception.Message)）"
    }
    if ([string]::IsNullOrWhiteSpace($json)) {
        Fail "序列化 JSON 结果为空：$Path"
    }
    # UTF-8，无 BOM；末尾补换行（不影响 JSON 语义）
    $encoding = New-Object System.Text.UTF8Encoding($false)
    try {
        [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $encoding)
    } catch {
        Fail "写入 package.json 失败：$Path（$($_.Exception.Message)）"
    }
}

function Get-JsonPropertyInfo {
    param($Object, [string]$Name)
    if ($null -eq $Object) {
        return $null
    }
    return $Object.PSObject.Properties[$Name]
}

function Get-JsonValue {
    param($Object, [string]$Name)
    $info = Get-JsonPropertyInfo $Object $Name
    if ($null -eq $info) {
        return $null
    }
    return $info.Value
}

function Ensure-JsonObject {
    param($Object, [string]$Name, [string]$Label)
    $info = Get-JsonPropertyInfo $Object $Name
    if ($null -eq $info) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value ([pscustomobject]@{}) -ErrorAction Stop
        return $Object.$Name
    }
    if ($null -eq $info.Value) {
        $Object.$Name = [pscustomobject]@{}
        return $Object.$Name
    }
    if (-not ($info.Value -is [System.Management.Automation.PSCustomObject])) {
        Fail "$Label 的 '$Name' 不是 JSON 对象，拒绝修改。"
    }
    return $info.Value
}

function Get-ComparablePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    $p = $Path.Trim()
    if ($p.StartsWith('\\?\UNC\')) {
        $p = '\\' + $p.Substring(8)
    } elseif ($p.StartsWith('\\?\')) {
        $p = $p.Substring(4)
    }
    try {
        $p = [System.IO.Path]::GetFullPath($p)
    } catch {
        # 保留原样做比较
    }
    return $p.TrimEnd('\', '/')
}

function Test-SamePath {
    param([string]$A, [string]$B)
    $na = Get-ComparablePath $A
    $nb = Get-ComparablePath $B
    if ([string]::IsNullOrEmpty($na) -or [string]::IsNullOrEmpty($nb)) {
        return $false
    }
    return [string]::Equals($na, $nb, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-FirstTarget {
    param($Target)
    if ($null -eq $Target) {
        return $null
    }
    if ($Target -is [System.Array]) {
        if ($Target.Count -gt 0) {
            return [string]$Target[0]
        }
        return $null
    }
    return [string]$Target
}

function Get-PathEntry {
    param([string]$Path)
    $entry = [pscustomobject]@{
        Exists         = $false
        IsReparsePoint = $false
        IsContainer    = $false
        LinkType       = $null
        Target         = $null
    }
    $item = $null
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
        $item = $null
    }
    if ($null -eq $item) {
        # 目标缺失的 junction 可能取不到 item，退化为父目录枚举（只认同名项）
        $parent = Split-Path -Parent $Path
        $leaf = Split-Path -Leaf $Path
        if ($parent -and (Test-Path -LiteralPath $parent)) {
            try {
                $item = Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop |
                    Where-Object { $_.Name -eq $leaf } |
                    Select-Object -First 1
            } catch {
                $item = $null
            }
        }
        if ($null -eq $item) {
            return $entry
        }
        $entry.IsContainer = $true
    } else {
        $entry.IsContainer = [bool]$item.PSIsContainer
    }
    $entry.Exists = $true
    try {
        $entry.IsReparsePoint = [bool](($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    } catch {
        $entry.IsReparsePoint = $false
    }
    try {
        $entry.LinkType = $item.LinkType
    } catch {
        $entry.LinkType = $null
    }
    try {
        if ($null -ne $item.PSObject.Properties['Target']) {
            $entry.Target = $item.Target
        }
    } catch {
        $entry.Target = $null
    }
    return $entry
}

function Get-BackupPath {
    param([string]$FilePath)
    $dir = Split-Path -Parent $FilePath
    $leaf = Split-Path -Leaf $FilePath
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $candidate = Join-Path $dir ($leaf + '.bak-' + $stamp)
    $n = 2
    while (Test-Path -LiteralPath $candidate) {
        $candidate = Join-Path $dir ($leaf + '.bak-' + $stamp + '-' + $n)
        $n++
    }
    return $candidate
}

function Remove-LinkEntry {
    param([string]$Path)
    $check = Get-PathEntry $Path
    if (-not $check.Exists) {
        return
    }
    if (-not $check.IsReparsePoint) {
        Fail "拒绝删除 '$Path'：它不是 junction/reparse point（真实目录/文件不会被自动删除）。"
    }
    try {
        if ($check.IsContainer) {
            # Directory.Delete 只删除 reparse point 本身，不会递归删除目标内容
            [System.IO.Directory]::Delete($Path, $false)
        } else {
            [System.IO.File]::Delete($Path)
        }
    } catch {
        Fail "删除 junction 失败：$Path（$($_.Exception.Message)）"
    }
}

function Get-BackupFiles {
    param([string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $Directory -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like ($script:BakPrefix + '*') } |
        Sort-Object Name)
}

# ---------------------------------------------------------------------------
# 解析参数 / 默认路径
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        Fail '无法推导 RepoRoot（$PSScriptRoot 为空），请显式传 -RepoRoot 或 -PluginDir。'
    }
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = Resolve-FullPath $RepoRoot

if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    # 优先认定「脚本自身就在插件包内」（随包分发的 install.ps1）：
    # 这样默认 PluginDir 就是包目录本身，不会推导出 packages\packages\...
    $selfIsPlugin = $false
    $selfPackagePath = $null
    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        $selfPackagePath = Join-Path $PSScriptRoot 'package.json'
    }
    if (-not [string]::IsNullOrWhiteSpace($selfPackagePath) -and (Test-Path -LiteralPath $selfPackagePath -PathType Leaf)) {
        try {
            $selfText = [System.IO.File]::ReadAllText($selfPackagePath, [System.Text.Encoding]::UTF8)
            $selfObj = $selfText | ConvertFrom-Json
            if ($null -ne $selfObj -and ($selfObj -is [System.Management.Automation.PSCustomObject])) {
                $selfDsh = Get-JsonValue $selfObj 'dsh'
                if ($null -ne $selfDsh) {
                    $selfBundle = Get-JsonValue $selfDsh 'bundle'
                    if ($null -ne $selfBundle) {
                        $selfPatch = Get-JsonValue $selfBundle 'patch'
                        if (($selfPatch -is [string]) -and (-not [string]::IsNullOrWhiteSpace($selfPatch))) {
                            $selfIsPlugin = $true
                        }
                    }
                }
            }
        } catch {
            $selfIsPlugin = $false
        }
    }
    if ($selfIsPlugin) {
        $PluginDir = $PSScriptRoot
    } else {
        # 兼容旧位置（scripts\install-context-governance.ps1）及显式给了 -RepoRoot 的场景
        $PluginDir = Join-Path $RepoRoot 'packages\dsh-context-governance'
    }
}
$PluginDir = Resolve-FullPath $PluginDir

if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        $ProfileDir = Join-Path $env:DSH_HOME 'profiles\desktop'
    } elseif (-not [string]::IsNullOrWhiteSpace($HOME)) {
        $ProfileDir = Join-Path $HOME '.dsh\profiles\desktop'
    } elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
    } else {
        Fail '无法推导默认 ProfileDir（DSH_HOME / HOME / USERPROFILE 都为空），请显式传 -ProfileDir。'
    }
}
$ProfileDir = Resolve-FullPath $ProfileDir

$Mode = 'install'
if ($Uninstall) {
    $Mode = 'uninstall'
}

$ProfilePackagePath = Join-Path $ProfileDir 'package.json'
$PluginPackagePath = Join-Path $PluginDir 'package.json'
$NodeModulesDir = Join-Path $ProfileDir 'node_modules'
$LinkPath = Join-Path $NodeModulesDir $script:PackageName

Write-Info "模式=$Mode profile=$ProfileDir"
Write-Info "插件目录=$PluginDir"
if ($DryRun) {
    Write-Info 'DryRun：只打印计划，不写任何文件。'
}

# ---------------------------------------------------------------------------
# 1. 校验（失败时不写任何文件）
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $ProfilePackagePath -PathType Leaf)) {
    Fail "profile package.json 不存在：$ProfilePackagePath（-ProfileDir 指向的目录必须是已存在的 DSH profile）"
}

if (-not $Uninstall) {
    if (-not (Test-Path -LiteralPath $PluginPackagePath -PathType Leaf)) {
        Fail "插件 package.json 不存在：$PluginPackagePath（从 Release zip 安装时用 -PluginDir 指向解压后的插件目录）"
    }
    $pluginPackage = Read-JsonFile $PluginPackagePath '插件 package.json'
    $pluginPatch = $null
    $pluginDsh = Get-JsonValue $pluginPackage 'dsh'
    if ($null -ne $pluginDsh) {
        $pluginBundle = Get-JsonValue $pluginDsh 'bundle'
        if ($null -ne $pluginBundle) {
            $pluginPatch = Get-JsonValue $pluginBundle 'patch'
        }
    }
    if (-not ($pluginPatch -is [string]) -or [string]::IsNullOrWhiteSpace($pluginPatch)) {
        Fail "插件 package.json 缺少 dsh.bundle.patch：$PluginPackagePath"
    }
}

$profilePackage = Read-JsonFile $ProfilePackagePath 'profile package.json'

# ---------------------------------------------------------------------------
# 2. 读取当前状态
# ---------------------------------------------------------------------------
$dependenciesObject = Get-JsonValue $profilePackage 'dependencies'
$depProperty = Get-JsonPropertyInfo $dependenciesObject $script:PackageName
$depExists = ($null -ne $depProperty)
$currentDepValue = $null
if ($depExists -and $null -ne $depProperty.Value) {
    $currentDepValue = [string]$depProperty.Value
}

$dshObject = Get-JsonValue $profilePackage 'dsh'
$profileObject = $null
$bundlesProperty = $null
if ($null -ne $dshObject) {
    $profileObject = Get-JsonValue $dshObject 'profile'
    if ($null -ne $profileObject) {
        $bundlesProperty = Get-JsonPropertyInfo $profileObject 'bundles'
    }
}
$bundles = @()
if ($null -ne $bundlesProperty -and $null -ne $bundlesProperty.Value) {
    $bundles = @($bundlesProperty.Value)
}
$bundleCount = 0
foreach ($b in $bundles) {
    if ([string]$b -eq $script:PackageName) {
        $bundleCount++
    }
}

$desiredDepValue = 'file:' + ($PluginDir -replace '\\', '/')

# ---------------------------------------------------------------------------
# 3. 规划 junction 动作（冲突在写任何文件之前报错）
# ---------------------------------------------------------------------------
$linkEntry = Get-PathEntry $LinkPath
$linkAction = 'none'   # none | create | replace | remove
$linkConflict = $null
$linkTargetForMessage = Get-FirstTarget $linkEntry.Target
$linkTargetText = '(无法读取)'
if (-not [string]::IsNullOrWhiteSpace($linkTargetForMessage)) {
    $linkTargetText = $linkTargetForMessage
}

if ($linkEntry.Exists) {
    if ($linkEntry.IsReparsePoint) {
        $sameTarget = Test-SamePath $linkTargetForMessage $PluginDir
        if ($Uninstall) {
            if ($sameTarget) {
                $linkAction = 'remove'
            } elseif ($Force) {
                $linkAction = 'remove'
            } else {
                $linkConflict = "node_modules\$($script:PackageName) 已存在但是 junction 且指向其他位置（Target=$linkTargetText），不是本插件目录；确认可用 -Force 删除它，或手工处理。"
            }
        } else {
            if ($sameTarget) {
                $linkAction = 'none'
            } elseif ($Force) {
                $linkAction = 'replace'
            } else {
                $linkConflict = "node_modules\$($script:PackageName) 已存在但是 junction 且指向其他位置（Target=$linkTargetText），不是本插件目录；确认可用 -Force 删除重建，或手工处理。"
            }
        }
    } else {
        $linkConflict = "node_modules\$($script:PackageName) 已存在且是真实目录/文件（不是 junction）；脚本不会删除它，请手工处理后再运行。"
    }
} elseif (-not $Uninstall) {
    $linkAction = 'create'
}

if ($null -ne $linkConflict) {
    Fail $linkConflict
}

# ---------------------------------------------------------------------------
# 4. 规划 JSON 改动
# ---------------------------------------------------------------------------
$jsonChanges = @()
$junctionChanges = @()
if ($Uninstall) {
    if ($depExists) {
        $jsonChanges += "删除 dependencies[$($script:PackageName)]"
    }
    if ($bundleCount -gt 0) {
        $jsonChanges += "从 dsh.profile.bundles 移除 $($script:PackageName)（$bundleCount 处）"
    }
    if ($linkAction -eq 'remove') {
        $junctionChanges += "删除 junction：$LinkPath"
    }
} else {
    if (-not $depExists) {
        $jsonChanges += "新增 dependencies[$($script:PackageName)] = $desiredDepValue"
    } elseif ($currentDepValue -ne $desiredDepValue) {
        $jsonChanges += "更新 dependencies[$($script:PackageName)]：$currentDepValue -> $desiredDepValue"
    }
    if ($bundleCount -eq 0) {
        $jsonChanges += "追加 dsh.profile.bundles 项 $($script:PackageName)"
    }
    if ($linkAction -eq 'create') {
        $junctionChanges += "创建 junction：$LinkPath -> $PluginDir"
    } elseif ($linkAction -eq 'replace') {
        $junctionChanges += "替换 junction（-Force）：$LinkPath -> $PluginDir"
    }
}
$jsonWillChange = ($jsonChanges.Count -gt 0)
$anyChange = ($jsonWillChange -or $junctionChanges.Count -gt 0)

if ($DryRun) {
    if (-not $anyChange) {
        Write-Output "[$Mode] 已是目标状态（无改动）。"
    } else {
        foreach ($change in $jsonChanges) {
            Write-Output "[dry-run] 将 $change"
        }
        if ($jsonWillChange) {
            $plannedBackup = Get-BackupPath $ProfilePackagePath
            Write-Output "[dry-run] 将备份 package.json -> $(Split-Path -Leaf $plannedBackup)"
            Write-Output "[dry-run] 将写回 package.json（UTF-8 无 BOM）"
        }
        foreach ($change in $junctionChanges) {
            Write-Output "[dry-run] 将 $change"
        }
    }
    Write-Output '未做任何修改（-DryRun）。'
    exit 0
}

# ---------------------------------------------------------------------------
# 5. 执行：安装先建 junction 再写 JSON；卸载先写 JSON 再删 junction。
#    这样中途失败时不会留下「依赖声明指向不存在的链接」或「链接指向已声明包」。
# ---------------------------------------------------------------------------
$backupPath = $null
$linkDone = $false

if (-not $Uninstall) {
    if ($linkAction -eq 'replace') {
        Remove-LinkEntry $LinkPath
        Write-Info "已删除旧 junction：$LinkPath"
    }
    if ($linkAction -eq 'create' -or $linkAction -eq 'replace') {
        if (-not (Test-Path -LiteralPath $NodeModulesDir)) {
            try {
                New-Item -ItemType Directory -Path $NodeModulesDir -Force | Out-Null
            } catch {
                Fail "创建 node_modules 目录失败：$NodeModulesDir（$($_.Exception.Message)）"
            }
        }
        try {
            New-Item -ItemType Junction -Path $LinkPath -Value $PluginDir -ErrorAction Stop | Out-Null
        } catch {
            Fail "创建 junction 失败：$LinkPath -> $PluginDir（$($_.Exception.Message)）"
        }
        $linkDone = $true
    }

    if ($jsonWillChange) {
        $backupPath = Get-BackupPath $ProfilePackagePath
        try {
            [System.IO.File]::Copy($ProfilePackagePath, $backupPath, $false)
        } catch {
            Fail "备份 package.json 失败：$backupPath（$($_.Exception.Message)）"
        }

        $depsTarget = Ensure-JsonObject $profilePackage 'dependencies' 'package.json'
        $existingDep = Get-JsonPropertyInfo $depsTarget $script:PackageName
        if ($null -eq $existingDep) {
            $depsTarget | Add-Member -MemberType NoteProperty -Name $script:PackageName -Value $desiredDepValue -ErrorAction Stop
        } else {
            $depsTarget.$($script:PackageName) = $desiredDepValue
        }

        if ($bundleCount -eq 0) {
            $bundlesParent = Ensure-JsonObject (Ensure-JsonObject $profilePackage 'dsh' 'package.json') 'profile' 'package.json'
            $bundlesInfo = Get-JsonPropertyInfo $bundlesParent 'bundles'
            if ($null -ne $bundlesInfo -and $null -ne $bundlesInfo.Value -and -not ($bundlesInfo.Value -is [System.Array])) {
                Fail "package.json 的 dsh.profile.bundles 不是数组，拒绝修改：$ProfilePackagePath"
            }
            if ($null -eq $bundlesInfo) {
                $bundlesParent | Add-Member -MemberType NoteProperty -Name 'bundles' -Value ([object[]]@()) -ErrorAction Stop
            } elseif ($null -eq $bundlesInfo.Value) {
                $bundlesParent.bundles = [object[]]@()
            }
            $newBundles = @()
            $currentBundlesInfo = Get-JsonPropertyInfo $bundlesParent 'bundles'
            if ($null -ne $currentBundlesInfo -and $null -ne $currentBundlesInfo.Value) {
                $newBundles = @($currentBundlesInfo.Value)
            }
            $newBundles = @($newBundles) + $script:PackageName
            $bundlesParent.bundles = [object[]]$newBundles
        }

        Write-JsonFile $ProfilePackagePath $profilePackage
    }
} else {
    if ($jsonWillChange) {
        $backupPath = Get-BackupPath $ProfilePackagePath
        try {
            [System.IO.File]::Copy($ProfilePackagePath, $backupPath, $false)
        } catch {
            Fail "备份 package.json 失败：$backupPath（$($_.Exception.Message)）"
        }

        $depsTarget = Get-JsonValue $profilePackage 'dependencies'
        if ($null -ne $depsTarget) {
            $depInfo = Get-JsonPropertyInfo $depsTarget $script:PackageName
            if ($null -ne $depInfo) {
                $depsTarget.PSObject.Properties.Remove($script:PackageName)
            }
        }

        if ($bundleCount -gt 0 -and $null -ne $profileObject) {
            $kept = @()
            foreach ($b in @($bundlesProperty.Value)) {
                if ([string]$b -ne $script:PackageName) {
                    $kept += $b
                }
            }
            $profileObject.bundles = [object[]]$kept
        }

        Write-JsonFile $ProfilePackagePath $profilePackage
    }

    if ($linkAction -eq 'remove') {
        Remove-LinkEntry $LinkPath
        $linkDone = $true
    }
}

if ($linkDone -and -not (Test-Path -LiteralPath $LinkPath)) {
    Write-Info "junction 已移除：$LinkPath"
}

# ---------------------------------------------------------------------------
# 6. 摘要 + 备份说明
# ---------------------------------------------------------------------------
$backupFiles = Get-BackupFiles $ProfileDir
$backupCount = $backupFiles.Count
$summaryParts = @()
$summaryParts += $jsonChanges
$summaryParts += $junctionChanges
if ($null -ne $backupPath) {
    $summaryParts += "备份 package.json -> $(Split-Path -Leaf $backupPath)"
}

if ($summaryParts.Count -eq 0) {
    Write-Output "[$Mode] 已是目标状态，无改动。"
} else {
    Write-Output "[$Mode] 已修改：$($summaryParts -join '；')。"
}

if ($Uninstall) {
    Write-Output "已保留历史备份 $backupCount 个（$($script:BakPrefix)*，审计用，不随卸载删除）。"
}

Write-Output '重启 DSH 生效。'
exit 0
