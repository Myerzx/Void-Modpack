[CmdletBinding()]
param(
    [string]$WorkspacePath,
    [switch]$RefreshStorage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $WorkspacePath) {
    $WorkspacePath = Join-Path $serverRoot 'workspace\server-original'
}
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
$catalog = Join-Path $serverRoot 'catalog'
$docsInventory = Join-Path $repoRoot 'docs\servidor\inventario'
New-Item -ItemType Directory -Path $catalog,$docsInventory -Force | Out-Null

function Export-PortableCsv {
    param([Parameter(Mandatory)]$Rows,[Parameter(Mandatory)][string]$Path)
    @($Rows) | ConvertTo-Csv -NoTypeInformation | Set-Content -LiteralPath $Path -Encoding UTF8
}

$directoryInventoryPath = Join-Path $docsInventory 'diretorios.csv'
if ((Test-Path -LiteralPath $directoryInventoryPath) -and -not $RefreshStorage) {
    $directoryRows = @(Import-Csv -LiteralPath $directoryInventoryPath)
    $totalFileCount = [int](($directoryRows | Measure-Object Files -Sum).Sum)
    $totalBytes = [long](($directoryRows | Measure-Object Bytes -Sum).Sum)
} else {
    $directoryStats = @{}
    $totalFileCount = 0
    $totalBytes = [long]0
    $options = [System.IO.EnumerationOptions]::new()
    $options.RecurseSubdirectories = $true
    $options.IgnoreInaccessible = $true
    $options.AttributesToSkip = 0
    foreach ($path in [System.IO.Directory]::EnumerateFiles($workspace, '*', $options)) {
        $file = [System.IO.FileInfo]::new($path)
        $relative = $file.FullName.Substring($workspace.Length + 1)
        $top = ($relative -split '[\\/]')[0]
        if (-not $directoryStats.ContainsKey($top)) {
            $directoryStats[$top] = [ordered]@{ Files = 0; Bytes = [long]0 }
        }
        $directoryStats[$top].Files++
        $directoryStats[$top].Bytes += [long]$file.Length
        $totalFileCount++
        $totalBytes += [long]$file.Length
    }
    $directoryRows = @($directoryStats.Keys | ForEach-Object {
        [pscustomobject][ordered]@{
            Directory = $_
            Files = $directoryStats[$_].Files
            Bytes = $directoryStats[$_].Bytes
        }
    } | Sort-Object Bytes -Descending)
    Export-PortableCsv -Rows $directoryRows -Path $directoryInventoryPath
    $directoryStats = $null
    [System.GC]::Collect()
}
Write-Host "Storage inventory ready: $totalFileCount files."

