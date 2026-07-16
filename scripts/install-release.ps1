Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:InstallStep = 0
$script:InstallStepTotal = 6

function Write-InstallStep([string]$Message) {
    $script:InstallStep += 1
    Write-Host ""
    Write-Host "[$($script:InstallStep)/$script:InstallStepTotal] $Message"
}

function Write-InstallDetail([string]$Message) {
    Write-Host "  $Message"
}

function Get-EnvironmentValue([string]$Name, [string]$DefaultValue) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $DefaultValue }
    return $value
}

function Get-ReleaseBase {
    $explicit = [Environment]::GetEnvironmentVariable("PORTABLE_DEVSHELL_RELEASE_BASE_URL")
    if (-not [string]::IsNullOrWhiteSpace($explicit)) { return $explicit.TrimEnd('/') }
    $repository = Get-EnvironmentValue "PORTABLE_DEVSHELL_RELEASE_REPOSITORY" "Aromatic05/portable-devshell"
    $requested = Get-EnvironmentValue "PORTABLE_DEVSHELL_VERSION" "latest"
    if ($requested -eq "latest") { return "https://github.com/$repository/releases/latest/download" }
    $tag = if ($requested.StartsWith("v")) { $requested } else { "v$requested" }
    return "https://github.com/$repository/releases/download/$tag"
}

function Download-File([string]$Url, [string]$Destination) {
    Write-InstallDetail "下载 $(Split-Path -Leaf $Destination)"
    $uri = $null
    if ([Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri) -and $uri.IsFile) {
        Copy-Item -Force -LiteralPath $uri.LocalPath -Destination $Destination
        return
    }
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        try {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri $Url -OutFile $Destination
            return
        } catch {
            if ($attempt -eq 3) { throw }
            Write-InstallDetail "下载失败，1 秒后重试（$attempt/3）"
            Start-Sleep -Seconds 1
        }
    }
}

function Set-InstallMetadata([string]$ManifestPath, [string]$WorkerReleaseDirectoryUrl) {
    $manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
    $manifest | Add-Member -NotePropertyName workerReleaseDirectoryUrl -NotePropertyValue $WorkerReleaseDirectoryUrl.TrimEnd('/') -Force
    $json = $manifest | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($ManifestPath, "$json`n", [Text.UTF8Encoding]::new($false))
}

function Assert-CliStarts([string]$CliPath, [string]$FailureLabel, [bool]$CommandWrapper = $false) {
    $smokeRoot = Join-Path ([IO.Path]::GetTempPath()) ("portable-devshell-smoke-" + [Guid]::NewGuid().ToString("N"))
    $names = @("HOME", "USERPROFILE", "LOCALAPPDATA", "PORTABLE_DEVSHELL_HOME", "XDG_RUNTIME_DIR")
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
    New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
    try {
        $env:HOME = $smokeRoot
        $env:USERPROFILE = $smokeRoot
        $env:LOCALAPPDATA = Join-Path $smokeRoot "AppData\Local"
        $env:PORTABLE_DEVSHELL_HOME = Join-Path $smokeRoot ".devshell"
        $env:XDG_RUNTIME_DIR = Join-Path $smokeRoot "runtime"
        New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA, $env:XDG_RUNTIME_DIR | Out-Null
        $output = if ($CommandWrapper) { @(& $CliPath status 2>&1) } else { @(& node $CliPath status 2>&1) }
        $exitCode = $LASTEXITCODE
        $text = $output -join [Environment]::NewLine
        if ($exitCode -ne 0 -or -not $text.Contains("control: stopped")) {
            throw "$FailureLabel：CLI 无法正常执行 status。`n$text"
        }
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $smokeRoot
    }
}

