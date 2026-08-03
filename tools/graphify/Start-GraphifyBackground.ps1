[CmdletBinding()]
param(
    [int]$DebounceSeconds = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$pidFile = Join-Path $repoRoot 'graphify-out\watcher.pid'
New-Item -ItemType Directory -Path (Split-Path -Parent $pidFile) -Force | Out-Null

if (Test-Path -LiteralPath $pidFile) {
    $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
        Write-Host "Graphify watcher is already running (PID $existingPid)."
        return
    }
}

$shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $shell) { throw 'PowerShell executable not found.' }
$watchScript = Join-Path $PSScriptRoot 'Watch-Graph.ps1'
$arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$watchScript,'-DebounceSeconds',$DebounceSeconds)
$process = Start-Process -FilePath $shell -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
Start-Sleep -Milliseconds 750
if ($process.HasExited) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $logFile = Join-Path $repoRoot 'graphify-out\watcher.log'
    $tail = if (Test-Path -LiteralPath $logFile) { (Get-Content -LiteralPath $logFile -Tail 20) -join [Environment]::NewLine } else { 'No watcher log was created.' }
    throw "Graphify watcher exited during startup.`n$tail"
}
Write-Host "Graphify watcher started in background (PID $($process.Id))."
