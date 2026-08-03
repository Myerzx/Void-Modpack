[CmdletBinding()]
param(
    [string]$PackPath = (Join-Path $PSScriptRoot '..\pack'),
    [string]$CatalogPath = (Join-Path $PSScriptRoot '..\catalog\addons.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pack = (Resolve-Path -LiteralPath $PackPath).Path
$manifestPath = Join-Path $pack 'manifest.json'
$overrides = Join-Path $pack 'overrides'
$errors = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Add-PackError([string]$Message) { $script:errors.Add($Message) }
function Add-PackWarning([string]$Message) { $script:warnings.Add($Message) }

if (-not (Test-Path -LiteralPath $manifestPath)) { Add-PackError 'manifest.json is missing.' }
if (-not (Test-Path -LiteralPath $overrides)) { Add-PackError 'overrides directory is missing.' }

if ($errors.Count -eq 0) {
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
    catch { Add-PackError "manifest.json is invalid JSON: $($_.Exception.Message)" }
}

if ($null -ne $manifest) {
    if ($manifest.minecraft.version -ne '1.20.1') { Add-PackError "Unexpected Minecraft version: $($manifest.minecraft.version)" }
    if ($manifest.minecraft.modLoaders[0].id -ne 'forge-47.4.0') { Add-PackError "Unexpected loader: $($manifest.minecraft.modLoaders[0].id)" }
    if ($manifest.files.Count -ne 27) { Add-PackError "Expected 27 enabled addon entries, found $($manifest.files.Count)." }
    $duplicates = @($manifest.files | Group-Object projectID,fileID | Where-Object Count -gt 1)
    if ($duplicates.Count -gt 0) { Add-PackError 'Manifest contains duplicate project/file entries.' }
}

$bannedNames = @('minecraftinstance.json','usercache.json','usernamecache.json','username-cache.json','user-prefs.json','.curseclient','servers.dat')
$files = @(Get-ChildItem -LiteralPath $pack -Recurse -Force -File -ErrorAction SilentlyContinue)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($pack.Length + 1).Replace('\','/')
    if ($file.Length -gt 95MB) { Add-PackError "File exceeds 95 MB: $relative" }
    if ($file.Name -in $bannedNames) { Add-PackError "Sensitive/runtime file present: $relative" }
    if ($relative -match '(^|/)(logs|crash-reports|saves|screenshots|xaero)(/|$)') { Add-PackError "Runtime directory present: $relative" }
    if ($file.Name -match '\.(jar|disabled|mca)$') { Add-PackError "Binary runtime artifact present: $relative" }
}

$jsonFiles = @($files | Where-Object Extension -in @('.json','.mcmeta'))
foreach ($file in $jsonFiles) {
    try {
        $jsonContent = Get-Content -LiteralPath $file.FullName -Raw
        $jsonContent = $jsonContent -replace '(?m)^\s*//.*$',''
        $null = $jsonContent | ConvertFrom-Json -ErrorAction Stop
    }
    catch { Add-PackError "Invalid JSON: $($file.FullName.Substring($pack.Length + 1))" }
}

$textFiles = @($files | Where-Object Extension -in @('.txt','.json','.json5','.toml','.cfg','.ini','.properties','.local'))
foreach ($file in $textFiles) {
    $lineNumber = 0
    Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue | ForEach-Object {
        $lineNumber++
        if ($_ -match '(?:^|[\s''"=])(?:[A-Za-z]:[\\/]|file:/+|\\\\[A-Za-z0-9_.-]+\\)') {
            Add-PackError "Absolute path in $($file.FullName.Substring($pack.Length + 1)):$lineNumber"
        }
    }
}

$fancyRoot = Join-Path $overrides 'config\fancymenu'
if (Test-Path -LiteralPath $fancyRoot) {
    Get-ChildItem -LiteralPath $fancyRoot -Recurse -File -Include '*.txt','*.json','*.properties','*.ini' | ForEach-Object {
        $sourceFile = $_
        $lineNumber = 0
        Get-Content -LiteralPath $sourceFile.FullName | ForEach-Object {
            $lineNumber++
            $line = $_
            foreach ($match in [regex]::Matches($line,'\[source:local\]([^\r\n]+)')) {
                $raw = $match.Groups[1].Value.Trim().Trim("'",'"',';')
                $raw = ($raw -split '\s+\[')[0].Trim()
                if ([string]::IsNullOrWhiteSpace($raw) -or $raw -match '^https?://') { continue }
                $candidate = Join-Path $overrides ($raw.TrimStart('/').Replace('/','\'))
                if (-not (Test-Path -LiteralPath $candidate)) {
                    Add-PackError "Missing FancyMenu asset '$raw' referenced by $($sourceFile.FullName.Substring($pack.Length + 1)):$lineNumber"
                }
            }
        }
    }
}

$optionsPath = Join-Path $overrides 'options.txt'
if (Test-Path -LiteralPath $optionsPath) {
    $resourceLine = Select-String -LiteralPath $optionsPath -Pattern '^resourcePacks:' | Select-Object -First 1
    foreach ($expected in @('Better-Leaves-9.4.zip','Excalibur_V1.20.zip')) {
        if ($null -eq $resourceLine -or $resourceLine.Line -notmatch [regex]::Escape($expected)) {
            Add-PackError "options.txt does not enable expected resource pack: $expected"
        }
    }
    if ($resourceLine.Line -match 'resources/resources\.zip') {
        Add-PackError 'options.txt still references the quarantined CtE resources.zip.'
    }
} else {
    Add-PackError 'overrides/options.txt is missing.'
}

if (Test-Path -LiteralPath $CatalogPath) {
    $catalog = Get-Content -LiteralPath $CatalogPath -Raw | ConvertFrom-Json
    $enabledCatalog = @($catalog | Where-Object { $_.enabled -eq $true })
    if ($enabledCatalog.Count -ne 27) { Add-PackError "Catalog enabled count is $($enabledCatalog.Count), expected 27." }
    $requiredShaders = @($enabledCatalog | Where-Object { $_.category -eq 'shaderpacks' -and $_.required })
    if ($requiredShaders.Count -gt 0) { Add-PackError 'Shader packs must remain optional while Oculus/Embeddium are disabled.' }
} else {
    Add-PackWarning 'Catalog is missing; run Export-LauncherInventory.ps1.'
}

foreach ($warning in $warnings) { Write-Warning $warning }
if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Host "ERROR: $_" -ForegroundColor Red }
    throw "Launcher pack validation failed with $($errors.Count) error(s)."
}

Write-Host "Launcher pack validation passed: $($files.Count) files, $($manifest.files.Count) external entries."
