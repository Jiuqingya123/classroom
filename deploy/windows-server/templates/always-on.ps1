#Requires -RunAsAdministrator
[CmdletBinding()]
param()

Write-Host ''
Write-Host '== 设置交流供电下的常开策略 ==' -ForegroundColor Cyan

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /change monitor-timeout-ac 10

Write-Host '  已关闭：睡眠、休眠、硬盘休眠（仅交流供电）' -ForegroundColor Green
Write-Host '  显示器：10 分钟关闭（不影响服务）' -ForegroundColor Green
Write-Host ''
Write-Host '还需手动确认：' -ForegroundColor Yellow
Write-Host '  1. BIOS/UEFI 中开启“来电自启 / AC Power Loss -> Power On”'
Write-Host '  2. 关闭 Windows 自动重启安装更新（可选：组策略或使用时段）'
Write-Host '  3. 笔记本请保持电源适配器连接，并在电源计划中关闭“节能模式”'
Write-Host ''
