<#
    注册 Codex 模型路由器的开机自启计划任务。

    用法（一般由 install-autostart.cmd 调用）：
        powershell -NoProfile -ExecutionPolicy Bypass -File install-autostart.ps1
        powershell ... -File install-autostart.ps1 -TaskName 自定义任务名

    取消：schtasks /delete /tn "CodexModelRouter" /f
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'CodexModelRouter'
)

$ErrorActionPreference = 'Stop'

$node = 'C:\Program Files\nodejs\node.exe'
$dir  = $PSScriptRoot
if (-not $dir) { $dir = 'E:\github\codex-model-router' }

if (-not (Test-Path -LiteralPath $node)) {
    throw "找不到 node.exe：$node"
}
if (-not (Test-Path -LiteralPath (Join-Path $dir 'server.mjs'))) {
    throw "找不到 server.mjs：$dir"
}

$action = New-ScheduledTaskAction -Execute $node -Argument 'server.mjs' -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "已注册计划任务: $TaskName"
Write-Host "  启动命令: `"$node`" server.mjs  (工作目录 $dir)"
Write-Host "  触发条件: 登录 $env:USERDOMAIN\$env:USERNAME 时自动启动"
Write-Host "  取消自启: schtasks /delete /tn `"$TaskName`" /f"