[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$pidFile = Join-Path $repoRoot 'graphify-out\watcher.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No Graphify watcher PID file found.'
    return
}

$watcherPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-Process -Id $watcherPid -ErrorAction SilentlyContinue
if ($process) {
    $pending = [System.Collections.Generic.Queue[int]]::new()
    $pending.Enqueue($watcherPid)
    $descendants = [System.Collections.Generic.List[int]]::new()
    while ($pending.Count -gt 0) {
        $parentId = $pending.Dequeue()
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId" -ErrorAction SilentlyContinue
        foreach ($child in $children) {
            $childId = [int]$child.ProcessId
            $descendants.Add($childId)
            $pending.Enqueue($childId)
        }
    }
    foreach ($childId in ($descendants | Sort-Object -Descending)) {
        Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $watcherPid -Force
    Write-Host "Stopped Graphify watcher (PID $watcherPid)."
} else {
    Write-Host "Graphify watcher PID $watcherPid is no longer running."
}
Remove-Item -LiteralPath $pidFile -Force
