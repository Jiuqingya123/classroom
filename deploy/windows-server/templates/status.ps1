#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [switch]$Remote
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$HealthUrl = 'http://127.0.0.1:8090/healthz'
$PublicUrl = 'http://{{FRP_SERVER}}:9999'

function Line($name, $value) {
    Write-Host ("  {0,-16} {1}" -f $name, $value)
}

Write-Host ''
Write-Host '== ClassRoom Server 状态 ==' -ForegroundColor Cyan
Line '主机' $env:COMPUTERNAME
Line '时间' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
$versionFile = Join-Path $Root 'VERSION.txt'
if (Test-Path $versionFile) {
    Line '版本' ((Get-Content $versionFile -TotalCount 1) -replace '^ClassRoom Server\s*', '')
}

Write-Host ''
Write-Host '-- 服务 --' -ForegroundColor Cyan
foreach ($name in @('ClassRoomServer', 'ClassRoomTunnel')) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($service) {
        $color = if ($service.Status -eq 'Running') { 'Green' } else { 'Yellow' }
        Write-Host ("  {0,-16} " -f $name) -NoNewline
        Write-Host $service.Status -ForegroundColor $color
    } else {
        Line $name '未安装'
    }
}

Write-Host ''
Write-Host '-- 本机健康 --' -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3
    Line '健康检查' ("ok, env=$($health.env), uptime=$($health.uptime)s, rooms=$($health.rooms), turn=$($health.turn)")
} catch {
    Line '健康检查' '失败（服务未启动或端口不通）'
}

$dbPath = Join-Path $Root 'data\app.db'
if (Test-Path $dbPath) {
    $db = Get-Item $dbPath
    Line '数据库' ("{0:N1} MB，最后写入 {1}" -f ($db.Length / 1MB), $db.LastWriteTime)
}

Write-Host ''
Write-Host '-- 隧道配置 --' -ForegroundColor Cyan
$frpcConfig = Join-Path $Root 'tunnel\frpc.toml'
if (Test-Path $frpcConfig) {
    foreach ($line in Get-Content $frpcConfig) {
        if ($line -match '^\s*(serverAddr|serverPort|remotePort)\s*=') {
            Line 'frpc' $line.Trim()
        }
    }
} else {
    Line 'frpc' '未找到 tunnel\frpc.toml'
}
$sshXml = Join-Path $Root 'service\ClassRoomTunnel.xml'
if (Test-Path $sshXml) {
    $xmlText = Get-Content $sshXml -Raw
    if ($xmlText -match 'ssh-tunnel\.ps1') { Line '模式' 'SSH 反向隧道' }
    elseif ($xmlText -match 'frpc\.exe') { Line '模式' 'frp 反向隧道' }
}

Write-Host ''
Write-Host '-- 最近日志 --' -ForegroundColor Cyan
$frpLog = Join-Path $Root 'logs\ClassRoomTunnel.out.log'
if (Test-Path $frpLog) {
    Write-Host '  [Tunnel]' -ForegroundColor DarkGray
    Get-Content $frpLog -Tail 8 | ForEach-Object { Write-Host "    $_" }
}
$sshLog = Join-Path $Root 'logs\ssh-tunnel.log'
if (Test-Path $sshLog) {
    Write-Host '  [SSH]' -ForegroundColor DarkGray
    Get-Content $sshLog -Tail 8 | ForEach-Object { Write-Host "    $_" }
}
$errLog = Join-Path $Root 'logs\ClassRoomServer.err.log'
if (Test-Path $errLog) {
    Write-Host '  [Server err]' -ForegroundColor DarkGray
    Get-Content $errLog -Tail 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
}

if ($Remote) {
    Write-Host ''
    Write-Host '-- 公网入口 --' -ForegroundColor Cyan
    try {
        $public = Invoke-RestMethod -Uri "$PublicUrl/healthz" -TimeoutSec 8
        Line '公网 /healthz' ("ok, env=$($public.env), uptime=$($public.uptime)s")
        Line '说明' '若 uptime 很小，可能仍指向云端；切换后应持续增长'
    } catch {
        Line '公网 /healthz' '失败（可能尚未切流，或隧道断开）'
    }
}

Write-Host ''
Write-Host '提示：隧道是否真正连通，以云端 `bash relay-linux/relay-status.sh` 为准。' -ForegroundColor DarkGray
Write-Host ''
