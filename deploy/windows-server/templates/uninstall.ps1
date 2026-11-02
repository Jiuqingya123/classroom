#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [switch]$RemoveConfig
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

function Step($message) {
    Write-Host ''
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Test-ServiceExists($name) {
    return [bool](Get-Service -Name $name -ErrorAction SilentlyContinue)
}

function Remove-ClassRoomService($name) {
    if (-not (Test-ServiceExists $name)) {
        Write-Host "    服务 $name 不存在，跳过" -ForegroundColor DarkGray
        return
    }
    $exe = Join-Path $Root "service\$name.exe"
    & $exe stop 2>&1 | Out-Null
    Start-Sleep -Seconds 1
    & $exe uninstall 2>&1 | Out-Null
    Start-Sleep -Seconds 1
    if (Test-ServiceExists $name) {
        throw "服务 $name 卸载失败，请手动处理。"
    }
    Write-Host "    已卸载服务 $name" -ForegroundColor Green
}

Step '停止并卸载服务'
Remove-ClassRoomService 'ClassRoomTunnel'
Remove-ClassRoomService 'ClassRoomServer'

Step '清理服务配置'
foreach ($file in @('service\ClassRoomTunnel.xml', 'service\ClassRoomServer.xml')) {
    $path = Join-Path $Root $file
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "    已删除 $file" -ForegroundColor Green
    }
}

if ($RemoveConfig) {
    Step '删除配置（保留数据）'
    foreach ($file in @('.env', 'config\turn.secret')) {
        $path = Join-Path $Root $file
        if (Test-Path $path) {
            Remove-Item $path -Force
            Write-Host "    已删除 $file" -ForegroundColor Green
        }
    }
}

Step '完成'
Write-Host "    数据目录：$(Join-Path $Root 'data')" -ForegroundColor Yellow
Write-Host "    日志目录：$(Join-Path $Root 'logs')" -ForegroundColor Yellow
Write-Host '    本脚本不会删除数据库和课件；确认不再需要时请手动备份或删除。' -ForegroundColor Yellow
Write-Host ''
