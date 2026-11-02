#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidateSet('frp', 'ssh', 'none')]
    [string]$Tunnel = 'frp',

    [string]$TurnSecret = '',

    [string]$SshServer = '',
    [string]$SshUser = 'root',
    [string]$SshKey = '',
    [int]$SshPort = 22,
    [switch]$SkipSshTest
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$ServerService = 'ClassRoomServer'
$TunnelService = 'ClassRoomTunnel'
$HealthUrl = 'http://127.0.0.1:8090/healthz'

function Step($message) {
    Write-Host ''
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Ok($message) {
    Write-Host "    $message" -ForegroundColor Green
}

function Warn($message) {
    Write-Host "    ! $message" -ForegroundColor Yellow
}

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '请右键“以管理员身份运行” PowerShell，再执行本脚本。'
    }
}

function Test-ServiceExists($name) {
    return [bool](Get-Service -Name $name -ErrorAction SilentlyContinue)
}

function Uninstall-ServiceIfExists($name) {
    if (-not (Test-ServiceExists $name)) { return }
    $exe = Join-Path $Root "service\$name.exe"
    & $exe stop 2>&1 | Out-Null
    Start-Sleep -Seconds 1
    & $exe uninstall 2>&1 | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-ServiceExists $name)) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "已有服务 $name 无法卸载，请先手动停止并删除后重试。"
}

function Write-Utf8NoBom($path, $text) {
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}

function Get-EnvValue($path, $key) {
    if (-not (Test-Path $path)) { return '' }
    $pattern = '^\s*' + [regex]::Escape($key) + '\s*=(.*)$'
    foreach ($line in [IO.File]::ReadAllLines($path)) {
        if ($line -match $pattern) { return $Matches[1].Trim() }
    }
    return ''
}

function Set-EnvValue($path, $key, $value) {
    $lines = @([IO.File]::ReadAllLines($path))
    $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = "$key=$value"
            $found = $true
        }
    }
    if (-not $found) { $lines += "$key=$value" }
    [IO.File]::WriteAllLines($path, $lines, (New-Object Text.UTF8Encoding($false)))
}

function New-RandomSecret([int]$byteCount) {
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $buffer = New-Object byte[] $byteCount
    $rng.GetBytes($buffer)
    return [Convert]::ToBase64String($buffer)
}

function Protect-SecretFile($path) {
    if (-not (Test-Path $path)) { return }
    & icacls $path /inheritance:r /grant:r '*S-1-5-18:(R)' '*S-1-5-32-544:(F)' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Warn "无法收紧 $path 的访问权限（文件系统可能不是 NTFS），请手动检查。"
    }
}

function Install-WinSwService($name, $xmlPath, $xmlText) {
    $exe = Join-Path $Root "service\$name.exe"
    Write-Utf8NoBom $xmlPath $xmlText
    Uninstall-ServiceIfExists $name
    & $exe install 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "服务 $name 安装失败（WinSW exit $LASTEXITCODE）。请查看 logs 目录。"
    }
    & $exe start 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "服务 $name 启动失败（WinSW exit $LASTEXITCODE）。请查看 logs 目录。"
    }
    Ok "服务 $name 已安装并启动"
}

function Wait-Health([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
            if ($response.ok) { return $true }
        } catch {
            # 服务启动中，继续轮询
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

Assert-Admin

Step '1/5 检查安装包'
$required = @(
    'node\node.exe',
    'app\server.mjs',
    'app\migrations\001_init.sql',
    'app\migrations\002_teaching_platform.sql',
    'service\ClassRoomServer.exe',
    'service\ClassRoomServer.xml.template'
)
foreach ($relative in $required) {
    if (-not (Test-Path (Join-Path $Root $relative))) {
        throw "安装包不完整，缺少 $relative"
    }
}
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
Ok "文件齐全：$Root"

Step '2/5 生成配置文件'
$envPath = Join-Path $Root '.env'
if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $Root 'config\.env.example') $envPath
    Ok '已从 config\.env.example 创建 .env'
}

$jwt = Get-EnvValue $envPath 'JWT_SECRET'
if (-not $jwt -or $jwt -eq 'please-change-me-at-install-time' -or $jwt.Length -lt 16) {
    Set-EnvValue $envPath 'JWT_SECRET' (New-RandomSecret 48)
    Ok '已生成随机 JWT_SECRET'
}

$turnFile = Join-Path $Root 'config\turn.secret'
if (-not $TurnSecret -and (Test-Path $turnFile)) {
    $TurnSecret = (Get-Content $turnFile -Raw).Trim()
}
if ($TurnSecret) {
    Set-EnvValue $envPath 'TURN_SECRET' $TurnSecret
    Ok '已写入 TURN_SECRET'
} else {
    Warn '未提供 TURN_SECRET：将退化为 STUN-only，跨运营商或对称 NAT 下音视频可能连不上。'
}