function Assert-Sha256([string]$File, [string]$ShaFile) {
    $expected = ((Get-Content -LiteralPath $ShaFile -TotalCount 1) -split '\s+')[0].Trim().ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { throw "无效的 SHA-256 文件：$ShaFile" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 校验失败：$File" }
}

function Get-ApplicationCliRelativePath([string]$ApplicationDirectory) {
    $packageManifestPath = Join-Path $ApplicationDirectory "package.json"
    if (-not (Test-Path -LiteralPath $packageManifestPath -PathType Leaf)) {
        throw "应用包缺少 package.json：$packageManifestPath"
    }
    $packageManifest = Get-Content -Raw -LiteralPath $packageManifestPath | ConvertFrom-Json
    $entry = [string]$packageManifest.bin.devshell
    if ([string]::IsNullOrWhiteSpace($entry)) {
        throw "应用包未声明 bin.devshell：$packageManifestPath"
    }
    if ([IO.Path]::IsPathRooted($entry)) {
        throw "应用包 bin.devshell 必须是相对路径：$entry"
    }

    $root = [IO.Path]::GetFullPath($ApplicationDirectory).TrimEnd('\')
    $absolute = [IO.Path]::GetFullPath((Join-Path $root $entry))
    $rootPrefix = "$root\"
    if (-not $absolute.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "应用包 bin.devshell 逃逸 package 根目录：$entry"
    }
    return $absolute.Substring($rootPrefix.Length).Replace('\', '/')
}

function Test-ControlProcessRunning([int]$ControlProcessId) {
    return $null -ne (Get-Process -Id $ControlProcessId -ErrorAction SilentlyContinue)
}

function Wait-ControlProcessExit([int]$ControlProcessId, [int]$TimeoutMilliseconds) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Test-ControlProcessRunning $ControlProcessId)) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return -not (Test-ControlProcessRunning $ControlProcessId)
}

function Stop-InstalledControl([string]$CurrentCli, [string]$DevshellHome) {
    $pidFile = Join-Path $DevshellHome "control\control.pid"
    if (Test-Path -LiteralPath $CurrentCli) {
        & node $CurrentCli stop *> $null
        if ($LASTEXITCODE -eq 0 -and -not (Test-Path -LiteralPath $pidFile)) { return }
        Write-Warning "当前 CLI 未能完整停止 control，尝试使用经过验证的 PID 恢复。"
    }

    if (-not (Test-Path -LiteralPath $pidFile)) { return }

    $pidSource = (Get-Content -Raw -LiteralPath $pidFile).Trim()
    $controlProcessId = 0
    if (-not [int]::TryParse($pidSource, [ref]$controlProcessId) -or $controlProcessId -le 0) {
        throw "control PID 文件无效：$pidFile"
    }

    if (-not (Test-ControlProcessRunning $controlProcessId)) {
        Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile
        return
    }

    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $controlProcessId" -ErrorAction SilentlyContinue
    $commandLine = if ($null -eq $processInfo) { "" } else { [string]$processInfo.CommandLine }
    if (-not $commandLine.Contains("ControlDaemon.js") -or -not $commandLine.ToLowerInvariant().Contains("portable-devshell")) {
        throw "拒绝终止 PID ${controlProcessId}：PID 文件指向的进程不是可验证的 portable-devshell ControlDaemon.js。"
    }

    try {
        Stop-Process -Id $controlProcessId -ErrorAction Stop
    } catch {
        if (Test-ControlProcessRunning $controlProcessId) { throw }
    }
    if (-not (Wait-ControlProcessExit $controlProcessId 5000)) {
        try {
            Stop-Process -Id $controlProcessId -Force -ErrorAction Stop
        } catch {
            if (Test-ControlProcessRunning $controlProcessId) { throw }
        }
        if (-not (Wait-ControlProcessExit $controlProcessId 2000)) {
            throw "经过验证的 control PID $controlProcessId 无法终止。"
        }
    }
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile
}

function Get-WorkerAssetName([string]$Target) {
    if ($Target.StartsWith("windows-")) { return "devshell-worker-$Target.exe" }
    return "devshell-worker-$Target"
}

function Install-Worker([string]$Target, [string]$Temporary, [string]$DevshellHome) {
    $asset = Get-WorkerAssetName $Target
    $source = Join-Path $Temporary $asset
    $sha = ((Get-Content -LiteralPath "$source.sha256" -TotalCount 1) -split '\s+')[0].Trim().ToLowerInvariant()
    $binaryName = if ($Target.StartsWith("windows-")) { "devshell-worker.exe" } else { "devshell-worker" }
    $workerDirectory = Join-Path $DevshellHome "workers\$Target\$sha"
    $workerBinDirectory = Join-Path $DevshellHome "bin"
    New-Item -ItemType Directory -Force -Path $workerDirectory, $workerBinDirectory | Out-Null
    Copy-Item -Force -LiteralPath $source -Destination (Join-Path $workerDirectory $binaryName)
    Set-Content -NoNewline -Encoding ASCII -LiteralPath (Join-Path $workerDirectory "$binaryName.sha256") -Value "$sha`n"
    Copy-Item -Force -LiteralPath $source -Destination (Join-Path $workerBinDirectory $asset)
}

