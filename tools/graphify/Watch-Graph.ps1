[CmdletBinding()]
param(
    [int]$DebounceSeconds = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$uvTools = (& uv tool dir).Trim()
$python = Join-Path $uvTools 'graphifyy\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    throw "Graphify uv interpreter not found: $python"
}

$out = Join-Path $repoRoot 'graphify-out'
$logFile = Join-Path $out 'watcher.log'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $out '.graphify_python'), "$python$([Environment]::NewLine)", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $out '.graphify_root'), "$repoRoot$([Environment]::NewLine)", $utf8NoBom)
Add-Content -LiteralPath $logFile -Value "[$([DateTimeOffset]::Now.ToString('o'))] Starting Graphify watcher." -Encoding UTF8

Push-Location -LiteralPath $repoRoot
try {
    & $python -m graphify.watch $repoRoot --debounce $DebounceSeconds *>> $logFile
} finally {
    Pop-Location
}
