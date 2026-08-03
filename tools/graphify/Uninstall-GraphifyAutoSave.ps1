[CmdletBinding()]
param(
    [switch]$KeepGitHook
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
& (Join-Path $PSScriptRoot 'Stop-GraphifyBackground.ps1')

$taskName = 'VoidFall-Graphify-AutoSave'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Scheduled task removed: $taskName"
}

if (-not $KeepGitHook) {
    Push-Location -LiteralPath $repoRoot
    try {
        & graphify hook uninstall
        if ($LASTEXITCODE -ne 0) { throw "graphify hook uninstall failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

Write-Host 'Graphify automatic saving was removed.'