Write-InstallStep "检查安装环境"
if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) { throw "缺少必需命令：node" }
if ($null -eq (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw "缺少必需命令：tar.exe" }
$nodeVersion = & node -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 24) {
    throw "portable-devshell 需要 Node.js 24 或更高版本。"
}

$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$hostTarget = switch ($architecture) {
    "X64" { "windows-x64" }
    "Arm64" { "windows-arm64" }
    default { throw "不支持的 Windows CPU 架构：$architecture" }
}

$homeDirectory = [Environment]::GetFolderPath("UserProfile")
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$installRoot = Get-EnvironmentValue "PORTABLE_DEVSHELL_INSTALL_ROOT" (Join-Path $localAppData "portable-devshell")
$binDirectory = Get-EnvironmentValue "PORTABLE_DEVSHELL_BIN_DIR" (Join-Path $homeDirectory ".local\bin")
$devshellHome = Get-EnvironmentValue "PORTABLE_DEVSHELL_HOME" (Join-Path $homeDirectory ".devshell")
$targets = @("linux-x64", $hostTarget) | Select-Object -Unique
$releaseBase = Get-ReleaseBase
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("portable-devshell-install-" + [Guid]::NewGuid().ToString("N"))
Write-InstallDetail "Node.js $(& node --version)"
Write-InstallDetail "宿主平台 $hostTarget"
Write-InstallDetail "预装 Worker：$($targets -join ', ')"
Write-InstallDetail "其他平台将在首次连接时按需下载"

