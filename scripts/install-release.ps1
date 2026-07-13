Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Assert-Sha256([string]$File, [string]$ShaFile) {
    $expected = ((Get-Content -LiteralPath $ShaFile -TotalCount 1) -split '\s+')[0].Trim().ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { throw "无效的 SHA-256 文件：$ShaFile" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 校验失败：$File" }
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
$targets = @("linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64")
$releaseBase = Get-ReleaseBase
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("portable-devshell-install-" + [Guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Force -Path $temporary | Out-Null
try {
    $appArchive = Join-Path $temporary "portable-devshell-app.tar.gz"
    $appSha = "$appArchive.sha256"
    Download-File "$releaseBase/portable-devshell-app.tar.gz" $appArchive
    Download-File "$releaseBase/portable-devshell-app.tar.gz.sha256" $appSha
    Assert-Sha256 $appArchive $appSha

    foreach ($target in $targets) {
        $asset = Get-WorkerAssetName $target
        $destination = Join-Path $temporary $asset
        Download-File "$releaseBase/$asset" $destination
        Download-File "$releaseBase/$asset.sha256" "$destination.sha256"
        Assert-Sha256 $destination "$destination.sha256"
    }

    $appDirectory = Join-Path $temporary "app"
    New-Item -ItemType Directory -Force -Path $appDirectory | Out-Null
    & tar.exe -xzf $appArchive -C $appDirectory
    if ($LASTEXITCODE -ne 0) { throw "无法解压 portable-devshell 应用包。" }
    $manifestPath = Join-Path $appDirectory "portable-devshell-install.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "发布包缺少 portable-devshell-install.json。" }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $version = [string]$manifest.version
    if ([string]::IsNullOrWhiteSpace($version)) { throw "应用包版本无效。" }

    $versionsDirectory = Join-Path $installRoot "versions"
    $versionDirectory = Join-Path $versionsDirectory $version
    $stagingDirectory = Join-Path $installRoot ".staging-$version-$PID"
    $backupDirectory = Join-Path $installRoot ".backup-$version-$PID"
    $currentDirectory = Join-Path $installRoot "current"
    New-Item -ItemType Directory -Force -Path $installRoot, $versionsDirectory, $binDirectory, $devshellHome | Out-Null
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stagingDirectory, $backupDirectory
    Copy-Item -Recurse -Force -LiteralPath $appDirectory -Destination $stagingDirectory

    $currentCli = Join-Path $currentDirectory "dist\cli\CliMain.js"
    if (Test-Path -LiteralPath $currentCli) {
        & node $currentCli stop *> $null
        if ($LASTEXITCODE -ne 0) { throw "无法停止当前 control daemon，安装已取消。" }
    }

    foreach ($target in $targets) { Install-Worker $target $temporary $devshellHome }
    $hostAsset = Get-WorkerAssetName $hostTarget
    Copy-Item -Force -LiteralPath (Join-Path $devshellHome "bin\$hostAsset") -Destination (Join-Path $devshellHome "bin\devshell-worker.exe")

    if (Test-Path -LiteralPath $versionDirectory) { Move-Item -Force $versionDirectory $backupDirectory }
    Move-Item -Force $stagingDirectory $versionDirectory
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $currentDirectory
    Copy-Item -Recurse -Force -LiteralPath $versionDirectory -Destination $currentDirectory
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $backupDirectory

    $commandPath = Join-Path $binDirectory "devshell.cmd"
    $cliPath = Join-Path $currentDirectory "dist\cli\CliMain.js"
    Set-Content -Encoding ASCII -LiteralPath $commandPath -Value "@echo off`r`nnode `"$cliPath`" %*`r`n"
    Write-Host "已安装 portable-devshell $version。"
    Write-Host "命令：$commandPath"
    Write-Host "Worker：$($targets -join ', ')"
    Write-Host "如果命令不可用，请将 $binDirectory 加入用户 PATH。"
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temporary
}