Protect-SecretFile $envPath
Protect-SecretFile $turnFile
Ok '.env 权限已限制为 SYSTEM 读取、Administrators 完全控制'

Step '3/5 安装并启动 ClassRoom 服务'
$rootXml = [Security.SecurityElement]::Escape($Root)
$serverXml = (Get-Content (Join-Path $Root 'service\ClassRoomServer.xml.template') -Raw).Replace('{{ROOT}}', $rootXml)
Install-WinSwService $ServerService (Join-Path $Root 'service\ClassRoomServer.xml') $serverXml

if (-not (Wait-Health 60)) {
    $errorLog = Join-Path $Root 'logs\ClassRoomServer.err.log'
    if (Test-Path $errorLog) {
        Write-Host '--- ClassRoomServer.err.log ---' -ForegroundColor Red
        Get-Content $errorLog -Tail 40 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    }
    throw "服务端健康检查失败：$HealthUrl"
}
Ok "健康检查通过：$HealthUrl"

Step "4/5 配置穿透隧道（$Tunnel）"
Uninstall-ServiceIfExists $TunnelService

if ($Tunnel -eq 'none') {
    Warn '已跳过隧道。本机只监听 127.0.0.1:8090，公网无法直接访问。'
} elseif ($Tunnel -eq 'frp') {
    if (-not (Test-Path (Join-Path $Root 'tunnel\frpc.exe'))) {
        throw '安装包缺少 tunnel\frpc.exe'
    }
    if (-not (Test-Path (Join-Path $Root 'tunnel\frpc.toml'))) {
        throw '安装包缺少 tunnel\frpc.toml'
    }
    $frpXml = (Get-Content (Join-Path $Root 'service\ClassRoomTunnel-frp.xml.template') -Raw).Replace('{{ROOT}}', $rootXml)
    Install-WinSwService $TunnelService (Join-Path $Root 'service\ClassRoomTunnel.xml') $frpXml

    Start-Sleep -Seconds 4
    $frpLog = Join-Path $Root 'logs\ClassRoomTunnel.out.log'
    if (Test-Path $frpLog) {
        $tail = (Get-Content $frpLog -Tail 30) -join "`n"
        if ($tail -match 'start proxy success|login to server success') {
            Ok 'frpc 已连接云端中继'
        } else {
            Warn '暂未在日志中看到连接成功；请运行 status.ps1，或在云端运行 relay-status.sh。'
        }
    }
} elseif ($Tunnel -eq 'ssh') {
    if (-not $SshServer) { throw 'SSH 模式需要 -SshServer 参数。' }
    if (-not $SshKey) { throw 'SSH 模式需要 -SshKey 参数（私钥文件路径）。' }
    $SshKey = (Resolve-Path $SshKey).Path

    $sshExe = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
    if (-not (Test-Path $sshExe)) {
        Warn '未找到 Windows OpenSSH 客户端，尝试安装...'
        Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' | Out-Null
        if (-not (Test-Path $sshExe)) {
            throw 'OpenSSH 客户端安装失败，请手动安装后重试。'
        }
    }
    Protect-SecretFile $SshKey

    if (-not $SkipSshTest) {
        & $sshExe -p $SshPort -i $SshKey -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$SshUser@$SshServer" 'echo ok' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'SSH 预检失败：请确认服务器地址、用户、私钥权限和 sshd 的 AllowTcpForwarding。'
        }
        Ok 'SSH 预检通过'
    }

    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sshXml = (Get-Content (Join-Path $Root 'service\ClassRoomTunnel-ssh.xml.template') -Raw)
    $sshXml = $sshXml.Replace('{{ROOT}}', $rootXml)
    $sshXml = $sshXml.Replace('{{POWERSHELL}}', [Security.SecurityElement]::Escape($powershellExe))
    $sshXml = $sshXml.Replace('{{SSH_SERVER}}', [Security.SecurityElement]::Escape($SshServer))
    $sshXml = $sshXml.Replace('{{SSH_USER}}', [Security.SecurityElement]::Escape($SshUser))
    $sshXml = $sshXml.Replace('{{SSH_KEY}}', [Security.SecurityElement]::Escape($SshKey))
    Install-WinSwService $TunnelService (Join-Path $Root 'service\ClassRoomTunnel.xml') $sshXml
    Ok 'SSH 反向隧道服务已启动'
}

Step '5/5 安装完成'
Write-Host ''
Write-Host '    本机健康检查 : http://127.0.0.1:8090/healthz'
Write-Host '    公网入口     : http://{{FRP_SERVER}}:9999 （云端切流后生效）'
Write-Host '    查看状态     : .\status.ps1'
Write-Host '    云端验证     : bash relay-linux/relay-status.sh'
Write-Host ''
Write-Host '    提醒：前往“电源和睡眠”关闭睡眠，或在 BIOS 开启来电自启；' -ForegroundColor Yellow
Write-Host '          可运行 .\tools\always-on.ps1 设置交流供电下不休眠。' -ForegroundColor Yellow