New-Item -ItemType Directory -Force -Path $temporary | Out-Null
try {
    Write-InstallStep "下载应用包"
    $appArchive = Join-Path $temporary "portable-devshell-app.tar.gz"
    $appSha = "$appArchive.sha256"
    Download-File "$releaseBase/portable-devshell-app.tar.gz" $appArchive
    Download-File "$releaseBase/portable-devshell-app.tar.gz.sha256" $appSha
    Assert-Sha256 $appArchive $appSha
    Write-InstallDetail "应用包 SHA-256 校验通过"

    Write-InstallStep "下载预装 Worker（$($targets.Count) 个）"
    foreach ($target in $targets) {
        $asset = Get-WorkerAssetName $target
        $destination = Join-Path $temporary $asset
        Download-File "$releaseBase/$asset" $destination
        Download-File "$releaseBase/$asset.sha256" "$destination.sha256"
        Assert-Sha256 $destination "$destination.sha256"
        Write-InstallDetail "$target 校验通过"
    }

    Write-InstallStep "验证应用包并准备安装"
    $appDirectory = Join-Path $temporary "app"
    New-Item -ItemType Directory -Force -Path $appDirectory | Out-Null
    & tar.exe -xzf $appArchive -C $appDirectory
    if ($LASTEXITCODE -ne 0) { throw "无法解压 portable-devshell 应用包。" }
    $manifestPath = Join-Path $appDirectory "portable-devshell-install.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "发布包缺少 portable-devshell-install.json。" }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $version = [string]$manifest.version
    if ([string]::IsNullOrWhiteSpace($version)) { throw "应用包版本无效。" }
    $explicitReleaseBase = [Environment]::GetEnvironmentVariable("PORTABLE_DEVSHELL_RELEASE_BASE_URL")
    $workerReleaseDirectory = if (-not [string]::IsNullOrWhiteSpace($explicitReleaseBase)) {
        $releaseBase
    } else {
        $repository = Get-EnvironmentValue "PORTABLE_DEVSHELL_RELEASE_REPOSITORY" "Aromatic05/portable-devshell"
        "https://github.com/$repository/releases/download/v$version"
    }
    Set-InstallMetadata $manifestPath $workerReleaseDirectory

    $versionsDirectory = Join-Path $installRoot "versions"
    $versionDirectory = Join-Path $versionsDirectory $version
    $stagingDirectory = Join-Path $installRoot ".staging-$version-$PID"
    $backupDirectory = Join-Path $installRoot ".backup-$version-$PID"
    $currentDirectory = Join-Path $installRoot "current"
    $currentBackupDirectory = Join-Path $installRoot ".current-backup-$PID"
    $commandPath = Join-Path $binDirectory "devshell.cmd"
    New-Item -ItemType Directory -Force -Path $installRoot, $versionsDirectory, $binDirectory, $devshellHome | Out-Null
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stagingDirectory, $backupDirectory, $currentBackupDirectory
    Copy-Item -Recurse -Force -LiteralPath $appDirectory -Destination $stagingDirectory
    $cliRelativePath = Get-ApplicationCliRelativePath $stagingDirectory
    $stagingCli = Join-Path $stagingDirectory $cliRelativePath
    if (-not (Test-Path -LiteralPath $stagingCli -PathType Leaf)) {
        throw "应用包声明的 CLI 不存在：$stagingCli"
    }
    Assert-CliStarts $stagingCli "安装前验证失败"
    Write-InstallDetail "CLI 入口和运行时依赖验证通过"

    Write-InstallStep "停止旧版本并切换安装"
    $currentCli = ""
    if (Test-Path -LiteralPath (Join-Path $currentDirectory "package.json") -PathType Leaf) {
        $currentCliRelativePath = Get-ApplicationCliRelativePath $currentDirectory
        $currentCli = Join-Path $currentDirectory $currentCliRelativePath
    }
    Stop-InstalledControl $currentCli $devshellHome

    foreach ($target in $targets) {
        Write-InstallDetail "安装 $target Worker"
        Install-Worker $target $temporary $devshellHome
    }
    $hostAsset = Get-WorkerAssetName $hostTarget
    Copy-Item -Force -LiteralPath (Join-Path $devshellHome "bin\$hostAsset") -Destination (Join-Path $devshellHome "bin\devshell-worker.exe")

    $previousCommandContent = if (Test-Path -LiteralPath $commandPath -PathType Leaf) {
        Get-Content -Raw -LiteralPath $commandPath
    } else {
        $null
    }
    $activated = $false
    try {
        if (Test-Path -LiteralPath $versionDirectory) { Move-Item -Force $versionDirectory $backupDirectory }
        if (Test-Path -LiteralPath $currentDirectory) { Move-Item -Force $currentDirectory $currentBackupDirectory }
        Move-Item -Force $stagingDirectory $versionDirectory
        Copy-Item -Recurse -Force -LiteralPath $versionDirectory -Destination $currentDirectory
        $cliPath = Join-Path $currentDirectory $cliRelativePath
        Set-Content -Encoding ASCII -LiteralPath $commandPath -Value "@echo off`r`nnode `"$cliPath`" %*`r`n"

        Write-InstallStep "验证安装结果"
        Assert-CliStarts $commandPath "安装结果验证失败" $true
        $activated = $true
    } finally {
        if (-not $activated) {
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $currentDirectory, $versionDirectory
            if (Test-Path -LiteralPath $currentBackupDirectory) { Move-Item -Force $currentBackupDirectory $currentDirectory }
            if (Test-Path -LiteralPath $backupDirectory) { Move-Item -Force $backupDirectory $versionDirectory }
            if ($null -eq $previousCommandContent) {
                Remove-Item -Force -ErrorAction SilentlyContinue $commandPath
            } else {
                Set-Content -Encoding ASCII -LiteralPath $commandPath -Value $previousCommandContent
            }
        }
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $backupDirectory, $currentBackupDirectory
    Write-InstallDetail "已安装命令可以正常启动"

    Write-Host ""
    Write-Host "已安装 portable-devshell $version。"
    Write-Host "命令：$commandPath"
    Write-Host "已预装 Worker：$($targets -join ', ')"
    Write-Host "其他 Worker：首次连接对应平台时按需下载并校验"
    Write-Host "下一步："
    Write-Host "  $commandPath start"
    Write-Host "  $commandPath tui"
    if (-not (($env:PATH -split ';') -contains $binDirectory)) {
        Write-Host "PATH 尚未包含 $binDirectory，请将它加入用户 PATH 后重新打开终端。"
    }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temporary
}