$modsPath = Join-Path $workspace 'mods'
$modFiles = @(Get-ChildItem -LiteralPath $modsPath -Force -File | Sort-Object Name)
$existingHashes = @{}
$existingCatalog = Join-Path $catalog 'mods.csv'
if (Test-Path -LiteralPath $existingCatalog) {
    foreach ($row in @(Import-Csv -LiteralPath $existingCatalog)) {
        $existingHashes[$row.FileName.ToLowerInvariant()] = $row
    }
}
$modRows = @($modFiles | ForEach-Object {
    $state = if ($_.Name -match '\.jar\.disabled$') { 'disabled' } elseif ($_.Name -match '\.jar$') { 'active' } else { 'backup-or-other' }
    $kind = if ($_.Name -match '(?i)stub') {
        'compatibility-stub'
    } elseif ($_.Name -match '(?i)(void_|compatibility|edited|dirty|ash of sin|cte_|tcr|roe_weapons|nightfall enhance|fix)') {
        'local-or-patched'
    } else {
        'upstream-or-third-party'
    }
    $existing = $existingHashes[$_.Name.ToLowerInvariant()]
    $sha256 = if ($existing -and [long]$existing.Bytes -eq $_.Length -and $existing.Sha256) {
        $existing.Sha256
    } else {
        (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [pscustomobject][ordered]@{
        FileName = $_.Name
        State = $state
        Kind = $kind
        Bytes = [long]$_.Length
        Sha256 = $sha256
        DistributionReview = if ($kind -eq 'upstream-or-third-party') { 'provider-metadata-required' } else { 'license-and-authorship-required' }
    }
})
Export-PortableCsv -Rows $modRows -Path (Join-Path $catalog 'mods.csv')
Write-Host "Mod inventory ready: $($modRows.Count) entries."

$activeServer = @($modRows | Where-Object State -eq 'active' | ForEach-Object FileName)
$embeddedClientPath = Join-Path $workspace 'local\drive_exports\VOID_MMORPG_CLIENT_ESSENTIAL_20260414_113822\mods'
$embeddedClient = if (Test-Path -LiteralPath $embeddedClientPath) {
    @(Get-ChildItem -LiteralPath $embeddedClientPath -File | Where-Object Name -match '\.jar$' | ForEach-Object Name)
} else { @() }
$currentLauncherPath = Join-Path $repoRoot 'Launcher\workspace\profile-original\mods'
$currentLauncher = if (Test-Path -LiteralPath $currentLauncherPath) {
    @(Get-ChildItem -LiteralPath $currentLauncherPath -File | Where-Object Name -match '\.jar$' | ForEach-Object Name)
} else { @() }

function New-NameMap {
    param([string[]]$Names)
    $map = @{}
    foreach ($name in $Names) { $map[$name.ToLowerInvariant()] = $name }
    return $map
}

$serverMap = New-NameMap $activeServer
$embeddedMap = New-NameMap $embeddedClient
$launcherMap = New-NameMap $currentLauncher
$allNames = @($serverMap.Keys + $embeddedMap.Keys + $launcherMap.Keys | Sort-Object -Unique)
$compatibilityRows = @($allNames | ForEach-Object {
    $key = $_
    $display = if ($serverMap.ContainsKey($key)) { $serverMap[$key] } elseif ($embeddedMap.ContainsKey($key)) { $embeddedMap[$key] } else { $launcherMap[$key] }
    [pscustomobject][ordered]@{
        FileName = $display
        Server = $serverMap.ContainsKey($key)
        EmbeddedClient = $embeddedMap.ContainsKey($key)
        CurrentLauncher = $launcherMap.ContainsKey($key)
    }
} | Sort-Object FileName)
Export-PortableCsv -Rows $compatibilityRows -Path (Join-Path $catalog 'compatibilidade-cliente.csv')
Write-Host "Compatibility inventory ready: $($compatibilityRows.Count) unique filenames."

$modsTotalCount = $modRows.Count
$pythonPointer = Join-Path $repoRoot 'graphify-out\.graphify_python'
$python = if (Test-Path -LiteralPath $pythonPointer) {
    (Get-Content -LiteralPath $pythonPointer -Raw).Trim()
} else {
    (Get-Command python -ErrorAction Stop).Source
}
$summaryScript = Join-Path $PSScriptRoot 'export_server_summary.py'
& $python $summaryScript --workspace $workspace --repo-root $repoRoot --server-root $serverRoot
if ($LASTEXITCODE -ne 0) { throw "Sanitized summary export failed with exit code $LASTEXITCODE." }

Copy-Item -LiteralPath (Join-Path $catalog 'mods.csv') -Destination (Join-Path $docsInventory 'mods.csv') -Force
Copy-Item -LiteralPath (Join-Path $catalog 'compatibilidade-cliente.csv') -Destination (Join-Path $docsInventory 'compatibilidade-cliente.csv') -Force
Copy-Item -LiteralPath (Join-Path $catalog 'resumo-servidor.json') -Destination (Join-Path $docsInventory 'resumo-servidor.json') -Force
Copy-Item -LiteralPath $directoryInventoryPath -Destination (Join-Path $catalog 'diretorios.csv') -Force

Write-Host "Server inventory exported: $totalFileCount files, $modsTotalCount mod entries."
