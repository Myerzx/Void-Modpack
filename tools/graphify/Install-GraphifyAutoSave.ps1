[CmdletBinding()]
param(
    [int]$DebounceSeconds = 3,
    [switch]$SkipScheduledTask
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$graphify = (Get-Command graphify -ErrorAction SilentlyContinue).Source
if (-not $graphify) { throw 'Graphify CLI was not found in PATH.' }

Push-Location -LiteralPath $repoRoot
try {
    & $graphify hook install
    if ($LASTEXITCODE -ne 0) { throw "graphify hook install failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot 'Start-GraphifyBackground.ps1') -DebounceSeconds $DebounceSeconds

if (-not $SkipScheduledTask) {
    $taskName = 'VoidFall-Graphify-AutoSave'
    $shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $shell) { throw 'PowerShell executable not found.' }
    $startScript = Join-Path $PSScriptRoot 'Start-GraphifyBackground.ps1'
    $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -DebounceSeconds {1}' -f $startScript,$DebounceSeconds
    $action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $repoRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the VoidFall Graphify knowledge graph updated.' -Force | Out-Null
    Write-Host "Scheduled task installed: $taskName"
}

Write-Host 'Graphify automatic saving is installed.'
