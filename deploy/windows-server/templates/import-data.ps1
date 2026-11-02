#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$Bundle = '',
    [string]$Db = '',
    [string]$Uploads = '',
    [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$ServiceName = 'ClassRoomServer'
$HealthUrl = 'http://127.0.0.1:8090/healthz'
$TimeStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$WorkDir = Join-Path $Root "data\_import-$TimeStamp"
$BackupDir = Join-Path $Root "data\backup\$TimeStamp"
$DbPath = Join-Path $Root 'data\app.db'
$UploadsPath = Join-Path $Root 'data\uploads'

function Step($message) {
    Write-Host ''
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Test-ServiceExists($name) {
    return [bool](Get-Service -Name $name -ErrorAction SilentlyContinue)
}

function Stop-ClassRoom {
    if (-not (Test-ServiceExists $ServiceName)) { return }
    $exe = Join-Path $Root 'service\ClassRoomServer.exe'
    & $exe stop 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    $service = Get-Service -Name $ServiceName
    if ($service.Status -ne 'Stopped') {
        $service.WaitForStatus('Stopped', '00:00:30')
    }
}

function Start-ClassRoom {
    $exe = Join-Path $Root 'service\ClassRoomServer.exe'
    & $exe start 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "服务启动失败（WinSW exit $LASTEXITCODE）" }
}

function Wait-Health([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
            if ($response.ok) { return $true }
        } catch {
            # 服务启动中
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-TarExe {
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) { return $tar }
    return 'tar'
}

function Expand-UploadArchive($source) {
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    if ($source -match '\.zip$') {
        Expand-Archive -LiteralPath $source -DestinationPath $WorkDir -Force
    } elseif ($source -match '\.(tar\.gz|tgz)$') {
        & (Get-TarExe) -xzf $source -C $WorkDir
        if ($LASTEXITCODE -ne 0) { throw "解压失败：$source" }
    } elseif ($source -match '\.tar$') {
        & (Get-TarExe) -xf $source -C $WorkDir
        if ($LASTEXITCODE -ne 0) { throw "解压失败：$source" }
    } else {
        throw "不支持的课件包格式：$source（支持目录、zip、tar、tar.gz）"
    }
    $candidate = Get-ChildItem -Path $WorkDir -Recurse -Directory -Filter 'uploads' | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    return $WorkDir
}

if (-not $Bundle -and -not $Db -and -not $Uploads) {
    Write-Host '用法：' -ForegroundColor Yellow
    Write-Host '  .\import-data.ps1 -Bundle D:\transfer\classroom-data-20261028-120000.tar.gz'
    Write-Host '  .\import-data.ps1 -Db D:\transfer\app.db -Uploads D:\transfer\uploads'
    Write-Host '  .\import-data.ps1 -Db D:\transfer\app.db'
    exit 1
}

Step '1/4 准备导入源'
if ($Bundle) {
    $Bundle = (Resolve-Path $Bundle).Path
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    if ($Bundle -match '\.zip$') {
        Expand-Archive -LiteralPath $Bundle -DestinationPath $WorkDir -Force
    } elseif ($Bundle -match '\.(tar\.gz|tgz)$') {
        & (Get-TarExe) -xzf $Bundle -C $WorkDir
        if ($LASTEXITCODE -ne 0) { throw "解压失败：$Bundle" }
    } elseif ($Bundle -match '\.tar$') {
        & (Get-TarExe) -xf $Bundle -C $WorkDir
        if ($LASTEXITCODE -ne 0) { throw "解压失败：$Bundle" }
    } else {
        throw 'Bundle 只支持 zip、tar、tar.gz'
    }
    $foundDb = Get-ChildItem -Path $WorkDir -Recurse -File -Filter 'app.db' | Select-Object -First 1
    if (-not $foundDb) { throw '压缩包内未找到 app.db' }
    $Db = $foundDb.FullName
    $foundUploads = Join-Path $foundDb.Directory.FullName 'uploads'
    if (Test-Path $foundUploads) { $Uploads = $foundUploads }
    Write-Host "    数据库：$Db"
    if ($Uploads) { Write-Host "    课件：$Uploads" }
}

$sourceDb = ''
if ($Db) {
    $sourceDb = (Resolve-Path $Db).Path
    $check = & (Join-Path $Root 'node\node.exe') (Join-Path $Root 'tools\db-check.mjs') $sourceDb 2>&1
    if ($LASTEXITCODE -ne 0) { throw "源数据库校验失败：$check" }
    Write-Host "    数据库校验通过：$check" -ForegroundColor DarkGray
}

$sourceUploads = ''
if ($Uploads) {
    $sourceUploads = (Resolve-Path $Uploads).Path
    if (-not (Test-Path $sourceUploads -PathType Container)) {
        $sourceUploads = Expand-UploadArchive $sourceUploads
    }
    $fileCount = (Get-ChildItem -Path $sourceUploads -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "    课件文件数：$fileCount"
}

Step '2/4 停止服务并备份'
Stop-ClassRoom
Write-Host '    服务已停止'

$dbBackedUp = $false
$dbImported = $false
$uploadsMoved = $false

if (-not $SkipBackup) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    if (Test-Path $DbPath) {
        Copy-Item $DbPath (Join-Path $BackupDir 'app.db') -Force
        foreach ($suffix in @('-wal', '-shm')) {
            if (Test-Path "$DbPath$suffix") {
                Copy-Item "$DbPath$suffix" (Join-Path $BackupDir "app.db$suffix") -Force
            }
        }
        $dbBackedUp = $true
    }
    Write-Host "    备份目录：$BackupDir"
} else {
    Write-Host '    已跳过备份（-SkipBackup），失败将无法自动回滚' -ForegroundColor Yellow
}

Step '3/4 导入数据'
try {
    if ($sourceDb) {
        Remove-Item $DbPath -Force -ErrorAction SilentlyContinue
        Remove-Item "$DbPath-wal" -Force -ErrorAction SilentlyContinue
        Remove-Item "$DbPath-shm" -Force -ErrorAction SilentlyContinue
        Copy-Item $sourceDb $DbPath -Force
        $dbImported = $true
        $check = & (Join-Path $Root 'node\node.exe') (Join-Path $Root 'tools\db-check.mjs') $DbPath 2>&1
        if ($LASTEXITCODE -ne 0) { throw "导入后的数据库校验失败：$check" }
        Write-Host "    数据库已导入：$check" -ForegroundColor Green
    }

    if ($sourceUploads) {
        if ((Test-Path $UploadsPath) -and -not $SkipBackup) {
            Move-Item $UploadsPath (Join-Path $BackupDir 'uploads')
            $uploadsMoved = $true
        } else {
            Remove-Item $UploadsPath -Recurse -Force -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Force -Path $UploadsPath | Out-Null
        Get-ChildItem -LiteralPath $sourceUploads -Force | ForEach-Object {
            Copy-Item $_.FullName -Destination $UploadsPath -Recurse -Force
        }
        Write-Host '    课件已导入' -ForegroundColor Green
    }

    Step '4/4 启动并验证'
    Start-ClassRoom
    if (-not (Wait-Health 60)) {
        throw "导入后健康检查失败：$HealthUrl"
    }
    Write-Host '    健康检查通过' -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host "导入失败：$_" -ForegroundColor Red
    Stop-ClassRoom
    if ($dbImported) {
        if ($dbBackedUp) {
            Copy-Item (Join-Path $BackupDir 'app.db') $DbPath -Force
            foreach ($suffix in @('-wal', '-shm')) {
                $backupFile = Join-Path $BackupDir "app.db$suffix"
                if (Test-Path $backupFile) {
                    Copy-Item $backupFile "$DbPath$suffix" -Force
                } else {
                    Remove-Item "$DbPath$suffix" -Force -ErrorAction SilentlyContinue
                }
            }
            Write-Host '    已恢复备份数据库' -ForegroundColor Yellow
        } else {
            Remove-Item $DbPath -Force -ErrorAction SilentlyContinue
            Remove-Item "$DbPath-wal" -Force -ErrorAction SilentlyContinue
            Remove-Item "$DbPath-shm" -Force -ErrorAction SilentlyContinue
            Write-Host '    已删除未完成导入的数据库（原先无数据库）' -ForegroundColor Yellow
        }
    }
    if ($uploadsMoved) {
        Remove-Item $UploadsPath -Recurse -Force -ErrorAction SilentlyContinue
        Move-Item (Join-Path $BackupDir 'uploads') $UploadsPath
        Write-Host '    已恢复备份课件' -ForegroundColor Yellow
    }
    Start-ClassRoom
    Write-Host "    诊断文件保留在：$WorkDir" -ForegroundColor Yellow
    throw
}

if (Test-Path $WorkDir) {
    Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '导入完成。' -ForegroundColor Green
Write-Host "  数据库：$DbPath"
Write-Host "  课件：$UploadsPath"
Write-Host "  回滚备份：$BackupDir"
Write-Host ''
