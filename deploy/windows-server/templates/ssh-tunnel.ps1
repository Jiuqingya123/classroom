[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$User,
    [Parameter(Mandatory = $true)][string]$Key,
    [int]$Port = 22,
    [string]$RemoteBind = '127.0.0.1:8091',
    [string]$LocalTarget = '127.0.0.1:8090'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $Root 'logs\ssh-tunnel.log'
$KnownHostsDir = Join-Path $env:USERPROFILE '.ssh'
$KnownHosts = Join-Path $KnownHostsDir 'known_hosts'

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null
New-Item -ItemType Directory -Force -Path $KnownHostsDir | Out-Null
if (-not (Test-Path $KnownHosts)) {
    New-Item -ItemType File -Path $KnownHosts | Out-Null
}

function Write-Log($message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

function Rotate-Log {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
        Move-Item -Force $LogFile "$LogFile.1"
    }
}

$sshExe = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path $sshExe)) {
    $command = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if (-not $command) {
        Write-Log 'fatal: ssh.exe not found'
        exit 1
    }
    $sshExe = $command.Source
}

$forward = "${RemoteBind}:${LocalTarget}"
Write-Log "starting ssh tunnel $User@$Server (port $Port), remote $forward"

while ($true) {
    Rotate-Log
    Write-Log 'connecting...'

    & $sshExe -N -T `
        -p $Port `
        -i $Key `
        -o BatchMode=yes `
        -o IdentitiesOnly=yes `
        -o ExitOnForwardFailure=yes `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o ConnectTimeout=15 `
        -o StrictHostKeyChecking=accept-new `
        -o UserKnownHostsFile=$KnownHosts `
        -R $forward `
        "$User@$Server" 2>&1 | ForEach-Object { Write-Log $_ }

    Write-Log "disconnected (exit $LASTEXITCODE), retry in 5 seconds"
    Start-Sleep -Seconds 5
}
